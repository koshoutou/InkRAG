/**
 * 流水线引擎（BullMQ 语义的 SQLite 实现，计划书 §10）
 *
 * - globalThis 单例（Next dev 每 route 模块独立实例，必须跨模块共享）
 * - setInterval 1200ms tick；进程内并发 2；CAS 认领（updateMany where status='pending'）
 * - 三类执行器：parse → chunk → embed（含 upsert，阶段状态分开回写）
 * - 失败处理：attempts < maxAttempts 且可重试 → 回 pending（BullMQ 语义）；
 *   NonRetryable（业务错误）或重试耗尽 → failed + document.status=failed + 事件
 *
 * Task 15-c 性能与可靠性重构（审计报告 P1-1/P1-2/P1-3/P1-4、N13/N14/N15/N16）：
 * - 【P1-1 吞吐】MinerU 等待移出并发槽：execParse 只做「上传+提交」，随后任务置为
 *   waiting_mineru（不占 active 槽）；独立轮询器（5s 一轮）接管远端状态查询，
 *   完成后下载产物并把任务回置 pending（payloadJson 阶段游标 stage='chunk'）
 * - 【P1-3 断点续传】远端 jobId/uploadId/fileId 持久化到 Document；重入 execParse
 *   先探测旧任务（不重新上传）；远端 404 → 清字段重新提交
 * - 【心跳续租】active 任务每 20s 更新 heartbeatAt；recoverStaleJobs 改为心跳驱动
 *   （>120s 未续租判僵死），回收前先 abort AbortController + CAS 回置（防双跑）
 * - 【P1-2 吞吐】嵌入经全局闸门：64/组（= 1 请求/组）× 在飞 ≤2 × AIMD 自适应
 *   放行间隔（实测嵌入 API qpm≈10，8 路并发会 429 风暴 → 重试耗尽失败）；
 *   向量入库 256/批 × 2 路有限并发
 * - 【N13/N14 取消】新状态 cancelled：删 KB / 删文档 / 重复入队前取消在途任务；
 *   各阶段边界与长循环检查 signal → 安静退出（不写 failed、不发失败事件）
 * - 【N16】progressThrottle 增 TTL 清扫（引擎 tick 惰性清理 >5 分钟无更新条目）
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { recordOp } from './oplog'
import { getRagSettings } from './settings'
import { getVectorStore, isNonRetryable, StoreError } from './vectorstore'
import { DEFAULT_CHUNK_CONFIG, splitMarkdown, countTokens, type ChunkConfig } from './chunking'
import {
  parseDocument,
  resolveDocEngine,
  submitMineruJob,
  probeMineruJob,
  finishMineruArtifact,
  parsePersistedHandle,
  serializeHandle,
  type MinerUHandle,
  type MinerUPartsHandle,
} from './mineru'
import { assertEmbedScheme, embedTexts } from './embed'
import { deterministicChunkId, textHash16 } from './ids'
import {
  chunksDir,
  markdownPath,
  middleJsonPath,
  resolveStorageKey,
  sourcePath,
} from './artifacts'
import {
  documentDone,
  documentProgress,
  documentStatus,
  jobUpdate,
  kbStats,
  pipelineActivity,
} from './events'
import type { DocumentStatus, MiddleJson } from './types'

const CONCURRENCY = 2
const TICK_MS = 1200
const MAX_ATTEMPTS = 3

// ---- F-CONC-01：任务级重试指数退避（BullMQ delayed-job 语义的 SQLite 等价实现）----
/** 退避序列（按 attempts 取，1→2s、2→8s、≥3→30s）；额外 0-1s 随机抖动防止同步风暴 */
const RETRY_BACKOFF_MS = [2_000, 8_000, 30_000]
function retryBackoffMs(attempts: number): number {
  const idx = Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1
  return RETRY_BACKOFF_MS[idx] + Math.floor(Math.random() * 1_000)
}

// ---- Task 15-c 新增调参 ----
/** MinerU 轮询器周期（与主引擎 tick 并行；轮询不占文档并发槽） */
const MINERU_POLL_MS = 5_000
/** MinerU 远端任务等待上限（防远端永久挂起；超时走可重试失败路径） */
const MINERU_WAIT_CAP_MS = 6 * 60 * 60_000
/** 活跃任务心跳间隔（≤30s，审计 B：心跳续租替代 10 分钟僵死判定） */
const HEARTBEAT_INTERVAL_MS = 20_000
/** 心跳过期阈值（超过即判僵死） */
const HEARTBEAT_STALE_MS = 120_000
/** 旧数据回退阈值（heartbeatAt 为空的存量 active 行，沿用 10 分钟） */
const LEGACY_STALE_MS = 10 * 60_000
/** 僵死回收执行频率（每 N 个 tick 一次，与 tick 频率解耦） */
const RECOVER_EVERY_TICKS = 10
/** progressThrottle 条目 TTL（审计#N16：防 Map 单调增长） */
const PROGRESS_TTL_MS = 5 * 60_000
/** 向量入库批内并发路数（Qdrant upsert 256/批） */
const UPSERT_CONCURRENCY = 2
/** 单次轮询器单轮最多处理的 waiting 任务数 */
const MINERU_POLL_BATCH = 20

type JobRow = NonNullable<Awaited<ReturnType<typeof db.pipelineJob.findUnique>>>
type DocRow = NonNullable<Awaited<ReturnType<typeof db.document.findUnique>>>
type KbRow = NonNullable<Awaited<ReturnType<typeof db.knowledgeBase.findUnique>>>

/** 在途任务状态集合（取消语义作用于这些状态；cancelled/completed/failed 为终态） */
const IN_FLIGHT_STATUSES = ['pending', 'active', 'waiting_mineru'] as const

// ---------------------------------------------------------------------------
// 哨兵异常（runJob 识别后安静处理，不走失败路径）
// ---------------------------------------------------------------------------

/** execParse 已把任务置为 waiting_mineru（槽位已释放），runJob 静默返回 */
class DeferMineruWait extends Error {
  constructor() {
    super('deferred-to-mineru-poller')
  }
}

/** 任务被取消（删库/删文档/重复入队）或被僵死回收：安静退出，不写 failed 不发事件（审计#N13） */
class JobCancelledSignal extends Error {
  constructor(reason = 'job-cancelled') {
    super(reason)
  }
}

// ---------------------------------------------------------------------------
// 引擎单例
// ---------------------------------------------------------------------------

interface PipelineEngineState {
  timer: ReturnType<typeof setInterval> | null
  /** MinerU 轮询器定时器（与主 tick 并行；审计#P1-1） */
  mineruTimer: ReturnType<typeof setInterval> | null
  busy: boolean
  /** MinerU 轮询器串行标志（单轮未结束不叠加下一轮） */
  mineruBusy: boolean
  startedAt: number
  tickCount: number
  /** 模块版本（dev 热重载自愈：新模块实例检测到版本更新即接管引擎） */
  moduleVersion: number
}

/**
 * 跨模块代际共享的运行时记账（不随引擎接管重置）。
 * 审计：dev 下每 route 模块独立求值 → 接管频繁发生，若 active/controllers 随引擎状态
 * 重建则旧协程的 finally 递减到旧对象上 → active 计数失真、并发槽超发（实测 active=6）。
 * 故把计数与 controller 表放在永不重建的 globalThis 槽位，全模块代际共享。
 */
interface PipelineSharedState {
  active: number
  /** jobId → AbortController（取消/僵死回收时通知活跃协程在检查点安静退出） */
  controllers: Map<string, AbortController>
}

const g = globalThis as unknown as {
  __ragPipeline?: PipelineEngineState
  __ragPipelineShared?: PipelineSharedState
}

function shared(): PipelineSharedState {
  if (!g.__ragPipelineShared) {
    g.__ragPipelineShared = { active: 0, controllers: new Map() }
  }
  return g.__ragPipelineShared
}

/** 每次模块求值取新值——dev 下模块重编译后可检测并接管旧引擎 */
const PIPELINE_MODULE_VERSION = Date.now()

export function ensurePipelineEngine(): PipelineEngineState {
  let eng = g.__ragPipeline
  if (eng && eng.moduleVersion !== PIPELINE_MODULE_VERSION) {
    // dev 热重载：旧模块实例的引擎（闭包引用旧代码）→ 安全接管
    // （active/controllers 在 shared() 槽位上，不重置——并发记账跨代际连续）
    if (eng.timer) clearInterval(eng.timer)
    if (eng.mineruTimer) clearInterval(eng.mineruTimer)
    console.log('[pipeline] 检测到模块更新，接管引擎（旧任务随新代码继续）')
    eng = undefined
  }
  if (!eng) {
    eng = {
      timer: null,
      mineruTimer: null,
      busy: false,
      mineruBusy: false,
      startedAt: Date.now(),
      tickCount: 0,
      moduleVersion: PIPELINE_MODULE_VERSION,
    }
    g.__ragPipeline = eng
  }
  if (!eng.timer) {
    eng.timer = setInterval(() => {
      void tick(eng!)
    }, TICK_MS)
    // MinerU 轮询器：独立 5s 定时器（waiting_mineru 任务不占文档槽；审计#P1-1）
    if (!eng.mineruTimer) {
      eng.mineruTimer = setInterval(() => {
        void mineruPollTick(eng!)
      }, MINERU_POLL_MS)
    }
    console.log('[pipeline] 引擎已启动（tick=1200ms, concurrency=2, mineru-poll=5000ms）')
    void pipelineActivity({
      at: Date.now(),
      level: 'info',
      message: '流水线引擎已启动（tick 1200ms / 并发 2 / MinerU 轮询 5s）',
    })
    // 启动恢复：上次进程中断遗留的 active 任务回 pending；
    // waiting_mineru 任务保持原状由轮询器接管（已在 DB，审计 A4）
    void recoverStaleJobs()
  }
  return eng
}

/**
 * 僵尸任务恢复（审计 B：心跳续租替代固定 10 分钟判定）。
 * 仅回收 status='active' 且（heartbeatAt 超 120s 未续租，或无心跳旧行且 startedAt 超 10 分钟）
 * 的任务；waiting_mineru / cancelled 不参与恢复。
 * 回置前先 abort 对应 controller 并等待一个 tick，回置本身用 CAS updateMany
 * （where 心跳仍过期）保证只有一个回收者成功 —— 消除「回置后原协程仍在跑」的双跑。
 */
async function recoverStaleJobs(): Promise<void> {
  try {
    const now = Date.now()
    const hbCutoff = new Date(now - HEARTBEAT_STALE_MS)
    const legacyCutoff = new Date(now - LEGACY_STALE_MS)
    const staleWhere = {
      status: 'active' as const,
      OR: [
        { heartbeatAt: { lt: hbCutoff } },
        { AND: [{ heartbeatAt: null }, { startedAt: { lt: legacyCutoff } }] },
      ],
    }
    const candidates = await db.pipelineJob.findMany({ where: staleWhere, select: { id: true } })
    if (candidates.length === 0) return

    // 先通知活跃协程在下一个检查点安静退出（尽力而为；终态写均有 CAS 兜底）
    let abortedAny = false
    for (const c of candidates) {
      const ctrl = shared().controllers.get(c.id)
      if (ctrl) {
        ctrl.abort()
        abortedAny = true
      }
    }
    if (abortedAny) await new Promise((r) => setTimeout(r, 100))

    const res = await db.pipelineJob.updateMany({
      where: { ...staleWhere, id: { in: candidates.map((c) => c.id) } },
      data: { status: 'pending' },
    })
    if (res.count > 0) {
      console.warn(`[pipeline] 心跳过期，恢复 ${res.count} 个僵死任务为 pending`)
    }
  } catch (e) {
    console.warn('[pipeline] 恢复僵死任务失败:', (e as Error).message)
  }
}

/** 活跃任务心跳续租（claim 时与运行中间隔写入） */
async function touchHeartbeat(jobId: string): Promise<void> {
  try {
    await db.pipelineJob.updateMany({ where: { id: jobId }, data: { heartbeatAt: new Date() } })
  } catch {
    /* 任务行可能已被级联删除（删库/删文档）——静默 */
  }
}

async function tick(eng: PipelineEngineState): Promise<void> {
  if (eng.busy) return
  eng.busy = true
  eng.tickCount++
  try {
    // 僵死回收频率与 tick 解耦（每 10 tick ≈ 12s 一次；CAS 保证幂等）
    if (eng.tickCount % RECOVER_EVERY_TICKS === 0) {
      await recoverStaleJobs()
      sweepProgressThrottle()
    }
    while (shared().active < CONCURRENCY) {
      const candidates = await db.pipelineJob.findMany({
        // F-CONC-01：延迟重试——仅认领 notBefore 已到期的 pending 任务
        where: {
          status: 'pending',
          OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 5,
      })
      if (candidates.length === 0) break
      let claimedAny = false
      for (const cand of candidates) {
        if (shared().active >= CONCURRENCY) break
        // CAS 认领：仅当仍为 pending 时抢占（防并发双取）；claim 即写首次心跳
        const claimed = await db.pipelineJob.updateMany({
          where: { id: cand.id, status: 'pending' },
          data: {
            status: 'active',
            startedAt: new Date(),
            attempts: { increment: 1 },
            heartbeatAt: new Date(),
          },
        })
        if (claimed.count > 0) {
          claimedAny = true
          const sh = shared()
          sh.active++
          const jobId = cand.id
          void runJob(jobId)
            .catch((e) => console.error('[pipeline] runJob 异常:', e))
            .finally(() => {
              // 跨模块代际的共享计数（旧协程 finally 也减同一槽位 → 接管后不超发）
              sh.active--
            })
        }
      }
      if (!claimedAny) break
    }
  } catch (e) {
    console.error('[pipeline] tick 异常:', e)
  } finally {
    eng.busy = false
  }
}

// ---------------------------------------------------------------------------
// MinerU 轮询器（审计#P1-1：等待移出并发槽）
// ---------------------------------------------------------------------------

/** 16-b：running 态进度上报节流表（jobId → 最近标签/时间；仅标签变化或 30s 才上报） */
const mineruRunningReport = new Map<string, { label: string; at: number }>()

/** 轮询器单轮：收集 waiting_mineru 任务并发查远端状态（不占文档槽） */
async function mineruPollTick(eng: PipelineEngineState): Promise<void> {
  if (eng.mineruBusy) return
  eng.mineruBusy = true
  try {
    const jobs = await db.pipelineJob.findMany({
      where: { status: 'waiting_mineru' },
      orderBy: { createdAt: 'asc' },
      take: MINERU_POLL_BATCH,
    })
    if (jobs.length === 0) return
    const settings = await getRagSettings()
    await Promise.all(jobs.map((job) => pollOneMineruJob(job, settings)))
  } catch (e) {
    console.warn('[pipeline][mineru] 轮询周期异常:', (e as Error).message)
  } finally {
    eng.mineruBusy = false
  }
}

/** 单个 waiting_mineru 任务的状态探测与推进 */
async function pollOneMineruJob(
  job: JobRow,
  settings: Awaited<ReturnType<typeof getRagSettings>>
): Promise<void> {
  try {
    const doc = await db.document.findUnique({ where: { id: job.documentId } })
    if (!doc) return // 文档/库已删（级联会清理本行）

    // 16-b：句柄解析统一走 parsePersistedHandle（单任务 / PDF 多段复合句柄 JSON）
    const handle = parsePersistedHandle(doc)
    if (!handle) {
      // 断点字段被清（重解析重置）→ 回 pending 从头跑 parse
      await db.pipelineJob.updateMany({
        where: { id: job.id, status: 'waiting_mineru' },
        data: { status: 'pending', payloadJson: '{}' },
      })
      return
    }

    // 远端任务等待上限（防永久挂起；重试时 probe gone → 重新提交）
    if (job.startedAt && Date.now() - job.startedAt.getTime() > MINERU_WAIT_CAP_MS) {
      await handleJobFailure(
        job,
        new StoreError('MinerU 远端任务等待超时（6 小时）——请检查 MinerU 服务状态', { retryable: true }),
        job.startedAt.getTime()
      )
      return
    }

    const probe = await probeMineruJob(handle, settings)
    // 连续探测失败计数（存 payloadJson.probeFails；成功即清零）。
    // 瞬时错误（网络/5xx/限频）→ 下轮再查不计失败；但连续 ~10 分钟（120 轮 × 5s）
    // 仍不可达时转可重试失败，避免对死掉的端点无限打点（旧实现会以 5s 频率刷 6 小时日志）。
    let probeFails = Number(safeParseJson(job.payloadJson).probeFails) || 0
    if (probe.state === 'running') {
      probeFails = 0
      // 16-b：实时进度——远端状态标签（排队中/解析中/转换中/k 段完成）变化或每 30s
      // 刷新一次文档进度与活动流，用户可实时看到 MinerU 解析到哪了
      const label = probe.label ?? '远端解析中'
      const waitedMin = job.startedAt ? Math.max(0, Math.floor((Date.now() - job.startedAt.getTime()) / 60_000)) : 0
      const msg = `MinerU 解析中（${label}）${waitedMin > 0 ? ` · 已等待 ${waitedMin} 分钟` : ''}`
      const last = mineruRunningReport.get(job.id)
      const now = Date.now()
      if (!last || last.label !== label || now - last.at > 30_000) {
        mineruRunningReport.set(job.id, { label, at: now })
        await reportProgress(doc, 'parsing', 30, msg)
      }
      // 续租（防御性：waiting 本就不参与 active 僵死回收）
      await db.pipelineJob.updateMany({
        where: { id: job.id, status: 'waiting_mineru' },
        data: { heartbeatAt: new Date(), payloadJson: '{}' },
      })
      return
    }
    mineruRunningReport.delete(job.id)
    if (probe.state === 'error') {
      probeFails += 1
      if (probeFails >= 120) {
        await handleJobFailure(
          job,
          new StoreError(`MinerU 状态探测连续失败约 10 分钟（${probe.error.message.slice(0, 120)}）——请检查 MinerU 服务可用性`, { retryable: true }),
          job.startedAt ? job.startedAt.getTime() : Date.now()
        )
        return
      }
      // 每分钟至多记一条日志（12 轮 × 5s）
      if (probeFails % 12 === 1) {
        console.warn(`[pipeline][mineru] ${doc.filename} 探测瞬时失败（连续第 ${probeFails} 轮）: ${probe.error.message.slice(0, 160)}`)
      }
      await db.pipelineJob.updateMany({
        where: { id: job.id, status: 'waiting_mineru' },
        data: { heartbeatAt: new Date(), payloadJson: JSON.stringify({ probeFails }) },
      })
      return
    }
    if (probe.state === 'gone') {
      // 远端任务不存在 → 回 pending（execParse 重入时清字段重新提交；审计 A3）
      await db.pipelineJob.updateMany({
        where: { id: job.id, status: 'waiting_mineru' },
        data: { status: 'pending', payloadJson: '{}' },
      })
      return
    }
    if (probe.state === 'failed') {
      await handleJobFailure(
        job,
        probe.error,
        job.startedAt ? job.startedAt.getTime() : Date.now()
      )
      return
    }

    // done → 下载 + 归一化产物（复用同步链路后半段逻辑）→ 回 pending 带阶段游标
    try {
      const art = await finishMineruArtifact(handle, probe, { kbId: doc.kbId, docId: doc.id }, settings)
      await reportProgress(doc, 'parsing', 92, 'MinerU 解析完成，产物已落盘', true)
      // 16-b：句柄序列化（单任务 = 裸 jobId；复合句柄 = JSON）
      const ser = serializeHandle(handle)
      const payload = JSON.stringify({
        stage: 'chunk',
        mineru: {
          jobId: ser.jobId,
          fileId: ser.fileId,
          uploadId: ser.uploadId,
          pages: art.pages,
          blockCount: art.blockCount,
        },
      })
      const flipped = await db.pipelineJob.updateMany({
        where: { id: job.id, status: 'waiting_mineru' },
        // attempts 减扣：waiting→pending 的重入会再次被 tick 认领（attempts+1），
        // 若不减扣则一次正常 MinerU 流转就烧掉 2/3 预算，尾部只剩 1 次容错
        data: { status: 'pending', payloadJson: payload, heartbeatAt: new Date(), attempts: { decrement: 1 } },
      })
      if (flipped.count === 0) return // 已被取消/回收
      void pipelineActivity({
        at: Date.now(),
        level: 'info',
        message: `MinerU 解析完成：${doc.filename}（${art.pages} 页 / ${art.blockCount} 块），重新排队继续流水线`,
      })
    } catch (e) {
      // 下载失败 → 常规失败路径（可重试回 pending 无游标 → 重入 execParse 再探测）
      await handleJobFailure(
        job,
        e,
        job.startedAt ? job.startedAt.getTime() : Date.now()
      )
    }
  } catch (e) {
    console.warn('[pipeline][mineru] 单任务轮询异常:', (e as Error).message)
  }
}

// ---------------------------------------------------------------------------
// 任务执行
// ---------------------------------------------------------------------------

/** 长循环内的存活检查点（同步、零 IO；signal 由取消/回收方触发） */
interface JobRunCtx {
  controller: AbortController
  /** 同步检查 signal（批循环内高频调用） */
  checkAlive(): void
}

function makeRunCtx(controller: AbortController): JobRunCtx {
  return {
    controller,
    checkAlive() {
      if (controller.signal.aborted) throw new JobCancelledSignal()
    },
  }
}

/**
 * 阶段边界检查：signal 未中止且 DB 中任务仍为本协程所有
 * （status='active' 且 attempts 未被新一轮认领递增 → 未被取消/回收）。
 */
async function assertJobActive(job: JobRow, ctx: JobRunCtx): Promise<void> {
  if (ctx.controller.signal.aborted) throw new JobCancelledSignal()
  const row = await db.pipelineJob.findUnique({ where: { id: job.id }, select: { status: true, attempts: true } })
  if (!row || row.status === 'cancelled') throw new JobCancelledSignal()
  if (row.status !== 'active' || row.attempts !== job.attempts) {
    // 已被僵死回收并重新认领（attempts 已递增）→ 让位，安静退出
    throw new JobCancelledSignal('job-reclaimed')
  }
}

async function runJob(jobId: string): Promise<void> {
  const job = await db.pipelineJob.findUnique({ where: { id: jobId } })
  if (!job) return
  if (job.status !== 'active') return // 已被取消（认领后、启动前窗口）
  ensurePipelineEngine()
  const sh = shared()
  const controller = new AbortController()
  sh.controllers.set(jobId, controller)
  const ctx = makeRunCtx(controller)
  const startedAt = Date.now()
  // 心跳续租：覆盖单个长 await（大文件上传/慢嵌入）期间无法到检查点的场景
  const heartbeatTimer = setInterval(() => {
    void touchHeartbeat(jobId)
  }, HEARTBEAT_INTERVAL_MS)
  try {
    const doc = await db.document.findUnique({ where: { id: job.documentId } })
    if (!doc) {
      throw new StoreError('文档记录不存在（可能已被删除）', { retryable: false })
    }
    const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
    if (!kb) {
      throw new StoreError('知识库不存在', { retryable: false })
    }
    await assertJobActive(job, ctx)
    if (job.type === 'parse') await execParse(job, doc, ctx)
    else if (job.type === 'chunk') await execChunk(job, doc, kb, ctx)
    else if (job.type === 'embed') await execEmbed(job, doc, kb, ctx)
    else throw new StoreError(`未知任务类型: ${job.type}`, { retryable: false })
    await assertJobActive(job, ctx)

    const durationMs = Date.now() - startedAt
    // CAS 终态写：仅当仍为本协程所有（active + attempts 未变）时落 completed；
    // 被取消/回收 → 安静退出（审计#N13：取消不算失败）
    const done = await db.pipelineJob.updateMany({
      where: { id: job.id, status: 'active', attempts: job.attempts },
      data: { status: 'completed', finishedAt: new Date(), durationMs, error: null },
    })
    if (done.count === 0) return
    await jobUpdate({
      jobId: job.id,
      documentId: job.documentId,
      type: job.type,
      status: 'completed',
      durationMs,
    })
  } catch (e) {
    if (e instanceof DeferMineruWait) return // 已置 waiting_mineru，轮询器接管
    if (e instanceof JobCancelledSignal) return // 安静退出：不写 failed、不发失败事件、不算失败
    await handleJobFailure(job, e, startedAt)
  } finally {
    clearInterval(heartbeatTimer)
    if (sh.controllers.get(jobId) === controller) sh.controllers.delete(jobId)
  }
}

function errorCodeOf(e: unknown): string {
  if (e instanceof StoreError && e.name !== 'StoreError' && e.name !== 'Error') return e.name
  return 'PIPELINE_ERROR'
}

async function handleJobFailure(job: JobRow, e: unknown, startedAt: number): Promise<void> {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 500)
  const code = errorCodeOf(e)
  const canRetry = !isNonRetryable(e) && job.attempts < job.maxAttempts
  const durationMs = Date.now() - startedAt

  // CAS 失败写：仅当任务仍为在途且属本协程（active/waiting_mineru + attempts 未变）；
  // 已被取消（cancelled）或回收 → 安静返回，不写失败状态、不落文档失败、不发事件（审计#N13）
  const own = { id: job.id, status: { in: [...IN_FLIGHT_STATUSES] }, attempts: job.attempts }
  const res = canRetry
    ? // F-CONC-01：可重试失败不立即回队——按 attempts 指数退避（2s/8s/30s+jitter）写 notBefore，
      // tick 到期才重新认领；短暂抖动（Qdrant 重启/DNS 抖动）不再在 ~4s 内烧完全部重试预算
      await db.pipelineJob.updateMany({
          where: own,
          data: {
            status: 'pending',
            error: message,
            notBefore: new Date(Date.now() + retryBackoffMs(job.attempts)),
          },
        })
    : await db.pipelineJob.updateMany({
        where: own,
        data: { status: 'failed', finishedAt: new Date(), durationMs, error: message },
      })
  if (res.count === 0) return

  if (canRetry) {
    await jobUpdate({
      jobId: job.id,
      documentId: job.documentId,
      type: job.type,
      status: 'retrying',
      error: `${message}（${Math.round(retryBackoffMs(job.attempts) / 1000)}s 后自动重试）`,
    })
    return
  }

  try {
    const doc = await db.document.findUnique({ where: { id: job.documentId } })
    if (doc) {
      const meta = safeParseJson(doc.metaJson)
      await serializeDocWrite(doc.id, async () => {
        await db.document.update({
          where: { id: doc.id },
          data: {
            status: 'failed',
            errorCode: code,
            errorMessage: message,
            metaJson: JSON.stringify({ ...meta, failedStage: job.type }),
          },
        })
        await documentStatus({
          docId: doc.id,
          kbId: doc.kbId,
          status: 'failed',
          stageProgress: doc.stageProgress,
          errorCode: code,
          errorMessage: message.slice(0, 300),
        })
      })
    }
  } catch (err) {
    console.error('[pipeline] 失败状态回写异常:', err)
  }
  // Task 17-5：永久失败落程序日志（重试中的失败在活动流可见，此处只记终态）
  recordOp({
    level: 'error',
    category: 'pipeline',
    action: 'pipeline.job_failed',
    message: `流水线任务永久失败（${job.type}，attempts ${job.attempts}/${job.maxAttempts}）：${message}`,
    detail: { jobId: job.id, type: job.type, code, durationMs },
    statusCode: 500,
    docId: job.documentId,
  })
  await jobUpdate({
    jobId: job.id,
    documentId: job.documentId,
    type: job.type,
    status: 'failed',
    error: message,
    durationMs,
  })
  await pipelineActivity({
    at: Date.now(),
    level: 'error',
    message: `任务失败 ${job.type} · ${message.slice(0, 150)}`,
  })
}

// ---------------------------------------------------------------------------
// 公共辅助
// ---------------------------------------------------------------------------

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}')
    return typeof v === 'object' && v !== null ? v : {}
  } catch {
    return {}
  }
}

/**
 * 同一文档的 DB 写入与事件串行化：按提交顺序链式执行。
 * 背景：SQLite 连接池下并发 update 可能乱序提交，节流进度写（如 95）晚于终态写
 * （ready+100）落库时会覆盖 stageProgress —— 链式化后保证终态永远最后生效。
 */
const docWriteChains = new Map<string, Promise<void>>()
function serializeDocWrite<T>(docId: string, task: () => Promise<T>): Promise<T> {
  const prev = docWriteChains.get(docId) ?? Promise.resolve()
  // 前序失败也继续执行本任务（链不因单次失败卡死）
  const run = prev.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  docWriteChains.set(docId, tail)
  void tail.then(() => {
    // 链尾静默后清理（若期间有新写入则保留新链尾）
    if (docWriteChains.get(docId) === tail) docWriteChains.delete(docId)
  })
  return run
}

/** 状态回写 + document:status 事件 */
async function setDocStatus(
  doc: DocRow,
  status: DocumentStatus,
  stageProgress: number,
  extra: { errorCode?: string | null; errorMessage?: string | null } = {}
): Promise<void> {
  await serializeDocWrite(doc.id, async () => {
    await db.document.update({
      where: { id: doc.id },
      data: { status, stageProgress, ...extra },
    })
    await documentStatus({
      docId: doc.id,
      kbId: doc.kbId,
      status,
      stageProgress,
      errorCode: extra.errorCode ?? null,
      errorMessage: extra.errorMessage ?? null,
    })
  })
}

/** 阶段内部进度（400ms 节流写库 + 事件）；条目由 sweepProgressThrottle 惰性清扫（审计#N16） */
const progressThrottle = new Map<string, { at: number; value: number }>()
async function reportProgress(
  doc: DocRow,
  stage: string,
  progress: number,
  message?: string,
  force = false
): Promise<void> {
  const now = Date.now()
  const last = progressThrottle.get(doc.id)
  if (!force && last && now - last.at < 400 && Math.abs(progress - last.value) < 5) return
  progressThrottle.set(doc.id, { at: now, value: progress })
  await serializeDocWrite(doc.id, async () => {
    try {
      await db.document.update({
        where: { id: doc.id },
        data: { stageProgress: Math.max(0, Math.min(100, Math.round(progress))) },
      })
    } catch {}
    await documentProgress({
      docId: doc.id,
      kbId: doc.kbId,
      stage,
      progress: Math.max(0, Math.min(100, Math.round(progress))),
      message,
    })
  })
}

/** progressThrottle TTL 清扫（引擎 tick 每 10 轮惰性调用；审计#N16：防 Map 单调增长） */
function sweepProgressThrottle(): void {
  const cutoff = Date.now() - PROGRESS_TTL_MS
  for (const [docId, v] of progressThrottle) {
    if (v.at < cutoff) progressThrottle.delete(docId)
  }
}

/** 重算 KB 统计 + kb:stats 事件 */
export async function updateKbStats(kbId: string): Promise<void> {
  try {
    const kb = await db.knowledgeBase.findUnique({ where: { id: kbId } })
    if (!kb) return
    const [docCount, chunkCount] = await Promise.all([
      db.document.count({ where: { kbId } }),
      db.chunk.count({ where: { kbId, isParent: false } }),
    ])
    let pointCount = 0
    try {
      const store = await getVectorStore()
      pointCount = await store.count(kb.collection)
    } catch {
      pointCount = 0
    }
    await db.knowledgeBase.update({
      where: { id: kbId },
      data: { docCount, chunkCount, pointCount },
    })
    await kbStats({ kbId, docCount, chunkCount, pointCount })
  } catch (e) {
    console.warn('[pipeline] 更新 KB 统计失败:', (e as Error).message)
  }
}

// ---------------------------------------------------------------------------
// 小工具：有限并发（审计#P1-2：批内并行；检查+占座同一同步段，无竞态）
// ---------------------------------------------------------------------------

function runLimited<T>(concurrency: number, tasks: Array<() => Promise<T>>): Promise<T[]> {
  let active = 0
  const queue: Array<() => void> = []
  return Promise.all(
    tasks.map(
      (task) =>
        new Promise<T>((resolve, reject) => {
          const start = () => {
            task().then(resolve, reject).finally(() => {
              active--
              const next = queue.shift()
              if (next) next()
            })
          }
          if (active < concurrency) {
            active++
            start()
          } else {
            queue.push(() => {
              active++
              start()
            })
          }
        })
    )
  )
}

// ---------------------------------------------------------------------------
// 执行器 · parse
// ---------------------------------------------------------------------------

/** parse 尾部（doc 字段回写 + 入队 chunk）：Node 引擎完成时 / MinerU 游标重入时共用 */
async function finishParseTail(
  doc: DocRow,
  r: {
    engine: string
    pages: number
    blockCount: number
    mineruJobId?: string | null
    mineruUploadId?: string | null
    mineruFileId?: string | null
  },
  parseMs: number
): Promise<void> {
  const meta = safeParseJson(doc.metaJson)
  await serializeDocWrite(doc.id, async () => {
    await db.document.update({
      where: { id: doc.id },
      data: {
        parseEngine: r.engine,
        layoutBlocks: r.blockCount,
        stageProgress: 100,
        mineruJobId: r.mineruJobId ?? null,
        mineruUploadId: r.mineruUploadId ?? null,
        mineruFileId: r.mineruFileId ?? null,
        metaJson: JSON.stringify({
          ...meta,
          pages: r.pages,
          blockCount: r.blockCount,
          parseEngine: r.engine,
          parseMs,
        }),
      },
    })
  })
  await reportProgress(doc, 'parsing', 100, '解析完成', true)
}

async function execParse(job: JobRow, doc: DocRow, ctx: JobRunCtx): Promise<void> {
  // 阶段游标（审计 A5：向后兼容——存量 job payloadJson='{}' 无游标 → 从头跑 parse）
  const payload = safeParseJson(job.payloadJson)
  if (payload.stage === 'chunk') {
    // MinerU 产物已由轮询器下载落盘 → 直接跑尾部（doc 字段回写 + 入队 chunk）
    const m = (payload.mineru ?? {}) as {
      jobId?: string
      fileId?: string | null
      uploadId?: string | null
      pages?: number
      blockCount?: number
    }
    await setDocStatus(doc, 'parsing', 90, { errorCode: null, errorMessage: null })
    const parseMs = job.startedAt ? Date.now() - job.startedAt.getTime() : 0
    await finishParseTail(
      doc,
      {
        engine: 'mineru',
        pages: Number(m.pages) || 0,
        blockCount: Number(m.blockCount) || 0,
        mineruJobId: m.jobId ?? doc.mineruJobId ?? null,
        mineruUploadId: m.uploadId ?? doc.mineruUploadId ?? null,
        mineruFileId: m.fileId ?? doc.mineruFileId ?? null,
      },
      parseMs
    )
    ctx.checkAlive()
    await assertJobActive(job, ctx) // 取消后不再入队 chunk（审计#N13/N14）
    await db.pipelineJob.create({
      data: {
        documentId: doc.id,
        kbId: doc.kbId,
        type: 'chunk',
        status: 'pending',
        maxAttempts: MAX_ATTEMPTS,
        payloadJson: '{}',
      },
    })
    return
  }

  await setDocStatus(doc, 'parsing', 5, { errorCode: null, errorMessage: null })
  const settings = await getRagSettings()
  const ext = path.extname(doc.filename).toLowerCase().replace('.', '') || 'bin'
  const localPath = sourcePath(doc.kbId, doc.id, ext)
  const started = Date.now()

  // per-doc 引擎选择（Task 14-e）：上传/URL 导入时写入 metaJson.engineChoice，优先级高于全局 parseMode
  const metaBefore = safeParseJson(doc.metaJson)
  const engineChoice = metaBefore.engineChoice
  const choice: 'mineru' | 'node' | undefined =
    engineChoice === 'mineru' || engineChoice === 'node' ? engineChoice : undefined

  // 16-c：全局模式按扩展名智能路由（仅 Node 类型走本地解析，省 MinerU 额度）
  const engineKind = resolveDocEngine(settings, choice, ext)

  if (engineKind === 'node') {
    // ---- Node 引擎：原同步链路（含全部内置解析器与进度） ----
    const result = await parseDocument({
      docId: doc.id,
      kbId: doc.kbId,
      filename: doc.filename,
      localPath,
      mimeType: doc.mimeType,
      settings,
      engine: 'node',
      onProgress: (e) => {
        void reportProgress(doc, 'parsing', Math.max(5, Math.min(99, e.progress)), e.message)
      },
    })
    ctx.checkAlive()
    await finishParseTail(doc, result, Date.now() - started)
    await assertJobActive(job, ctx)
    await db.pipelineJob.create({
      data: {
        documentId: doc.id,
        kbId: doc.kbId,
        type: 'chunk',
        status: 'pending',
        maxAttempts: MAX_ATTEMPTS,
        payloadJson: '{}',
      },
    })
    return
  }

  // ---- MinerU 引擎：分阶段（审计#P1-1：等待移出并发槽；P1-3：断点续传；16-b：PDF 多段复合句柄） ----
  const existing = parsePersistedHandle(doc)

  let handle: MinerUHandle
  if (existing && existing.kind === 'parts') {
    // 16-b 复合句柄断点续传：逐段探测聚合（不重新上传已提交段）
    const probe = await probeMineruJob(existing, settings)
    if (probe.state === 'running' || probe.state === 'done') {
      handle = existing // 交给轮询器接管
    } else if (probe.state === 'gone') {
      // 仅失效段重新提交（goneParts / 缺 jobId 的段）
      const resume: MinerUPartsHandle = {
        ...existing,
        parts: existing.parts.map((p, i) =>
          probe.goneParts?.includes(i) || !p.jobId
            ? { ...p, jobId: undefined, uploadId: undefined, fileId: undefined }
            : { ...p }
        ),
      }
      await reportProgress(doc, 'parsing', 10, '部分段远端任务已失效，重新上传这些段', true)
      handle = await submitMineruJob({
        docId: doc.id,
        kbId: doc.kbId,
        filename: doc.filename,
        localPath,
        settings,
        resume,
        onProgress: (e) => {
          void reportProgress(doc, 'parsing', Math.max(5, Math.min(30, e.progress)), e.message)
        },
      })
    } else {
      // failed（远端终态失败/不可重试业务错误）→ 常规失败路径
      throw probe.error
    }
  } else if (existing) {
    // 断点续传：不重新上传，先探一次旧任务状态
    const probe = await probeMineruJob(existing, settings)
    if (probe.state === 'running' || probe.state === 'done') {
      handle = existing // 交给轮询器接管
    } else if (probe.state === 'gone') {
      // 远端任务不存在 → 清断点字段重新提交
      await serializeDocWrite(doc.id, () =>
        db.document.update({
          where: { id: doc.id },
          data: { mineruJobId: null, mineruUploadId: null, mineruFileId: null },
        })
      )
      await reportProgress(doc, 'parsing', 10, '远端任务已失效，重新上传解析', true)
      handle = await submitMineruJob({
        docId: doc.id,
        kbId: doc.kbId,
        filename: doc.filename,
        localPath,
        settings,
        onProgress: (e) => {
          void reportProgress(doc, 'parsing', Math.max(5, Math.min(30, e.progress)), e.message)
        },
      })
    } else {
      // failed（远端终态失败/不可重试业务错误）→ 常规失败路径
      throw probe.error
    }
  } else {
    handle = await submitMineruJob({
      docId: doc.id,
      kbId: doc.kbId,
      filename: doc.filename,
      localPath,
      settings,
      onProgress: (e) => {
        void reportProgress(doc, 'parsing', Math.max(5, Math.min(30, e.progress)), e.message)
      },
    })
  }

  // 上传/提交返回后先响应取消（审计#N13：避免给已取消任务写入断点字段）
  ctx.checkAlive()

  // 持久化断点字段（16-b：复合句柄存 JSON；先落字段再置状态：轮询器不会见到缺句柄的 waiting 任务）
  const ser = serializeHandle(handle)
  await serializeDocWrite(doc.id, () =>
    db.document.update({
      where: { id: doc.id },
      data: {
        mineruJobId: ser.jobId,
        mineruUploadId: ser.uploadId,
        mineruFileId: ser.fileId,
      },
    })
  )
  // 任务转入 waiting_mineru（CAS：仅 active → waiting_mineru；不占并发槽）
  const flipped = await db.pipelineJob.updateMany({
    where: { id: job.id, status: 'active', attempts: job.attempts },
    data: { status: 'waiting_mineru', heartbeatAt: new Date() },
  })
  if (flipped.count === 0) throw new JobCancelledSignal()
  await reportProgress(doc, 'parsing', 30, '已提交 MinerU，等待远端解析（不占流水线并发槽）', true)
  // 哨兵：runJob 静默返回并释放槽位，轮询器接管
  throw new DeferMineruWait()
}

// ---------------------------------------------------------------------------
// 执行器 · chunk
// ---------------------------------------------------------------------------

async function execChunk(job: JobRow, doc: DocRow, kb: KbRow, ctx: JobRunCtx): Promise<void> {
  await setDocStatus(doc, 'chunking', 5)

  const md = await fs.readFile(markdownPath(doc.kbId, doc.id), 'utf-8')
  const middle = JSON.parse(
    await fs.readFile(middleJsonPath(doc.kbId, doc.id), 'utf-8')
  ) as MiddleJson
  const config: ChunkConfig = {
    ...DEFAULT_CHUNK_CONFIG,
    ...safeParseJson(doc.chunkConfigSnap || kb.chunkConfig || '{}'),
  }
  const layout = Array.isArray(middle?.blocks) ? middle.blocks : []

  await reportProgress(doc, 'chunking', 20, '执行 Markdown 感知切分')
  const result = splitMarkdown(md, config, layout)

  // 清旧 chunks + 向量（重切场景幂等；确定性 ID 本可覆盖，但删除更干净）
  await db.chunk.deleteMany({ where: { documentId: doc.id } })
  const store = await getVectorStore()
  await store.ensureCollection(kb.collection, kb.dim || 1024)
  try {
    await store.deleteByFilter(kb.collection, {
      must: [{ key: 'doc_id', match: { value: doc.id } }],
    })
  } catch (e) {
    console.warn('[pipeline] 清理旧向量跳过（可能无旧数据）:', (e as Error).message)
  }
  // 清旧 chunk 文件
  await fs.rm(chunksDir(doc.kbId, doc.id), { recursive: true, force: true })
  await fs.mkdir(chunksDir(doc.kbId, doc.id), { recursive: true })

  await reportProgress(doc, 'chunking', 50, `切分完成：${result.stats.parentCount} 父 / ${result.stats.total} 子`)

  // 父 chunk 行 + 文件
  const parentTextBySeq = new Map(result.parents.map((p) => [p.seq, p.text]))
  const rows: Parameters<typeof db.chunk.create>[0]['data'][] = []
  let iter = 0
  for (const p of result.parents) {
    if (++iter % 100 === 0) ctx.checkAlive() // 取消检查点（审计#N13）
    const id = deterministicChunkId(doc.kbId, doc.id, p.seq, textHash16(p.text))
    await fs.writeFile(path.join(chunksDir(doc.kbId, doc.id), `${id}.txt`), p.text, 'utf-8')
    rows.push({
      id,
      documentId: doc.id,
      kbId: doc.kbId,
      isParent: true,
      parentId: null,
      seq: p.seq,
      docType: 'text',
      tokenCount: p.tokenCount,
      charStart: p.charStart,
      charEnd: p.charEnd,
      pageFrom: 0,
      pageTo: 0,
      bboxFrom: '[]',
      bboxTo: '[]',
      textPreview: p.text.slice(0, 500),
      storageKey: `${doc.kbId}/${doc.id}/chunks/${id}.txt`,
      enabled: true,
    })
  }
  // 子 chunk 行 + 文件
  for (const c of result.children) {
    if (++iter % 100 === 0) ctx.checkAlive()
    const id = deterministicChunkId(doc.kbId, doc.id, c.seq, textHash16(c.text))
    await fs.writeFile(path.join(chunksDir(doc.kbId, doc.id), `${id}.txt`), c.text, 'utf-8')
    const parentText = parentTextBySeq.get(c.parentSeq) ?? ''
    rows.push({
      id,
      documentId: doc.id,
      kbId: doc.kbId,
      isParent: false,
      parentId: c.parentSeq >= 0 && parentText
        ? deterministicChunkId(doc.kbId, doc.id, c.parentSeq, textHash16(parentText))
        : null,
      seq: c.seq,
      docType: c.docType,
      tokenCount: c.tokenCount,
      charStart: c.charStart,
      charEnd: c.charEnd,
      pageFrom: c.pageFrom,
      pageTo: c.pageTo,
      bboxFrom: JSON.stringify(c.bboxFrom ?? []),
      bboxTo: JSON.stringify(c.bboxTo ?? []),
      textPreview: c.text.slice(0, 500),
      storageKey: `${doc.kbId}/${doc.id}/chunks/${id}.txt`,
      enabled: true,
    })
  }
  // 批量入库（事务分批）
  const TX = 100
  for (let i = 0; i < rows.length; i += TX) {
    ctx.checkAlive()
    await db.$transaction(rows.slice(i, i + TX).map((r) => db.chunk.create({ data: r })))
  }

  const meta = safeParseJson(doc.metaJson)
  await serializeDocWrite(doc.id, async () => {
    await db.document.update({
      where: { id: doc.id },
      data: {
        layoutBlocks: layout.length,
        stageProgress: 100,
        metaJson: JSON.stringify({
          ...meta,
          parentCount: result.stats.parentCount,
          childCount: result.stats.total,
          chunkStats: result.stats,
        }),
      },
    })
  })
  await reportProgress(doc, 'chunking', 100, '切分落盘完成', true)
  await updateKbStats(doc.kbId)

  // 衔接：chunk 完成 → 入队 embed（embed 内含 upsert 阶段）
  await assertJobActive(job, ctx) // 取消后不再入队 embed（审计#N13/N14）
  await db.pipelineJob.create({
    data: {
      documentId: doc.id,
      kbId: doc.kbId,
      type: 'embed',
      status: 'pending',
      maxAttempts: MAX_ATTEMPTS,
      payloadJson: '{}',
    },
  })
}

// ---------------------------------------------------------------------------
// 全局嵌入闸门（审计#P1-2 第二杠杆：并行 + qpm 自适应节流）
// ---------------------------------------------------------------------------

/**
 * 实测本环境嵌入 API 为共享 qpm 限流（约 10 请求/分钟；单条与 64 条/批均计 1 次）。
 * 此前「2 文档 × 4 组并发 = 8 路」的批请求会瞬间打爆配额 → 429 风暴 →
 * embed.ts 批内 3 次重试（3/8/15s）骑不过 60s 滑动窗口 → 整文档 failed。
 *
 * 改为进程级全局闸门（globalThis 单例，跨文档/跨 job 共享）：
 * - 组大小 = 64（与 embed.ts 内部批次一致 → 每次 embedTexts 调用恰好 1 个 HTTP 请求，
 *   闸门在请求粒度上节流；embed.ts 既有批内 429 退避原样保留）
 * - 同时在飞的 embedTexts ≤ 2；相邻放行保持自适应最小间隔（AIMD：
 *   成功 -500ms 衰减到 0；组级可重试失败 ×2+1s 封顶 30s），
 *   在未知配额的 API 前自收敛到略低于配额的请求速率
 * - 组级可重试重试（等待 20s/45s 骑过限流窗口，等待期让出槽位并响应取消），
 *   重试耗尽才走 job 失败路径（attempts 语义不变）
 */

interface EmbedGateWaiter {
  wake: () => void
  /** 取消：出队 + reject JobCancelledSignal（删库/重复入队时不再白烧配额） */
  drop: () => void
}

interface EmbedGateState {
  inFlight: number
  /** 相邻放行最小间隔（AIMD 自适应；0 = 仅受在飞上限约束） */
  minIntervalMs: number
  lastAdmitAt: number
  queue: EmbedGateWaiter[]
}

const embedGateG = globalThis as unknown as { __ragEmbedGate?: EmbedGateState }
const EMBED_GATE_MAX_IN_FLIGHT = 2
const EMBED_GATE_INTERVAL_FLOOR_MS = 0
const EMBED_GATE_INTERVAL_CAP_MS = 30_000
/** 起始间隔按实测 qpm≈10 预置；大配额 API 下每成功一次衰减 500ms，约 13 次后全速 */
const EMBED_GATE_INTERVAL_INIT_MS = 6_500
/** 组大小 = embed.ts 的 EMBED_BATCH（每次调用恰好 1 个请求） */
const EMBED_GROUP_SIZE = 64
/** 组级可重试失败的等待序列（骑过 60s 限流滑动窗口） */
const EMBED_GROUP_RETRY_DELAYS_MS = [20_000, 45_000]

function embedGate(): EmbedGateState {
  if (!embedGateG.__ragEmbedGate) {
    embedGateG.__ragEmbedGate = {
      inFlight: 0,
      minIntervalMs: EMBED_GATE_INTERVAL_INIT_MS,
      lastAdmitAt: 0,
      queue: [],
    }
  }
  return embedGateG.__ragEmbedGate
}

/** 放行泵：在飞 < 上限 且 距上次放行 ≥ minInterval 时唤醒队首；未到点则定时再泵 */
function pumpEmbedGate(): void {
  const g = embedGate()
  if (g.queue.length === 0 || g.inFlight >= EMBED_GATE_MAX_IN_FLIGHT) return
  const waitMs = g.lastAdmitAt + g.minIntervalMs - Date.now()
  if (waitMs > 0) {
    const t = setTimeout(() => pumpEmbedGate(), waitMs + 5)
    // 不阻止进程退出（Node/Bun 定时器兜底）
    ;(t as unknown as { unref?: () => void }).unref?.()
    return
  }
  const w = g.queue.shift()!
  g.inFlight++
  g.lastAdmitAt = Date.now()
  w.wake()
}

function acquireEmbedSlot(ctx: JobRunCtx): Promise<void> {
  const g = embedGate()
  return new Promise<void>((resolve, reject) => {
    // 排队期间响应取消（审计#N13：删库后嵌入组不再占用闸门/白烧配额）
    if (ctx.controller.signal.aborted) {
      reject(new JobCancelledSignal())
      return
    }
    let settled = false
    const cleanup = () => ctx.controller.signal.removeEventListener('abort', onAbort)
    const waiter: EmbedGateWaiter = {
      wake: () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      },
      drop: () => {
        if (settled) return
        settled = true
        cleanup()
        const idx = g.queue.indexOf(waiter)
        if (idx >= 0) g.queue.splice(idx, 1)
        reject(new JobCancelledSignal())
      },
    }
    const onAbort = () => waiter.drop()
    ctx.controller.signal.addEventListener('abort', onAbort)
    g.queue.push(waiter)
    pumpEmbedGate()
  })
}

/** ok=true 成功 → 间隔衰减；ok=false 可重试失败 → 间隔加倍（AIMD） */
function releaseEmbedSlot(ok: boolean): void {
  const g = embedGate()
  g.inFlight = Math.max(0, g.inFlight - 1)
  g.minIntervalMs = ok
    ? Math.max(EMBED_GATE_INTERVAL_FLOOR_MS, g.minIntervalMs - 500)
    : Math.min(EMBED_GATE_INTERVAL_CAP_MS, g.minIntervalMs * 2 + 1_000)
  pumpEmbedGate()
}

/** 单组嵌入：闸门放行 + 组级可重试重试（等待期响应取消） */
async function embedGroupWithGate(
  texts: string[],
  dim: number,
  ctx: JobRunCtx
): Promise<Awaited<ReturnType<typeof embedTexts>>> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= EMBED_GROUP_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      // 限流窗口为 60s 滑动：等待期间不占闸门槽位，且每秒响应取消
      const delay = EMBED_GROUP_RETRY_DELAYS_MS[attempt - 1]
      for (let slept = 0; slept < delay; slept += 1_000) {
        ctx.checkAlive()
        await new Promise((r) => setTimeout(r, Math.min(1_000, delay - slept)))
      }
      ctx.checkAlive()
    }
    await acquireEmbedSlot(ctx)
    ctx.checkAlive() // 放行瞬间再确认（abort 与放行变叉的兜底）
    try {
      const r = await embedTexts(texts, { dim })
      releaseEmbedSlot(true)
      return r
    } catch (e) {
      if (e instanceof JobCancelledSignal) throw e // 取消信号不上重试循环
      const retryable = !isNonRetryable(e)
      releaseEmbedSlot(retryable)
      if (!retryable) throw e // 不可重试（鉴权/参数/维度）直接上抛走失败路径
      lastErr = e
      console.warn(
        `[pipeline][embed] 组级重试 ${attempt}/${EMBED_GROUP_RETRY_DELAYS_MS.length}: ${(e as Error).message.slice(0, 140)}`
      )
    }
  }
  throw lastErr
}

/**
 * 批量嵌入：按 64/组切分经全局闸门并发执行（组间在飞 ≤2 + 自适应间隔），
 * 结果按组序拼回，onProgress 聚合为全局 done/total。
 */
async function embedTextsParallel(
  texts: string[],
  dim: number,
  ctx: JobRunCtx,
  onProgress?: (done: number, total: number) => void
): Promise<Awaited<ReturnType<typeof embedTexts>>> {
  if (texts.length === 0) {
    return embedTexts(texts, { dim })
  }
  const groups: string[][] = []
  for (let i = 0; i < texts.length; i += EMBED_GROUP_SIZE) {
    groups.push(texts.slice(i, i + EMBED_GROUP_SIZE))
  }
  const doneByGroup = new Array<number>(groups.length).fill(0)
  let reported = 0
  const results = await runLimited(
    EMBED_GATE_MAX_IN_FLIGHT,
    groups.map((g, gi) => async () => {
      const r = await embedGroupWithGate(g, dim, ctx)
      if (onProgress) {
        doneByGroup[gi] = g.length
        const done = doneByGroup.reduce((a, b) => a + b, 0)
        if (done > reported) {
          reported = done
          onProgress(done, texts.length)
        }
      }
      return r
    })
  )
  const vectors: number[][] = []
  const sparse: Awaited<ReturnType<typeof embedTexts>>['sparse'] = []
  for (const r of results) {
    vectors.push(...r.vectors)
    sparse.push(...r.sparse)
  }
  return {
    vectors,
    sparse,
    dim: results.find((r) => r.vectors.length > 0)?.dim ?? dim,
    provider: results.find((r) => r.vectors.length > 0)?.provider ?? 'noop',
  }
}

// ---------------------------------------------------------------------------
// 执行器 · embed（含 upsert，阶段状态分开回写，向量不跨 job 传输）
// ---------------------------------------------------------------------------

async function execEmbed(job: JobRow, doc: DocRow, kb: KbRow, ctx: JobRunCtx): Promise<void> {
  void job
  await setDocStatus(doc, 'embedding', 5)

  const children = await db.chunk.findMany({
    where: { documentId: doc.id, isParent: false },
    orderBy: { seq: 'asc' },
  })
  if (children.length === 0) {
    await finalizeReady(doc, 0)
    return
  }

  // 子 chunk 全文（embedding 输入）
  const texts = await Promise.all(
    children.map((c) =>
      fs.readFile(resolveStorageKey(c.storageKey), 'utf-8').catch(() => c.textPreview)
    )
  )
  const dim = kb.dim || 1024
  const emb = await embedTextsParallel(texts, dim, ctx, (done, total) => {
    void reportProgress(doc, 'embedding', 5 + Math.round((55 * done) / total), `嵌入 ${done}/${total}`)
  })
  ctx.checkAlive()

  // v1.6：入库前断言嵌入方案与建库锁定一致（dim / sparseScheme；
  // 不一致 → EMBED_SCHEME_MISMATCH 不可重试失败，防止中途换模型污染向量库）
  try {
    assertEmbedScheme(kb, emb)
  } catch (e) {
    const err = new StoreError(`EMBED_SCHEME_MISMATCH: ${(e as Error).message}`, { retryable: false })
    err.name = 'EMBED_SCHEME_MISMATCH'
    throw err
  }

  await setDocStatus(doc, 'upserting', 65)

  // 父文本（§14.8：≤2000 token 入子 payload，超限只存 parent_id）
  const parentIds = [
    ...new Set(children.map((c) => c.parentId).filter((v): v is string => Boolean(v))),
  ]
  const parentTextMap = new Map<string, string>()
  if (parentIds.length > 0) {
    const parents = await db.chunk.findMany({ where: { id: { in: parentIds } } })
    await Promise.all(
      parents.map(async (p) => {
        try {
          parentTextMap.set(p.id, await fs.readFile(resolveStorageKey(p.storageKey), 'utf-8'))
        } catch {
          parentTextMap.set(p.id, p.textPreview)
        }
      })
    )
  }

  // §6.4 payload 契约
  const points = children.map((c, i) => {
    const parentFull = c.parentId ? parentTextMap.get(c.parentId) : undefined
    const parentText =
      parentFull && countTokens(parentFull) <= 2000 ? parentFull : undefined
    const payload: Record<string, unknown> = {
      kb_id: kb.id,
      doc_id: doc.id,
      parent_id: c.parentId,
      page: c.pageFrom,
      page_from: c.pageFrom,
      page_to: c.pageTo,
      bbox_from: safeParseArray(c.bboxFrom),
      bbox_to: safeParseArray(c.bboxTo),
      seq: c.seq,
      token_count: c.tokenCount,
      text_preview: (texts[i] ?? '').slice(0, 200),
      doc_type: c.docType,
      enabled: c.enabled,
      created_at: Date.now(),
      ...(parentText ? { parent_text: parentText } : {}),
    }
    return { id: c.id, dense: emb.vectors[i], sparse: emb.sparse[i], payload }
  })

  const store = await getVectorStore()
  await store.ensureCollection(kb.collection, dim)
  // 审计#P1-2：256/批 2 路有限并发入库（原先串行 await；进度取单调最大值防回跳）
  const BATCH = 256
  const batches: (typeof points)[] = []
  for (let i = 0; i < points.length; i += BATCH) batches.push(points.slice(i, i + BATCH))
  let doneCount = 0
  let maxCount = 0
  await runLimited(
    UPSERT_CONCURRENCY,
    batches.map((batch) => async () => {
      ctx.checkAlive()
      await store.upsertPoints(kb.collection, batch)
      doneCount += batch.length
      maxCount = Math.max(maxCount, doneCount)
      void reportProgress(
        doc,
        'upserting',
        65 + Math.round((30 * maxCount) / points.length),
        `向量入库 ${maxCount}/${points.length}`
      )
    })
  )

  // 取消检查点：finalizeReady 前确认未被取消（避免把重入队后的 queued 文档改写成 ready）
  ctx.checkAlive()

  await finalizeReady(doc, children.length)
}

function safeParseArray(s: string): number[] {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

async function finalizeReady(doc: DocRow, chunkCount: number): Promise<void> {
  await serializeDocWrite(doc.id, async () => {
    await db.document.update({
      where: { id: doc.id },
      data: { status: 'ready', stageProgress: 100, errorCode: null, errorMessage: null },
    })
  })
  // 本次流水线运行耗时（enqueue 时写入 runStartedAt；缺失时回退文档创建时间）
  const meta = safeParseJson(doc.metaJson)
  const runStartedAt = typeof meta.runStartedAt === 'number' ? meta.runStartedAt : new Date(doc.createdAt).getTime()
  const tookMs = Math.max(0, Date.now() - runStartedAt)
  await documentDone({
    docId: doc.id,
    kbId: doc.kbId,
    status: 'ready',
    chunkCount,
    tookMs,
  })
  await updateKbStats(doc.kbId)
  await pipelineActivity({
    at: Date.now(),
    level: 'info',
    message: `文档就绪：${doc.filename}（${chunkCount} chunks，${tookMs}ms）`,
  })
}

// ---------------------------------------------------------------------------
// 任务取消（审计#N13/N14：删 KB / 删文档 / 重复入队互斥）
// ---------------------------------------------------------------------------

async function cancelJobsWhere(where: { kbId?: string; documentId?: string }): Promise<number> {
  ensurePipelineEngine()
  const targets = await db.pipelineJob.findMany({
    where: { ...where, status: { in: [...IN_FLIGHT_STATUSES] } },
    select: { id: true },
  })
  if (targets.length === 0) return 0
  // 先 abort 活跃协程（在下一个检查点安静退出），再 CAS 落 cancelled
  let abortedAny = false
  for (const t of targets) {
    const ctrl = shared().controllers.get(t.id)
    if (ctrl) {
      ctrl.abort()
      abortedAny = true
    }
  }
  if (abortedAny) await new Promise((r) => setTimeout(r, 50))
  const res = await db.pipelineJob.updateMany({
    where: { id: { in: targets.map((t) => t.id) }, status: { in: [...IN_FLIGHT_STATUSES] } },
    data: { status: 'cancelled', finishedAt: new Date() },
  })
  if (res.count > 0) {
    console.log(`[pipeline] 已取消 ${res.count} 个在途任务（${where.kbId ? 'kb=' + where.kbId : 'doc=' + where.documentId}）`)
  }
  return res.count
}

/** 删除知识库前取消其全部在途任务（先取消再删目录，避免半写状态；审计#N13） */
export async function cancelKbJobs(kbId: string): Promise<number> {
  return cancelJobsWhere({ kbId })
}

/** 删除文档/重复入队前取消其全部在途任务（审计#N13/N14） */
export async function cancelDocumentJobs(docId: string): Promise<number> {
  return cancelJobsWhere({ documentId: docId })
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 文档入队（upload / reparse / rechunk / retry 动作统一入口） */
export async function enqueueDocument(
  docId: string,
  fromStage: 'parse' | 'chunk' | 'embed'
): Promise<void> {
  ensurePipelineEngine()
  const doc = await db.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('文档不存在')
  // 取消该文档全部在途任务（pending/active/waiting_mineru → cancelled + abort；
  // 审计#N14：原先只清 pending，重复点「重解析」会并发写同一批 chunk）
  await cancelDocumentJobs(docId)
  // 记录本次运行起点（document:done 的 tookMs 用）
  const meta = safeParseJson(doc.metaJson)
  await db.document.update({
    where: { id: docId },
    data: { metaJson: JSON.stringify({ ...meta, runStartedAt: Date.now() }) },
  })
  await db.pipelineJob.create({
    data: {
      documentId: docId,
      kbId: doc.kbId,
      type: fromStage,
      status: 'pending',
      maxAttempts: MAX_ATTEMPTS,
      payloadJson: '{}',
    },
  })
}

/** 引擎统计（health/dashboard 用） */
export async function pipelineStats(): Promise<{
  pending: number
  active: number
  waiting: number
  cancelled: number
  failed: number
  completed: number
  uptimeSec: number
  concurrency: number
}> {
  const eng = ensurePipelineEngine()
  const [pending, active, waiting, cancelled, failed, completed] = await Promise.all([
    db.pipelineJob.count({ where: { status: 'pending' } }),
    db.pipelineJob.count({ where: { status: 'active' } }),
    db.pipelineJob.count({ where: { status: 'waiting_mineru' } }),
    db.pipelineJob.count({ where: { status: 'cancelled' } }),
    db.pipelineJob.count({ where: { status: 'failed' } }),
    db.pipelineJob.count({ where: { status: 'completed' } }),
  ])
  return {
    pending,
    active,
    waiting,
    cancelled,
    failed,
    completed,
    uptimeSec: Math.floor((Date.now() - eng.startedAt) / 1000),
    concurrency: CONCURRENCY,
  }
}
