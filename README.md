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
- **Dify 兼容导出 API `/v1/datasets`**：MinerU 面板「导出到 Dify」直接对接本平台——配置入口在「知识库」视图「Dify 导出对接」按钮（地址/Key 配置 + 检查链接/模拟导出/公网可达性三步自检 + 对接文档）；状态映射到 Dify indexing_status、process_rule.max_tokens→chunk size；注意导出由 mineru.net 服务器转发，平台需公网可达（文档 §2）；对接文档 `docs/dify-compat.md`
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
