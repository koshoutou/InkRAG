// RAG 知识库平台 · 前端类型定义
// 唯一权威来源：/home/z/my-project/docs/api-contract.md

export type DocStatus =
  | 'queued'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'upserting'
  | 'ready'
  | 'failed'

export type DocType = 'text' | 'table' | 'code' | 'image'
export type ChunkStrategy = 'token' | 'title' | 'hybrid'
/** v1.6：本地向量引擎已移除；未配置 Qdrant 时建库/向量读写硬失败 */
export type VectorMode = 'qdrant' | 'unconfigured'
/** 稀疏向量方案（建库时探测锁定）：none（无稀疏输出，检索强制 dense）| native（原生稀疏） */
export type SparseScheme = 'none' | 'native'
export type SearchMode = 'hybrid' | 'dense' | 'sparse'
export type FusionMode = 'rrf' | 'dbsf'
export type ApiKeyRole = 'admin' | 'operator' | 'readonly'

export const DOC_STATUSES: DocStatus[] = [
  'queued',
  'parsing',
  'chunking',
  'embedding',
  'upserting',
  'ready',
  'failed',
]

export const PROCESSING_STATUSES: DocStatus[] = [
  'queued',
  'parsing',
  'chunking',
  'embedding',
  'upserting',
]

// ---------------------------------------------------------------------------
// §1 知识库
// ---------------------------------------------------------------------------

export interface ChunkConfig {
  size: number
  overlap: number
  parentSize: number
  strategy: ChunkStrategy
  protects: string[]
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  size: 512,
  overlap: 0,
  parentSize: 2000,
  strategy: 'token',
  protects: ['code', 'table'],
}

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

// ---------------------------------------------------------------------------
// §2 文档 / Chunk / Layout
// ---------------------------------------------------------------------------

export interface DocSummary {
  id: string
  kbId: string
  filename: string
  mimeType: string
  sizeBytes: number
  status: DocStatus
  stageProgress: number
  parseConfigV: number
  parseEngine: string
  errorCode: string | null
  errorMessage: string | null
  layoutBlocks: number
  chunkCount: number
  enabledChunkCount?: number
  /** URL 导入来源（空 = 本地上传；契约 §26） */
  sourceUrl: string
  metaJson: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface DocDetail extends DocSummary {
  chunkConfigSnap: ChunkConfig
  storageKey: string
  middleJsonAvailable: boolean
  markdownAvailable: boolean
  sourceAvailable: boolean
}

export interface ChunkItem {
  id: string
  documentId: string
  isParent: boolean
  parentId: string | null
  seq: number
  docType: DocType
  tokenCount: number
  charStart: number
  charEnd: number
  pageFrom: number
  pageTo: number
  bboxFrom: number[]
  bboxTo: number[]
  textPreview: string
  enabled: boolean
  /** 人工编辑时间（ISO）；null = 未编辑 */
  editedAt: string | null
}

export interface ChunkFull extends ChunkItem {
  text: string
  parentText?: string
}

export interface LayoutBlock {
  idx: number
  type: 'text' | 'title' | 'table' | 'code' | 'image'
  page: number // 1-based
  bbox: [number, number, number, number] // PDF 点空间 [x0,y0,x1,y1]，原点左下
  charStart: number
  charEnd: number
  text: string // ≤200 字符
}

export interface LayoutData {
  layout: LayoutBlock[]
  pageCount: number
  pageSizes: { w: number; h: number }[]
}

export interface ChunkPreviewStats {
  total: number
  parentCount: number
  tokenMin: number
  tokenMax: number
  tokenAvg: number
  tokenP95: number
  docTypeCounts: Record<string, number>
  tookMs: number
}

export interface ChunkPreview {
  chunks: ChunkItem[]
  parents: ChunkItem[]
  stats: ChunkPreviewStats
}

// ---------------------------------------------------------------------------
// §3 检索
// ---------------------------------------------------------------------------

export interface SearchDebugBody {
  kbId: string
  query: string
  topK?: number
  mode?: SearchMode
  rerank?: boolean
  prefetchLimit?: number
  filter?: { docIds?: string[]; pageRange?: [number, number] }
  withParentContext?: boolean
  debug?: { fusion?: FusionMode; rrfK?: number; rrfWeights?: [number, number] }
}

export interface DebugRankItem {
  chunkId: string
  score: number
  page: number
  preview: string
}

export interface FusedRankItem {
  chunkId: string
  score: number
  denseRank?: number
  sparseRank?: number
}

export interface RerankRankItem {
  chunkId: string
  rerankScore: number
  prevRank: number
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
    denseTop: DebugRankItem[]
    sparseTop: DebugRankItem[]
    fusedTop: FusedRankItem[]
    rerankTop?: RerankRankItem[]
    fusion: string
    rrfK?: number
    mode: string
  }
}

// ---------------------------------------------------------------------------
// §4 API Keys
// ---------------------------------------------------------------------------

export interface ApiKeyItem {
  id: string
  name: string
  role: ApiKeyRole
  enabled: boolean
  callCount: number
  lastUsedAt: string | null
  createdAt: string
  keyPreview: string
  key?: string // 仅创建时一次性返回
}

// ---------------------------------------------------------------------------
// §5 系统
// ---------------------------------------------------------------------------

export interface HealthInfo {
  qdrant: { mode: string; ok: boolean; version?: string; message?: string }
  vectorStore: { mode: string; ok: boolean; collections: number; points: number }
  embedding: { mode: string; ok: boolean; dim?: number; model: string; message?: string }
  mineru: { mode: string; ok: boolean; message?: string }
  rerank: { mode: string; ok: boolean; model: string }
  pipeline: { pending: number; active: number; failed: number; uptimeSec: number }
}

/** /api/system/metrics-summary（Prometheus 指标 JSON 摘要） */
export interface MetricsSummary {
  process: { uptimeSec: number }
  search: { total: number; errors: number; avgMs: number | null; maxMs: number; byMode: Record<string, number> }
  store: { kbs: number; documents: Record<string, number>; chunks: number; enabledChunks: number; points: number }
  api: { calls: number }
  pipeline: { pending: number; active: number; failed: number; completed: number; uptimeSec: number }
  modes: Record<string, string>
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
  durationMs: number | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  docName?: string
}

export interface JobsStats {
  pending: number
  active: number
  completed: number
  failed: number
  byType: Record<string, number>
}

// ---------------------------------------------------------------------------
// §7 仪表盘
// ---------------------------------------------------------------------------

export interface DashboardData {
  totals: {
    kbs: number
    docs: number
    chunks: number
    points: number
    enabledChunks: number
    docsReady: number
    docsFailed: number
    docsProcessing: number
  }
  recentDocs: (DocSummary & { kbName: string })[]
  recentLogs: {
    id: string
    query: string
    collection: string
    mode: string
    tookMs: number
    resultCount: number
    source: string
    createdAt: string
  }[]
  jobs: { pending: number; active: number; failed: number }
  statusFlow: Record<string, number>
}

// ---------------------------------------------------------------------------
// §6 设置（基座路由扩展字段）
// ---------------------------------------------------------------------------

export interface RagSettings {
  id: string
  url: string
  apiKey: string
  defaultCollection: string
  embedApiBase: string
  embedApiKey: string
  embedModel: string
  rerankApiBase: string
  rerankApiKey: string
  rerankModel: string
  /** MinerU 接入方式（Task 14-e）：selfhost | cloud | cloud-agent */
  mineruProvider: string
  mineruApiUrl: string
  mineruApiKey: string
  mineruTier: string
  mineruOcrMode: string
  useFallbackParser: boolean
  useMockEmbedding: boolean
  useMockRerank: boolean
  updatedAt: string
}

export type TestKind = 'qdrant' | 'embed' | 'rerank' | 'mineru'

export interface TestResult {
  ok: boolean
  message: string
  /** mineru 探测时的接入方式（selfhost | cloud | cloud-agent） */
  provider?: string
  /** 探测细节（端点/原因，失败时辅助排查） */
  detail?: string
  dim?: number
  version?: string
}

// ---------------------------------------------------------------------------
// §9 Socket 事件
// ---------------------------------------------------------------------------

export interface DocumentStatusEvent {
  docId: string
  kbId: string
  status: DocStatus
  stageProgress: number
  errorCode?: string
  errorMessage?: string
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
  status: DocStatus
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
  error?: string
  durationMs?: number
}

export interface PipelineActivityEvent {
  at: string
  level: 'info' | 'warn' | 'error' | string
  message: string
}

// ---------------------------------------------------------------------------
// §10 备份与恢复（/api/system/backups）
// ---------------------------------------------------------------------------

export interface BackupItem {
  id: string
  createdAt: string
  /** 平台版本标识（schema 兼容性提示用） */
  version: string
  /** 备份内容统计 */
  counts: {
    kbs: number
    docs: number
    chunks: number
    points: number
    keys: number
    jobs: number
  }
  /** 文件体积（字节；total 含 Qdrant 快照） */
  sizes: { db: number; artifacts: number; total: number }
  /** 备份时向量模式（v1.6 起仅 qdrant；旧备份可能为 local，仅展示用） */
  vectorMode: string
  /** 备份时平台设置摘要 */
  settingsSummary: Record<string, unknown>
  /** 是否含 artifacts 产物目录 */
  includesArtifacts: boolean
  /** §29 是否内嵌 Qdrant 快照文件（qdrant 模式创建且未显式关闭时 true） */
  includesQdrantSnapshots: boolean
  /** §29 内嵌快照清单（备份目录 qdrant-snapshots/ 下） */
  qdrantSnapshots?: { collection: string; file: string; sizeBytes: number }[]
  /** §29 创建/恢复过程中的非致命警告（单集合快照失败等；备份本身成功） */
  warnings?: string[]
  /** 是否定时任务自动创建（本地扩展契约字段） */
  auto?: boolean
}

export interface RestoreResult {
  ok: true
  restored: {
    kbs: number
    docs: number
    chunks: number
    points: number
    keys: number
    jobs: number
    settings: boolean
    artifactsFiles: number
    /** §29 成功恢复的 Qdrant 集合数（未恢复/不含快照时 0） */
    qdrantRestored: number
  }
  backupId: string
  tookMs: number
  /** §29 非致命警告（单集合恢复失败等；面板数据已恢复成功） */
  warnings?: string[]
}

// ---------------------------------------------------------------------------
// §11 检索测试集（/api/kb/[id]/testcases）
// ---------------------------------------------------------------------------

export interface TestCaseParams {
  mode?: SearchMode
  topK?: number
  prefetchLimit?: number
  rerank?: boolean
  fusion?: FusionMode
  rrfK?: number
  rrfWeights?: [number, number]
}

export interface TestCaseItem {
  id: string
  kbId: string
  name: string
  query: string
  expectDocIds: string[]
  /** 可选 chunk 级金标准：非空时 pass 需全部命中 */
  expectChunkIds: string[]
  params: TestCaseParams
  enabled: boolean
  createdAt: string
  updatedAt: string
  /** 最近一次运行结果（空对象 = 从未运行） */
  lastRun: {
    pass?: boolean
    hitRate?: number
    mrr?: number
    tookMs?: number
    ranAt?: string
    hits?: string[]
    misses?: string[]
    chunkPass?: boolean
    chunkMisses?: string[]
    resultTop?: { chunkId: string; docId: string; filename: string; score: number; rank: number }[]
  }
  /** 结果过期：KB 下有 chunk 在 lastRun 之后被人工编辑（rerun 可刷新） */
  stale?: boolean
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
  /** chunk 级金标准结果（配置了 expectChunkIds 时有效） */
  chunkPass?: boolean
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
// §12 chunk 批量操作与导出（/api/documents/[id]/chunks/batch | export）
// ---------------------------------------------------------------------------

export interface ChunkBatchResult {
  ok: true
  action: 'enable' | 'disable'
  updated: number
  /** 向量 payload 同步失败的 chunk 数（非致命，DB 已更新） */
  payloadSyncFailed: number
}

// ---------------------------------------------------------------------------
// §14 仪表盘检索质量趋势（/api/dashboard/trends，数据源 QdrantCallLog）
// ---------------------------------------------------------------------------

export interface TrendDay {
  /** yyyy-MM-dd */
  date: string
  /** 当日检索次数 */
  searches: number
  /** 平均耗时 ms */
  avgMs: number
  /** P95 耗时 ms */
  p95Ms: number
  /** 平均结果数 */
  avgResults: number
  /** 空结果次数（resultCount=0） */
  zeroResults: number
}

export interface TopQueryItem {
  query: string
  count: number
  avgMs: number
  avgResults: number
  lastAt: string
  /** 主要来源：debug-console | external | web-ui */
  source: string
}

export interface ModeBreakdownItem {
  mode: string
  count: number
  avgMs: number
}

export interface DashboardTrends {
  /** 最近 N 天（含空日补零），倒序→正序由前端决定 */
  days: TrendDay[]
  topQueries: TopQueryItem[]
  modeBreakdown: ModeBreakdownItem[]
  totals: { searches: number; avgMs: number; p95Ms: number; zeroRate: number }
}

// ---------------------------------------------------------------------------
// §15 备份定时任务配置（/api/system/backups/schedule）
// ---------------------------------------------------------------------------

export interface BackupSchedule {
  enabled: boolean
  intervalHours: number
  keep: number
  /** 下次自动备份时间（null = 未启用或调度器异常） */
  nextRunAt: string | null
  /** 上次自动备份时间 */
  lastRunAt: string | null
  /** 上次自动备份产物 ID（可下载） */
  lastBackupId: string | null
  /** 调度器进程状态 */
  schedulerRunning: boolean
  /** 自动备份累计成功/失败计数（进程内，重启清零） */
  runCount: number
  failCount: number
}

// ---------------------------------------------------------------------------
// §16 文档文档版本管理（/api/documents/[id]/versions[?v1=&v2=]，契约 §17）
// ---------------------------------------------------------------------------

export interface DocVersionInfo {
  /** 'current'（DB 当前） | '1'/'2'…（文件快照） */
  version: string
  source: 'snapshot' | 'current'
  createdAt: string
  chunkCount: number
  totalTokens: number
  chunkConfigSnap: string
  docStatus: string
  parseEngine: string
  /** §27 快照元信息（恢复/删除操作依据；current 无此字段） */
  meta?: {
    version: number
    createdAt: string
    docStatus: string
    parseEngine: string
    chunkConfigSnap: string
    chunkCount: number
    totalTokens: number
    /** 快照是否含全文（§27 增强后创建的快照才可无损恢复） */
    hasFullText?: boolean
  }
}

/** §27 版本恢复结果 */
export interface RestoreVersionResult {
  ok: true
  /** 恢复产生的新版本号 */
  restoredVersion: number
  fromVersion: string
  chunkCount: number
  /** 缺 fullText 降级用 textPreview 的 chunk 数 */
  degradedChunks: number
}

export type VersionDiffType = 'same' | 'added' | 'removed' | 'changed'

export interface VersionDiffChunk {
  seq: number
  textPreview: string
  tokenCount: number
  charStart: number
  charEnd: number
}

export interface VersionDiffItem {
  type: VersionDiffType
  v1?: VersionDiffChunk
  v2?: VersionDiffChunk
  /** type=changed 时的文本相似度 0-1 */
  similarity?: number
}

export interface VersionConfigDiffEntry {
  key: string
  v1: string
  v2: string
}

export interface VersionCompareResult {
  doc: { id: string; filename: string }
  v1: DocVersionInfo
  v2: DocVersionInfo
  summary: {
    same: number
    added: number
    removed: number
    changed: number
    v1Chunks: number
    v2Chunks: number
    v1Tokens: number
    v2Tokens: number
  }
  configDiff: VersionConfigDiffEntry[]
  items: VersionDiffItem[]
}

// ---------------------------------------------------------------------------
// §17 异步测试集运行状态（/api/kb/[id]/testcases/run[?async]，契约 §21）
// ---------------------------------------------------------------------------

export type TestRunStatus = 'running' | 'done' | 'error'

export interface TestRunState {
  runId: string
  kbId: string
  kbName: string
  status: TestRunStatus
  total: number
  done: number
  current?: string
  startedAt: string
  finishedAt?: string
  error?: string
  report?: TestRunReport
}

// ---------------------------------------------------------------------------
// §23 Qdrant 快照（/api/qdrant/snapshots，契约 §23；qdrant 模式专用，local 模式返回 400）
// ---------------------------------------------------------------------------

export interface QdrantSnapshotItem {
  name: string
  collection: string
  /** epoch 毫秒（qdrant creation_time 秒 → 毫秒） */
  createdAt: number
  /** 字节（qdrant size 字段） */
  sizeBytes: number
  /** 下载直链（经平台代理，相对路径） */
  downloadUrl: string
}

export interface QdrantSnapshotListResult {
  /** 当前向量库模式（qdrant = 可用；未配置时接口直接 400） */
  vectorMode: string
  collections: { collection: string; snapshots: QdrantSnapshotItem[] }[]
  /** 各集合快照总数 */
  totalSnapshots: number
}

// ---------------------------------------------------------------------------
// §24 测试集运行历史（/api/kb/[id]/testruns，契约 §24；进程内注册表，重启清零）
// ---------------------------------------------------------------------------

export interface TestRunHistoryItem {
  runId: string
  kbId: string
  kbName: string
  status: TestRunStatus
  total: number
  done: number
  startedAt: string
  finishedAt?: string
  error?: string
  /** status=done 时的汇总（完整报告不含 cases 明细，减小载荷） */
  summary?: {
    passed: number
    failed: number
    hitRateAvg: number
    mrrAvg: number
    tookMsTotal: number
  }
}

// ---------------------------------------------------------------------------
// §28 实时活动流 / 任务中心（/api/activity，契约 §28）
// ---------------------------------------------------------------------------

/** 活动流文档行（DocSummary + kbName 装饰） */
export interface ActivityDoc {
  id: string
  kbId: string
  kbName: string
  filename: string
  mimeType: string
  sizeBytes: number
  status: DocStatus
  stageProgress: number
  parseConfigV: number
  parseEngine: string
  errorCode: string | null
  errorMessage: string | null
  layoutBlocks: number
  chunkCount: number
  sourceUrl: string
  metaJson: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ActivityResponse {
  running: ActivityDoc[]
  failed: ActivityDoc[]
  stats: { runningCount: number; failedCount: number }
}

// ---------------------------------------------------------------------------
// §29 备份一体化（面板 + Qdrant 快照：一同创建 / 下载 / 恢复 + 上传恢复）
// ---------------------------------------------------------------------------

/** 已上传 Qdrant 快照行（GET /api/system/backups/upload） */
export interface UploadedQdrantSnapshot {
  fileName: string
  sizeBytes: number
  createdAt: string
  /** 从文件名推断的目标集合（现有集合最长前缀匹配，否则首段） */
  inferredCollection: string
}

/** 上传响应：完整备份包（导入备份列表）或单独 Qdrant 快照 */
export type BackupUploadResult =
  | { kind: 'backup'; backup: BackupItem }
  | { kind: 'qdrant-snapshot'; fileName: string; sizeBytes: number }

// ---------------------------------------------------------------------------
// §29-A 平台资源占用（GET /api/system/resources）
// ---------------------------------------------------------------------------

export interface ResourceUsage {
  process: {
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    /** 进程 CPU 占用 %（两次采样差分，首次请求 0） */
    cpuPercent: number
    uptimeSec: number
    pid: number
  }
  system: {
    totalMemBytes: number
    freeMemBytes: number
    usedMemPercent: number
    loadavg: [number, number, number]
    cpuCount: number
    platform: string
    nodeVersion: string
    hostname: string
  }
  disk: {
    /** {cwd}/db 目录（不含 backups 子目录） */
    dbBytes: number
    artifactsBytes: number
    backupsBytes: number
  }
}
