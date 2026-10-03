/**
 * DB 行 → 契约摘要类型 的序列化助手（各 API 路由共用）
 */
import type { KbSummary, ChunkItem, DocSummary, DocumentStatus, JobItem } from './types'
import { DEFAULT_CHUNK_CONFIG } from './chunking'
import type { KnowledgeBase, Document, Chunk, PipelineJob } from '@prisma/client'

function parseChunkConfig(s: string): KbSummary['chunkConfig'] {
  try {
    const v = JSON.parse(s || '{}')
    return {
      size: typeof v.size === 'number' ? v.size : DEFAULT_CHUNK_CONFIG.size,
      overlap: typeof v.overlap === 'number' ? v.overlap : DEFAULT_CHUNK_CONFIG.overlap,
      parentSize: typeof v.parentSize === 'number' ? v.parentSize : DEFAULT_CHUNK_CONFIG.parentSize,
      strategy: ['token', 'title', 'hybrid'].includes(v.strategy) ? v.strategy : 'hybrid',
      protects: Array.isArray(v.protects) ? v.protects : DEFAULT_CHUNK_CONFIG.protects,
    }
  } catch {
    return { ...DEFAULT_CHUNK_CONFIG }
  }
}

export function toKbSummary(
  kb: KnowledgeBase,
  counts: { docCount: number; chunkCount: number; pointCount: number },
  vectorMode: 'qdrant' | 'unconfigured'
): KbSummary {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    collection: kb.collection,
    embeddingModel: kb.embeddingModel,
    dim: kb.dim,
    chunkConfig: parseChunkConfig(kb.chunkConfig),
    vectorMode,
    sparseScheme: kb.sparseScheme === 'native' ? 'native' : 'none',
    rerankEnabled: kb.rerankEnabled,
    docCount: counts.docCount,
    chunkCount: counts.chunkCount,
    pointCount: counts.pointCount,
    createdAt: kb.createdAt.toISOString(),
    updatedAt: kb.updatedAt.toISOString(),
  }
}

export { parseChunkConfig }

export function toDocSummary(
  doc: Document,
  counts?: { chunkCount: number; enabledChunkCount?: number }
): DocSummary {
  let meta: Record<string, unknown> = {}
  try {
    const v = JSON.parse(doc.metaJson || '{}')
    if (typeof v === 'object' && v) meta = v
  } catch {}
  return {
    id: doc.id,
    kbId: doc.kbId,
    filename: doc.filename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status as DocumentStatus,
    stageProgress: doc.stageProgress,
    parseConfigV: doc.parseConfigV,
    parseEngine: doc.parseEngine,
    errorCode: doc.errorCode,
    errorMessage: doc.errorMessage,
    layoutBlocks: doc.layoutBlocks,
    chunkCount: counts?.chunkCount ?? 0,
    ...(counts?.enabledChunkCount !== undefined
      ? { enabledChunkCount: counts.enabledChunkCount }
      : {}),
    sourceUrl: doc.sourceUrl ?? '',
    metaJson: meta,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

export function toChunkItem(c: Chunk): ChunkItem {
  let bboxFrom: number[] = []
  let bboxTo: number[] = []
  try {
    bboxFrom = JSON.parse(c.bboxFrom || '[]')
    bboxTo = JSON.parse(c.bboxTo || '[]')
  } catch {}
  return {
    id: c.id,
    documentId: c.documentId,
    isParent: c.isParent,
    parentId: c.parentId,
    seq: c.seq,
    docType: c.docType as ChunkItem['docType'],
    tokenCount: c.tokenCount,
    charStart: c.charStart,
    charEnd: c.charEnd,
    pageFrom: c.pageFrom,
    pageTo: c.pageTo,
    bboxFrom,
    bboxTo,
    textPreview: c.textPreview,
    enabled: c.enabled,
    editedAt: c.editedAt?.toISOString() ?? null,
  }
}

export function toJobItem(job: PipelineJob, docName?: string): JobItem {
  return {
    id: job.id,
    documentId: job.documentId,
    kbId: job.kbId,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.error,
    durationMs: job.durationMs,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    ...(docName !== undefined ? { docName } : {}),
  }
}

