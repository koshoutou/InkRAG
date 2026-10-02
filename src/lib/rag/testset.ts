/**
 * 检索测试集回归（契约 §12 金标准用例 + 命中率/MRR 报告；§16 chunk 级金标准；§18 结果过期）
 *
 * 用例 = 查询 + 期望命中文档集合（金标准）+ 可选 chunk 级金标准 + 参数快照。
 * 运行走与生产同路径的 runSearch（调试即生产，source = debug-console）。
 *
 * 指标：
 *   hitRate = |期望 ∩ TopK 结果文档| / |期望|
 *   MRR     = 1 / 首个期望文档在结果文档序列中的排名（无命中 0）
 *   pass    = misses 为空（文档级）
 *
 * chunk 级金标准（§16 严格模式，expectChunkIds 非空）：
 *   chunkPass = 期望 chunk 全部出现在 Top-K 结果 chunk 集合
 *   chunkMisses = 未命中的期望 chunk ID 列表
 *   pass = chunkPass && 文档级 pass（两者都过才通过）
 *
 * 结果过期（§18 stale）：
 *   lastRun.ranAt 之后 KB 下 chunk 集发生变化（人工编辑写 editedAt / 重切分重建 createdAt）
 *   → 最近一次结果不再可信，需重跑刷新；runTestSet 运行后 ranAt 更新自然复位。
 */
import { db } from '@/lib/db'
import type { KnowledgeBase, RetrievalTestCase } from '@prisma/client'
import { pipelineActivity } from './events'
import { runSearch } from './search'

// ---------------------------------------------------------------------------
// 契约 §12 类型（服务端版本，与前端 src/components/rag/types.ts 对齐）
// ---------------------------------------------------------------------------

export interface TestCaseParams {
  mode?: 'hybrid' | 'dense' | 'sparse'
  topK?: number
  prefetchLimit?: number
  rerank?: boolean
  fusion?: 'rrf' | 'dbsf'
  rrfK?: number
  rrfWeights?: [number, number]
}

export interface TestRunCaseResult {
  caseId: string
  name: string
  query: string
  pass: boolean
  hitRate: number
  mrr: number
  tookMs: number
  hits: string[]
  misses: string[]
  /** chunk 级金标准结果（配置了 expectChunkIds 的严格模式下有效） */
  chunkPass?: boolean
  /** 严格模式下未进入 Top-K 结果的期望 chunk ID */
  chunkMisses?: string[]
  resultTop: { chunkId: string; docId: string; filename: string; score: number; rank: number }[]
  error?: string
}

export interface TestRunReport {
  ranAt: string
  total: number
  passed: number
  failed: number
  hitRateAvg: number
  mrrAvg: number
  tookMsAvg: number
  tookMsTotal: number
  cases: TestRunCaseResult[]
}

// ---------------------------------------------------------------------------
// 解析 / 校验助手
// ---------------------------------------------------------------------------

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** paramsJson → TestCaseParams（容错 + 白名单净化，供路由层复用） */
export function sanitizeParams(input: unknown): TestCaseParams {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const raw = input as Record<string, unknown>
  const out: TestCaseParams = {}
  if (raw.mode === 'hybrid' || raw.mode === 'dense' || raw.mode === 'sparse') out.mode = raw.mode
  if (typeof raw.topK === 'number' && Number.isFinite(raw.topK)) {
    out.topK = Math.min(Math.max(Math.round(raw.topK), 1), 50)
  }
  if (typeof raw.prefetchLimit === 'number' && Number.isFinite(raw.prefetchLimit)) {
    out.prefetchLimit = Math.min(Math.max(Math.round(raw.prefetchLimit), 1), 200)
  }
  if (typeof raw.rerank === 'boolean') out.rerank = raw.rerank
  if (raw.fusion === 'rrf' || raw.fusion === 'dbsf') out.fusion = raw.fusion
  if (typeof raw.rrfK === 'number' && Number.isFinite(raw.rrfK)) {
    out.rrfK = Math.min(Math.max(Math.round(raw.rrfK), 1), 1000)
  }
  if (
    Array.isArray(raw.rrfWeights) &&
    raw.rrfWeights.length === 2 &&
    raw.rrfWeights.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    out.rrfWeights = [raw.rrfWeights[0] as number, raw.rrfWeights[1] as number]
  }
  return out
}

/** JSON string[] 容错解析（非字符串项剔除、去重），expectDocIds / expectChunkIds 共用 */
function parseStringIdArray(raw: string | null | undefined): string[] {
  const v = safeJson<unknown>(raw, [])
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))]
}

/** expectDocIds JSON → string[]（容错：非字符串项剔除、去重） */
export function parseExpectDocIds(raw: string | null | undefined): string[] {
  return parseStringIdArray(raw)
}

/** expectChunkIds JSON → string[]（容错：非字符串项剔除、去重；契约 §16） */
export function parseExpectChunkIds(raw: string | null | undefined): string[] {
  return parseStringIdArray(raw)
}

// ---------------------------------------------------------------------------
// DB 行 → 契约 TestCaseItem
// ---------------------------------------------------------------------------

/**
 * stale 可选透传：列表接口传入（契约 §18）；单例创建/更新响应可不传（前端按缺失 = 未过期处理）
 */
export function toTestCaseItem(c: RetrievalTestCase, stale?: boolean): Record<string, unknown> {
  return {
    id: c.id,
    kbId: c.kbId,
    name: c.name,
    query: c.query,
    expectDocIds: parseExpectDocIds(c.expectDocIds),
    expectChunkIds: parseExpectChunkIds(c.expectChunkIds),
    params: sanitizeParams(safeJson<unknown>(c.paramsJson, {})),
    enabled: c.enabled,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    lastRun: safeJson<Record<string, unknown>>(c.lastRunJson, {}) ?? {},
    ...(stale !== undefined ? { stale } : {}),
  }
}

// ---------------------------------------------------------------------------
// 结果过期判定（契约 §18 stale）
// ---------------------------------------------------------------------------

/**
 * KB 级 chunk 最新变更时间 = 所有 chunk 的 max(max(createdAt, editedAt))。
 * - chunk 人工编辑 → 写 editedAt（M6 T6.6 重嵌入）
 * - 文档重解析/重切分 → 删旧建新，新 chunk createdAt 更晚
 * 两条路径都覆盖；KB 无 chunk 时返回 null（无从谈起过期）。
 * 单次 aggregate，避免逐 chunk / 逐用例 N+1 查询。
 */
export async function getKbChunkMaxAt(kbId: string): Promise<Date | null> {
  const agg = await db.chunk.aggregate({
    where: { kbId },
    _max: { createdAt: true, editedAt: true },
  })
  const created = agg._max.createdAt
  const edited = agg._max.editedAt
  if (!created && !edited) return null
  if (!created) return edited
  if (!edited) return created
  return created > edited ? created : edited
}

/**
 * 单用例 stale 判定：KB chunk 最新变更时间 > lastRun.ranAt → 结果过期。
 * 从未运行（ranAt 缺失/非法）→ false（没有可过期的结果）。
 * ranAt 为 ISO 字符串（写入即 new Date().toISOString()），统一转毫秒比较。
 */
export function computeStale(kbChunkMaxAt: Date | null, lastRunJson: string | null): boolean {
  if (!kbChunkMaxAt) return false
  const lastRun = safeJson<Record<string, unknown>>(lastRunJson, {})
  const ranAt = lastRun?.ranAt
  if (typeof ranAt !== 'string' || ranAt.length === 0) return false
  const ranAtMs = Date.parse(ranAt)
  if (Number.isNaN(ranAtMs)) return false
  return kbChunkMaxAt.getTime() > ranAtMs
}

// ---------------------------------------------------------------------------
// 单用例执行
// ---------------------------------------------------------------------------

const DEFAULT_TEST_TOP_K = 5

export async function runCase(kb: KnowledgeBase, c: RetrievalTestCase): Promise<TestRunCaseResult> {
  const params = sanitizeParams(safeJson<unknown>(c.paramsJson, {}))
  const expectChunkIds = parseExpectChunkIds(c.expectChunkIds)
  const result: TestRunCaseResult = {
    caseId: c.id,
    name: c.name,
    query: c.query,
    pass: false,
    hitRate: 0,
    mrr: 0,
    tookMs: 0,
    hits: [],
    misses: [],
    resultTop: [],
  }

  try {
    const expectDocIds = parseExpectDocIds(c.expectDocIds)
    if (expectDocIds.length === 0) {
      result.error = '用例未配置期望文档'
      if (expectChunkIds.length > 0) {
        result.chunkPass = false
        result.chunkMisses = [...expectChunkIds]
      }
      return result
    }

    const debug =
      params.fusion || params.rrfK || params.rrfWeights
        ? {
            ...(params.fusion ? { fusion: params.fusion } : {}),
            ...(params.rrfK ? { rrfK: params.rrfK } : {}),
            ...(params.rrfWeights ? { rrfWeights: params.rrfWeights } : {}),
          }
        : undefined

    const search = await runSearch({
      source: 'debug-console',
      kbId: kb.id,
      query: c.query,
      topK: params.topK ?? DEFAULT_TEST_TOP_K,
      ...(params.mode ? { mode: params.mode } : {}),
      ...(params.rerank !== undefined ? { rerank: params.rerank } : {}),
      ...(params.prefetchLimit !== undefined ? { prefetchLimit: params.prefetchLimit } : {}),
      ...(debug ? { debug } : {}),
      withParentContext: false,
    })

    // Top-K 结果文档序列（按首次出现顺序去重）
    const orderedDocIds: string[] = []
    const seen = new Set<string>()
    for (const h of search.results) {
      const docId = h.source.docId
      if (docId && !seen.has(docId)) {
        seen.add(docId)
        orderedDocIds.push(docId)
      }
    }

    const hitSet = new Set(orderedDocIds)
    result.hits = expectDocIds.filter((d) => hitSet.has(d))
    result.misses = expectDocIds.filter((d) => !hitSet.has(d))
    result.hitRate = result.hits.length / expectDocIds.length

    // MRR = 1 / 首个期望文档在结果文档序列中的排名（无命中 0）
    const expectSet = new Set(expectDocIds)
    for (let i = 0; i < orderedDocIds.length; i++) {
      if (expectSet.has(orderedDocIds[i])) {
        result.mrr = Math.round((1 / (i + 1)) * 1e4) / 1e4
        break
      }
    }

    // 严格模式（§16）：期望 chunk 全部出现在 Top-K 结果 chunk 集合才算 chunkPass
    // pass = chunkPass && 文档级 pass（两者都过才通过）；文档级 hitRate/MRR 照常计算
    if (expectChunkIds.length > 0) {
      const resultChunkIds = new Set(search.results.map((h) => h.chunkId).filter(Boolean))
      result.chunkMisses = expectChunkIds.filter((id) => !resultChunkIds.has(id))
      result.chunkPass = result.chunkMisses.length === 0
      result.pass = result.chunkPass && result.misses.length === 0
    } else {
      result.pass = result.misses.length === 0
    }
    result.tookMs = search.tookMs
    result.resultTop = search.results.slice(0, 5).map((h, i) => ({
      chunkId: h.chunkId,
      docId: h.source.docId,
      filename: h.source.filename,
      score: h.rerankScore ?? h.score,
      rank: i + 1,
    }))
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    result.pass = false
    // 严格模式：运行异常 = 结果集为空，chunk 级全未命中
    if (expectChunkIds.length > 0) {
      result.chunkPass = false
      result.chunkMisses = [...expectChunkIds]
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// 测试集回归（批量执行 + 结果写回 + 汇总）
// ---------------------------------------------------------------------------

export async function runTestSet(
  kbId: string,
  opts: { caseIds?: string[]; onlyEnabled?: boolean } = {},
): Promise<TestRunReport> {
  const kb = await db.knowledgeBase.findUnique({ where: { id: kbId } })
  if (!kb) throw new Error('知识库不存在')

  const onlyEnabled = opts.onlyEnabled ?? true
  const where: Record<string, unknown> = { kbId }
  if (opts.caseIds && opts.caseIds.length > 0) {
    where.id = { in: opts.caseIds }
  } else if (onlyEnabled) {
    where.enabled = true
  }
  const cases = await db.retrievalTestCase.findMany({ where, orderBy: { createdAt: 'asc' } })

  const results: TestRunCaseResult[] = []
  for (const c of cases) {
    // 失败不中断：单例异常记入 error，继续下一例
    const r = await runCase(kb, c)
    results.push(r)
    await db.retrievalTestCase
      .update({
        where: { id: c.id },
        data: {
          lastRunJson: JSON.stringify({
            pass: r.pass,
            hitRate: r.hitRate,
            mrr: r.mrr,
            tookMs: r.tookMs,
            ranAt: new Date().toISOString(),
            hits: r.hits,
            misses: r.misses,
            ...(r.chunkPass !== undefined ? { chunkPass: r.chunkPass } : {}),
            ...(r.chunkMisses !== undefined ? { chunkMisses: r.chunkMisses } : {}),
            resultTop: r.resultTop,
            ...(r.error ? { error: r.error } : {}),
          }),
        },
      })
      .catch(() => {})
  }

  const total = results.length
  const passed = results.filter((r) => r.pass).length
  const round4 = (v: number) => Math.round(v * 1e4) / 1e4
  const report: TestRunReport = {
    ranAt: new Date().toISOString(),
    total,
    passed,
    failed: total - passed,
    hitRateAvg: total ? round4(results.reduce((a, r) => a + r.hitRate, 0) / total) : 0,
    mrrAvg: total ? round4(results.reduce((a, r) => a + r.mrr, 0) / total) : 0,
    tookMsAvg: total ? Math.round(results.reduce((a, r) => a + r.tookMs, 0) / total) : 0,
    tookMsTotal: results.reduce((a, r) => a + r.tookMs, 0),
    cases: results,
  }

  // 运维活动流（尽力而为，失败不影响回归）
  void pipelineActivity({
    at: Date.now(),
    level: 'info',
    message: `测试集回归完成：${total} 用例 · 通过 ${passed} · 平均命中率 ${(report.hitRateAvg * 100).toFixed(0)}%`,
  }).catch(() => {})

  return report
}

// ---------------------------------------------------------------------------
// §21 异步测试集运行（后台 job + 进度推送）
// 小规模（≤ ASYNC_THRESHOLD 例）保持同步直跑（现有 runTestSet 兼容）；
// 大规模立即返回 runId，后台逐例执行，每例完成向 kb:{kbId} 房间推 testrun:progress。
// ---------------------------------------------------------------------------

import { emitToRoom } from './events'

/** 同步直跑的规模上限（超过则自动转异步 job） */
export const ASYNC_THRESHOLD = 8

export type TestRunStatus = 'running' | 'done' | 'error'

export interface TestRunState {
  runId: string
  kbId: string
  kbName: string
  status: TestRunStatus
  /** 计划执行的用例数 */
  total: number
  done: number
  /** 最近完成的用例名（进度条旁显示） */
  current?: string
  startedAt: string
  finishedAt?: string
  error?: string
  /** 完成后的完整报告（status=done 时有值） */
  report?: TestRunReport
}

/** globalThis 单例（dev HMR 热重载下保持 job 状态；对齐 pipeline.ts 引擎模式） */
interface TestRunRegistry {
  runs: Map<string, TestRunState>
  moduleVersion: number
}

const g = globalThis as typeof globalThis & { __ragTestRuns?: TestRunRegistry }

function registry(): TestRunRegistry {
  if (!g.__ragTestRuns || g.__ragTestRuns.moduleVersion !== MODULE_VERSION) {
    g.__ragTestRuns = { runs: new Map(), moduleVersion: MODULE_VERSION }
  }
  return g.__ragTestRuns
}

/** 模块版本号（源码结构性变更时递增，触发注册表接管重建） */
const MODULE_VERSION = 1

/** 已完成运行保留条数（防内存无界） */
const KEEP_FINISHED = 20

/**
 * 启动异步测试集运行：立即返回 runId 与初始状态。
 * job 生命周期：running → done（正常）/ error（整体异常）。
 * 进度事件：每例完成 emitToRoom(`kb:${kbId}`, 'testrun:progress', {…TestRunState})
 */
export async function startTestRun(
  kbId: string,
  opts: { caseIds?: string[]; onlyEnabled?: boolean } = {},
): Promise<TestRunState> {
  const kb = await db.knowledgeBase.findUnique({ where: { id: kbId } })
  if (!kb) throw new Error('知识库不存在')

  // 解析目标用例（与 runTestSet 相同的过滤语义）
  const onlyEnabled = opts.onlyEnabled ?? true
  const where: Record<string, unknown> = { kbId }
  if (opts.caseIds && opts.caseIds.length > 0) {
    where.id = { in: opts.caseIds }
  } else if (onlyEnabled) {
    where.enabled = true
  }
  const cases = await db.retrievalTestCase.findMany({ where, orderBy: { createdAt: 'asc' } })
  if (cases.length === 0) throw new Error('没有符合条件的用例')

  const runId = `trun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const state: TestRunState = {
    runId,
    kbId,
    kbName: kb.name,
    status: 'running',
    total: cases.length,
    done: 0,
    startedAt: new Date().toISOString(),
  }
  const reg = registry()
  reg.runs.set(runId, state)
  // 清理旧的已完成运行
  const finished = [...reg.runs.values()].filter((r) => r.status !== 'running')
  if (finished.length > KEEP_FINISHED) {
    for (const old of finished
      .sort((a, b) => (a.finishedAt ?? a.startedAt).localeCompare(b.finishedAt ?? b.startedAt))
      .slice(0, finished.length - KEEP_FINISHED)) {
      reg.runs.delete(old.runId)
    }
  }

  // 后台执行（不 await；异常兜底记入 state.error）
  void (async () => {
    const results: TestRunCaseResult[] = []
    try {
      for (const c of cases) {
        state.current = c.name
        const r = await runCase(kb, c)
        results.push(r)
        await db.retrievalTestCase
          .update({
            where: { id: c.id },
            data: {
              lastRunJson: JSON.stringify({
                pass: r.pass,
                hitRate: r.hitRate,
                mrr: r.mrr,
                tookMs: r.tookMs,
                ranAt: new Date().toISOString(),
                hits: r.hits,
                misses: r.misses,
                ...(r.chunkPass !== undefined ? { chunkPass: r.chunkPass } : {}),
                ...(r.chunkMisses !== undefined ? { chunkMisses: r.chunkMisses } : {}),
                resultTop: r.resultTop,
                ...(r.error ? { error: r.error } : {}),
              }),
            },
          })
          .catch(() => {})
        state.done++
        void emitToRoom(`kb:${kbId}`, 'testrun:progress', {
          runId,
          kbId,
          status: state.status,
          total: state.total,
          done: state.done,
          current: state.current,
        }).catch(() => {})
      }
      const total = results.length
      const passed = results.filter((r) => r.pass).length
      const round4 = (v: number) => Math.round(v * 1e4) / 1e4
      state.report = {
        ranAt: new Date().toISOString(),
        total,
        passed,
        failed: total - passed,
        hitRateAvg: total ? round4(results.reduce((a, r) => a + r.hitRate, 0) / total) : 0,
        mrrAvg: total ? round4(results.reduce((a, r) => a + r.mrr, 0) / total) : 0,
        tookMsAvg: total ? Math.round(results.reduce((a, r) => a + r.tookMs, 0) / total) : 0,
        tookMsTotal: results.reduce((a, r) => a + r.tookMs, 0),
        cases: results,
      }
      state.status = 'done'
      state.finishedAt = new Date().toISOString()
      void pipelineActivity({
        at: Date.now(),
        level: 'info',
        message: `异步测试集回归完成：${total} 用例 · 通过 ${passed} · 平均命中率 ${(state.report.hitRateAvg * 100).toFixed(0)}%`,
      }).catch(() => {})
      void emitToRoom(`kb:${kbId}`, 'testrun:progress', {
        runId,
        kbId,
        status: 'done',
        total: state.total,
        done: state.done,
      }).catch(() => {})
    } catch (e) {
      state.status = 'error'
      state.error = (e as Error).message ?? String(e)
      state.finishedAt = new Date().toISOString()
      void emitToRoom(`kb:${kbId}`, 'testrun:progress', {
        runId,
        kbId,
        status: 'error',
        error: state.error,
        total: state.total,
        done: state.done,
      }).catch(() => {})
    }
  })()

  return state
}

/** 查询运行状态（不存在 / 已被清理 → null） */
export function getTestRun(runId: string): TestRunState | null {
  return registry().runs.get(runId) ?? null
}

/** 当前 KB 是否有进行中的运行（防重复启动） */
export function getRunningTestRun(kbId: string): TestRunState | null {
  for (const r of registry().runs.values()) {
    if (r.kbId === kbId && r.status === 'running') return r
  }
  return null
}

// ---------------------------------------------------------------------------
// §24 测试集运行历史（GET /api/kb/[id]/testruns；数据源 = 上方 globalThis 注册表）
// 进程内语义：重启清零；同步直跑（≤8 例）不入表，只有异步运行产生历史。
// ---------------------------------------------------------------------------

/**
 * §24 运行历史条目（服务端本地定义，与前端 src/components/rag/types.ts §24 同构——
 * 后端 lib 不 import 前端组件目录的类型文件，路由层直接序列化透传）。
 * done 态映射 summary（不含 report.cases 明细，减小载荷）。
 */
export interface TestRunHistoryItem {
  runId: string
  kbId: string
  kbName: string
  status: TestRunStatus
  /** 计划执行的用例数 */
  total: number
  done: number
  startedAt: string
  finishedAt?: string
  error?: string
  /** status=done 时从 state.report 提取的汇总（无 cases 明细） */
  summary?: {
    passed: number
    failed: number
    hitRateAvg: number
    mrrAvg: number
    tookMsTotal: number
  }
}

/**
 * 列出 KB 的运行历史（含 running + 最近完成的，按 startedAt 倒序；契约 §24）。
 * running 天然置顶：同 KB 运行互斥（409 防重复），进行中的 job 必然启动最晚。
 */
export function listTestRuns(kbId: string): TestRunHistoryItem[] {
  const runs = [...registry().runs.values()].filter((r) => r.kbId === kbId)
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return runs.map((r) => {
    const item: TestRunHistoryItem = {
      runId: r.runId,
      kbId: r.kbId,
      kbName: r.kbName,
      status: r.status,
      total: r.total,
      done: r.done,
      startedAt: r.startedAt,
      ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
      ...(r.error ? { error: r.error } : {}),
    }
    if (r.status === 'done' && r.report) {
      item.summary = {
        passed: r.report.passed,
        failed: r.report.failed,
        hitRateAvg: r.report.hitRateAvg,
        mrrAvg: r.report.mrrAvg,
        tookMsTotal: r.report.tookMsTotal,
      }
    }
    return item
  })
}
