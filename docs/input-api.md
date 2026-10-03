# 入库 API（/api/input）集成文档

> 面向 AI Agent / 自动化集成的**知识入库** HTTP API。
> 基础路径：`/api/input` · 鉴权：`Authorization: Bearer <ApiKey>`
> 完整端点清单与响应结构以本文档为准（契约 §33）；本文档可经 `GET /api/input/docs` 获取原文。

## 1. 概述与定位

本平台是**知识库管理平台**：负责知识库的创建、文档上传、解析（MinerU / 本地引擎双模）、切分（父子索引）、向量化入库、版本管理与备份导出。

**本平台不执行检索**（契约 §32，2026-10 起）：检索调用与审计由独立的外部检索平台承担。因此 `/api/input` 只包含「写入侧」能力——建库、上传、文本入库、状态轮询、重试、删除；没有任何检索 / 召回端点。外部检索平台可通过知识库元数据（`retrievalMode` / `rerankEnabled` / `dim` / `embeddingModel` / Qdrant `collection`）直接对接底层向量库完成检索。

能力速览：

| 能力 | 端点 | 说明 |
|---|---|---|
| 获取本文档 | `GET /api/input/docs` | 公开无鉴权，text/markdown |
| 知识库列表 | `GET /api/input/knowledge-bases` | 含统计与检索元数据 |
| 创建知识库 | `POST /api/input/knowledge-bases` | 自动建 Qdrant 集合 |
| 知识库详情 | `GET /api/input/knowledge-bases/{id}` | 含 doc/chunk/point 计数 |
| 删除知识库 | `DELETE /api/input/knowledge-bases/{id}` | 级联清理（向量/行/磁盘） |
| 上传文件 | `POST /api/input/knowledge-bases/{id}/documents` | multipart，支持多文件并发 |
| 文本入库 | `POST /api/input/knowledge-bases/{id}/text` | 直接提交文本内容 |
| 文档列表 | `GET /api/input/documents` | 跨库查询 / 状态过滤 |
| 文档详情 | `GET /api/input/documents/{id}` | 状态机 + 进度 + 产物可用性 |
| 失败重试 | `POST /api/input/documents/{id}/retry` | 从失败阶段续跑 |
| 删除文档 | `DELETE /api/input/documents/{id}` | 级联清理向量与产物 |

## 2. 快速开始（30 秒版）

```bash
# ① 在平台「Agent API」视图创建 API Key（仅此一次展示明文，形如 rag-<32位hex>）
export KEY="rag-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# ② 建知识库（retrievalMode 是给外部检索平台读的元数据，本平台不执行检索）
curl -X POST http://<host>/api/input/knowledge-bases \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name": "agent-kb", "retrievalMode": "hybrid"}'
# → 201 { "kb": { "id": "<kbId>", ... } }

# ③ 上传一个 Markdown 文件
curl -X POST http://<host>/api/input/knowledge-bases/<kbId>/documents \
  -H "Authorization: Bearer $KEY" \
  -F "file=@./notes.md"
# → 201 { "doc": { "id": "<docId>", "status": "queued", ... }, "deduplicated": false }

# ④ 轮询状态直到 ready（建议 2~5 秒一次）
curl -H "Authorization: Bearer $KEY" \
  "http://<host>/api/input/documents/<docId>"
# → { "doc": { "status": "ready", "chunkCount": 12, ... } }
```

## 3. 鉴权与错误码总表

### 3.1 鉴权

- 所有端点（`GET /api/input/docs` 除外）都要求请求头 `Authorization: Bearer <ApiKey>`。
- API Key 在平台「Agent API」视图创建，明文仅创建时展示一次（落库只存 sha256，恒定时间比对）。
- 角色权限：

| 角色 | 读操作（GET） | 写操作（POST / DELETE） |
|---|---|---|
| `admin` | ✅ | ✅ |
| `operator` | ✅ | ✅ |
| `readonly` | ✅ | ❌ 403 |

- 每次鉴权成功会异步累计 `callCount` 并刷新 `lastUsedAt`（可在「Agent API」视图查看调用量）。

### 3.2 错误码总表

所有错误响应统一为 JSON：`{ "error": "<人类可读的中文说明>" }`。

| 状态码 | 场景 | 处理建议 |
|---|---|---|
| 400 | 参数缺失 / 类型错误 / 扩展名不在白名单 / chunkConfig 非法 / 文件为空 / 非 multipart 请求 | 修正请求体后重试 |
| 401 | 缺少 `Authorization` 头 / Key 无效 | 检查 Key 是否复制完整（`rag-` 前缀） |
| 403 | Key 已禁用（enabled=false）；或 readonly 角色执行写操作 | 换用启用的 operator/admin Key |
| 404 | 知识库 / 文档 / 文档（docs）不存在 | 确认 id；被并发的删除请求清掉也会 404 |
| 409 | 建库重名；对非 failed 状态文档重试 | 换名建库；先轮询到终态再重试 |
| 413 | 单文件 > 200MB；单请求总量 > 500MB；文本 > 200MB | 拆分文件 / 分批上传 |
| 500 | 服务端未捕获异常 | 携带 error 文案联系平台管理员 |
| 503 | 建库时 Qdrant 不可达（不落库行，无孤儿记录） | 检查平台 Qdrant 配置后重试 |

> 建库还有一类 **400 引导错误**：平台未配置 Qdrant 连接或未配置 Embedding API 时，建库直接失败并返回引导到「设置」页的文案——这是部署问题而非请求问题。

## 4. 端点详解

### 4.1 获取本文档

`GET /api/input/docs` —— **公开端点，无需鉴权**。

- 响应：`200` `Content-Type: text/markdown; charset=utf-8`，正文为本文档全文。
- `404`（JSON）：`{ "error": "API 文档尚未部署（docs/input-api.md 不存在）—— 请联系平台管理员" }`

### 4.2 知识库列表

`GET /api/input/knowledge-bases`

- 请求：无参数。
- 响应 `200`：

```json
{
  "kbs": [
    {
      "id": "0c9c6f2e-…",
      "name": "agent-kb",
      "description": "",
      "collection": "kb_0c9c6f2e5dce",
      "embeddingModel": "BAAI/bge-m3",
      "dim": 1024,
      "chunkConfig": { "size": 512, "overlap": 0, "parentSize": 2000, "strategy": "hybrid", "protects": ["code", "table"] },
      "vectorMode": "qdrant",
      "sparseScheme": "none",
      "rerankEnabled": false,
      "retrievalMode": "hybrid",
      "docCount": 3,
      "chunkCount": 57,
      "pointCount": 57,
      "createdAt": "2026-10-03T12:00:00.000Z",
      "updatedAt": "2026-10-03T12:05:00.000Z"
    }
  ]
}
```

- 说明：按创建时间倒序；`pointCount` 为库行快照（流水线每次 ready 后回写），不实时探测 Qdrant。

### 4.3 创建知识库

`POST /api/input/knowledge-bases` → `201 { "kb": KbSummary }`

请求体（JSON）：

| 字段 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `name` | string | ✅ | — | 全局唯一（重名 409）；非空 |
| `description` | string | ❌ | `""` | 任意文本 |
| `chunkConfig` | object | ❌ | 平台默认 | 见 §6；非法值返回 400 |
| `rerankEnabled` | boolean | ❌ | `false` | 检索元数据（§7） |
| `retrievalMode` | string | ❌ | `"hybrid"` | `hybrid` / `dense` / `sparse` 三选一，其他值静默回退 `hybrid` |
| `dim` | number | ❌ | 实测维度 | 与嵌入模型实测维度不一致 → 400 |

建库行为（与平台 UI 完全一致）：名称唯一校验 → Qdrant / Embedding 配置强校验（未配置 400）→ 实测探测嵌入维度并锁定 → 创建 Qdrant 集合（不可达 503，不落库行）→ 落库。

```bash
curl -X POST http://<host>/api/input/knowledge-bases \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "agent-kb",
    "description": "由 Agent 创建",
    "retrievalMode": "sparse",
    "chunkConfig": { "size": 400, "overlap": 50, "strategy": "title" }
  }'
```

```python
import requests

r = requests.post(
    "http://<host>/api/input/knowledge-bases",
    headers={"Authorization": f"Bearer {KEY}"},
    json={"name": "agent-kb", "retrievalMode": "sparse"},
    timeout=30,
)
kb = r.json()["kb"]  # 201；重名时 r.status_code == 409
```

```javascript
const res = await fetch('http://<host>/api/input/knowledge-bases', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'agent-kb', retrievalMode: 'sparse' }),
})
const { kb } = await res.json() // 201
```

错误示例：`409 { "error": "知识库名称已存在：agent-kb" }`

注意事项：`dim` / `embeddingModel` 建库后不可改（换模型 = 新建库重导）；`retrievalMode`、`rerankEnabled` 建库后可在平台 UI 调整（PATCH 语义目前仅在平台 UI 提供，入库 API 不提供改库端点）。

### 4.4 知识库详情

`GET /api/input/knowledge-bases/{id}` → `200 { "kb": KbSummary }` / `404`。

字段同 4.2；`docCount` / `chunkCount` 为实时计数，`pointCount` 为快照。

### 4.5 删除知识库

`DELETE /api/input/knowledge-bases/{id}` → `200`：

```json
{
  "ok": true,
  "deleted": { "docs": 3, "chunks": 57, "points": 57, "cancelledJobs": 1 }
}
```

- 语义（与平台 UI 删库完全一致）：先取消该库全部在途任务（`cancelledJobs` 计数）→ 删除 Qdrant 集合（`points` 为删除前点数）→ 级联删除 Chunk / Document / PipelineJob / KB 行 → 清理磁盘产物目录 → 残留计数校验。
- Qdrant 不可达时跳过向量集合删除（告警），行数据与磁盘仍正常清理——即该操作**不会**因向量库抖动而失败。
- `404`：库不存在（或已被并发请求删除）。

### 4.6 上传文件（核心端点）

`POST /api/input/knowledge-bases/{id}/documents`（`multipart/form-data`）→ `201`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | file | 二选一 | 单文件字段 |
| `files` | file（可重复） | 二选一 | 多文件字段（`getAll('files')`），与 `file` 可并存 |
| `chunkConfig` | string（JSON） | ❌ | 一次性覆盖 KB 默认切分配置（仅本次入库生效），如 `"{\"size\":400}"` |
| `engine` | string | ❌ | `mineru` / `node` 二选一；缺省跟随全局智能路由（§8） |

响应（多文件）：

```json
{
  "docs": [ { "id": "…", "status": "queued", "chunkCount": 0, "…": "…" } ],
  "deduplicated": [ { "id": "…", "status": "ready", "chunkCount": 12, "…": "…" } ],
  "failures": [ { "filename": "virus.exe", "error": "不支持的文件类型 .exe（支持：pdf / doc / …）" } ]
}
```

- `docs`：全部入库成功（含秒传命中）的 DocSummary 数组，顺序与上传顺序一致；
- `deduplicated`：其中**秒传命中**的子集（见 §5.3）；
- `failures`：逐文件失败明细（扩展名白名单 400、单文件超 200MB、空文件等），**单文件失败不影响其余文件**。

单文件请求额外兼容顶层字段：`{ "doc": DocSummary, "deduplicated": true|false, "docs": [DocSummary], "failures": [] }`。

```bash
# 多文件：一个合法 md + 一个会被拒绝的 exe
curl -X POST http://<host>/api/input/knowledge-bases/<kbId>/documents \
  -H "Authorization: Bearer $KEY" \
  -F "files=@./a.md" -F "files=@./b.pdf" \
  -F 'chunkConfig={"size":400,"overlap":20}' -F "engine=node"
```

```python
files = [("files", ("a.md", open("a.md", "rb"), "text/markdown")),
         ("files", ("b.pdf", open("b.pdf", "rb"), "application/pdf"))]
r = requests.post(
    f"http://<host>/api/input/knowledge-bases/{kb_id}/documents",
    headers={"Authorization": f"Bearer {KEY}"},
    files=files,
    data={"chunkConfig": '{"size":400}', "engine": "node"},
    timeout=600,
)
out = r.json()
for d in out["docs"]:        poll_until_ready(d["id"])
for f in out["failures"]:    print(f["filename"], f["error"])
```

```javascript
const form = new FormData()
form.append('files', fileA)   // Blob / File
form.append('files', fileB)
form.append('chunkConfig', JSON.stringify({ size: 400 }))
const res = await fetch(`http://<host>/api/input/knowledge-bases/${kbId}/documents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}` },
  body: form,
})
const { docs, deduplicated, failures } = await res.json()
```

错误示例：
- `400 { "error": "请求必须是 multipart/form-data" }`
- `400 { "error": "缺少 file / files 字段（至少上传一个文件）" }`
- `413 { "error": "单次请求总上传量 612.0MB 超过上限 500.0MB" }`

注意事项：单文件 200MB（与 MinerU 云一致）；上传为流式接收（伪造 Content-Length 也逃不过流式限额）；`IngestError` 级错误（白名单 / 体积 / 空）在多文件模式下进 `failures`，不改变整体状态码（仍 201）。

### 4.7 文本直接入库

`POST /api/input/knowledge-bases/{id}/text`（JSON）→ `201 { "doc": DocSummary, "deduplicated": boolean }`

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `name` | string | ❌ | `untitled.md` | 文档名；无（或不支持的）扩展名时自动补 `.md` |
| `text` | string | ✅ | — | UTF-8 文本，≤ 200MB；参与 sha256 秒传判定 |
| `chunkConfig` | object | ❌ | KB 默认 | 同 4.6 |
| `engine` | string | ❌ | 智能路由 | 文本默认按 Markdown 走 Node 引擎，一般无需指定 |

```bash
curl -X POST http://<host>/api/input/knowledge-bases/<kbId>/text \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name": "meeting-1013.md", "text": "# 会议纪要\n- 平台定位：知识库管理\n- 检索由外部承担"}'
```

```python
r = requests.post(
    f"http://<host>/api/input/knowledge-bases/{kb_id}/text",
    headers={"Authorization": f"Bearer {KEY}"},
    json={"name": "meeting-1013.md", "text": "# 会议纪要\n…"},
    timeout=60,
)
doc = r.json()["doc"]
```

```javascript
const res = await fetch(`http://<host>/api/input/knowledge-bases/${kbId}/text`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'meeting-1013.md', text: '# 会议纪要\n…' }),
})
const { doc, deduplicated } = await res.json()
```

错误示例：`400 { "error": "缺少 text 字段（不能为空）" }`；`413 { "error": "文本体积 240.0MB 超过单文件上限 200.0MB" }`

### 4.8 文档列表

`GET /api/input/documents?kbId=&status=&q=&limit=&offset=` → `200 { "docs": DocSummary[], "total": number }`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `kbId` | string | 全库 | 指定后仅返回该库；库不存在 → 404 |
| `status` | string | 全部 | `queued` / `parsing` / `chunking` / `embedding` / `upserting` / `ready` / `failed` |
| `q` | string | — | 文件名模糊匹配（contains） |
| `limit` | int | 50 | 1..200 |
| `offset` | int | 0 | ≥ 0，配合 `total` 翻页 |

按 `createdAt` 倒序；每个 DocSummary 附带实时 `chunkCount` / `enabledChunkCount`。

```bash
curl -H "Authorization: Bearer $KEY" \
  "http://<host>/api/input/documents?status=failed&limit=20"
```

### 4.9 文档详情（轮询端点）

`GET /api/input/documents/{id}` → `200 { "doc": DocDetail }` / `404`

```json
{
  "doc": {
    "id": "…", "kbId": "…", "filename": "a.md", "mimeType": "text/markdown",
    "sizeBytes": 1024, "status": "ready", "stageProgress": 100,
    "parseConfigV": 1, "parseEngine": "node",
    "errorCode": null, "errorMessage": null,
    "layoutBlocks": 3, "chunkCount": 5, "enabledChunkCount": 5,
    "sourceUrl": "",
    "metaJson": {},
    "chunkConfigSnap": { "size": 512, "overlap": 0, "parentSize": 2000, "strategy": "hybrid", "protects": ["code", "table"] },
    "storageKey": "<kbId>/<docId>/",
    "markdownAvailable": true, "middleJsonAvailable": true, "sourceAvailable": true,
    "createdAt": "…", "updatedAt": "…"
  }
}
```

- `status` / `stageProgress`：状态机与阶段进度（0-100，按阶段内进度），是轮询的主字段；
- `errorCode` / `errorMessage`：`failed` 时非空，可直接展示给用户或作为重试决策依据；
- `parseEngine`：实际使用的引擎（`mineru` / `fallback`，后者为本地降级引擎；平台 UI 显示为「降级解析」），智能路由的结果可在此核对；
- `chunkConfigSnap`：本次入库实际生效的切分配置快照；
- `markdownAvailable` 等三个布尔：产物落盘可用性。

### 4.10 失败重试

`POST /api/input/documents/{id}/retry` → `200 { "ok": true, "stage": "parse" | "chunk" | "embed" }`

- 仅 `failed` 状态可重试；其余状态 → `409`（如 `{ "error": "仅失败（failed）状态的文档可以重试，当前状态：ready" }`）。
- 从失败阶段续跑（`stage` 返回续跑起点），不产生新版本；重试会先取消该文档在途任务再入队，可安全重复调用。
- 与平台 UI 文档行「重试」按钮完全同一实现（`lib/rag/kb.ts retryFailedDocumentCore`）。

```bash
curl -X POST http://<host>/api/input/documents/<docId>/retry \
  -H "Authorization: Bearer $KEY"
```

### 4.11 删除文档

`DELETE /api/input/documents/{id}` → `200 { "ok": true, "deletedChunks": 12 }` / `404`

语义（与平台 UI 删文档一致）：取消在途任务 → 向量 `delete(filter doc_id)` → 删 Chunk / PipelineJob / Document 行 → 清磁盘产物 → 计数校验 → 回写 KB 统计。向量库抖动不阻塞行删除。

## 5. 并发与流水线语义（重要）

### 5.1 状态机与轮询

文档状态机：`queued → parsing → chunking → embedding → upserting → ready | failed`

- `parsing` 阶段若走 MinerU，**文档状态保持 `parsing`**，底层任务进入 `waiting_mineru`（不占并发槽，见 5.2）；`stageProgress` 会持续上报（含「N/M 段完成 · 已等待 N 分钟」类进度）。
- 每个 `stageProgress` 是当前阶段内的 0-100 进度；阶段切换会重置。

**轮询建议**：

| 项 | 建议 |
|---|---|
| 轮询端点 | `GET /api/input/documents/{id}`（带 chunk 计数与错误字段） |
| 间隔 | 2~5 秒（Node 引擎秒级完成；MinerU 云排队可达分钟~小时级，可退避到 10~30 秒） |
| 终止条件 | `status === 'ready'`（成功）或 `status === 'failed'`（读 `errorCode`/`errorMessage` 决定是否 retry） |
| 超时上限 | MinerU 等待平台上限 6 小时（超时自动 failed）；Agent 侧建议 15 分钟无进度变化再告警 |

### 5.2 并发模型

- 流水线进程内并发 **2** 个执行槽（不同文档并行解析/切分/嵌入）；
- **MinerU 等待不占槽**：提交 MinerU 后任务进入 `waiting_mineru`，由独立轮询器（5 秒一轮）接管远端状态，完成后回到队列继续——大批量 PDF 不会堵死其他文档；
- 多文件上传（4.6）用 `Promise.allSettled` 并发处理，单文件失败互不影响；
- 嵌入写入有全局闸门（64/组、在飞 ≤2、AIMD 自适应限速），Agent 无需自己限流。

### 5.3 秒传（去重）

同一知识库内，`sha256(内容) + parseConfigV` 相同的重复上传**不产生新文档、不入队**：

- 响应 `deduplicated: true`（单文件）或出现在 `deduplicated` 数组（多文件）；
- 返回的是**既有文档**的 DocSummary（可能已是 `ready`、带 chunkCount）；
- Agent 判定 `deduplicated === true` 时可直接复用返回的 doc id，无需再轮询。

### 5.4 失败恢复（重试 / 心跳回收 / 断点续传）

| 机制 | 行为 |
|---|---|
| 阶段重试 | 每个流水线阶段失败自动重试最多 **3 次**（可重试错误自动回队）；不可重试的业务错误（如不支持的类型）立即 failed |
| 心跳回收 | active 任务每 20 秒续租；>120 秒未续租判僵死，自动 abort + 回置重跑（进程崩溃自愈） |
| 断点续传 | MinerU 远端 `jobId/uploadId/fileId` 持久化在文档行；重试时先探测旧任务**不重新上传**；远端 404 才重新提交 |
| PDF 自动拆分 | MinerU 云精准档 200MB/200 页上限，超限自动按页拆段提交、轮询、合并（复合句柄） |
| 手动重试 | `POST /api/input/documents/{id}/retry` 从失败阶段续跑（见 4.10） |

## 6. chunkConfig（切分配置）

```json
{
  "size": 512,
  "overlap": 0,
  "parentSize": 2000,
  "strategy": "hybrid",
  "protects": ["code", "table"]
}
```

| 字段 | 类型 | 默认 | 语义与取值 |
|---|---|---|---|
| `size` | int | 512 | 子 chunk 目标 token 数（建议 200~1024；非数值回退默认） |
| `overlap` | int | 0 | 硬切时相邻子 chunk 的 token 重叠（0~size/2 合理；UTF-8 安全按 rune 切） |
| `parentSize` | int | 2000 | 父 chunk token 上限（父块过大时按标题/段落二分） |
| `strategy` | string | `hybrid` | `token`（纯顺序切）/ `title`（标题树切）/ `hybrid`（标题优先 + token 兜底合并）；其余值回退 `hybrid` |
| `protects` | string[] | `["code","table"]` | 原子保护块类型：代码块 / 表格不跨 chunk 切断（≤size 整块保留，超长按行二分） |

**父子索引结构**：每个文档先按 `parentSize` 切父块（检索时提供完整上下文），父块内再按 `size` 切子块（命中粒度）。向量点同时含父/子两类（子块命中 → 外部检索平台可回读父块文本）。`chunkCount` 统计口径为**子 chunk**。

配置优先级：上传时 `chunkConfig`（一次性覆盖）> KB 建库时 `chunkConfig` > 平台默认。修改配置重切会产生新版本（`parseConfigV` +1，旧版本自动归档），平台 UI 提供文档版本管理；入库 API 只在新入库时指定配置。

## 7. retrievalMode / rerankEnabled（检索元数据）

本平台**不执行检索**，但建库时锁定两项元数据供外部检索平台读取：

- `retrievalMode`：`hybrid`（默认，稠密+稀疏）/ `dense`（仅稠密）/ `sparse`（仅稀疏）。外部检索平台按此选择召回策略；`sparseScheme`（`native`/`none`）指示嵌入服务是否原生提供稀疏向量。
- `rerankEnabled`：库级 Rerank 开关建议。外部检索平台可在召回后按此决定是否重排。
- 外部对接还需读取：`collection`（Qdrant 集合名）、`dim`（向量维度）、`embeddingModel`（嵌入模型，建库时实测锁定，中途换模型会被入库断言拦截）。

## 8. 引擎选择（engine / 智能路由）

上传 / 文本入库可选 `engine`：

| 取值 | 行为 |
|---|---|
| `mineru` | 强制 MinerU（云端高保真解析；适合扫描件 / 复杂版式 PDF / 图片） |
| `node` | 强制本地降级引擎（pdfjs/mammoth 等，秒级完成，无页数限制） |
| 缺省（auto） | 跟随平台全局设置 + **扩展名智能路由** |

智能路由规则（16-c）：

- 全局 **mineru** 模式：仅 Node 支持的类型（md/txt/csv/epub…）→ 本地直解（省额度、快）；仅 MinerU 或双引擎类型（pdf/docx/图片…）→ MinerU 高保真；
- 全局 **fallback** 模式：一律本地引擎；仅 MinerU 支持的类型（图片 / ppt / xls）会给出明确的配置指引错误。

支持类型矩阵（上传白名单共 **30** 种扩展名）：

| 引擎可用性 | 扩展名 |
|---|---|
| 双引擎（Node ✚ MinerU 云） | `pdf` `doc` `docx` `pptx` `xlsx` |
| 仅 MinerU 云（自部署 V1 仅前两类） | `ppt` `xls`；图片 `png` `jpg` `jpeg` `jp2` `webp` `gif` `bmp` |
| 仅 Node（本地引擎） | `md` `markdown` `txt` `html` `htm` `shtml` `csv` `tsv` `rtf` `odt` `ods` `odp` `epub` `ofd` `mhtml` `mht` |

> 自部署 MinerU（V1）保守支持 `pdf` + 图片；官方云·精准 v4 支持上表全部 MinerU 类型。实际使用的引擎在文档详情 `parseEngine` 字段回显。

## 9. 与 Dify 兼容层（/v1/datasets）的关系

平台另提供 **Dify 兼容数据集 API**（`/v1/datasets/**`，独立于 `/api/input`）：

- 用途：让 MinerU 官方面板的「导出到 Dify」功能直接对接本平台——在 MinerU 面板填本平台地址 + API Key 即可把解析结果一键导入知识库；
- 区别：`/v1/datasets` 是 Dify 的数据集协议兼容层（create-by-file / create-by-text 等端点），能力是 `/api/input` 的子集，仅覆盖「建数据集 + 传文档」；完整能力（列表 / 重试 / 删除 / 文档详情轮询）请使用 `/api/input`；
- 鉴权、流水线语义、秒传规则两层完全一致（同一共享层实现）。详见后续 `dify-compat` 专项文档。

## 10. MCP Server（预告）

`mcp/` 目录即将发布独立的 MCP（Model Context Protocol）Server：把本文档全部入库能力封装为 MCP 工具（create_kb / upload_document / ingest_text / get_document / retry / delete…），支持 Claude Desktop、Cursor 等 MCP 客户端零 HTTP 代码接入。鉴权复用同一套 API Key。发布前请先用 HTTP API 集成。

## 11. FAQ

**Q1：建库返回 400「未配置 Qdrant 连接 / 未配置 Embedding API」？**
平台级前置条件未满足：管理员需在「设置 → Qdrant / Embedding」配置并测试连通。这不是请求错误，重试同样的请求不会成功。

**Q2：上传返回 413？**
三道限额：单文件 200MB（与 MinerU 云一致）、单请求总量 500MB、文本入库 200MB。大文件请拆分；超 200 页的 PDF 走 MinerU 时平台会自动按页拆段，无需手动处理。

**Q3：MinerU 一直 parsing 不动？**
MinerU 云免费档排队可能很长（小时级）。文档状态保持 `parsing`、任务处于 `waiting_mineru`（不占并发槽）。平台上限等待 6 小时，超时自动 failed（可 retry 续跑，断点续传不重新上传）。轮询间隔建议退避到 10~30 秒。

**Q4：readonly Key 上传返回 403？**
readonly 角色仅允许 GET。写入操作（建库 / 上传 / 文本入库 / 重试 / 删除）需要 operator 或 admin 角色 Key。

**Q5：重复上传同一文件返回的 id 和上次一样？**
这是**秒传**：同 KB + 内容 sha256 + 解析配置版本一致时直接复用既有文档（`deduplicated: true`），不会产生新版本。需要强制重新入库时，先删除旧文档或修改 chunkConfig。

**Q6：retry 返回 409？**
仅 `failed` 状态可重试；`ready` / 处理中的文档重试会得到 409。流水线自身失败会自动重试 3 次，多数情况无需手动干预。

**Q7：如何拿到切分后的文本给外部检索平台？**
外部平台直接对接 Qdrant 集合（`collection` 字段），向量 payload 含 `doc_id` / chunk 文本与偏移；或使用平台 UI 的导出 / 备份能力。入库 API 不提供 chunk 读取端点（属管理域）。

**Q8：上传成功但 `chunkCount` 是 0？**
`chunkCount` 在入库响应时点为 0 是正常的（流水线异步执行）。轮询 `GET /api/input/documents/{id}` 到 `ready` 后再读 `chunkCount`。
