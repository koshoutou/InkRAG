/**
 * Dify 兼容层映射（Task 17-3）
 *
 * 平台模型 → Dify 数据集 API 形状：
 *   KnowledgeBase  → Dataset      （id/name/description/document_count/word_count/…）
 *   Document       → Document     （id/name/indexing_status/…，batch = 文档 id：单文件一批）
 *   文档状态机      → indexing_status（queued→waiting / parsing→parsing / chunking→splitting /
 *                      embedding|upserting→indexing / ready→completed / failed→error）
 *
 * process_rule 映射（MinerU 导出高级配置）：
 *   process_rule.mode='custom' + rules.segmentation.max_tokens → chunkConfig.size（一次性切分覆盖，
 *   clamp 64..8192；Dify 允许到 7500，平台按 64..8192 收敛，超出部分在文档中说明）
 *   segmentation.separator / pre_processing_rules / doc_form / doc_language / indexing_technique：
 *   接受并记录到文档 metaJson.difyParams（平台按 Markdown 结构切分，不按分隔符硬切——文档中说明差异）
 */
import type { Document, KnowledgeBase } from '@prisma/client'
import { db } from '@/lib/db'

/** Dify epoch 秒（浮点） */
function epoch(date: Date | null | undefined): number | null {
  return date ? Math.floor(date.getTime() / 1000) : null
}

export interface DifyDataset {
  id: string
  name: string
  description: string
  permission: string
  browser_access: boolean
  knowledge_api_document_id: string
  app_count: number
  app_list: unknown[]
  document_count: number
  word_count: number
  creator: { id: string; name: string }
  created_at: number | null
  updated_at: number | null
  indexing_technique: string
  embedding_model: string
  embedding_model_provider: string
  retrieval_model: unknown
  partial_member_list: unknown[]
}

export function toDifyDataset(kb: KnowledgeBase, counts: { docCount: number; chunkCount: number }): DifyDataset {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    permission: 'only_me',
    browser_access: false,
    knowledge_api_document_id: '',
    app_count: 0,
    app_list: [],
    document_count: counts.docCount,
    // word_count 以 chunk 数近似（平台无逐文档词数统计；字段为 Dify 面板兼容保留）
    word_count: counts.chunkCount,
    creator: { id: 'platform', name: 'InkRAG' },
    created_at: epoch(kb.createdAt),
    updated_at: epoch(kb.updatedAt),
    indexing_technique: 'high_quality',
    embedding_model: kb.embeddingModel,
    embedding_model_provider: 'platform',
    retrieval_model: null,
    partial_member_list: [],
  }
}

export type DifyIndexingStatus = 'waiting' | 'parsing' | 'cleaning' | 'splitting' | 'indexing' | 'completed' | 'error' | 'paused'

export function mapIndexingStatus(status: string): DifyIndexingStatus {
  switch (status) {
    case 'queued': return 'waiting'
    case 'parsing': return 'parsing'
    case 'chunking': return 'splitting'
    case 'embedding': return 'indexing'
    case 'upserting': return 'indexing'
    case 'ready': return 'completed'
    case 'failed': return 'error'
    default: return 'waiting'
  }
}

export interface DifyDocument {
  id: string
  position: number
  data_source_type: string
  data_source_info: { file_name: string; file_extension: string; file_size: number }
  name: string
  doc_type: string
  doc_metadata: Record<string, unknown>
  indexing_status: DifyIndexingStatus
  enabled: boolean
  archived: boolean
  error: string | null
  keywords: unknown[]
  created_at: number | null
  created_by: string
  indexing_start_at: number | null
  completed_at: number | null
  words_count: number
  segment_count: number
  segment_count_language: string
  processing_rule?: unknown
}

export function toDifyDocument(
  doc: Document,
  extra: { position?: number; segments?: { total: number; enabled: number } } = {},
): DifyDocument {
  const ext = doc.filename.includes('.') ? `.${doc.filename.split('.').pop()}` : ''
  return {
    id: doc.id,
    position: extra.position ?? 1,
    data_source_type: 'upload_file',
    data_source_info: {
      file_name: doc.filename,
      file_extension: ext,
      file_size: doc.sizeBytes,
    },
    name: doc.filename,
    doc_type: '',
    doc_metadata: {},
    indexing_status: mapIndexingStatus(doc.status),
    enabled: true,
    archived: false,
    error: doc.errorMessage ?? null,
    keywords: [],
    created_at: epoch(doc.createdAt),
    created_by: 'api',
    indexing_start_at: epoch(doc.createdAt),
    completed_at: doc.status === 'ready' ? epoch(doc.updatedAt) : null,
    // words_count 以 chunk 计数近似（兼容字段；平台不产逐文档 token 统计）
    words_count: extra.segments?.total ?? 0,
    segment_count: extra.segments?.total ?? 0,
    segment_count_language: 'Chinese',
  }
}

/** 文档 segment 计数（isParent=false 口径，与平台 UI 一致） */
export async function docSegments(docId: string): Promise<{ total: number; enabled: number }> {
  const [total, enabled] = await Promise.all([
    db.chunk.count({ where: { documentId: docId, isParent: false } }),
    db.chunk.count({ where: { documentId: docId, isParent: false, enabled: true } }),
  ])
  return { total, enabled }
}

export interface DifyProcessRuleInfo {
  mode: string
  separator?: string
  max_tokens?: number
  applied_max_tokens?: number
  pre_processing_rules?: unknown
}

/**
 * 解析 create-by-file / create-by-text 的 data.process_rule：
 * 返回 { chunkConfig?: {size} }（供 ingest 一次性覆盖）+ 原始参数（记录到 metaJson.difyParams）。
 */
export function applyDifyProcessRule(data: Record<string, unknown>): {
  chunkConfig?: { size: number }
  ruleInfo: DifyProcessRuleInfo | null
} {
  const rule = data?.process_rule
  if (!rule || typeof rule !== 'object') return { ruleInfo: null }
  const r = rule as Record<string, unknown>
  const mode = String(r.mode ?? 'automatic')
  if (mode !== 'custom') return { ruleInfo: { mode } }
  const rules = (r.rules ?? {}) as Record<string, unknown>
  const seg = (rules.segmentation ?? {}) as Record<string, unknown>
  const separator = typeof seg.separator === 'string' ? seg.separator : undefined
  const rawMax = Number(seg.max_tokens)
  const hasMax = Number.isFinite(rawMax) && rawMax > 0
  // Dify 上限 7500，平台 chunk size 收敛 64..8192
  const applied = hasMax ? Math.max(64, Math.min(8192, Math.floor(rawMax))) : undefined
  const pre = rules.pre_processing_rules
  return {
    ...(applied ? { chunkConfig: { size: applied } } : {}),
    ruleInfo: {
      mode,
      separator,
      max_tokens: hasMax ? rawMax : undefined,
      applied_max_tokens: applied,
      ...(Array.isArray(pre) ? { pre_processing_rules: pre } : {}),
    },
  }
}

/** 把 Dify 原始参数（separator/doc_form/doc_language/indexing_technique/process_rule）记录到文档 metaJson.difyParams */
export async function recordDifyParams(docId: string, params: Record<string, unknown>): Promise<void> {
  try {
    const doc = await db.document.findUnique({ where: { id: docId }, select: { metaJson: true } })
    if (!doc) return
    let meta: Record<string, unknown> = {}
    try {
      const v = JSON.parse(doc.metaJson || '{}')
      if (typeof v === 'object' && v) meta = v as Record<string, unknown>
    } catch {}
    meta.difyParams = params
    await db.document.update({ where: { id: docId }, data: { metaJson: JSON.stringify(meta) } })
  } catch {
    // 记录失败不影响入库
  }
}
