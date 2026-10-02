# RAG 知识库平台 · API 与模块契约 v1.0

> 本文档是前后端并行开发的**唯一契约**。后端按此实现 API，前端按此调用。
> 所有响应统一 `{ error: string }` 错误格式（HTTP 非 2xx）。

## 0. 核心概念

- **向量存储双模式**：`qdrant`（配置了 Qdrant URL 且可达）| `local`（内置 SQLite 向量引擎，沙箱演示）。前端无需关心，后端 `lib/vectorstore` 自动路由。
- **解析双模式**：`mineru`（配置了 MinerU API URL）| `fallback`（内置降级解析器：md/txt/html 直接转 markdown；pdf 用 pdfjs 提取文本+坐标生成 layout）。
- **嵌入双模式**：`real`（OpenAI 兼容 /embeddings）| `mock`（确定性哈希特征向量 + 词法 sparse）。
- **状态机**：`queued → parsing → chunking → embedding → upserting → ready | failed`
- **实时事件**：socket.io 连接 `io('/?XTransformPort=3003')`，事件见 §9。

## 1. 知识库 `/api/kb`

### GET /api/kb
→ `{ kbs: KbSummary[] }`
```ts
interface KbSummary {
  id: string; name: string; description: string;
  collection: string; embeddingModel: string; dim: number;
  chunkConfig: ChunkConfig; vectorMode: 'local'|'qdrant';
  rerankEnabled: boolean;
  docCount: number; chunkCount: number; pointCount: number;
  createdAt: string; updatedAt: string;
}
interface ChunkConfig {
  size: number;        // 子 chunk token 目标，默认 512
  overlap: number;     // 重叠 token，默认 0
  parentSize: number;  // 父 chunk token 上限，默认 2000
  strategy: 'token'|'title'|'hybrid';
  protects: string[];  // 原子保护块类型 ['code','table']
}
```

### POST /api/kb
Body: `{ name, description?, embeddingModel?, dim?, chunkConfig?, rerankEnabled? }`
→ 201 `{ kb: KbSummary }`（自动建 collection：qdrant 模式按计划书 §6.3 固化配置；local 模式建内置引擎集合）
错误：name 重复 409。

### GET /api/kb/[id]
→ `{ kb: KbSummary & { recentDocs: DocSummary[] } }`

### PATCH /api/kb/[id]
Body: `{ name?, description?, chunkConfig?, rerankEnabled? }`（dim/embeddingModel 建库后不可改）
→ `{ kb: KbSummary }`

### DELETE /api/kb/[id]
级联删除：文档 + chunks + 向量集合 + 磁盘产物。→ `{ ok: true, deleted: {...} }`

## 2. 文档 `/api/kb/[id]/documents` + `/api/documents/[id]`

### GET /api/kb/[id]/documents?status=&q=&limit=&offset=
→ `{ docs: DocSummary[]; total: number }`
```ts
interface DocSummary {
  id: string; kbId: string; filename: string; mimeType: string;
  sizeBytes: number; status: DocStatus; stageProgress: number;
  parseConfigV: number; parseEngine: string;
  errorCode: string|null; errorMessage: string|null;
  layoutBlocks: number; chunkCount: number; enabledChunkCount?: number;
  metaJson: Record<string,any>; createdAt: string; updatedAt: string;
}
type DocStatus = 'queued'|'parsing'|'chunking'|'embedding'|'upserting'|'ready'|'failed';
```

### POST /api/kb/[id]/documents （multipart/form-data）
字段：`file`（支持 .pdf .md .markdown .txt .html）+ 可选 `chunkConfig`（JSON 字符串，仅本次覆盖）
流程：流式 sha256 → 秒传判定（同 kb+hash+parseConfigV 直接返回已有文档）→ 落盘 source → 建 Document(queued) → 入流水线
→ 201 `{ doc: DocSummary, deduplicated: boolean }`（秒传 deduplicated=true）

### GET /api/documents/[id]
→ `{ doc: DocSummary & { chunkConfigSnap: ChunkConfig, storageKey: string, middleJsonAvailable: boolean, markdownAvailable: boolean, sourceAvailable: boolean } }`

### POST /api/documents/[id]/action
Body: `{ action: 'reparse' | 'rechunk' | 'retry' , chunkConfig?: ChunkConfig }`
- `reparse`：重走全流水线（parse_config_v+1）
- `rechunk`：只重切分（跳过解析，parse_config_v+1，先清旧 chunk/向量）
- `retry`：失败重试（从失败阶段续跑）
→ `{ ok: true }`

### DELETE /api/documents/[id]
级联：向量 delete(filter doc_id) → chunk 行 → document 行 → 磁盘产物目录 → count 校验
→ `{ ok: true, deletedChunks: number }`

### GET /api/documents/[id]/file?kind=source|markdown|middle
→ 原始字节流（Content-Type 相应；middle 返回 JSON）

### GET /api/documents/[id]/chunks?limit=50&offset=0&parentOnly=false&q=
→ `{ chunks: ChunkItem[]; total: number }`
```ts
interface ChunkItem {
  id: string; documentId: string; isParent: boolean; parentId: string|null;
  seq: number; docType: 'text'|'table'|'code'|'image';
  tokenCount: number; charStart: number; charEnd: number;
  pageFrom: number; pageTo: number;
  bboxFrom: number[]; bboxTo: number[];
  textPreview: string; enabled: boolean; editedAt: string|null;
}
```

### GET /api/documents/[id]/chunk/[chunkId]?full=1
→ `{ chunk: ChunkItem & { text: string, parentText?: string } }`（full=1 读落盘全文）

### PATCH /api/documents/[id]/chunk/[chunkId]
Body（三种互斥分支）：
- `{ enabled?: boolean }` 软禁用：payload.enabled + 检索恒过滤；Qdrant 模式同步更新 payload
- `{ text: string }` 编辑全文（M6 T6.6）：备份原文 chunks/{id}.orig.txt → 写新全文 → 重嵌入 → 同 ID 原地 upsert 向量点；仅子 chunk 可编辑
- `{ revert: true }` 还原原文：从 .orig.txt 恢复 → 重嵌入 → editedAt 置空；无备份时报 400
→ `{ chunk: ChunkItem, result?: { chunkId, oldTokens, newTokens, embedMode, tookMs } }`

### DELETE /api/documents/[id]/chunk/[chunkId]
删除单 chunk：向量点 + 行 + 磁盘。→ `{ ok: true }`

### POST /api/documents/[id]/chunk-preview
Body: `{ chunkConfig: ChunkConfig }` —— 只读缓存产物重切，零外部调用，不落库
→ `{ preview: { chunks: ChunkItem[]; parents: ChunkItem[]; stats: { total, parentCount, tokenMin, tokenMax, tokenAvg, tokenP95, docTypeCounts, tookMs } } }`

### GET /api/documents/[id]/layout
→ `{ layout: LayoutBlock[]; pageCount: number; pageSizes: {w:number,h:number}[] }`（middle.json 提取，供三屏高亮）
```ts
interface LayoutBlock {
  idx: number; type: 'text'|'title'|'table'|'code'|'image';
  page: number;                 // 1-based
  bbox: [number,number,number,number]; // PDF 点空间
  charStart: number; charEnd: number;  // 对应 full.md 字符范围
  text: string;                 // ≤200 字符
}
```

## 3. 检索（生产 API + 调试台同路径）

### POST /api/search/debug  （Web 调试台用，无需 API Key）
Body:
```ts
{
  kbId: string;
  query: string;
  topK?: number;              // 默认 5
  mode?: 'hybrid'|'dense'|'sparse';  // 默认 hybrid
  rerank?: boolean;           // 默认 false
  prefetchLimit?: number;     // 默认 50
  filter?: { docIds?: string[]; pageRange?: [number,number] };
  withParentContext?: boolean; // 默认 true
  debug?: { fusion?: 'rrf'|'dbsf'; rrfK?: number; rrfWeights?: [number,number] };
}
```
→ `{ result: SearchResponse }`
```ts
interface SearchResponse {
  tookMs: number;
  stages: { embedMs: number; recallMs: number; fusionMs: number; rerankMs: number; contextMs: number };
  results: SearchHit[];
  debug: {
    embed: { dim: number; denseHash: string; denseFirst8: number[]; sparseNnz: number; provider: string };
    denseTop: { chunkId: string; score: number; page: number; preview: string }[];   // Top N 原始分
    sparseTop: { chunkId: string; score: number; page: number; preview: string }[];
    fusedTop: { chunkId: string; score: number; denseRank?: number; sparseRank?: number }[]; // 融合后 + 前序 rank
    rerankTop?: { chunkId: string; rerankScore: number; prevRank: number }[];
    fusion: string; rrfK?: number; mode: string;
  };
}
interface SearchHit {
  chunkId: string; score: number; rerankScore?: number|null;
  text: string; parentText?: string|null;
  source: {
    docId: string; filename: string; page: number;
    bbox: number[]|null; seq: number; docType: string;
  };
}
```

### POST /api/v1/knowledge-bases/[kbId]/search （对外 Agent API，Bearer 鉴权）
Header: `Authorization: Bearer <ApiKey>`
Body 同上（无 kbId 字段；`debug` 参数需 operator+ 角色，readonly 传 debug 返回 400）
→ 同 SearchResponse（external 来源自动写 QdrantCallLog）
错误：401 无 Key / 403 无权限 / 404 KB 不存在。

## 4. API Keys `/api/apikeys`

### GET /api/apikeys → `{ keys: { id,name,role,enabled,callCount,lastUsedAt,createdAt, keyPreview }[] }`（不返回完整 key）
### POST /api/apikeys Body: `{ name, role?: 'admin'|'operator'|'readonly' }`
→ 201 `{ key: {..., key: '完整key仅此一次返回'} }`（格式 `rag-` + 32 hex）
### PATCH /api/apikeys/[id] Body: `{ enabled?: boolean }` → `{ key }`
### DELETE /api/apikeys/[id] → `{ ok: true }`

## 5. 系统 `/api/system`

### GET /api/system/health
→ `{ health: { qdrant: {mode, ok, version?, message}, vectorStore: {mode, ok, collections, points}, embedding: {mode, ok, dim?, model, message}, mineru: {mode, ok, message}, rerank: {mode, ok, model}, pipeline: {mode:'engine', ok, message, pending, active, failed, uptimeSec} } }`

### GET /api/metrics
Prometheus 文本格式（`text/plain; version=0.0.4`）。指标族：
`rag_process_uptime_seconds` / `rag_search_requests_total{mode}` / `rag_search_errors_total` / `rag_search_duration_ms_{sum,count,max}` / `rag_kbs_total` / `rag_documents_total{status}` / `rag_chunks_total` / `rag_chunks_enabled_total` / `rag_vector_points_total` / `rag_apikey_calls_total` / `rag_pipeline_jobs_total{status,type}` / `rag_pipeline_queue_depth{status}` / `rag_pipeline_uptime_seconds` / `rag_component_mode{component,mode}`
（检索计数器为进程内计数，重启清零；DB 聚合指标持久）

### GET /api/system/metrics-summary
→ `{ summary: { process:{uptimeSec}, search:{total,errors,avgMs,maxMs,byMode}, store:{kbs,documents,chunks,enabledChunks,points}, api:{calls}, pipeline:{pending,active,failed,completed,uptimeSec}, modes } }`（OpsView 指标卡）

### GET /api/system/jobs?status=&type=&limit=50
→ `{ jobs: JobItem[]; stats: { pending, active, completed, failed, byType: Record<string,number> } }`
```ts
interface JobItem { id, documentId, kbId, type, status, attempts, maxAttempts, error, durationMs, createdAt, startedAt, finishedAt, docName? }
```

### POST /api/system/jobs/[id]/retry → `{ ok: true }`（failed → pending 重排队）
### POST /api/system/jobs/clean Body: `{ status?: 'completed'|'failed', olderThanHours?: number }` → `{ cleaned: number }`

## 6. 基座工作台（保留，路由走 vectorstore 适配器）

原有 `/api/qdrant/*` 全部保留（settings/collections/points/search/call-logs/test），collections 系列改为优先真实 Qdrant、未配置时读内置引擎（响应结构不变，见基座 types.ts）。
Settings 扩展字段：`mineruApiUrl, mineruApiKey, mineruTier, mineruOcrMode, useLocalVectorStore, useFallbackParser, useMockEmbedding, useMockRerank`（PUT /api/qdrant/settings 同步支持，POST /api/qdrant/test 增加 kind: 'mineru'）。

## 7. 仪表盘 `/api/dashboard`

### GET /api/dashboard
→ `{ dashboard: {
  totals: { kbs, docs, chunks, points, enabledChunks, docsReady, docsFailed, docsProcessing };
  recentDocs: (DocSummary & {kbName})[];       // 最近 10
  recentLogs: { id, query, collection, mode, tookMs, resultCount, source, createdAt }[];  // 最近 10
  jobs: { pending, active, failed };
  statusFlow: Record<string, number>;          // 各状态文档数
} }`

## 8. 内部模块契约（src/lib，后端实现依据）

```
src/lib/
  db.ts                  # 已有 Prisma 单例
  qdrant.ts              # 已有（基座）—— 保留
  rag/
    types.ts             # 共享类型（上述 interface 的服务端版本）
    settings.ts          # getRagSettings()：读 QdrantSetting 单例 + 双模式判定
    vectorstore.ts       # VectorStore 接口 + LocalVectorStore + QdrantVectorStore + getVectorStore()
    chunking.ts          # 纯函数切分引擎（计划书 §11.2 Phase1-4）：parseMarkdownBlocks/buildParentChild/splitChildren/坐标回填
    mineru.ts            # MinerUClient 六步协议（§5.2）+ FallbackParser（md/txt/html/pdf 降级）
    embed.ts             # embedTexts(): real(OpenAI 兼容) | mock(哈希特征)；embedQuery 同
    rerank.ts            # rerankDocs(): real | mock(BM25 词法)
    search.ts            # 检索管线（§12.1 六阶段，生产/调试同路径）
    artifacts.ts         # 产物目录管理：{ARTIFACTS_DIR}/{kbId}/{docId}/source|full.md|middle.json|chunks/
    ids.ts               # uuidv5 确定性 chunk ID（§14.7）
    events.ts            # emitPipelineEvent(): HTTP POST → mini-service:3003
    pipeline.ts          # 流水线引擎（globalThis 单例 tick loop，四阶段 job 执行器，状态回写，事件推送）
```

## 9. Socket.io 实时事件（mini-service 端口 3003）

- 连接：`io('/?XTransformPort=3003', { transports:['websocket','polling'] })`
- 客户端 `emit('subscribe', { rooms: string[] })`，room 约定：`kb:{kbId}`、`doc:{docId}`、`global`
- 服务端事件（mini-service 收到 POST /emit 后广播）：
  - `document:status` `{ docId, kbId, status, stageProgress, errorCode?, errorMessage? }`
  - `document:progress` `{ docId, kbId, stage, progress, message? }`（阶段内部进度）
  - `document:done` `{ docId, kbId, status, chunkCount, tookMs }`
  - `kb:stats` `{ kbId, docCount, chunkCount, pointCount }`
  - `job:update` `{ jobId, documentId, type, status, error?, durationMs }`
  - `pipeline:activity` `{ at, level, message }`（运维活动流）
  - `chunk:update` `{ chunkId, docId, kbId, action: 'edit'|'revert', tokenCount }`（chunk 编辑/还原重入库）

## 10. 产物目录布局（计划书 §9.3）

```
{ARTIFACTS_DIR = /home/z/my-project/artifacts}/
  {kbId}/{docId}/
    source.<ext>       # 原始文件
    full.md            # 解析 markdown
    middle.json        # layout+bbox（{ pages: {w,h}[], blocks: LayoutBlock[] }）
    chunks/{chunkId}.txt      # chunk 全文
    chunks/{chunkId}.orig.txt # 人工编辑前的原文备份（仅编辑过的 chunk 存在，用于还原）
```
storage_key 一律存相对路径 `{kbId}/{docId}/...`。

## 11. 备份与恢复 `/api/system/backups`（M8 运维增强）

备份内容：SQLite 快照（`VACUUM INTO` 一致性在线备份）+ artifacts 产物目录（可选）+ manifest.json。
备份存储：`{DB_DIR}/backups/{backupId}/`（db.sqlite / artifacts/ / manifest.json）。
local 向量引擎的向量数据在 VectorPoint 表中随库备份；qdrant 模式需另行 Qdrant snapshot（UI 提示）。

- `GET /api/system/backups` → `{ backups: BackupItem[] }`（按 createdAt 倒序）
- `POST /api/system/backups` body `{ includeArtifacts?: boolean = true }` → `{ backup: BackupItem }`
- `GET /api/system/backups/[id]/download` → `application/x-tar` 流（Content-Disposition attachment，整个备份目录 tar 打包）
- `DELETE /api/system/backups/[id]` → `{ ok: true }`
- `POST /api/system/backups/[id]/restore` → `{ result: RestoreResult }`
  - 恢复语义：独立 PrismaClient 读备份库 → 主库事务内 deleteMany + createMany 全表复制（QdrantSetting/ApiKey/QdrantCallLog/KnowledgeBase/Document/Chunk/PipelineJob/VectorPoint/RetrievalTestCase）→ artifacts 目录整体替换 → 返回恢复计数
  - 注意：恢复为破坏性操作（覆盖当前数据），UI 必须 AlertDialog 二次确认

```ts
BackupItem = {
  id: string            // yyyyMMdd-HHmmss-xxxx
  createdAt: string
  version: string       // schema 版本标识
  counts: { kbs; docs; chunks; points; keys; jobs }
  sizes: { db; artifacts; total }   // 字节
  vectorMode: string    // local | qdrant（qdrant 时提示需单独 snapshot）
  settingsSummary: Record<string, unknown>
  includesArtifacts: boolean
}
RestoreResult = { ok: true; restored: { kbs; docs; chunks; points; keys; jobs; settings: boolean; artifactsFiles }; backupId; tookMs }
```

## 12. 检索测试集（金标准回归）`/api/kb/[id]/testcases`

用例 = 查询 + 期望命中文档集合（金标准）+ 参数快照。运行走与生产同路径的 runSearch（调试即生产）。
指标：hitRate = |期望 ∩ TopK 结果文档| / |期望|；MRR = 1 / 首个期望文档的最高排名；pass = hitRate === 1。

- `GET /api/kb/[id]/testcases` → `{ cases: TestCaseItem[]; docs: DocSummary[] }`（docs 供前端选择期望文档）
- `POST /api/kb/[id]/testcases` body `{ name, query, expectDocIds: string[], params?: TestCaseParams }` → `{ testCase }`
- `PATCH /api/testcases/[id]` body `{ name?; query?; expectDocIds?; params?; enabled? }` → `{ testCase }`
- `DELETE /api/testcases/[id]` → `{ ok: true }`
- `POST /api/kb/[id]/testcases/run` body `{ caseIds?: string[]; onlyEnabled?: boolean = true }` → `{ report: TestRunReport }`
  - 逐用例运行（失败不中断，error 记入用例结果）；每例结果写回 lastRunJson；汇总 pass 率 / hitRate 均值 / MRR 均值 / 耗时

```ts
TestCaseParams = { mode?; topK?; prefetchLimit?; rerank?; fusion?; rrfK?; rrfWeights? }
TestRunReport = { ranAt; total; passed; failed; hitRateAvg; mrrAvg; tookMsAvg; tookMsTotal; cases: TestRunCaseResult[] }
TestRunCaseResult = { caseId; name; query; pass; hitRate; mrr; tookMs; hits: string[]; misses: string[]; resultTop: {chunkId;docId;filename;score;rank}[]; error? }
```

## 13. chunk 批量操作与导出 `/api/documents/[id]/chunks/batch | export`

- `POST /api/documents/[id]/chunks/batch` body `{ action: 'enable'|'disable', chunkIds?: string[], scope?: 'children'|'all' }`
  → `ChunkBatchResult = { ok, action, updated, payloadSyncFailed }`
  - chunkIds 指定集合；否则按 scope（children = 仅子 chunk，默认；all = 含父 chunk）
  - DB updateMany + 向量 setPayload 批量同步（payload 同步失败仅计数，不回滚 DB）
- `GET /api/documents/[id]/chunks/export?format=json|csv|md&includeParents=0|1` → 文件下载
  - json：`{ doc, chunks: ChunkItem & { text }[] }`
  - csv：UTF-8 BOM，列 seq,isParent,docType,tokenCount,pageFrom,pageTo,enabled,editedAt,text（text 内换行/引号 CSV 转义）
  - md：按 seq 重组 markdown（`## chunk {seq} · {docType}` 分节）

## 14. 仪表盘检索质量趋势 `/api/dashboard/trends`（数据源 QdrantCallLog）

- `GET /api/dashboard/trends?days=14` → `{ trends: DashboardTrends }`
  - days：1-90，默认 14；返回按日聚合（空日补零）+ 热门查询 Top 10 + 模式分布 + 全期汇总

```ts
TrendDay = { date: 'yyyy-MM-dd'; searches: number; avgMs: number; p95Ms: number; avgResults: number; zeroResults: number }
TopQueryItem = { query; count; avgMs; avgResults; lastAt; source }
ModeBreakdownItem = { mode; count; avgMs }
DashboardTrends = { days: TrendDay[]; topQueries: TopQueryItem[]; modeBreakdown: ModeBreakdownItem[]; totals: { searches; avgMs; p95Ms; zeroRate } }
```

## 15. 备份定时任务 `/api/system/backups/schedule`

进程内调度器（globalThis 单例 setInterval，复用 createBackup）；自动备份产物与手动备份同目录同结构，manifest 中可含 auto: true 标记；轮转清理只删除**自动备份**（按 keep 保留最近 N 份），手动备份不动。

- `GET /api/system/backups/schedule` → `{ schedule: BackupSchedule }`
- `PUT /api/system/backups/schedule` body `{ enabled?; intervalHours?; keep? }`（intervalHours 2-168、keep 2-50，越界 clamp）→ `{ schedule }`
  - 调度器语义：enabled=true 时启动定时器（每分钟检查 nextRunAt）；改配置即热重载（clear + 重建）；nextRunAt = lastRunAt/max(now, 启动时间) + intervalHours
  - schedule GET 每次调用确保调度器与 DB 配置一致（惰性同步，防进程重启后未启动）

```ts
BackupSchedule = { enabled; intervalHours; keep; nextRunAt: string|null; lastRunAt: string|null; lastBackupId: string|null; schedulerRunning: boolean; runCount: number; failCount: number }
```

## 16. 测试集 chunk 级金标准（扩展 §12）

RetrievalTestCase 新增 `expectChunkIds`（JSON string[]，默认空）。语义：
- 非空时为**严格模式**：pass = 期望 chunk 全部出现在 Top-K 结果（chunkPass 字段），未命中 chunk 逐条列入 chunkMisses（chunk ID 短码）；文档级 hitRate/MRR 照常计算
- 为空时行为不变（文档级 pass）
- POST/PATCH body 增加 `expectChunkIds?: string[]`；用例详情返回 `expectChunkIds`；运行结果增加 `chunkPass?/chunkMisses?`

## 17. 文档版本快照与对比 `/api/documents/[id]/versions`

**快照机制**：POST action（reparse / rechunk）在 parseConfigV 递增**之前**归档当前 chunk 集（best-effort，失败不阻塞动作）。存储：`{ARTIFACTS_ROOT}/{kbId}/{docId}/versions/v{n}.json`（幂等：同版本文件已存在则跳过；空文档不快照；随备份 includeArtifacts 留存）。版本标识：`'current'` = DB 当前 chunk；`'1'/'2'…` = 文件快照。

- `GET /api/documents/[id]/versions` → `{ versions: DocVersionInfo[] }`（current 在前，快照按版本号倒序）
- `GET /api/documents/[id]/versions/compare?v1=&v2=` → `{ compare: VersionCompareResult }`（v1 ≠ v2；v2 默认 'current'）
  - diff 算法：内容指纹（isParent + textPreview sha1 前 16 位）序列上 LCS 锚点 → matched=same；v1 独有=removed、v2 独有=added；相邻未匹配段按序两两配对=changed（bigram dice 相似度 0-1）
  - items 数量不做截断（同文档 chunk 量级 < 500）

```ts
DocVersionInfo = { version: 'current'|'1'|'2'…; source: 'snapshot'|'current'; createdAt; chunkCount; totalTokens; chunkConfigSnap: string(JSON); docStatus; parseEngine }
VersionDiffChunk = { seq; textPreview; tokenCount; charStart; charEnd }
VersionDiffItem = { type: 'same'|'added'|'removed'|'changed'; v1?: VersionDiffChunk; v2?: VersionDiffChunk; similarity?: number }
VersionConfigDiffEntry = { key; v1: string; v2: string }   // chunkConfigSnap 逐 key 对比，值不同才列出
VersionCompareResult = { doc: { id; filename }; v1: DocVersionInfo; v2: DocVersionInfo; summary: { same; added; removed; changed; v1Chunks; v2Chunks; v1Tokens; v2Tokens }; configDiff: VersionConfigDiffEntry[]; items: VersionDiffItem[] }
```

## 18. 测试集结果过期标注（扩展 §12 / §16）

`GET /api/kb/[id]/testcases` 用例列表新增 `stale: boolean`：该用例 `lastRun.ranAt` 之后，KB 下存在 chunk 被人工编辑（Chunk.editedAt > ranAt）或文档重新解析/切分（Document.parseConfigV 变化对应 updated chunk 集）→ 结果过期，需重跑刷新。UI 端展示为 amber 徽标「结果过期」+ 一键回归入口。runTestCases 运行后 stale 自然复位。

## 19. 快捷动作事件落地（前端契约）

命令面板（§8-b）快捷动作派发的 CustomEvent 监听端：

| 事件 | 监听视图 | 行为 |
|---|---|---|
| `rag:quick-create-kb` | 知识库 | 自动打开「新建知识库」Dialog |
| `rag:quick-run-tests` | 测试集回归 | 自动触发一键回归（带确认或直接跑） |
| `rag:quick-backup` | 系统运维 | 自动触发「创建备份」 |
| `rag:quick-create-key` | Agent API | 自动打开「新建 API Key」Dialog |

事件 detail `{ from: 'command-palette' }`；监听端 useQuickAction(eventName, handler) 统一封装（挂载时订阅、卸载时清理）。趋势图下钻：点击趋势卡某天 → `setView('retrieval')` + store.retrievalDateFilter='YYYY-MM-DD' → 检索调试台历史侧栏打开并按该日过滤（消费后清除）。

## 20. Qdrant 真实模式联调补充（2026-10-02，v1.9.7 实测）

- **模式切换**：PUT /api/qdrant/settings 设 url → qdrant 模式（url 空 → local）；健康检查 vectorStore.mode/ok/collections/points 实时反映；不可达自动降级 local 并告警
- **payload index 版本兼容**（ensureCollection）：对象形式 field_schema（memory/enable_hnsw/range/lookup 为 1.10+/1.14+ 特性）在 1.9.x 会 400（untagged enum 严格解析）→ **自动降级字符串简写**（"keyword"/"integer"）重试成功；index 仅影响过滤性能不阻塞功能
- **检索语义**：
  - mode 非法值（如 recommend）→ 400「无效 mode」（原先静默 0 结果）
  - collection 在当前向量库不存在（模式切换后旧 KB）→ **422** + 友好提示（引导重解析/重切分/批量重解析）；原先裸 500
- **批量重解析（UI）**：文档中心工具栏「批量重解析」按钮 → AlertDialog 确认 → 对当前 KB 全部 ready/failed 文档逐个 POST action reparse（旧版本自动快照，可用于文档版本管理）；恢复路径 = 模式切换后的重新入库
- **联调环境**：workspace/qdrant-server/start.sh（qdrant 1.9.7 二进制 + storage 持久化，curl localhost:6333 探活）

## 21. 异步测试集运行（扩展 §12）

大规模用例（> 8 例，ASYNC_THRESHOLD）或显式 `async: true` 时转后台 job，防同步串行 >30s 网关超时：

- `POST /api/kb/[id]/testcases/run` body `{ caseIds?; onlyEnabled? = true; async? }`
  - 已有运行中的 job → **409** `{ run, note }`（前端直接接管轮询，不视为错误）
  - 同步路径（≤8 例且未强制异步）→ `{ report }`（旧行为不变）
  - 异步路径 → `{ run: TestRunState }`（立即返回 runId，后台逐例执行）
- `GET /api/kb/[id]/testcases/run/[runId]` → `{ run }`（404 = 不存在或已被清理；保留最近 20 条完成记录）
- 进度推送：每例完成向 `kb:{kbId}` 房间 emit **`testrun:progress`** `{ runId, kbId, status, total, done, current? }`；完成/失败也推（status=done|error）
- 语义：runId 进程内（globalThis 单例，HMR 热重载保留）；每例结果仍实时写 lastRunJson（中断也能看到已完成部分）

```ts
TestRunState = { runId; kbId; kbName; status: 'running'|'done'|'error'; total; done; current?; startedAt; finishedAt?; error?; report?: TestRunReport }
```

## 22. 文档版本管理报告导出（扩展 §17）

- `GET /api/documents/[id]/versions/compare/export?v1=&v2=&format=json|md`
  - `json`：完整结构（exportedAt/doc/v1/v2/summary/configDiff/items）
  - `md`：人读报告（版本信息表 + 汇总 + 参数差异表 + 变化明细，same 折叠为计数，预览截断 500 字符）
  - 响应带 `Content-Disposition: attachment`（文件名 `versions-{文档名}-v{v1}-vs-v{v2}-{yyyymmdd}.{ext}`）
  - 前端直链：`ragApi.compareExportUrl(docId, v1, v2, format)`（浏览器 <a download>）

## 23. Qdrant 快照管理（2026-10-02 新增，扩展 §11 备份体系）

qdrant 模式下向量数据的独立备份通道（local 模式全链路 400 友好提示；备份卡 §11 仅覆盖 SQLite+artifacts）：

- `GET /api/qdrant/snapshots` → `{ vectorMode, collections: [{ collection, snapshots: QdrantSnapshotItem[] }], totalSnapshots }`
  - 仅返回有快照的集合；local 模式 → 400 `{ error: 'local 模式无 Qdrant 快照，请先在设置中切换 qdrant 模式' }`
- `POST /api/qdrant/snapshots` body `{ collection }` → `{ snapshot }`（qdrant `POST /collections/{c}/snapshots?wait=true`，同步创建）
- `DELETE /api/qdrant/snapshots/{name}?collection=` → `{ ok: true }`
- `POST /api/qdrant/snapshots/{name}/restore?collection=` → `{ ok, message }`（qdrant `?priority=snapshot`：快照优先覆盖现集合）
- `GET /api/qdrant/snapshots/{name}/download?collection=` → 文件流（代理 qdrant 下载，响应带 Content-Disposition attachment；避免前端直连 qdrant 端口）
- QdrantSnapshotItem `{ name; collection; createdAt(epoch ms); sizeBytes; downloadUrl }`（downloadUrl 为平台代理相对路径，可直接 <a download>）
- 错误语义：qdrant 不可达 → 502；collection 不存在 → 404；快照名不存在 → 404；统一 `{ error }` 载荷

## 24. 测试集运行历史（2026-10-02 新增，扩展 §21）

- `GET /api/kb/[id]/testruns` → `{ runs: TestRunHistoryItem[] }`（按启动时间倒序，含 running + 最近完成的 ≤20 条）
  - 数据源：§21 的 globalThis 注册表（进程内，**重启清零**，与 BackupSchedule 进程内统计同语义）
  - `TestRunHistoryItem` 不含 report.cases 明细（减小载荷），done 态给 summary 汇总 `{ passed, failed, hitRateAvg, mrrAvg, tookMsTotal }`
- UI（测试集回归视图「最近运行」区）：时间倒序列表（状态徽标 running/done/error + 用例数 + 通过率 + MRR + 总耗时 + 相对时间），running 行显示实时进度（复用 §21 双通道事件流）；点击历史行可将该次运行的汇总参数填入顶部汇总卡（只读回看）

## 25. 跨视图下钻事件 v2（扩展 §19，2026-10-02）

TrendsCard（派发端）→ RetrievalDebugView（消费端）双通道事件：

- `rag:goto-retrieval` detail `{ mode: 'hybrid'|'dense'|'sparse'; kbId? }` —— 模式分布条点击（选中 KB 过滤时携带 kbId）
- `rag:prefill-query` detail `{ query: string; kbId? }` —— 热门查询点击
- **双通道防丢**：派发前先写 `window.__ragDrillPending { ts, kind, detail }`（TTL 8s），再 setView + 250ms 后 dispatch 实时事件；消费端挂载时先读缓冲（先到先消费、读后即清），再挂 addEventListener（消费时同步清缓冲防重复）
- 消费动作：goto → setMode（白名单校验）+ kbId 有效则 setKbId + ToggleGroup amber ring 1.8s pulse；prefill → setQuery + focus(Textarea) + amber ring 1.8s pulse

## 26. 文档上传与导入能力升级（2026-10-02 新增，Task 13-a）

### 26.1 扩展上传类型（docx）

- `POST /api/kb/[id]/documents` 支持扩展名：`.pdf / .docx / .md / .markdown / .txt / .html / .htm`（.docx 新增）
- docx 服务端解析走内置降级解析器（RAGFlow 同款思路的 Node 轻量实现）：`mammoth.convertToHtml(buffer)` → 共享 HTML→Markdown 清洗器（`src/lib/rag/parsers/`）：
  - 结构保真：h1-h6 → `#/##…`、ul/ol 嵌套 li（缩进 2 空格）、table → md 管道表格（`\|` 转义）、strong/em、a → `[文本](href)`、img → `[图片:alt](src)`、pre/code → 围栏代码块（language-xxx class 识别）
  - 字符清洗：控制字符、`\r\n` 统一、零宽/不换行/全角空白、行首尾修剪、bullet 字符（•‣▪◦·）统一为 `-`、>2 连续空行合并为 2、强调标记与 CJK 标点间空格收紧
- docx 的 mimeType 固定映射：`application/vnd.openxmlformats-officedocument.wordprocessingml.document`

### 26.2 URL 导入端点

- `POST /api/kb/[id]/import-url` body `{ url: string, filename?: string }`（**单 URL 一次调用**）
- 服务端抓取：`AbortSignal.timeout(15s)`、浏览器 UA、`redirect: 'follow'`、响应上限 8MB
- **sitemap 分支**（URL 路径含 `sitemap*.xml` 或 body 含 `<urlset>/<sitemapindex>`）：
  - sitemapindex 递归一层（子图最多 5 张）→ `200 { sitemap: true, urls: string[] }`（去重、上限 30；不建文档、不入流水线）
- 正文分支：`text/html` → 主内容抽取（`article > main > [role=main] > #content > .mw-parser-output` > 文本密度最大容器，链接密度>0.5 降权 0.3；剥离 script/style/nav/header/footer/aside/form 等）→ 结构化 markdown；`text/plain|markdown` → 原文同款清洗；其余 Content-Type → 422
- 建档规则：filename = `body.filename > <title> > <h1> > host+path`（非法字符清洗、≤80 字符、强制 `.md` 后缀）、mimeType `text/markdown`、抽取文本 sha256 秒传（复用唯一索引语义）、`metaJson = { sourceUrl, site, importedAt, importTookMs }`、source 产物落盘 `.md`、`enqueueDocument(parse)`
- 响应：`201 { doc: DocSummary, deduplicated: boolean }` | `200 { sitemap, urls }` | `400/422 { error }`（4xx：抓取失败/超时/非文本/正文为空）

### 26.3 Document 新字段（additive）

- `DocSummary.sourceUrl: string`（空 = 本地上传；URL 导入 = 抓取最终地址，经 redirect follow）
- Prisma `Document.sourceUrl String @default("")`（`bun run db:push` 平滑加列，老数据空串）

### 26.4 批量上传客户端编排语义（不新增批量端点）

- 批量 = 前端逐文件调度既有上传端点，**并发 2**；单次会话 URL 数量上限 30（sitemap 展开的子链接计入）
- 上传进度：XHR `upload.onprogress` 字节级百分比；解析进度：复用 §9 socket 事件（`document:status/progress/done`），客户端按 `docId` 关联任务卡
- 终态语义：`ready`（emerald，含 chunkCount/tookMs）| `failed`（rose，含 errorMessage + 单文件重试）| `deduplicated`（amber 秒传）
- 完成后客户端 invalidate：`['docs', kbId]`、`['dashboard']`、`['kbs']`

## §27 文档版本管理：恢复历史版本 / 删除版本（v1.4）

用户需求：文档版本管理升级为「文档版本管理」——可恢复历史版本（含向量数据），也可删除文档版本。

### 27.1 快照增强（向后兼容）

- `v{n}.json` 的 chunks 自 §27 起携带恢复所需完整字段：`fullText`（全文）、`parentId`、`docType`、`pageFrom/pageTo`、`bboxFrom/bboxTo`、`storageKey`。
- 旧快照（缺 fullText）恢复时降级：该 chunk 以 `textPreview`（≤500 字）入库，响应中 `degradedChunks` 计数。
- `GET /api/documents/[id]/versions` 的快照行新增 `meta: { hasFullText }`，UI 据此提示「无损恢复 / 降级恢复」。

### 27.2 版本号递增语义（bumpDocVersion）

三屏联动的**启用/停用/编辑/还原/删除** chunk 与沙盒入库统一调用：变更前先归档当前 chunk 集为 `v{parseConfigV}.json`（幂等），再 `parseConfigV+1`。文档版本因此完整覆盖「切分配置变更」与「chunk 级内容变更」两类历史，均可回滚。

- 文档处于流水线中（queued/parsing/chunking/embedding/upserting）时拒绝变更 → HTTP 409。

### 27.3 恢复历史版本

```
POST /api/documents/[id]/versions/[version]/restore
→ { ok: true, restoredVersion, fromVersion, chunkCount, degradedChunks }
```

流程：校验（版本存在 / 非流水线中）→ 归档当前（当前内容不丢，恢复后可再恢复回来）→ 清空 chunks（行+磁盘+向量点 deleteByFilter）→ 按快照重建（行 + 磁盘全文）→ 状态 queued → 入队 embed（重新嵌入 + 向量库重写，chunk ID 确定性保持一致）。

### 27.4 删除版本

```
DELETE /api/documents/[id]/versions/[version] → { ok: true }
```

仅删除快照文件 `v{n}.json`；`current` 无文件 → 400。

### 27.5 三屏联动 chunk 变更响应

`PATCH/DELETE /api/documents/[id]/chunk/[chunkId]` 响应新增 `version`（递增后的新版本号）；流水线中 → 409。
