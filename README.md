# InkRAG · 轻量 RAG 知识库管理平台

> 一套可自托管的轻量级 RAG 知识库管理系统：多引擎文档解析 → 父子双块切分 → 混合检索（稠密 + 稀疏 + Rerank）→ 全链路白盒可观测。

## 功能总览

### 文档与解析
- **三种 MinerU 接入方式可切换**：自部署 V1（六步协议）/ 官方云·精准 API（Token，高精度批量）/ 官方云·Agent 轻量（免 Token）——三种协议互不兼容，面板内一键切换并探测可用性
- **Node 本地解析器（22 种类型）**：PDF（pdfjs 文本+坐标）/ DOCX（mammoth 结构化）/ PPTX / XLSX / ODT / ODS / ODP / EPUB / OFD / MHTML / RTF / DOC / CSV / TSV / HTML / MD / TXT 等，参考 RAGFlow 的清洗策略（正文抽取、冗余剥离、结构保真）
- **图片解析**：png / jpg / jpeg / jp2 / webp / gif / bmp 经 MinerU 引擎支持
- **逐文件引擎选择**：上传时每个文件可单独勾选 MinerU 或 Node 解析；类型推荐矩阵内置
- **两段式上传**：选文件进待传队列 → 可继续添加 → 点「开始上传」确认执行；并发 2 + 字节级进度 + 六阶段实时步进器；SHA256 秒传
- **URL 导入**：粘贴 URL 抓取导入，可选 MinerU / Node 引擎

### 切分与质量
- **三屏联动**：原文（PDF 坐标高亮）/ Markdown / chunk 列表双向联动；chunk 可编辑、启停、删除——变更即重嵌入、同步向量库、自动递增文档版本号
- **切分沙盒**：无损参数试验（size/overlap/parentSize/strategy/保护块），300ms 防抖预览，「入库此切分结果」一键落库
- **测试集回归**：金标准用例 + 命中率/MRR 评估 + 异步运行历史（切分/入库质量回归属知识库管理域；对外检索 API 已移除——见更新日志 v1.8）

### 对外接口（供 AI 调用）
- **入库 API `/api/input`**：Bearer Key 鉴权（401/403 读写角色分离）；建库（含 retrievalMode 检索模式元数据）/ 多文件并发上传 / 文本直接入库 / 跨库文档查询 / 失败重试 / 级联删除；sha256 秒传、单文件 200MB；超详细文档（应用内一键查看 + `docs/input-api.md`）
- **Dify 兼容导出 API `/v1/datasets`**：MinerU 面板「导出到 Dify」直接对接本平台——配置入口在「知识库」视图「Dify 导出对接」按钮（地址/Key 配置 + Key 内联创建/启停/删除 + 对接文档）；状态映射到 Dify indexing_status、process_rule.max_tokens→chunk size；注意导出由 mineru.net 服务器转发，平台需公网可达（文档 §2）；对接文档 `docs/dify-compat.md`
- **MCP Server（`mcp/`）**：Claude Desktop / Cursor 等通过 Model Context Protocol 直接入库——10 工具与 /api/input 一一对应，stdio transport，中英双语 README

### 版本管理
- **自动快照**：重解析 / 重切分 / chunk 编辑 / 启停 / 删除 / 恢复前自动归档当前版本（含全文）
- **chunk 级 diff**：LCS 锚点 + bigram dice 相似度，四类变更（same/added/removed/changed）
- **恢复历史版本**：归档当前 → 版本号 +1 → 重建 chunks → 重新向量化写入向量库；无损/降级恢复徽标
- **删除版本**：历史快照可单独删除

### 可观测与运维
- **实时活动·任务中心**：每篇文档的解析 → 切分 → 向量化 → 写入向量库全程进度实时推送（socket.io）；失败可重试、报错可展开、完成自动隐藏、失败记录可删除
- **系统运维**：健康矩阵（Qdrant/向量引擎/嵌入/MinerU/Rerank/流水线）、平台资源占用（进程内存/CPU、系统负载、磁盘明细）、Prometheus 指标
- **程序日志**：面板操作 / 运行信息 / 报错的统一记录（info/warn/error × 八分类）——关键词/级别/分类/时间窗筛选、行内详情展开、导出 JSON、按时长清理；共享层一处埋点三条链路（UI / 入库 API / Dify 兼容）全覆盖 + 未捕获请求错误全局兜底
- **备份一体化**：面板数据（SQLite + 产物）与 Qdrant 快照一同创建 / 一同下载 / 一同恢复，也可分开单独操作；支持上传备份包（tar.gz）与 Qdrant 快照（.snapshot）恢复；定时自动备份含轮转清理
- **Agent API 视图**：API Key 管理（三角色）+ 入库 API 文档一键查看；**Dify 导出对接**配置入口在「知识库」视图（与入库 API 相互独立）

## 技术栈

Next.js 16（App Router）· TypeScript · Tailwind CSS 4 · shadcn/ui · Prisma（SQLite）· socket.io · Zustand · TanStack Query · pdfjs-dist · mammoth · fflate · cheerio

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 初始化数据库
cp .env.example .env   # 按需修改 DATABASE_URL 与 PANEL_PORT（默认 2607）
bun run db:push

# 3. 启动主服务（默认端口 2607，可在 .env 用 PANEL_PORT 覆盖）
bun run dev

# 4. 启动实时事件服务（socket.io，端口 2608/2609）
cd mini-services/pipeline-events && bun install && bun run dev
```

打开 `http://localhost:2607`，在「设置」中配置 Qdrant / Embedding / Rerank / MinerU（v1.6 起必须先配置 Qdrant 与 Embedding 才能创建知识库；未配置或不可达时写入硬失败并给出引导，不再自动降级本地演示模式）。

### MinerU 接入方式选择

| 方式 | 适用 | 凭据 |
|---|---|---|
| 自部署 V1（`mineru-kit api-server`） | 数据不出内网 / 离线 / 自控算力 | 可选 Bearer |
| 官方云·精准（`mineru.net/api/v4`） | 最高精度 / 批量 / 多格式导出 | Bearer Token |
| 官方云·Agent 轻量（`mineru.net/api/v1/agent`） | 零门槛 / 单文件 ≤10MB | 免 Token（IP 限频） |

> 注意：三者协议互不兼容。自部署请填 **API Server 端口**（默认 8000，`/v1/health` 握手），不要填 WebUI 端口（7860）——WebUI 不实现 `/v1/*` 协议，会导致 404。

## 文档

- [API 契约（35 节）](./docs/api-contract.md)
- [入库 API 超详细文档（/api/input）](./docs/input-api.md)
- [Dify 兼容数据集 API 对接指南（/v1/datasets · MinerU 面板导出）](./docs/dify-compat.md)
- [MCP Server（Claude Desktop / Cursor 接入）](./mcp/README.md)

## 更新日志

### v1.20（2026-10 · 知识库排行榜与文档类型筛选 3 项）

> 本轮聚焦于让用户在仪表盘直观看到各知识库容量分布（Top 5 排行榜），并在文档中心支持按文件类型筛选，提升库管理效率。

**知识库排行榜（FE-017/BE-017）**
- **BE-017 `/api/dashboard` 增加 `kbLeaderboard` 字段**：Top 5 知识库按 `pointCount` 倒序；每项含 `id/name/docCount/chunkCount/pointCount/createdAt`。
- **FE-017 仪表盘「知识库容量排行榜」卡**：Top 5 列表，排名徽章（1=金 `amber`，2=银 `stone`，3=铜 `orange`，4-5 灰色）；每行：排名圆徽 + 库名 + 容量进度条（按 `maxPoints` 比例）+ 文案「N 点 · N chunk · N 文档」；「查看全部」按钮跳转知识库列表。

**文档类型筛选（FE-018）**
- **FE-018 文档中心按文件类型筛选**：`/api/kb/[id]/documents` GET 增加 `ext` 查询参数（`endsWith '.ext'`）；`listDocs` 增加 `ext` 选项；DocumentsView 新增「全部类型」筛选下拉（PDF/Markdown/Word/Excel/PPT/文本/HTML/EPUB），与状态/引擎筛选并列。

**E2E 验证**
- API: `kbLeaderboard` 返回 2 个库（按 pointCount 排序）✓
- API: `ext=pdf` 返回 2 PDF / `ext=md` 返回 1 MD ✓
- UI: 仪表盘排行榜卡渲染 ✓ / 文档中心「全部类型」筛选渲染 ✓

### v1.19（2026-10 · 吞吐趋势时间范围切换与批量重解析选中 3 项）

> 本轮聚焦于让吞吐趋势图支持 1h/6h/24h 时间范围切换（不同粒度看不同时段），并在文档中心支持对选中（而非全部）文档批量重解析。

**吞吐趋势时间范围（FE-015/BE-016）**
- **BE-016 `/api/dashboard` 支持 `trendRange` 查询参数**：`?trendRange=1h|6h|24h`（默认 24h）；桶大小自适应（1h→5min桶 12 个，6h→30min桶 12 个，24h→1h桶 24 个）；桶标签自适应（1h/6h→`HH:MM`，24h→`HH:00`）；查询范围动态计算。
- **FE-015 仪表盘吞吐趋势时间范围切换**：DashboardView 新增 `trendRange` state；`useQuery` queryKey 加入 trendRange（切换时重新请求）；趋势卡顶部增加 1h/6h/24h 按钮组（选中态 primary 高亮）；移除原静态「近 24h」文案。

**文档中心批量重解析选中（FE-016）**
- **FE-016 文档中心「批量重解析选中」按钮**：`runBatchReparseSelected` 仅对 `selectedIds` 中的文档 `reparse`（而非全部 ready/failed）；violet 配色 + 数量 Badge，仅在 `selectedIds.size>0` 显示；与「批量删除」并列形成选中后操作组；成功后清空选中 + 刷新 docs/dashboard。

**E2E 验证**
- API: default 24h→24 桶 total=6 / 1h→12 桶 HH:MM / 6h→12 桶 HH:MM ✓
- UI: 1h/6h/24h 按钮组渲染 + 点击切换 ✓；选中后「批量重解析选中」按钮出现 ✓

### v1.18（2026-10 · 仪表盘吞吐趋势图与文档中心批量删除 3 项）

> 本轮聚焦于让用户直观看到流水线近 24h 的吞吐健康度，并在文档中心支持选中多个文档批量删除，提升运维效率。

**仪表盘吞吐趋势（FE-013/BE-015）**
- **BE-015 `/api/dashboard` 增加 `throughputTrend` 字段**：近 24h 按小时桶聚合 `completed`/`failed` 任务数（`finishedAt >= 24h前`）；24 桶，0=最旧 → 23=当前小时，每桶 `{hour: 'HH:00', completed, failed}`。
- **FE-013 仪表盘「流水线吞吐趋势」图**：recharts `AreaChart` 双路面积图（completed emerald + failed rose），渐变填充 + CartesianGrid + XAxis 每 4h + YAxis 整数 + RTooltip；顶部图例显示完成/失败总数 + 「近 24h」标签；无数据时显示空态提示。

**文档中心批量删除（FE-014）**
- **文档中心新增批量删除**：`selectedIds` Set + `toggleSelect`/`selectAll`/`selectNone`；表头新增全选 Checkbox 列；DocRow 新增行内 Checkbox + 选中高亮（sky/5）；「批量删除」按钮仅在 `selectedIds.size>0` 时显示（红色 + 数量 Badge）；`runBatchDelete` 循环 `deleteDoc`，toast 汇总成功/失败 + 清理 chunk 数；AlertDialog 二次确认（红色强调不可撤销 + 安全提示）；删除后清空选中 + 刷新 docs/dashboard。

**E2E 验证**
- API: `throughputTrend` 24 桶，total completed=6 failed=1 ✓
- UI: 仪表盘「吞吐趋势」卡渲染 ✓；文档中心选中后「批量删除」按钮出现 ✓

### v1.17（2026-10 · 引擎分布可视化与批量降级 3 项）

> 本轮聚焦于让用户在仪表盘直观看到 MinerU vs 本地引擎的文档占比，并在 MinerU 故障期间支持一键批量降级所有失败文档。

**引擎分布可视化与批量降级（FE-011/012/BE-014）**
- **BE-014 `/api/dashboard` 增加 `engineDistribution` 字段**：按 `parseEngine` groupBy 统计（mineru / fallback / pending 含空 parseEngine），仪表盘 API 响应增加 `engineDistribution: {mineru:N, fallback:N, pending:N}`。
- **FE-011 仪表盘「解析引擎分布」统计卡**：堆叠条形图展示 MinerU(sky) / 本地引擎(amber) / 未解析(stone) 占比；图例含色点 + 标签 + 数量 + 百分比；与状态机分布条同口径样式。
- **FE-012 文档中心「批量降级重试」按钮**：DocumentsView 新增 `batchFallbackTargets`（当前 KB 全部 failed 文档）；`runBatchFallback` 循环调用 `retryWithNode`，toast 汇总成功/失败数；蓝色 sky 配色 + 数量 Badge，MinerU 故障期间一键降级所有失败文档；与「批量重解析」并列。

**E2E 验证**
- API: `engineDistribution={mineru:0,fallback:2,pending:1}` ✓
- UI: 仪表盘「解析引擎分布」卡渲染 + 文档中心「批量降级重试」按钮渲染 ✓

### v1.16（2026-10 · 文档解析引擎可见化 2 项）

> 本轮聚焦于让用户直观看到每个文档的解析方式（MinerU 云服务 vs 本地降级解析器），并在文档中心支持按引擎筛选，便于排查 MinerU 故障期间降级重试的文档。

**文档引擎可见化（FE-009/010）**
- **FE-009 仪表盘「最近文档」表增加解析引擎列**：新增 `ParseEngineBadge` 组件（mineru=蓝色「MinerU」/ fallback=琥珀色「本地引擎」/ 空=灰色「未解析」）；仪表盘最近文档表新增「引擎」列（文件名/知识库/引擎/状态/时间），让用户在仪表盘即可看到每个文档的解析方式。
- **FE-010 文档中心列表增加解析引擎筛选 + 统一徽章**：`/api/kb/[id]/documents` GET 增加 `engine` 查询参数（mineru 精确匹配 / fallback 匹配 `['fallback','']` 含未解析态 / all 不筛选）；DocumentsView 新增「全部引擎」筛选下拉（全部引擎/MinerU/本地引擎）；DocumentsView 表格引擎列改用统一 `ParseEngineBadge`（原实现只处理两态，新增「未解析」态）。

**E2E 验证**
- API：engine=mineru 返回 0 文档（无 MinerU 解析的）；engine=fallback 返回 3 文档（含空 parseEngine 的 failed 文档）✓
- UI：仪表盘最近文档表显示「引擎」列 + 「本地引擎」徽章；文档中心筛选栏显示「全部状态 | 全部引擎」下拉；文档表格引擎列显示 MinerU/本地引擎/未解析三态徽章 ✓

### v1.15（2026-10 · MinerU 降级重试与 standalone PDF worker 修复 2 项）

> 本轮通过 E2E 测试发现 MinerU 云 CDN 证书过期导致 PDF 解析永久失败的链路问题，补全降级重试机制并修复 standalone 构建下 pdfjs worker 文件缺失。

**MinerU 降级重试（FE-008+）**
- **新增 `/api/documents/[id]/retry-with-node` 路由**：MinerU 失败后把 `engineChoice` 改为 `node`（本地解析器），清 MinerU 续传字段（jobId/uploadId/fileId），失败 parse job 重置为 pending。记录 `fallbackFromMineru` + `fallbackAt` 审计字段。
- **MinerU CDN TLS 错误分类提示**：`downloadZip` 检测 `certificate/CERT_/tls/ssl` + `expired/invalid/self-signed` 错误，给出明确指引（① 稍后重试 ② 切 cloud-agent ③ Node 引擎重试），不再笼统报「下载失败」。
- **TaskCenterView 失败任务卡新增「降级重试」按钮**（蓝色，仅 parse 阶段失败显示）：`canFallbackToNode` 判定失败阶段为 parse 即可降级（PDF 受 PERF-004/005 100MB 限制，超限会在 Node 解析时再报 `FALLBACK_PDF_TOO_LARGE`）。

**standalone PDF worker 修复（PERF-006）**
- **问题**：`next build` standalone 未拷贝 `pdfjs-dist/legacy/build/pdf.worker.mjs` → fake worker 动态 import `./pdf.worker.mjs` 失败 → Node 解析 PDF 报「Setting up fake worker failed: Cannot find module」。
- **修复**：`package.json` build 脚本增加 `cp pdf.worker.mjs` + `pdf.worker.min.mjs` 到 standalone；`mineru.ts` `parsePdf` 显式设置 `GlobalWorkerOptions.workerSrc = require.resolve(...)`（dev 模式原生可用，standalone 模式文件已拷贝可解析）。

**E2E 验证**
- 上传 PDF (MinerU engine) → MinerU CDN 证书过期失败 ✓
- `retry-with-node` → engineChoice=node + 清 MinerU 字段 ✓
- Node fallback 解析 PDF → parse→chunk→embed→ready，10s 内完成，1 chunk，parseEngine=fallback ✓

### v1.14（2026-10 · UI 可见化深化与 E2E 验证 3 项）

> 本轮聚焦于仪表盘与运维页的流水线状态可视化深化，并完成完整 E2E RAG 流水线验证（创建知识库 → 上传文档 → parse→chunk→embed→ready 全链路跑通）。

**UI 可见化深化**
- **FE-006 仪表盘「流水线引擎」统计卡**：6 格网格展示队列(pending+waiting) / 活跃(并发槽) / 已完成 / 失败 / 成功率 / 运行时长；顶部状态指示灯三态（运行中绿色脉冲 / 已暂停琥珀色 / 关闭中红色脉冲）；数据来源 `/api/dashboard` pipeline 段。让用户在仪表盘即可看到引擎吞吐与健康度，无需深入系统运维页。
- **FE-007 运维健康矩阵 pipeline 状态色**：pipeline 行从二元绿/红扩展为三态——running 绿点 / paused 琥珀点+脉冲 / draining 红点；卡片背景随状态变色；badge 展示「已暂停」/「关闭中」替代 mode；文案增加 pending/active/completed/failed 完整计数。与 v1.13 横幅形成双层提示。
- **SEC-008++ 密钥轮转天数告警**：设置→面板安全 tab 的「上次密钥轮转」展示「N 天前」；超 90 天未轮转 → 琥珀色边框 + ⚠ 告警「建议改密」。符合安全合规检查需求。

**E2E 验证**
- 完整 RAG 流水线端到端跑通：创建知识库（dim=1024, BAAI/bge-m3, Qdrant collection 创建）→ 上传 Markdown 文档 → pipeline parse(fallback)→chunk→embed→ready，1 chunk / 1 向量点入库 Qdrant，pipeline.completed=3 / failed=0，成功率 100%。

### v1.13（2026-10 · 状态可见化与运维增强 3 项）

> 本轮聚焦于上一轮 13 项修复的「可见性闭环」：让备份/恢复期间的流水线暂停、优雅关闭的 draining 态、改密轮转的审计时间从前端可见，让运维与 k8s 编排能据此决策。

**状态可见化（FE-005/BE-011）**
- **Pipeline paused/draining 状态 UI 横幅**：`/api/dashboard` 与 `/api/system/health` 增加 `pipeline` 段（`paused`/`pausedReason`/`pausedAt`/`draining`/`drainingAt`）；仪表盘与系统运维页顶部增加状态横幅——`draining` 红色「服务正在关闭，排空活跃任务中」/ `paused` 琥珀色「流水线已暂停（备份/恢复进行中）」，让用户直观看到引擎非正常态。
- **`draining` → 503 摘流**：`/api/system/health` 在 `draining=true` 时返回 HTTP 503，k8s readiness probe / 网关探活据此摘流（不再接新请求）；liveness 仍走 `/api/system/health/live` 200。`drainForShutdown()` 入口设置 `draining=true`，配合 BE-010 优雅关闭。

**密钥轮转审计（SEC-008+）**
- **`secretRotatedAt` 持久化 + UI 展示**：`PanelAuth` schema 增加 `secretRotatedAt DateTime?`；改密轮转成功后写入时间戳；`/api/auth/session` 返回 `secretRotatedAt`；设置 → 面板安全 tab 展示「上次密钥轮转」——已轮转显示绿色时间戳，从未轮转显示琥珀色提示「改密后将自动轮转密钥，使旧会话失效」。便于安全合规检查。

### v1.12（2026-10 · 运维补全 / 安全加固 / 性能与可靠性增强 13 项）

> 本轮针对运维完整性、安全面、前端渲染性能与后端数据一致性四类审计发现逐条修复：补全 UI 已调用但路由缺失的备份上传 / 日志清理调度端点；加固实时事件 /emit 与 SSRF 防护；前端 PDF 长文档虚拟化与防抖修复；后端秒传去重、版本恢复事务化、备份/恢复期间流水线暂停、优雅关闭、大文件内存保护；部署脚本补全 Prisma 生成与 mini-service 编排；改密轮转密钥。

**运维补全（OPS）**
- **备份上传路由缺失（OPS-001）**：UI 备份导入调用 `/api/system/backups/upload` 返回 404。新增路由：GET 列出已上传 `.snapshot`、POST 接收 multipart/form-data（`.snapshot` 直接保存为 `uploaded-{ts}-{原名}.snapshot`、`.tar.gz` 走 `importBackupArchive` 解包入库）、DELETE 按 `?file=` 删除。复用 `backup.ts` 的 `listUploadedQdrantSnapshots` / `importBackupArchive` / `deleteUploadedQdrantSnapshot`；文件名白名单 + 2GB 上限 + 目标路径强制落在 `BACKUPS_ROOT` 内防路径穿越。
- **日志清理调度路由缺失（OPS-002）**：UI 轮询 `/api/system/oplogs/schedule` 404。新增 GET 返回 `{ schedule: OplogCleanSchedule }` 并惰性拉起调度器，PUT 更新 `{ enabled?, olderThanHours?, maxLevel? }` 热重载调度器。复用 `oplog.ts` 的 `ensureOplogCleanScheduler` / `updateOplogCleanConfig`；字段校验 1-8760 小时 / info-warn-error 白名单。
- **部署脚本不完整（OPS-009/012）**：`build` 缺 `prisma generate`（standalone 缺 Prisma Client 引擎二进制会启动失败）、无 mini-service 启动脚本。修复：`build` 前置 `prisma generate`；新增 `start:events` 脚本；mini-service `pipeline-events` 补 `uncaughtException`/`unhandledRejection` 进程级兜底（致命错误优雅关闭后退出交 supervisor 重启，可忽略 I/O 中断不退出）；新增 `Dockerfile`（多阶段构建 + supervisord 编排两进程 + dumb-init 信号转发 + HEALTHCHECK 走 `/api/system/health/live`）与 `deploy/inkrag.service` / `deploy/inkrag-events.service` systemd unit 示例（含安全加固与 SIGTERM 宽限配合优雅关闭）。

**安全加固（SEC/BE）**
- **`/emit` 不校验 room/event（BE-001）**：虽有 `x-inkrag-emit-secret` 鉴权，但不校验 room 与 event，存在事件伪造风险。新增 `EMIT_EVENT_RE` 白名单正则仅放行已知事件（`chunk:update`/`document:done`/`document:progress`/`document:status`/`job:update`/`kb:stats`/`pipeline:activity`/`testrun:progress`）；抽出 `isValidRoom()` 与 subscribe 共用；非法 event 或 room 返回 400。
- **SSRF 防护增强 + 健康探针拆分（SEC-002）**：管理员配置的 `qdrant.url`/`mineruApiUrl`/`embedApiBase`/`rerankApiBase` 无 SSRF 校验；`/api/system/health` 公开暴露内部聚合状态。修复：抽取 `assertPublicHttpUrl()` 到 `src/lib/rag/ssrf.ts` 共享（含 IPv4/IPv6 私网段判定 + 域名 DNS 全量校验），`import-url` 路由改 import 复用，`qdrant/settings` PUT 对四个 URL 字段应用校验；拆分 `/api/system/health/live`（公开仅 `{ok:true}`）与 `/api/system/health`（需面板会话返回详细状态），middleware 公开豁免清单与单元测试同步更新。

**前端性能与正确性（FE）**
- **PdfViewer 全量渲染长文档崩溃（FE-002）**：同时渲染所有 PDF 页导致长文档 OOM。新增 `LazyPdfPage` 组件用 `IntersectionObserver`（rootMargin 400px 预挂载）只挂载视口附近页面；占位骨架屏保留与真实页面等宽等高的 `data-page` div 保证滚动条高度与页码探测无布局抖动；不可见页卸载释放 canvas；选中 chunk 强制其页范围入可见集确保高亮渲染。
- **OpLogsCard 防抖失效（FE-004）**：误用 `useMemo` 设 `setTimeout`，但 `useMemo` 不执行返回的 cleanup，每次输入新增未清除定时器导致防抖失效触发多次查询。改用现有 `useDebouncedValue` hook（内部 `useEffect` + `clearTimeout` 正确清理）；分页重置从 effect 内 `setState` 改到搜索框 `onChange` 直接重置（符合 React 规范）。

**后端数据一致性（LOGIC）**
- **秒传去重硬编码 `parseConfigV: 1`（LOGIC-001）**：编辑后文档 `parseConfigV` 递增，秒传查找只比对 v1 行落空，同一原文重新上传建新行而非去重。`findDuplicated` 与 P2002 处理改为 `orderBy: { parseConfigV: 'desc' }` 取最新版本比对；`import-url` 路由两处秒传判定与 P2002 处理同步修复。
- **版本恢复非事务化 + 先删后建留空文档（LOGIC-002/003）**：`db.chunk.deleteMany` 与 `createMany` 不在事务中，失败留空文档；先删 Qdrant 旧向量后重建，空窗期向量缺失。重构 `restoreDocVersion`：① 全量子 chunk 同步嵌入前置（失败零副作用）② 磁盘写入在 DB 事务前（失败清理已写文件）③ `db.$transaction([deleteMany, createMany])` 原子提交 ④ Qdrant 先 `upsertPoints` 新向量再 `deletePoints` 仅删不在新 chunk 集合的旧向量（无空窗）⑤ 向量层失败时 chunk 已恢复，状态标记 `failed` + `RESTORE_VECTOR_FAILED` 明确报错而非静默丢失 ⑥ 恢复完成直接置 `ready`（embed+upsert 已同步，无需入队流水线）。

**可靠性与资源控制（BE/PERF）**
- **备份/恢复期间流水线未暂停（BE-005/OPS-003）**：备份快照与流水线并发写库不一致；恢复期间全表替换与流水线并发数据错乱。`PipelineEngineState` 增加 `paused` 标志，`tick()`/`mineruPollTick()` 顶部检查（活跃任务不中断，仅阻止新任务认领）；导出 `pausePipelineEngine`/`resumePipelineEngine`/`isPipelinePaused`；`backup.ts` 新增 `withPipelinePaused` 辅助（pause → 执行 → finally resume + 30 分钟超时 watchdog 兜底强制恢复），`createBackup`/`restoreBackup` 整体包裹；`pipelineStats` 增加 `paused`/`pausedReason`/`pausedAt` 字段监控可见。
- **无 SIGTERM 处理（BE-010）**：`docker stop`/k8s rolling update 的 SIGTERM 10s 后被 SIGKILL 强杀，活跃任务被粗暴中断留僵尸任务。新增 `drainForShutdown(timeoutMs=30s)`：暂停新任务 → 遍历 abort 所有活跃 Controller（任务在下一个 `checkAlive` 检查点安静退出）→ 轮询 `active` 至 0 或超时 → 清理引擎定时器；`instrumentation.ts` 注册 SIGTERM/SIGINT 监听器调用后 `process.exit`，二次信号立即强制退出，35s 硬超时兜底。
- **大 PDF 处理 OOM（PERF-004/005）**：`pdf-split.ts` 与降级解析器把整个 PDF 读入内存，大文件直接 OOM。新增 `FALLBACK_PDF_MAX_BYTES=100MB`（降级解析器上限）与 `PDF_SPLIT_HARD_MAX_BYTES=500MB`（拆分硬上限）；`parseWithFallback` 的 PDF 分支超 100MB 抛 `FALLBACK_PDF_TOO_LARGE` 不可重试错误并提示配置 MinerU；`countPdfPages`/`splitPdfToParts` 入口 `assertSplittable` 校验；>50MB/>200MB 警告日志。
- **改密不轮转 HMAC 密钥（SEC-008）**：改密仅更新密码哈希，旧会话令牌与 API Key 签名仍有效。新增 `rotatePanelSecret()`：原子覆盖 `db/.panel.secret`（先写 tmp 再 rename）+ 清空进程内缓存；`handlePasswordChange` 改密成功后调用，换发新会话；mini-service `getSecret()` 增加密钥文件 mtime 检测，主服务轮转后自动清缓存重读无需重启；UI 根据轮转结果提示「其他设备会话已失效需重新登录」。

### v1.11（2026-10 · 一致性审计整改：密钥链路 / 鉴权回归 / 端口串联 / 测试脚手架 18 项）

> 本轮针对一份针对仓库的「AI 修复任务清单」逐条核验并修复：P0 全清（事件链路密钥静默瘫痪、硬编码默认口令）、P1 全清（监控/探活端点鉴权回归、备份端口、env 模板、测试脚手架）、P2 收口（运维页端口、进程退出语义、CORS、版本号）、P3 体验收敛（Qdrant 端口提示、Dify 地址只读、变量命名空间化、API Key 前缀、自定义头命名空间）。误报项（B01-B03）已核实排除，迁移提示项（C01）已补入文档。

**P0 — 致命**
- **事件链路密钥静默瘫痪（A01+A07）**：主服务与实时事件服务共享同一份 `db/.panel.secret`，但环境变量名两套（`PANEL_SECRET` vs `RAG_EVENTS_SECRET`）、密钥文件路径基址两套（`process.cwd()` vs `import.meta.dir`）。运维按主服务文档注入 `PANEL_SECRET` 后，主服务直接返回字面量、不生成密钥文件；mini-service 不认识该变量名 → 读默认路径文件不存在 → `getSecret()` 返回空 → 所有 socket 握手被拒 + `/emit` 403，整条实时事件链路 100% 瘫痪且**无启动期告警**。修复：两服务双向兼容两套变量名（主服务名优先）、密钥文件基址统一为 `process.cwd()/db/.panel.secret`、mini-service 新增启动期密钥可达性探测（不可用时打印醒目告警含恢复指引）。
- **硬编码默认口令（A02）**：`DEFAULT_PANEL_PASSWORD` 硬编码为作者联系 ID，任何拿到仓库者皆知初始口令。修复：移除硬编码，改为每实例首次启动随机生成 32 位易读口令（去除 IO01lo 易混字符），落盘 `db/.panel.pass`（0600，gitignore）并醒目打印到 stdout 含修改指引；来源优先级 `PANEL_INITIAL_PASSWORD` 环境变量 > 文件复用（跨重启稳定）> 首次生成。`.gitignore` 显式补充 `.panel.secret`/`.panel.pass` 防脱离 `db/` 目录泄露。顺带修复 `createEventsTicket()` 返回类型与实现不符的历史类型错误。

**P1 — 严重**
- **`/api/metrics` 被 401 拦截（A03）**：v1.10 引入面板鉴权后豁免清单漏配 `/api/metrics` → Prometheus 抓取（不带 panel Cookie）监控断流。修复：路由内独立 scrape token 鉴权——配置 `METRICS_SCRAPE_TOKEN`（≥16 位）后校验 `?token=` 或 `Authorization: Bearer`；面板会话仍可查看；都无则 401（不再无条件公开指标）。
- **`/api/system/health` 被 401 拦截（A04 → SEC-002 拆分）**：Docker HEALTHCHECK / 网关探活全失败。早期修复把 `/api/system/health` 整体豁免，但该端点聚合 Qdrant / 向量 / Embedding / MinerU 等内部状态，公开暴露内部信息（SEC-002）。现拆分：`/api/system/health/live` 公开仅返回 `{ok:true}` 供外部探活；`/api/system/health` 需面板会话返回详细聚合状态。Docker HEALTHCHECK / k8s liveness probe 请改用 `/api/system/health/live`。
- **备份恢复回退端口 3000（A05）**：`backup.ts` `defaultOrigin()` 回退端口硬编码 3000，v1.10 端口已迁移到 2607。直接 `bun .next/standalone/server.js` 启动时 PORT 为空 → Qdrant 回拉失败、含快照备份静默损坏。修复：回退端口优先级 `PORT > PANEL_PORT > 2607`。
- **`.env.example` 覆盖 2/13（A06）**：仅定义 `PANEL_PORT`、`DATABASE_URL`，新部署者不知密钥注入、事件端口、监控 token。修复：补齐全部 14 个环境变量（含 A02/A03 新增的初始口令与 scrape token），分五组并标注 `[必配-生产]`/`[可选]`，附生成示例（`openssl rand`）。
- **全仓无测试（A08）**：v1.10 大量并发/鉴权/重试/解压改动仅静态审计覆盖。修复：引入 `bun test`（原生支持，无需依赖），新增 4 测试文件 25 用例——中间件豁免前缀（固化 A03/A04 回归保护）、`retryBackoffMs` 退避序列边界、`createKeyHash`/`apiKeyColumns` 明文不落库契约、`safeUnzip` 三层解压预算（炸弹不进内存）。为可测性导出 `retryBackoffMs`/`RETRY_BACKOFF_BASE_MS`/`isPublicApiPath`。

**P2 — 中等**
- **OpsView scrape 命令硬编码 `:3000`（A09）**：复制即用连错端口。修复：动态取 `window.location.port`（默认 2607），补 token 提示与 A03 呼应。
- **`uncaughtException` 后继续运行（A10）**：进程可能处于不一致状态（堆损坏/半写文件），继续响应放大损坏。修复：记录后 1s 延迟退出（exit 1）交由 supervisor 重启；`unhandledRejection` 仍不退出（Promise 漏网可隔离）；可忽略的 I/O 中断（EPIPE/ECONNRESET/ERR_STREAM_PREMATURE_CLOSE 等）不退出。
- **socket.io `cors.origin: '*'`（A11）**：虽由握手票据兜底，属不必要暴露面。修复：新增 `RAG_EVENTS_CORS_ORIGIN` 环境变量（逗号分隔允许源，生产推荐配置面板域名）；未配置时回退 `origin: true`（反射请求 Origin，适配同源面板，避免发送通配头）。
- **schema 注释残留旧前缀 `lkb-`（A12）**：历史遗留前缀误导维护者。修复：改为 `inkrag-xxxx…`，与实际生成逻辑一致。
- **版本号三套并存（A13）**：`package.json` 0.2.1 / UI v1.0 / README v1.10 互相矛盾。修复：`package.json` 升至 1.10.0（与 v1.10 更新日志对齐），`next.config.ts` 读取 version 经 `env` 注入 `INKRAG_VERSION`，UI 改读 `process.env.INKRAG_VERSION`，发版只需改 `package.json`。

**P3 — 低风险改进**
- **Qdrant 输入框缺默认端口提示（A14）**：补「默认端口 6333」与示例（`http://10.0.0.5:6333` / 云端 `https`）。
- **Dify 导出地址可改只读（A15）**：默认只读展示 `effectiveBase` 避免误填，新增「编辑」按钮切换可写——保留内网/公网地址不一致场景的可编辑能力。
- **`SOCKET_PORT`/`EMIT_PORT` 裸名无前缀（A16）**：新增命名空间变量 `RAG_EVENTS_SOCKET_PORT`/`RAG_EVENTS_EMIT_PORT`（推荐），保留旧名兼容读取。
- **API Key 前缀 `rag-`（A17）**：改为 `inkrag-`，与项目命名前缀统一（`verifyApiKey` 不校验前缀，存量 `rag-` key 仍可用）；同步 input-api / dify-compat / api-contract / mcp README 文档。
- **自定义头 `x-emit-secret` 无命名空间（A18）**：改为 `x-inkrag-emit-secret`，接收方双向兼容旧名（滚动升级不中断 emit 链路）。

**端口迁移提示（C01）**
- 面板端口由 3000 段迁移到 2607；socket.io 由 3003/3004 迁移到 2608/2609。**外部旧调用方/脚本**（如旧版 MinerU 面板、早期集成）若硬编码 `3000`/`3003`/`3004` 需改为 `2607`/`2608`/`2609`。内置 MCP 已默认 2607。

### v1.10（2026-10 · 深度审计整改：安全、可靠性、性能三大主线 24 项）

> 本轮按《架构与功能性审查报告》（外部深度审计）逐项整改：审计矩阵中 P0 全清、P1 全清、P2 按性价比取舍；
> 同时完成三项产品需求（面板登录鉴权 / 端口体系 / Dify 对接界面瘦身）。**多租户/多实例类需求按部署定位明确不适用**（单机轻量知识库管理平台）。

**面板安全（F-E2E-01 🔴 P0：管理面 API 全链路无鉴权）**
- 面板登录密码：默认 `koshoutou`（scrypt+盐哈希存储，首次访问播种），可在「设置 → 面板安全」修改（默认密码醒目警示条）；HttpOnly Cookie 会话 12h；登录防爆破限流（同 IP 连续失败 5 次锁 30s）
- `src/middleware.ts`（Next 16 nodejs runtime）保护 `/api/**` 全部管理端点；豁免 `/api/auth`（鉴权本身）、`/api/input`（Bearer Key 供 AI/MCP）、`/v1`（Dify 兼容 Bearer Key）——三条对外通道与面板鉴权相互独立
- 前端登录遮罩全屏接管（未登录不加载任何视图与敏感数据）+ 全局 401 拦截（会话过期自动收回遮罩）+ 顶栏退出登录
- socket.io 事件链路鉴权三件套（F-EXT-14 🔴）：握手票据（面板会话派生 HMAC，12h TTL）+ room 名白名单 + 服务间 emit 密钥（`x-emit-secret`）——此前任意来源可连 2608 订阅任意房间（文档名/错误信息/ID 枚举泄露）

**可靠性（流水线语义修正）**
- 任务重试指数退避（F-CONC-01 🔴）：`PipelineJob.notBefore` 字段 + 2s/8s/30s+jitter——短暂抖动不再 4 秒烧完 3 次重试预算导致永久失败
- 僵死回收减扣 attempts（F-CONC-02 🔴）：进程卡顿/GC 停顿（>120s 心跳过期）不再白烧重试次数
- MinerU 流式化 + 体积感知超时（F-EXT-04/05 🔴）：云上传改流式请求体（200MB 峰值内存 400MB+→流式）；超时 60s+1.5s/MB 封顶 15 分钟（原固定 120s 在 <2MB/s 上行必超时→重传→耗尽）
- 嵌入熔断器（F-EXT-02）：连续 6 次可重试失败→开路 60s 快速失败（半开探测恢复，退避翻倍封顶 10 分钟）；超时按批字符量动态化（F-EXT-01）；响应数量不符纳入重试（F-EXT-03）
- 引擎/备份/日志清理三调度器进程自启动（F-CONC-04/18）：此前重启后仅靠 API 惰性触发，仅经 MCP/Dify 层使用时在途任务永久挂起；全局 unhandledRejection/uncaughtException 兜底日志（F-CONC-15）；引擎定时器 unref（F-CONC-17）
- MinerU 轮询三级限流退避（F-CONC-06/EXT-07/EXT-09）：单轮任务并发 ≤4、复合句柄段探测并发 ≤4、探测失败指数退避（5→60s）——远端限流压力与日志噪音双降
- 入队背压 429（F-CONC-05/16）：在途深度上限 500，超限返回 Retry-After——批量拖拽 500 文件不再无声打满磁盘/配额
- 终态数据保留策略（F-LOC-09）：completed/cancelled 任务 7 天、failed 30 天、调用日志 30 天，引擎惰性清扫（冷却 1h）
- MinerU provider 切换影响面警示（F-LOC-13）：在途任务将自动重传的配额消耗在保存时明示

**性能与内存**
- 解压炸弹防护 + 异步解压（F-LOC-01 🔴 + F-EXT-06）：`safeUnzip` 三层预算（条目 ≤5000 / 单条 ≤256MB / 总量 ≤512MB，展开前拦截）替换全部 4 处 `unzipSync`——恶意 zip 不再 OOM，解压不再冻结事件循环
- 切分坐标回填预排序 + 双二分（F-LOC-03）：O(chunks×blocks·log blocks) → 排序一次 + 每次双二分（乱序/重叠块语义不变，2000 块 6000 chunk 实测语义 0 偏差）
- 设置 3s TTL 进程内缓存 + 写后失效（F-LOC-08）；PrismaClient 无条件单例（F-LOC-07）；verifyApiKey 索引直查 O(log n)（原全表扫描）
- HNSW m 可配置（F-EXT-12）：默认 0 保持低内存权衡，大库（>10 万点）可在设置页调 16；空闲期 WAL checkpoint（F-LOC-11）；displayWidth 码点查表（F-LOC-02）

**正确性**
- 健康检查文案与硬失败行为一致（F-E2E-02）+ 健康矩阵新增「实时事件服务」探活行（F-EXT-15）
- middle.json 定位 miss 不再退化为 0 污染溯源坐标（F-EXT-08：游标估算+继承页码+miss 率告警）；句点切分上下文判断（F-LOC-06：3.14/v1.2.3/e.g. 不误切）；OOXML CDATA/属性变体提取（F-LOC-05）
- KB 点数统计失败保留上次值（F-EXT-11）；KB 级写链串行化（F-CONC-09）；413 上传中断清理临时文件（F-E2E-05）；traceId 入库生成贯穿失败日志（F-CONC-12）

**端口体系与产品需求**
- 端口切换：面板默认 **2607**（`PANEL_PORT` 可覆盖，`scripts/dev.ts` 启动包装器自动读 .env）、socket.io **2608/2609**（原 3003/3004，与常见 3000 段服务冲突）；emit 地址 `RAG_EVENTS_EMIT_URL` 可环境变量化
- Dify 导出对接对话框瘦身：移除链路自检三按钮（检查链接/模拟导出/公网可达性）与 `/api/dify/reachability` 端点；新增 API Key 管理（列表/启停/删除/内联创建）
- 管理面登录、Key 管理、设置改密全部落 ProgramLog 审计（auth 分类）

### v1.9（2026-10 · 仓库治理修复与 Dify 导出链路攻坚）

> 本轮为 v1.8 之后的仓库治理与 MinerU 导出问题攻坚补录：包括一次影响仓库完整性的 .gitignore 缺陷修复、MinerU「导出到 Dify」失败根因的分析实证、Dify 对接入口的产品化迁移，以及程序日志的存储可观测性。

**仓库治理（重要修复）**
- `.gitignore` 规则缺陷导致业务路由被静默忽略：bare `backups/` 等目录规则会匹配任意层级目录，曾使 `src/app/api/system/backups/` 下 9 个备份 API 路由文件从未进入仓库（线上仓库存在 UI 调用缺失 API 的坏状态）——全部目录规则改根锚定（`/backups/`），并根锚定 `db/`、`artifacts/`、`download/`、`upload/` 防同类误伤；恢复环境丢失的 `.env.example` 与 LICENSE
- 补齐被误忽略的备份系统 9 个 API 路由（列表/创建/详情/删除/下载/恢复/Qdrant 快照恢复/快照文件/定时计划 + 快照下载），仓库与运行代码完全一致

**MinerU 导出到 Dify（失败根因与修复）**
- 分析 mineru-desktop 前端 bundle 实证导出链路架构：「检查链接/选择导出位置」是用户浏览器直连 `GET /v1/datasets`（跨域 CORS），而「导出」是浏览器 POST mineru.net 后端 `/api/v4/tasks/{taskId}/dify`，由 **mineru.net 服务器**向 `{平台地址}/v1/datasets/{id}/document/create-by-text` 做服务器端转发——因此**检查链接通过 ≠ 导出可用**，导出要求平台地址对 mineru.net 公网可达（内网 / localhost / 临时预览域名会「检查链接成功但导出失败」）
- 以 MinerU 精确载荷（name/text/indexing_technique=high_quality/process_rule/doc_form/created_from）联调 create-by-text 通过；`docs/dify-compat.md` 新增「导出链路架构（必读）」与故障排查专行

**Dify 对接入口迁移（产品化）**
- 「Dify 导出对接」入口从 Agent API 视图迁移至**知识库视图**头部配置按钮（与入库 API `/api/input` 彻底分离、相互独立）；对接配置（平台地址自动检测 + 导出专用 Key 内联创建）+ 说明介绍一体
- Agent API 视图收敛为纯入库 API 文档卡 + Key 管理；契约 §32/§34 与 README 入口描述同步

**可观测性**
- 程序日志存储占用接入系统运维：磁盘区新增「程序日志（N 条 · 估算）」占用条；日志卡头部显示全量条数与估算体积（`GET /api/system/oplogs` 返回 stats）
- 程序日志定时清理（默认关闭）：保留时长（1h–1 年）+ 清理级别上限（info/warn/error）可配置，进程内调度器自动轮转（`QdrantSetting.oplogAutoClean*` 三字段）

### v1.8（2026-10 · 平台定位收敛：知识库管理 + 入库接口生态）

> 本轮按「平台只做知识库管理」重新划定边界：**对外检索 API 与检索日志整体移除**（检索调用与审计由独立平台承担）；
> 对外能力转向**入库接口生态**——/api/input（AI 调用）、/v1/datasets（Dify 兼容，MinerU 面板直连）、MCP Server（Claude/Cursor）。

**功能新增**
- `/api/input` 入库 API（11 端点）：建库（retrievalMode 元数据）/ 多文件并发上传 / 文本入库 / 状态轮询 / 重试 / 删除；401/403 读写角色分离；应用内一键查看 513 行超详细文档
- `/v1/datasets` Dify 兼容层（13 端点）：MinerU 面板「导出到 Dify」填本平台地址+Key 直连；process_rule（段落分隔符+每段最大 token）→ chunk size 映射；Dify indexing_status 状态机映射
- MCP Server `mcp/`（inkrag-mcp）：10 工具 stdio，Claude Desktop / Cursor 配置示例（中英双语）
- 运维程序日志：ProgramLog 表 + 全链路埋点（共享层/流水线失败/设置/Key/备份）+ instrumentation 全局兜底；OpsView 程序日志卡（筛选/详情展开/导出/清理）
- 共享入库层抽取：kbcreate / ingest / 删除重试三 core——UI、/api/input、/v1/datasets 三链路同一实现；KnowledgeBase 新增 retrievalMode 字段（KbSummary 暴露）

**功能移除（§32，破坏性）**
- `POST /api/v1/knowledge-bases/[kbId]/search`、`POST /api/search/debug`、`GET /api/dashboard/trends` → 404；仪表盘不再返回 recentLogs
- Prometheus rag_search_* 指标与 metricsSummary.search 字段
- 前端「检索调试台」视图、「检索质量趋势」卡、「最近检索日志」表（导航与 store 收敛）
- runSearch 不再写检索日志（保留供测试集质量回归与内部排障）

**修复**
- MinerU 设置「测试连接」失效根因：/api/qdrant/test 路由文件曾因环境异常丢失（主工作区；仓库未受影响）——恢复后「以已保存配置直接测试」正常（无参回退 DB 设置）
- Task 16 遗留 E2E 收口：MinerU 云免费档排队 12h 过期（-60012）→ 按 6h 等待上限设计失败、错误信息清晰；超大 PDF 自动拆分链路行为符合设计


### v1.7（2026-10 · 超大 PDF 拆分联动 MinerU 与编辑一致性闭环）

> 本轮聚焦「大文件解析体验」与「编辑所见即所得」：MinerU 官方云对单文件有页数/体积硬限制（云·精准 200MB/200 页、轻量 10MB/20 页），超限此前直接业务失败；chunk 编辑只改数据层不落文档产物，重新入库会回到旧文本。

**超大 PDF 自动拆分（MinerU 联动）**
- 超限 PDF 提交前用 pdf-lib 按页自动拆分成多段，逐段提交远端（复合句柄 `{kind:'parts'}` 持久化），全部完成后**精确偏移合并**产物（markdown 拼接 + middle.json 页码累加 / 字符偏移平移，检索无感）
- **断点续传粒度 = 段**：仅失效段重新上传，已提交段不重传、不重复计费
- **实时进度可见**：轮询器聚合各段状态，活动流实时显示「MinerU 解析中（k/n 段完成 · 排队中/解析中）· 已等待 N 分钟」
- 设置新增「超大 PDF 自动拆分」开关与每段页数（0 = 按服务商默认；体积超限按页密度自动折算更小段）
- 上传对话框明确提示页数/体积限制、自动拆分行为与额度消耗、Node 引擎本地解析无页数限制（扫描件需 MinerU OCR）

**编辑一致性（chunk → 文档产物双向同步）**
- chunk **编辑 / 还原**：full.md 区间同步替换 + 后续 chunk 偏移平移 + 父块重切片 + middle.json 重对齐——重新入库 / 重切不再回到旧文本
- chunk **删除**：full.md 对应区间同步删除，防止重切时被删内容复活
- **版本恢复回写产物**：快照携带 full.md 全文（≤8MB），恢复历史版本时直接回写（旧快照按子块全文降级拼接），响应携带 `mdRestored` 修补结果

**连接与调度体验**
- **修复探测不一致**：连接测试接口无参 / 掩码密钥时回退读已存设置（此前上传对话框把掩码密钥当真实 Key 探测且不传 Provider，导致「设置里测试 200、上传时却提示未连接」）
- **修复瞬态 404 报错**：前端 API 层对 dev 重启 / 网关闪断窗口的 HTML 404 自动重试（两退避），根治「调度状态加载失败：Non-JSON response: 404」类报错
- **修复事件服务热重载分裂**：globalThis 单例守护，`bun --hot` 重载不再丢失实时事件（此前重载后 emit 打到新实例、旧连接全部失联回收）
- **按扩展名智能路由**：全局 MinerU 模式下仅 Node 类型（md/txt/csv 等）本地直解省额度（此前整包提交 MinerU 必被拒），双引擎类型走 MinerU 高保真
- **设置 PUT 缺省保留现值**：部分更新不再清空未携带字段
- **切分沙盒按钮合一**：参数有变更 =「入库此切分结果（N 项变更）」；无变更 =「按当前配置重新入库」，语义弹窗分明
- **运维调度透明化**：任务统计补「等 MinerU / 已取消」两态 + 可折叠调度说明（并发 2、等待不占槽、心跳回收、重试、断点续传、自动拆分）

### v1.6（2026-10 · 安全与性能审计整改）

> 本轮基于一次全面的安全与性能审计（覆盖 50 个后端路由、全部核心库、数据模型与构建配置），针对三大"静默错误"设计与吞吐锁死问题进行集中整改：

**正确性与安全（P0）**
- **移除本地向量引擎降级模式**：未配置 / 不可达 Qdrant 时写入一律硬失败并给出配置引导，杜绝"写本地、读 Qdrant"造成的静默索引断裂；LocalVectorStore 与 VectorPoint 表整体删除
- **Mock 嵌入默认关闭**：未配置真实 Embedding API 时嵌入硬失败；建库强校验（必须已配置 Qdrant 与 Embedding，实测探测锁定维度），不再有 `mock-bge-m3` 兜底
- **稀疏向量方案锁定**：知识库新增 `sparseScheme` 字段（建库时探测写入），真实模式稀疏输出多字段探测（`sparse_indices` / `lexical_weights` / `sparse_embedding` 等，兼容多种值形态），探测不到显式标记 `none` 并强制 dense 检索，**不再静默退化为哈希词袋**；入库与版本恢复双重断言防止两套稀疏空间混用
- **SSRF 防护**：URL 导入增加内网 / 云元数据 / CGNAT 地址黑名单 + DNS 逐 IP 校验 + 手动逐跳重定向校验 + 流式读取 8MB 限额
- **上传与响应加固**：单文件 200MB / 单请求 500MB 上限；文档预览改 `attachment` + Content-Type 白名单；全局 `nosniff` / `Referrer-Policy` / `X-Frame-Options` / CSP 响应头
- **密钥安全**：设置接口密钥掩码返回（`***尾4位`，留空保持原值）；API Key 改 sha256 哈希存储 + 恒定时间比对，存量明文惰性迁移销毁

**性能与可靠性（P1）**
- **流水线重构**：MinerU 等待移出并发槽位（`waiting_mineru` 状态 + 独立轮询器 + `mineruJobId` 断点续传，杜绝重复上传重复计费）；僵死恢复改心跳续租（120s 无心跳回收，AbortController + CAS 防双跑）；嵌入批内 4 路并发、入库 2 路并发；MinerU 信号量竞态修复
- **取消语义**：删除知识库 / 重复解析自动取消在途任务（`cancelled` 状态），不再产生半写状态与并发写冲突
- **事件推送 fire-and-forget**：流水线不再被事件服务阻塞；进度节流表 TTL 清理防内存泄漏
- **SQLite 开启 WAL 与 busy_timeout**；Qdrant 探测超时与重试参数适配高延迟远程实例

**工程卫生（P2）**
- 清理脚手架残留与 5 个零引用依赖；健康检查按 MinerU Provider 三态判定；修复活动流未定义字段引用

> 安全说明：本平台定位为本地 / 内网自部署工具，管理面未内置登录鉴权；如需暴露公网，请置于带认证的反向代理（如 Caddy / Nginx Basic Auth）之后，并妥善保管数据目录。

### v1.5（2026-10）

> 本轮源于一轮集中反馈修复与功能补强，全部按需求清单逐项交付：

- **文档版本管理**：恢复历史版本（含向量数据重建）、删除版本；快照升级为携带全文与溯源字段（§27）
- **版本号全覆盖**：切分沙盒新增「入库此切分结果」；三屏联动启用 / 编辑 / 还原 / 删除 chunk 统一自动归档快照并递增版本号（流水线进行中 409 保护）
- **实时活动流重做**：原内存型活动日志重做为任务中心——逐文档解析 / 切分 / 向量化 / 入库进度实时推送，失败重试、报错展开、完成隐藏、失败可删（§28）
- **系统运维资源占用**：进程内存 / CPU、系统负载、磁盘明细实时监控
- **备份一体化**：面板数据 + Qdrant snap 一同创建 / 下载 / 恢复，分开单独创建；tar.gz 备份包与 .snapshot 快照上传恢复（§29）
- **MinerU 双模式修复**（核心）：修复自部署与官方云 API 协议错位问题（404 根因），支持三种接入方式切换 + 状态探测 + 并发信号量
- **解析类型大扩展**：从 7 种扩至 29 种（Node 22 种 + MinerU 12 种）；图片解析支持
- **上传体验重构**：两段式确认（不自动跑）、MinerU 开关（探测可用性）、逐文件引擎选择、类型推荐矩阵说明；URL 导入引擎可选
- **移除 sitemap/wiki 递归导入**
- **布局修复**：主布局改原生滚动，修复 ScrollArea 与 flex 布局交互异常（11 视图 + 基座组件）
- 页脚新增 GitHub 开源地址；平台品牌定为「InkRAG」

### v1.4

- 品牌与体验：关闭 Next dev 徽标；设置弹窗输入框失焦 bug 修复（组件身份不稳定根因）
- 真实模式联调：远程 Qdrant 1.19.1 + bge-m3 嵌入 + bge-reranker-v2-m3 重排全链路打通；三模块瞬时错误批内退避（429/超时指数退避）；upsert 分批优化
- 文档解析管线升级：DOCX 结构化解析（mammoth + 共享 HTML 清洗器）；URL 导入；批量上传流式进度（并发 2 双队列 + socket 六阶段）
- 修复 /api/qdrant/test 路由缺失；建库维度自动探测

### v1.3

- 检索台下钻事件消费端闭环（模式/KB 上下文跟随 + 视觉反馈）
- Qdrant 快照管理（创建 / 列表 / 下载 / 恢复 / 删除，1.9.x 兼容）
- 测试集运行历史（异步运行实时刷新 + 历史展开）
- 全局窄屏 grid 溢出清理（17 处）

### v1.2

- 快捷动作 + 趋势图下钻；stale 测试集三态闭环；文档版本管理（chunk 级 diff + 导出报告）
- 文档版本快照机制（reparse/rechunk 前归档）

### v1.1

- 三屏联动（PDF 坐标高亮 / Markdown / chunk 双向联动）；chunk 编辑重入库；切分沙盒
- 检索调试台白盒四阶段；测试集回归；备份与恢复（VACUUM INTO + 产物归档 + 定时调度）
- 命令面板（Ctrl+K）；深色模式；Agent API v1

### v1.0

- 平台基座：知识库 / 文档流水线（parse → chunk → embed → upsert 六阶段状态机）/ 父子双块切分 / 混合检索三模式 / 本地向量引擎降级 / Qdrant 双模式 / 基座工作台（集合浏览 / 点检索 / 调用日志）
## License

本仓库基于 **InkRAG Open Source License**（[LICENSE](./LICENSE)，Apache License 2.0 + 附加条款）开源发布。

- **著作权始终归 Inkcoo（koshoutou）所有。**
- **保留作者署名（Inkcoo / InkRAG）时：可闭源、可商用**，可对外提供服务、可出售，无需另行取得商业许可。
- 若在**对外商用产品/服务**中**移除作者署名（Inkcoo / InkRAG）**：须先取得 **Inkcoo** 的书面授权（是否收费、收费多少由作者决定）。
- **商业规模门槛**：达百万级月活跃用户（MAU）或千万人民币级月营收时，即便保留署名，对外提供服务也须取得 **Inkcoo** 的商业许可。
- 商业授权详见 [COMMERCIAL.md](./COMMERCIAL.md)。

## NOTICE

版权与署名信息见 [NOTICE](./NOTICE)。

## 致谢 / Acknowledgments

本项目的功能设计与协议实现参考并受益于以下优秀的开源社区项目，在此致以诚挚的感谢：

- [Dify](https://github.com/langgenius/dify) —— 知识库 API 交互规范与 `/v1/datasets` 兼容层的设计参考
- [RAGFlow](https://github.com/infiniflow/ragflow) —— 文档清洗算法与多屏联动交互的设计参考
- [MinerU](https://github.com/opendatalab/MinerU) —— 文档解析引擎接入与「导出到 Dify」链路的设计参考

再次感谢上述开源项目及其维护者为整个开源社区所做出的杰出贡献。
