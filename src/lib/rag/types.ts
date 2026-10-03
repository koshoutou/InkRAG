/**
 * RAG 知识库平台 · 服务端共享类型（契约 docs/api-contract.md 的服务端版本）
 *
 * 本文件是 src/lib/rag/* 各模块与 API 路由之间的类型契约单一来源。
 */

// ---------------------------------------------------------------------------
// 基础枚举 / 配置
// ---------------------------------------------------------------------------

/** 文档状态机（计划书 §10.2）：queued → parsing → chunking → embedding → upserting → ready | failed */
export type DocumentStatus =
  | 'queued'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'upserting'
  | 'ready'
  | 'failed'

/** 切分配置（契约 §1，计划书 §11.3） */
export interface ChunkConfig {
  /** 子 chunk token 目标，默认 512 */
  size: number
  /** 重叠 token 数，默认 0 */
  overlap: number
  /** 父 chunk token 上限，默认 2000 */
  parentSize: number
  /** token（顺序）| title（标题树）| hybrid（标题优先 + token 兜底合并） */
  strategy: 'token' | 'title' | 'hybrid'
  /** 原子保护块类型，如 ['code', 'table'] */
  protects: string[]
}

/** 双模式判定结果（v1.6：本地向量引擎已移除，未配置 Qdrant 时建库/写入硬失败） */
export type VectorMode = 'qdrant' | 'unconfigured'
export type ParseMode = 'mineru' | 'fallback' | 'none'
export type EmbedMode = 'real' | 'mock' | 'none'
export type RerankMode = 'real' | 'mock' | 'none'

/** 稀疏向量方案（建库时探测锁定，防止两种 sparse 空间静默混用）：
 *  none（provider 无稀疏输出，检索强制 dense）| native（provider 原生稀疏，写入断言非空） */
export type SparseScheme = 'none' | 'native'

// ---------------------------------------------------------------------------
// Layout（middle.json 契约 §10 产物布局）
// ---------------------------------------------------------------------------

/** middle.json 中的布局块（供三屏高亮，契约 §2 layout 接口） */
export interface LayoutBlock {
  idx: number
  type: 'text' | 'title' | 'code' | 'table' | 'image'
  /** 1-based 页码 */
  page: number
  /** PDF 点空间 [x0, y0, x1, y1]，原点左下 */
  bbox: [number, number, number, number]
  /** 对应 full.md 的字符范围（与生成的 markdown 严格对齐） */
  charStart: number
  charEnd: number
  /** ≤200 字符文本 */
  text: string
}

/** middle.json 统一格式（所有解析路径产出一致） */
export interface MiddleJson {
  pages: { w: number; h: number }[]
  blocks: LayoutBlock[]
}

// ---------------------------------------------------------------------------
// 切分引擎（chunking.ts 产物）
// ---------------------------------------------------------------------------

export interface SplitParent {
  seq: number
  text: string
  charStart: number
  charEnd: number
  tokenCount: number
}

export interface SplitChild {
  seq: number
  /** 父 chunk 的 seq（文档内全局顺序号） */
  parentSeq: number
  text: string
  docType: 'text' | 'table' | 'code' | 'image'
  tokenCount: number
  charStart: number
  charEnd: number
  pageFrom: number
  pageTo: number
  bboxFrom: number[]
  bboxTo: number[]
}

export interface SplitStats {
  total: number
  parentCount: number
  tokenMin: number
  tokenMax: number
  tokenAvg: number
  tokenP95: number
  docTypeCounts: Record<string, number>
}

export interface SplitResult {
  parents: SplitParent[]
  children: SplitChild[]
  stats: SplitStats
}

// ---------------------------------------------------------------------------
// API 摘要类型（契约 §1/§2）
// ---------------------------------------------------------------------------

export interface KbSummary {
  id: string
  name: string
  description: string
  collection: string
  embeddingModel: string
  dim: number
  chunkConfig: ChunkConfig
  vectorMode: VectorMode
  /** 稀疏向量方案（建库时探测锁定）：none | native */
  sparseScheme: SparseScheme
  rerankEnabled: boolean
  docCount: number
  chunkCount: number
  pointCount: number
  createdAt: string
  updatedAt: string
}

export interface DocSummary {
  id: string
  kbId: string
  filename: string
  mimeType: string
  sizeBytes: number
  status: DocumentStatus
  stageProgress: number
  parseConfigV: number
  parseEngine: string
  errorCode: string | null
  errorMessage: string | null
  layoutBlocks: number
  chunkCount: number
  enabledChunkCount?: number
  metaJson: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ChunkItem {
  id: string
  documentId: string
  isParent: boolean
  parentId: string | null
  seq: number
  docType: 'text' | 'table' | 'code' | 'image'
  tokenCount: number
  charStart: number
  charEnd: number
  pageFrom: number
  pageTo: number
  bboxFrom: number[]
  bboxTo: number[]
  textPreview: string
  enabled: boolean
}

export interface JobItem {
  id: string
  documentId: string
  kbId: string
  type: string
  status: string
  attempts: number
  maxAttempts: number
  error: string | null
  durationMs: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  docName?: string
}

// ---------------------------------------------------------------------------
// 检索（契约 §3）
// ---------------------------------------------------------------------------

export interface SearchFilter {
  docIds?: string[]
  pageRange?: [number, number]
}

export interface SearchDebugOpts {
  fusion?: 'rrf' | 'dbsf'
  rrfK?: number
  rrfWeights?: [number, number]
  prefetchLimit?: number
}

export interface SearchRequest {
  kbId: string
  query: string
  topK?: number
  mode?: 'hybrid' | 'dense' | 'sparse'
  rerank?: boolean
  prefetchLimit?: number
  filter?: SearchFilter
  withParentContext?: boolean
  debug?: SearchDebugOpts
}

export interface SearchHit {
  chunkId: string
  score: number
  rerankScore?: number | null
  text: string
  parentText?: string | null
  source: {
    docId: string
    filename: string
    page: number
    bbox: number[] | null
    seq: number
    docType: string
  }
}

export interface DebugTopItem {
  chunkId: string
  score: number
  page: number
  preview: string
}

export interface FusedTopItem {
  chunkId: string
  score: number
  denseRank?: number
  sparseRank?: number
}

export interface RerankTopItem {
  chunkId: string
  rerankScore: number
  prevRank: number
}

export interface SearchResponse {
  tookMs: number
  stages: {
    embedMs: number
    recallMs: number
    fusionMs: number
    rerankMs: number
    contextMs: number
  }
  results: SearchHit[]
  debug: {
    embed: {
      dim: number
      denseHash: string
      denseFirst8: number[]
      sparseNnz: number
      provider: string
    }
    denseTop: DebugTopItem[]
    sparseTop: DebugTopItem[]
    fusedTop: FusedTopItem[]
    rerankTop?: RerankTopItem[]
    fusion: string
    rrfK?: number
    mode: string
    /** 建库时锁定的稀疏方案（none 时强制 dense 检索） */
    sparseScheme?: string
  }
}

// ---------------------------------------------------------------------------
// 向量存储（vectorstore.ts）
// ---------------------------------------------------------------------------

/** Qdrant 风格过滤条件（对齐 Qdrant REST Filter 结构） */
export interface VectorFilterCondition {
  key: string
  match?: { value?: string | number | boolean; any?: (string | number)[] }
  range?: { gte?: number; lte?: number; gt?: number; lt?: number }
}

export interface VectorFilter {
  must?: VectorFilterCondition[]
  must_not?: VectorFilterCondition[]
  should?: VectorFilterCondition[]
}

export interface SparseVector {
  indices: number[]
  values: number[]
}

export interface PointInput {
  id: string
  dense: number[]
  sparse: SparseVector
  payload: Record<string, unknown>
}

export interface QueryHit {
  id: string
  score: number
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 解析产物（mineru.ts）
// ---------------------------------------------------------------------------

export interface ParseProgressEvent {
  /** 0-100 */
  progress: number
  message?: string
}

export interface ParseArtifacts {
  engine: 'mineru' | 'fallback'
  markdownPath: string
  middleJsonPath: string
  pages: number
  blockCount: number
  /** MinerU 断点续传（计划书 §10.4）：持久化到 document 记录 */
  mineruJobId?: string
  mineruUploadId?: string
  mineruFileId?: string
}

// ---------------------------------------------------------------------------
// Socket 事件 payload（契约 §9）
// ---------------------------------------------------------------------------

export interface DocumentStatusEvent {
  docId: string
  kbId: string
  status: DocumentStatus
  stageProgress: number
  errorCode?: string | null
  errorMessage?: string | null
}

export interface DocumentProgressEvent {
  docId: string
  kbId: string
  stage: string
  progress: number
  message?: string
}

export interface DocumentDoneEvent {
  docId: string
  kbId: string
  status: DocumentStatus
  chunkCount: number
  tookMs: number
}

export interface KbStatsEvent {
  kbId: string
  docCount: number
  chunkCount: number
  pointCount: number
}

export interface JobUpdateEvent {
  jobId: string
  documentId: string
  type: string
  status: string
  error?: string | null
  durationMs?: number
}

export interface PipelineActivityEvent {
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}
