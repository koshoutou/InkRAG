/**
 * 流水线引擎（BullMQ 语义的 SQLite 实现，计划书 §10）
 *
 * - globalThis 单例（Next dev 每 route 模块独立实例，必须跨模块共享）
 * - setInterval 1200ms tick；进程内并发 2；CAS 认领（updateMany where status='pending'）
 * - 四类执行器：parse → chunk → embed（含 upsert，阶段状态分开回写）
 * - 失败处理：attempts < maxAttempts 且可重试 → 回 pending（BullMQ 语义）；
 *   NonRetryable（业务错误）或重试耗尽 → failed + document.status=failed + 事件
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { getRagSettings } from './settings'
import { getVectorStore, isNonRetryable, StoreError } from './vectorstore'
import { DEFAULT_CHUNK_CONFIG, splitMarkdown, countTokens, type ChunkConfig } from './chunking'
import { parseDocument } from './mineru'
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

type JobRow = NonNullable<Awaited<ReturnType<typeof db.pipelineJob.findUnique>>>
type DocRow = NonNullable<Awaited<ReturnType<typeof db.document.findUnique>>>
type KbRow = NonNullable<Awaited<ReturnType<typeof db.knowledgeBase.findUnique>>>

// ---------------------------------------------------------------------------
// 引擎单例
// ---------------------------------------------------------------------------

interface PipelineEngineState {
  timer: ReturnType<typeof setInterval> | null
  busy: boolean
  active: number
  startedAt: number
  tickCount: number
  /** 模块版本（dev 热重载自愈：新模块实例检测到版本更新即接管引擎） */
  moduleVersion: number
}

const g = globalThis as unknown as { __ragPipeline?: PipelineEngineState }

/** 每次模块求值取新值——dev 下模块重编译后可检测并接管旧引擎 */
const PIPELINE_MODULE_VERSION = Date.now()

export function ensurePipelineEngine(): PipelineEngineState {
  let eng = g.__ragPipeline
  if (eng && eng.moduleVersion !== PIPELINE_MODULE_VERSION) {
    // dev 热重载：旧模块实例的引擎（闭包引用旧代码）→ 安全接管
    if (eng.timer) clearInterval(eng.timer)
    console.log('[pipeline] 检测到模块更新，接管引擎（旧任务随新代码继续）')
    eng = undefined
  }
  if (!eng) {
    eng = {
      timer: null,
      busy: false,
      active: 0,
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
    console.log('[pipeline] 引擎已启动（tick=1200ms, concurrency=2）')
    void pipelineActivity({
      at: Date.now(),
      level: 'info',
      message: '流水线引擎已启动（tick 1200ms / 并发 2）',
    })
    // 启动恢复：上次进程中断遗留的 active 任务回 pending
    void recoverStaleJobs()
  }
  return eng
}

/** 僵尸任务恢复：active 且 startedAt 超 10 分钟 → pending（dev 热重载/进程重启遗留） */
async function recoverStaleJobs(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000)
    const res = await db.pipelineJob.updateMany({
      where: { status: 'active', startedAt: { lt: cutoff } },
      data: { status: 'pending' },
    })
    if (res.count > 0) {
      console.warn(`[pipeline] 恢复 ${res.count} 个中断任务为 pending`)
    }
  } catch (e) {
    console.warn('[pipeline] 恢复中断任务失败:', (e as Error).message)
  }
}

async function tick(eng: PipelineEngineState): Promise<void> {
  if (eng.busy) return
  eng.busy = true
  eng.tickCount++
  try {
    if (eng.tickCount % 25 === 0) await recoverStaleJobs()
    while (eng.active < CONCURRENCY) {
      const candidates = await db.pipelineJob.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: 5,
      })
      if (candidates.length === 0) break
      let claimedAny = false
      for (const cand of candidates) {
        if (eng.active >= CONCURRENCY) break
        // CAS 认领：仅当仍为 pending 时抢占（防并发双取）
        const claimed = await db.pipelineJob.updateMany({
          where: { id: cand.id, status: 'pending' },
          data: { status: 'active', startedAt: new Date(), attempts: { increment: 1 } },
        })
        if (claimed.count > 0) {
          claimedAny = true
          eng.active++
          const jobId = cand.id
          void runJob(jobId)
            .catch((e) => console.error('[pipeline] runJob 异常:', e))
            .finally(() => {
              eng.active--
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
// 任务执行
// ---------------------------------------------------------------------------

async function runJob(jobId: string): Promise<void> {
  const job = await db.pipelineJob.findUnique({ where: { id: jobId } })
  if (!job) return
  const startedAt = Date.now()
  try {
    const doc = await db.document.findUnique({ where: { id: job.documentId } })
    if (!doc) {
      throw new StoreError('文档记录不存在（可能已被删除）', { retryable: false })
    }
    const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
    if (!kb) {
      throw new StoreError('知识库不存在', { retryable: false })
    }
    if (job.type === 'parse') await execParse(job, doc)
    else if (job.type === 'chunk') await execChunk(job, doc, kb)
    else if (job.type === 'embed') await execEmbed(job, doc, kb)
    else throw new StoreError(`未知任务类型: ${job.type}`, { retryable: false })

    const durationMs = Date.now() - startedAt
    await db.pipelineJob.update({
      where: { id: job.id },
      data: { status: 'completed', finishedAt: new Date(), durationMs, error: null },
    })
    await jobUpdate({
      jobId: job.id,
      documentId: job.documentId,
      type: job.type,
      status: 'completed',
      durationMs,
    })
  } catch (e) {
    await handleJobFailure(job, e, startedAt)
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

  if (canRetry) {
    await db.pipelineJob.update({
      where: { id: job.id },
      data: { status: 'pending', error: message },
    })
    await jobUpdate({
      jobId: job.id,
      documentId: job.documentId,
      type: job.type,
      status: 'retrying',
      error: message,
    })
    return
  }

  await db.pipelineJob.update({
    where: { id: job.id },
    data: { status: 'failed', finishedAt: new Date(), durationMs, error: message },
  })
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

/** 阶段内部进度（400ms 节流写库 + 事件） */
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
// 执行器 · parse
// ---------------------------------------------------------------------------

async function execParse(job: JobRow, doc: DocRow): Promise<void> {
  void job
  await setDocStatus(doc, 'parsing', 5, { errorCode: null, errorMessage: null })
  const settings = await getRagSettings()
  const ext = path.extname(doc.filename).toLowerCase().replace('.', '') || 'bin'
  const localPath = sourcePath(doc.kbId, doc.id, ext)
  const started = Date.now()

  // per-doc 引擎选择（Task 14-e）：上传/URL 导入时写入 metaJson.engineChoice，优先级高于全局 parseMode
  const metaBefore = safeParseJson(doc.metaJson)
  const engineChoice = metaBefore.engineChoice
  const engine: 'mineru' | 'node' | undefined =
    engineChoice === 'mineru' || engineChoice === 'node' ? engineChoice : undefined

  const result = await parseDocument({
    docId: doc.id,
    kbId: doc.kbId,
    filename: doc.filename,
    localPath,
    mimeType: doc.mimeType,
    settings,
    engine,
    onProgress: (e) => {
      void reportProgress(doc, 'parsing', Math.max(5, Math.min(99, e.progress)), e.message)
    },
  })

  const meta = safeParseJson(doc.metaJson)
  await serializeDocWrite(doc.id, async () => {
    await db.document.update({
      where: { id: doc.id },
      data: {
        parseEngine: result.engine,
        layoutBlocks: result.blockCount,
        stageProgress: 100,
        mineruJobId: result.mineruJobId ?? null,
        mineruFileId: result.mineruFileId ?? null,
        metaJson: JSON.stringify({
          ...meta,
          pages: result.pages,
          blockCount: result.blockCount,
          parseEngine: result.engine,
          parseMs: Date.now() - started,
        }),
      },
    })
  })
  await reportProgress(doc, 'parsing', 100, '解析完成', true)

  // 事件驱动衔接（§10.3）：parse 完成 → 入队 chunk
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
}

// ---------------------------------------------------------------------------
// 执行器 · chunk
// ---------------------------------------------------------------------------

async function execChunk(job: JobRow, doc: DocRow, kb: KbRow): Promise<void> {
  void job
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
  for (const p of result.parents) {
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
// 执行器 · embed（含 upsert，阶段状态分开回写，向量不跨 job 传输）
// ---------------------------------------------------------------------------

async function execEmbed(job: JobRow, doc: DocRow, kb: KbRow): Promise<void> {
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
  const emb = await embedTexts(texts, {
    dim,
    onProgress: (done, total) => {
      void reportProgress(doc, 'embedding', 5 + Math.round((55 * done) / total), `嵌入 ${done}/${total}`)
    },
  })

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
  const BATCH = 256
  for (let i = 0; i < points.length; i += BATCH) {
    await store.upsertPoints(kb.collection, points.slice(i, i + BATCH))
    void reportProgress(
      doc,
      'upserting',
      65 + Math.round((30 * Math.min(i + BATCH, points.length)) / points.length),
      `向量入库 ${Math.min(i + BATCH, points.length)}/${points.length}`
    )
  }

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
  // 记录本次运行起点（document:done 的 tookMs 用）
  const meta = safeParseJson(doc.metaJson)
  await db.document.update({
    where: { id: docId },
    data: { metaJson: JSON.stringify({ ...meta, runStartedAt: Date.now() }) },
  })
  // 清理该文档残留 pending 任务（防重复入队）
  await db.pipelineJob.deleteMany({ where: { documentId: docId, status: 'pending' } })
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
  failed: number
  completed: number
  uptimeSec: number
  concurrency: number
}> {
  const eng = ensurePipelineEngine()
  const [pending, active, failed, completed] = await Promise.all([
    db.pipelineJob.count({ where: { status: 'pending' } }),
    db.pipelineJob.count({ where: { status: 'active' } }),
    db.pipelineJob.count({ where: { status: 'failed' } }),
    db.pipelineJob.count({ where: { status: 'completed' } }),
  ])
  return {
    pending,
    active,
    failed,
    completed,
    uptimeSec: Math.floor((Date.now() - eng.startedAt) / 1000),
    concurrency: CONCURRENCY,
  }
}

