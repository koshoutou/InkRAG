/**
 * 知识库汇总助手（列表/详情共用：活统计 docCount/chunkCount + pointCount）
 * + 删除/重试共享核心（Task 17-2：/api/kb、/api/documents 与 /api/input 三链路同一语义）
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { getRagSettings } from './settings'
import { toKbSummary } from './serialize'
import { getVectorStore } from './vectorstore'
import { ARTIFACTS_ROOT, removeDocDir } from './artifacts'
import { cancelKbJobs, cancelDocumentJobs, updateKbStats, enqueueDocument } from './pipeline'
import type { KbSummary } from './types'
import type { KnowledgeBase } from '@prisma/client'

export async function kbSummaryWithCounts(kb: KnowledgeBase): Promise<KbSummary> {
  const settings = await getRagSettings()
  const [docCount, chunkCount] = await Promise.all([
    db.document.count({ where: { kbId: kb.id } }),
    db.chunk.count({ where: { kbId: kb.id, isParent: false } }),
  ])
  // pointCount 用库行快照（pipeline 每次 ready 后回写）；
  // 不在此处实时探测 Qdrant（列表页逐库 count 会放大远程延迟，且不可达时列表不应失败）
  return toKbSummary(kb, { docCount, chunkCount, pointCount: kb.pointCount }, settings.vectorMode)
}

export async function kbSummaries(kbs: KnowledgeBase[]): Promise<KbSummary[]> {
  return Promise.all(kbs.map((kb) => kbSummaryWithCounts(kb)))
}

// ---------------------------------------------------------------------------
// 删除知识库核心（Task 17-2 抽取；/api/kb/[id] DELETE 与 /api/input/knowledge-bases/[id] DELETE 共用）
// ---------------------------------------------------------------------------

export type DeleteKbResult =
  | { ok: true; deleted: { docs: number; chunks: number; points: number; cancelledJobs: number } }
  | { ok: false; status: number; error: string }

/**
 * 删除知识库（级联）：取消在途任务 → 删向量集合 → 删行（Chunk/Document/PipelineJob/KB）→ 清磁盘产物 → count 校验。
 * 顺序不可变（审计#N13：先取消再删，避免 runJob 半写状态）。
 */
export async function deleteKnowledgeBaseCore(id: string): Promise<DeleteKbResult> {
  const kb = await db.knowledgeBase.findUnique({ where: { id } })
  if (!kb) return { ok: false, status: 404, error: '知识库不存在' }

  const docs = await db.document.findMany({ where: { kbId: id }, select: { id: true } })
  const chunkCount = await db.chunk.count({ where: { kbId: id } })

  // 0) 先取消该 KB 全部在途任务（pending/active/waiting_mineru → cancelled + abort）
  const cancelledJobs = await cancelKbJobs(id)

  // 1) 向量集合整体删除（Qdrant deleteCollection；不可达时跳过并告警，行数据仍级联删除）
  let pointsDeleted = 0
  try {
    const store = await getVectorStore()
    pointsDeleted = await store.count(kb.collection).catch(() => 0)
    await store.deleteCollection(kb.collection)
  } catch (e: any) {
    console.warn('[kb] 删除向量集合失败（可能不存在/不可达）:', e?.message ?? e)
  }
  // 2) 行删除（Chunk/Document 级联）
  await db.chunk.deleteMany({ where: { kbId: id } })
  await db.document.deleteMany({ where: { kbId: id } })
  await db.pipelineJob.deleteMany({ where: { kbId: id } })
  await db.knowledgeBase.delete({ where: { id } })
  // 3) 磁盘产物
  await fs.rm(path.join(ARTIFACTS_ROOT, id), { recursive: true, force: true })

  // 4) count 校验
  const remain = await db.chunk.count({ where: { kbId: id } })
  if (remain !== 0) {
    console.warn(`[kb] 级联删除校验失败：仍残留 ${remain} chunks`)
  }

  return {
    ok: true,
    deleted: { docs: docs.length, chunks: chunkCount, points: pointsDeleted, cancelledJobs },
  }
}

// ---------------------------------------------------------------------------
// 删除文档核心（Task 17-2 抽取；/api/documents/[id] DELETE 与 /api/input/documents/[id] DELETE 共用）
// ---------------------------------------------------------------------------

export type DeleteDocResult =
  | { ok: true; deletedChunks: number }
  | { ok: false; status: number; error: string }

/** 删除文档（级联）：取消在途 → 向量 delete(filter doc_id) → chunk/任务/文档行 → 磁盘产物 → count 校验 → updateKbStats */
export async function deleteDocumentCore(docId: string): Promise<DeleteDocResult> {
  const doc = await db.document.findUnique({ where: { id: docId } })
  if (!doc) return { ok: false, status: 404, error: '文档不存在' }
  const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
  if (!kb) return { ok: false, status: 404, error: '知识库不存在' }

  // 0) 先取消该文档全部在途任务（pending/active/waiting_mineru → cancelled + abort；审计#N13）
  await cancelDocumentJobs(docId)

  // 1) 向量 delete(filter doc_id)
  try {
    const store = await getVectorStore()
    await store.deleteByFilter(kb.collection, {
      must: [{ key: 'doc_id', match: { value: doc.id } }],
    })
  } catch (e: any) {
    console.warn('[doc] 删除向量失败（可能无数据）:', e?.message ?? e)
  }
  // 2) chunk 行 + document 行 + 任务
  const deletedChunks = await db.chunk.count({ where: { documentId: docId } })
  await db.chunk.deleteMany({ where: { documentId: docId } })
  await db.pipelineJob.deleteMany({ where: { documentId: docId } })
  await db.document.delete({ where: { id: docId } })
  // 3) 磁盘产物
  await removeDocDir(doc.kbId, doc.id)
  // 4) count 校验
  const remain = await db.chunk.count({ where: { documentId: docId } })
  if (remain !== 0) console.warn(`[doc] 删除校验失败：仍残留 ${remain} chunks`)

  await updateKbStats(doc.kbId)
  return { ok: true, deletedChunks }
}

// ---------------------------------------------------------------------------
// 失败文档重试核心（Task 17-2 抽取；/api/documents/[id]/action retry 分支与 /api/input/documents/[id]/retry 共用）
// ---------------------------------------------------------------------------

export type RetryDocResult =
  | { ok: true; stage: 'parse' | 'chunk' | 'embed' }
  | { ok: false; status: number; error: string }

/**
 * 失败文档重试：从失败阶段续跑（meta.failedStage 记录，缺省 parse），不产生新版本。
 * 仅 failed 状态可重试（409 流水线保护——重试会取消该文档在途任务后重新入队）。
 */
export async function retryFailedDocumentCore(docId: string): Promise<RetryDocResult> {
  const doc = await db.document.findUnique({ where: { id: docId } })
  if (!doc) return { ok: false, status: 404, error: '文档不存在' }
  const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
  if (!kb) return { ok: false, status: 404, error: '知识库不存在' }

  // 409 流水线保护：重试只对 failed 文档开放（UI 同口径：失败行才展示「重试」按钮）
  if (doc.status !== 'failed') {
    return { ok: false, status: 409, error: `仅失败（failed）状态的文档可以重试，当前状态：${doc.status}` }
  }

  let meta: Record<string, unknown> = {}
  try {
    meta = JSON.parse(doc.metaJson || '{}')
  } catch {}
  const failedStage = String(meta.failedStage ?? '')
  const stage: 'parse' | 'chunk' | 'embed' = ['parse', 'chunk', 'embed'].includes(failedStage)
    ? (failedStage as 'parse' | 'chunk' | 'embed')
    : 'parse'

  await db.document.update({
    where: { id: docId },
    data: {
      status: 'queued',
      stageProgress: 0,
      errorCode: null,
      errorMessage: null,
      metaJson: JSON.stringify({ ...meta, failedStage: null }),
    },
  })
  if (stage !== 'parse') {
    // 续跑 chunk/embed 前先清旧产物（chunk job 亦会清理，双保险）
    try {
      const store = await getVectorStore()
      await store.deleteByFilter(kb.collection, {
        must: [{ key: 'doc_id', match: { value: doc.id } }],
      })
    } catch (e: any) {
      console.warn('[retry] 清理旧向量跳过:', e?.message ?? e)
    }
  }
  // enqueueDocument 内部会先取消该文档全部在途任务再建新任务（审计#N14，并发保护）
  await enqueueDocument(docId, stage)
  return { ok: true, stage }
}
