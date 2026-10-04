# Dify 兼容数据集 API（/v1/datasets）· 对接指南

> **一句话定位**：本平台在 `/v1` 前缀实现了 Dify「知识库 API（Datasets）」的兼容子集。
> 在 **MinerU 面板「导出到 Dify」** 中填**本平台的访问地址**与**平台 API Key**，即可把解析结果直接导出到本平台入库——不需要部署 Dify。
>
> ⚠️ **先看 §2 导出链路架构**：「检查链接」是浏览器直连，而「导出」由 **mineru.net 服务器转发**——
> 平台地址必须**公网可达**（内网/临时预览域名可能出现「检查链接成功但导出失败」）。

---

## 1. 快速开始（30 秒）

1. 在平台 **知识库视图 → Dify 导出对接**（配置按钮）中创建或选择一把 API Key（建议 `operator` 或 `admin` 角色；`readonly` 无法写入）
2. 在 MinerU 面板打开 **导出 → Dify**：
   - **API 服务器地址**：填本平台地址（如 `https://your-domain`，**不要带 `/v1`**——面板会自动拼接，与 Dify 官方 `https://api.dify.ai` 的填法一致）
   - **API 密钥**：填平台 API Key（`rag-` 开头；Dify 官方为 `dataset-` 开头，本平台按 Bearer 原样校验，前缀不限）
3. 点击 **检查链接**——面板会请求 `GET /v1/datasets`，返回 200 即连接成功
4. 选择导出位置（已有数据集 = 平台知识库，或新建数据集 = 平台自动建库）
5. （可选）配置高级选项：段落分隔符、每段最大 token 数（≤7500）→ 点击 **导出**

导出完成后，文档进入平台流水线（解析 → 切分 → 向量化 → 写入 Qdrant），可在平台「文档中心」查看实时进度，用「三屏联动」核对解析产物。

诊断方法：从外部网络（如手机热点）访问 `https://your-domain/v1/datasets`，能看到 JSON 401 响应即说明公网可达。

---

## 2. 导出链路架构（必读：为什么检查链接成功、导出却失败）

对 MinerU 面板前端（mineru-desktop bundle）分析实证的调用架构：

| MinerU 面板动作 | 实际调用方 | 调用路径 | 网络要求 |
|---|---|---|---|
| 检查链接 | **用户浏览器**（跨域 CORS） | `GET {平台地址}/v1/datasets` | 浏览器 → 平台可达 |
| 选择导出位置（列表/新建） | **用户浏览器** | `GET/POST {平台地址}/v1/datasets…` | 同上 |
| **导出** | **mineru.net 服务器**（服务器端转发） | 浏览器 → `POST mineru.net/api/v4/tasks/{taskId}/dify`（携带 app_key/dataset_id/host/content）→ mineru.net 服务器 → `POST {平台地址}/v1/datasets/{id}/document/create-by-text` | **mineru.net 服务器 → 平台公网可达** |

导出时浏览器把 `app_key / dataset_id / host(平台地址) / content(导出参数)` 提交给 mineru.net 后端，由**mineru.net 的服务器**从它自己的网络向平台发起 `create-by-text`。因此：

- **检查链接通过**：只证明「你的浏览器 → 平台」通（比如平台就跑在你本机/内网/临时预览域名，浏览器自然能访问）。
- **导出失败（“糟糕，操作失败，请稍后再试 / 导出失败”）**：mineru.net 服务器访问不到你填的平台地址（内网地址、localhost、临时预览域名、或被 mineru.net 出站网络阻断）。此时平台侧不会收到任何请求（日志无 create-by-text 记录）。

**解决**：把平台部署在**公网稳定可达的域名**上（自有服务器 + 域名 + 反向代理 HTTPS，README 有反代加固指引），然后在平台「知识库 → Dify 导出对接」里用**公网可达性检测**复测，通过后再到 MinerU 面板导出。

> 附：MinerU 导出载荷实测兼容——`{ name, text, indexing_technique: "high_quality", process_rule: { mode, rules: { pre_processing_rules[], segmentation: { separator, max_tokens } } }, doc_form: "text_model", created_from: "api" }`，平台的 `create-by-text` 已按该精确载荷联调通过（含 automatic/custom 两种 mode、分隔符与 max_tokens 映射）。

---

## 3. 端点总表（Dify Service API 兼容子集）

| 方法 | 路径 | 平台语义 | 说明 |
|---|---|---|---|
| GET | `/v1/datasets?page=&limit=&keyword=` | 知识库列表 | 分页，Dify 响应形状 |
| POST | `/v1/datasets` | 创建知识库 | name ≤40 字符；重名 409 `dataset_name_duplicate` |
| GET | `/v1/datasets/{id}` | 知识库详情 | |
| PATCH | `/v1/datasets/{id}` | 重命名 / 改描述 | `{ name?, description? }` |
| DELETE | `/v1/datasets/{id}` | 删除知识库 | **204 空体**；级联删除文档/向量/产物 |
| GET | `/v1/datasets/{id}/documents?page=&limit=&keyword=` | 文档列表 | 含 indexing_status |
| GET | `/v1/datasets/{id}/documents/{docId}` | 文档详情 | |
| DELETE | `/v1/datasets/{id}/documents/{docId}` | 删除文档 | **204 空体** |
| GET | `/v1/datasets/{id}/documents/{batch}/indexing-status` | 索引进度 | **batch = 文档 id**（单文件一批） |
| POST | `/v1/datasets/{id}/document/create-by-file` | 上传文件入库 | multipart：`data`（JSON）+ `file` |
| POST | `/v1/datasets/{id}/document/create-by-text` | 文本直接入库 | `{ name, text, process_rule?… }` |
| POST | `/v1/datasets/{id}/document/create_by_text` | 同上（下划线别名） | Dify 废弃别名一并兼容 |

**鉴权**：全部端点要求 `Authorization: Bearer <平台APIKey>`。错误体为 Dify 格式：

```json
{ "code": "not_found", "message": "Dataset not found.", "status": 404 }
```

| code | HTTP | 场景 |
|---|---|---|
| `unauthorized` | 401 | 缺少/错误 Bearer |
| `forbidden` | 403 | Key 已禁用；readonly 角色写入 |
| `not_found` | 404 | 数据集/文档不存在 |
| `invalid_param` | 400 | 参数缺失或非法 |
| `dataset_name_duplicate` | 409 | 创建/改名撞名 |
| `no_file_uploaded` / `too_many_files` | 400 | create-by-file 文件字段错误 |
| `file_too_large` | 413 | 单文件 >200MB |
| `internal_error` | 500 | 服务端异常（含 Qdrant/Embedding 未配置的建库失败引导文案） |

---

## 4. 状态映射（平台状态机 → Dify indexing_status）

| 平台状态 | Dify indexing_status | 备注 |
|---|---|---|
| queued | waiting | |
| parsing | parsing | 含 MinerU 云排队（`waiting_mineru` 轮询期间仍为 parsing） |
| chunking | splitting | |
| embedding / upserting | indexing | |
| ready | completed | `completed_at` 回填 |
| failed | error | `error` 字段透出平台 errorMessage |

`indexing-status` 响应中的 `completed_segments / total_segments` = 平台 chunk 计数（`isParent=false` 口径，与平台 UI 一致）。

---

## 5. process_rule（高级配置）映射

MinerU 导出面板的高级配置对应 Dify 的 `data.process_rule`。本平台的映射策略：

| Dify 参数 | 平台行为 |
|---|---|
| `mode: "automatic"` | 使用知识库默认切分配置（父子索引：size 512 / parentSize 2000 / 结构感知） |
| `mode: "custom"` + `rules.segmentation.max_tokens` | **映射为本次入库的 chunk size**（clamp 64..8192；Dify 允许到 7500，平台按 64..8192 收敛，超出自动截到边界） |
| `rules.segmentation.separator` | **接受并记录**（写入文档 `metaJson.difyParams`），但不按分隔符硬切——平台切分是 Markdown 结构感知（标题/列表/表格/代码块），分隔符语义见下方说明 |
| `rules.pre_processing_rules`（去多余空格/去 URL 邮箱） | 记录；平台解析器在 MinerU/Node 解析阶段已做等价清洗 |
| `indexing_technique`（high_quality/economy） | 记录；平台一律走向量索引（等价 high_quality） |
| `doc_form`（text_model/hierarchical_model/qa_model） | 记录；平台默认即父子双层索引（≈ hierarchical_model） |
| `doc_language` | 记录 |

> **分隔符语义差异（重要）**：Dify 按 `separator`（如 `\n\n`）机械切段 + max_tokens 截断；本平台按文档结构切分（标题层级、列表、表格、代码块原子保护），不做硬截断。绝大多数场景下平台的切分质量更好（尤其 Markdown/PDF 解析产物）；若你的用例强依赖「严格按分隔符切段」，请在导出后于平台「切分沙盒」中预览确认，或使用 /api/input 以 `chunkConfig` 精确控制。

---

## 6. 与 /api/input 的关系

| 维度 | /api/input（入库 API） | /v1/datasets（Dify 兼容层） |
|---|---|---|
| 面向 | AI Agent / 自动化脚本（通用） | Dify 协议消费者（MinerU 面板、Dify 生态工具） |
| 鉴权 | Bearer 平台 API Key | 相同 |
| 建库/上传/查询 | 平台原生语义（retrievalMode、engine 选择、多文件并发） | Dify 形状（process_rule、indexing_status、batch） |
| 多文件 | 单请求多文件 allSettled | 单文件（Dify 协议限制） |
| 引擎选择 | `engine: mineru/node` | 跟随全局智能路由（不暴露 engine 参数） |

两层共用同一共享层（`lib/rag/kbcreate.ts` / `lib/rag/ingest.ts`）——同一套校验、秒传、流水线语义，零行为分叉。

---

## 7. 字段近似说明（诚实披露）

- `word_count`：平台无逐文档词数统计，以 chunk 数近似（Dify 面板展示用途）
- `words_count`（文档级）：同上，以 chunk 计数近似
- `creator`：固定 `{ id: "platform", name: "InkRAG" }`
- `permission`：固定 `only_me`（平台为单租户本地工具，无 Dify 的团队权限模型）
- `processing_started_at` 等 per-stage 时间戳：平台不落盘分阶段时间，`indexing-status` 中相关字段为 `null`，仅 `completed_at` / `error` 真实

---

## 8. curl 示例

```bash
# 列出数据集（= 检查链接）
curl -s "https://your-domain/v1/datasets?page=1&limit=20" \
  -H "Authorization: Bearer rag-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 新建数据集
curl -s -X POST "https://your-domain/v1/datasets" \
  -H "Authorization: Bearer rag-…" -H "Content-Type: application/json" \
  -d '{ "name": "MinerU 导出", "description": "来自 MinerU 面板", "indexing_technique": "high_quality" }'

# 上传文件（等价 MinerU 导出动作）
curl -s -X POST "https://your-domain/v1/datasets/{dataset_id}/document/create-by-file" \
  -H "Authorization: Bearer rag-…" \
  -F 'data={"process_rule":{"mode":"custom","rules":{"segmentation":{"separator":"\n\n","max_tokens":500}}},"doc_form":"hierarchical_model","doc_language":"Chinese"}' \
  -F 'file=@./parsed.md'

# 轮询索引进度（batch = create 响应里的 document.id）
curl -s "https://your-domain/v1/datasets/{dataset_id}/documents/{batch}/indexing-status" \
  -H "Authorization: Bearer rag-…"

# 文本直接入库
curl -s -X POST "https://your-domain/v1/datasets/{dataset_id}/document/create-by-text" \
  -H "Authorization: Bearer rag-…" -H "Content-Type: application/json" \
  -d '{ "name": "notes", "text": "# 标题\n正文…", "process_rule": {"mode":"custom","rules":{"segmentation":{"max_tokens":300}}} }'
```

轮询建议：间隔 2–5s；`indexing_status` 到 `completed` 或 `error` 即停。MinerU 云排队期间可能长时间 `parsing`（平台 6h 等待上限，超时自动 failed 并给出文案）。

---

## 10. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| **检查链接成功但导出失败（“操作失败/导出失败”）** | 导出由 mineru.net 服务器转发调用 `create-by-text`，你的平台地址对它不可达（内网/localhost/临时预览域名）；平台侧日志无任何请求记录即此症状 | 平台部署到公网域名（自有服务器 + 反代）后重试；可从手机热点/外部网络访问 `https://your-domain/v1/datasets` 能看到 JSON 401 即公网可达（详见 §2） |
| 检查链接失败 401 | Key 错误/被删 | 在平台知识库视图「Dify 导出对接」或 Agent API 视图重建 Key |
| 检查链接 404 HTML | 填了带 `/v1` 的地址或平台未部署 | 地址只填根（如 `https://your-domain`） |
| 建库 500 +「未配置 Qdrant/Embedding」 | 平台设置缺连接 | 平台「设置」里配置并测试通过 Qdrant 与 Embedding |
| 导出长时间 parsing | MinerU 云排队 / 大 PDF 拆段中 | 平台「实时活动」看进度；6h 上限自动失败可重试 |
| 413 file_too_large | 单文件 >200MB | 拆分后导出 |
| 删除数据集 204 但面板仍显示 | 面板缓存 | 刷新列表 |

**区分「平台端点问题」与「网络问题」**：在「Dify 导出对接」弹窗依次点 **检查链接（模拟 MinerU）** → **模拟导出** → **公网可达性检测**。前两个全过而第三个失败 = 网络/部署问题（§2）；模拟导出直接报错 = 把错误信息发回来排查。 |

---

## 11. 安全注意

- API Key 通过 MinerU 面板传输到本平台——与 Dify 官方行为一致（密钥只进你自己的平台）；请为 MinerU 导出使用**专用、可随时吊销**的 Key
- `readonly` Key 只能读列表/进度，不能导出（403）
- 平台单租户本地工具定位：`/v1` 与平台 API 一样**未做公网鉴权加固**（README 有反代加固指引）；请勿暴露到不受信网络
