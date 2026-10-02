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

### 检索与调试
- **混合检索**：Dense（bge-m3）+ Sparse（BM25 近似）+ RRF 融合 + Rerank（bge-reranker-v2-m3），dense/sparse/hybrid 三模式
- **三屏联动**：原文（PDF 坐标高亮）/ Markdown / chunk 列表双向联动；chunk 可编辑、启停、删除——变更即重嵌入、同步向量库、自动递增文档版本号
- **切分沙盒**：无损参数试验（size/overlap/parentSize/strategy/保护块），300ms 防抖预览，「入库此切分结果」一键落库
- **检索调试台**：白盒四阶段耗时、命中卡片、调用日志回放、趋势图下钻
- **测试集回归**：金标准用例 + 命中率/MRR 评估 + 异步运行历史

### 版本管理
- **自动快照**：重解析 / 重切分 / chunk 编辑 / 启停 / 删除 / 恢复前自动归档当前版本（含全文）
- **chunk 级 diff**：LCS 锚点 + bigram dice 相似度，四类变更（same/added/removed/changed）
- **恢复历史版本**：归档当前 → 版本号 +1 → 重建 chunks → 重新向量化写入向量库；无损/降级恢复徽标
- **删除版本**：历史快照可单独删除

### 可观测与运维
- **实时活动·任务中心**：每篇文档的解析 → 切分 → 向量化 → 写入向量库全程进度实时推送（socket.io）；失败可重试、报错可展开、完成自动隐藏、失败记录可删除
- **系统运维**：健康矩阵（Qdrant/向量引擎/嵌入/MinerU/Rerank/流水线）、平台资源占用（进程内存/CPU、系统负载、磁盘明细）、Prometheus 指标
- **备份一体化**：面板数据（SQLite + 产物）与 Qdrant 快照一同创建 / 一同下载 / 一同恢复，也可分开单独操作；支持上传备份包（tar.gz）与 Qdrant 快照（.snapshot）恢复；定时自动备份含轮转清理
- **Agent API**：Bearer Key 鉴权对外检索 API（v1），读写角色分离

## 技术栈

Next.js 16（App Router）· TypeScript · Tailwind CSS 4 · shadcn/ui · Prisma（SQLite）· socket.io · Zustand · TanStack Query · pdfjs-dist · mammoth · fflate · cheerio

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 初始化数据库
cp .env.example .env   # 按需修改 DATABASE_URL
bun run db:push

# 3. 启动主服务（端口 3000）
bun run dev

# 4. 启动实时事件服务（socket.io，端口 3003/3004）
cd mini-services/pipeline-events && bun install && bun run dev
```

打开 `http://localhost:3000`，在「设置」中配置 Qdrant / Embedding / Rerank / MinerU；不配置时自动进入本地演示模式（本地向量引擎 + Node 解析器 + Mock 嵌入）。

### MinerU 接入方式选择

| 方式 | 适用 | 凭据 |
|---|---|---|
| 自部署 V1（`mineru-kit api-server`） | 数据不出内网 / 离线 / 自控算力 | 可选 Bearer |
| 官方云·精准（`mineru.net/api/v4`） | 最高精度 / 批量 / 多格式导出 | Bearer Token |
| 官方云·Agent 轻量（`mineru.net/api/v1/agent`） | 零门槛 / 单文件 ≤10MB | 免 Token（IP 限频） |

> 注意：三者协议互不兼容。自部署请填 **API Server 端口**（默认 8000，`/v1/health` 握手），不要填 WebUI 端口（7860）——WebUI 不实现 `/v1/*` 协议，会导致 404。

## 文档

- [API 契约（29 节）](./docs/api-contract.md)

## 更新日志

### v1.5（2026-10 · 本轮）

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
