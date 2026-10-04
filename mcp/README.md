# inkrag-mcp

InkRAG 知识库平台的 MCP（Model Context Protocol）Server。

MCP Server for the InkRAG knowledge-base platform.

---

## 定位 / What it is

中文：本 Server 把平台的**入库 API**（`/api/input`，完整契约见平台 `docs/input-api.md`，可经 `GET /api/input/docs` 获取）封装为 MCP 工具，让 Claude Desktop、Cursor 等 MCP 客户端**零 HTTP 代码**接入：创建知识库、上传本地文件、直接提交文本、轮询流水线进度、失败重试、删除。鉴权复用平台 API Key（`Authorization: Bearer`）。

注意：本平台只做**知识入库**（解析/切分/向量化），**不执行检索**——检索由外部平台直连 Qdrant 完成（元数据 `retrievalMode` / `rerankEnabled` / `collection` / `dim` 可经 `list_knowledge_bases` 读取）。

EN: This server wraps the platform's **ingestion API** (`/api/input`, full contract: `docs/input-api.md`, also served at `GET /api/input/docs`) as MCP tools, so MCP clients (Claude Desktop, Cursor, …) can create knowledge bases, upload local files, ingest raw text, poll pipeline status, retry failures and delete — with zero HTTP code. Authentication reuses the platform API Key (`Authorization: Bearer`).

Note: the platform is **ingestion-only** (parse / chunk / embed). Retrieval is performed by an external platform talking to Qdrant directly (read `retrievalMode` / `rerankEnabled` / `collection` / `dim` from `list_knowledge_bases`).

## 安装 / Install

```bash
# bun（推荐 / recommended）
cd mcp && bun install

# 或 npm / or npm
cd mcp && npm install
```

运行方式（MCP 客户端自动拉起，一般无需手动运行）/ The MCP client launches it automatically; manual run for debugging:

```bash
bun run start          # 或 npm start
INKRAG_BASE_URL=http://localhost:2607 INKRAG_API_KEY=inkrag-xxxx bun src/index.ts
```

`npm run build` 可选（tsc 类型检查，产物不落盘）；开发热重载 `bun run dev`。

### 环境变量 / Environment variables

| 变量 | 必填 | 默认 | 说明 / Description |
|---|---|---|---|
| `INKRAG_API_KEY` | ✅ | — | 平台 API Key。在平台「Agent API」视图创建（明文仅创建时展示一次，形如 `inkrag-<32位hex>`）。缺失时 Server 启动即失败并打印获取指引。Create it in the platform's "Agent API" view; the plaintext key is shown **once** at creation. |
| `INKRAG_BASE_URL` | ❌ | `http://localhost:2607` | 平台地址。Platform base URL. |

## Claude Desktop 配置 / Configuration

`claude_desktop_config.json`（macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`；Windows: `%APPDATA%\Claude\claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "inkrag": {
      "command": "bun",
      "args": ["run", "start"],
      "cwd": "/absolute/path/to/inkrag/mcp",
      "env": {
        "INKRAG_BASE_URL": "http://localhost:2607",
        "INKRAG_API_KEY": "inkrag-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

> 用 npm：`"command": "npm", "args": ["start"]`（或直接 `"command": "node", "args": ["--experimental-strip-types", "src/index.ts"]`，Node ≥ 22.6）。`cwd` 也可省略——把 `args` 写成绝对路径形式 `"args": ["run", "start", "--cwd", "/absolute/path/to/mcp"]` 或在打包安装后用 bin 名 `inkrag-mcp`。

## Cursor 配置

`~/.cursor/mcp.json`（或项目级 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "inkrag": {
      "command": "bun",
      "args": ["run", "start"],
      "cwd": "/absolute/path/to/inkrag/mcp",
      "env": {
        "INKRAG_BASE_URL": "http://localhost:2607",
        "INKRAG_API_KEY": "inkrag-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

## 工具清单 / Tools

| # | 工具 | 对应端点 | 说明 / Description |
|---|---|---|---|
| 1 | `list_knowledge_bases` | `GET /api/input/knowledge-bases` | 精简表：名称/ID/文档数/子chunk数/向量点数/retrievalMode（+ collection/dim/embeddingModel 供外部检索平台对接）。Simplified table per KB. |
| 2 | `create_knowledge_base` | `POST /api/input/knowledge-bases` | `name` 必填；`retrievalMode` / `rerankEnabled` / `chunkConfig` / `description` 可选。Creates KB + Qdrant collection. |
| 3 | `get_knowledge_base` | `GET /api/input/knowledge-bases/{id}` | KB 详情（实时 doc/chunk 计数）。KB detail. |
| 4 | `delete_knowledge_base` | `DELETE /api/input/knowledge-bases/{id}` | ⚠️ 级联删除该库全部文档与向量数据（不可恢复）。Cascades docs & vectors. |
| 5 | `upload_files` | `POST /api/input/knowledge-bases/{id}/documents` | `kbId` + 绝对路径数组 `localPaths`——Server 端读本机文件转 multipart 上传；多文件并发（Promise.allSettled），每文件失败单独透传（`failures`），不炸整批。Reads local files server-side, uploads as multipart; per-file failures isolated. |
| 6 | `ingest_text` | `POST /api/input/knowledge-bases/{id}/text` | 直接提交文本（等价上传 Markdown；`name` 无扩展名自动补 `.md`）。Ingest raw text. |
| 7 | `list_documents` | `GET /api/input/documents` | `kbId`（可选）/ `status` 过滤 / `q` 模糊 / `limit`+`offset` 分页。List & filter docs. |
| 8 | `get_document` | `GET /api/input/documents/{id}` | 轮询主端点：status/stageProgress/errorCode/errorMessage/chunk 数/切分配置快照。Poll pipeline status. |
| 9 | `retry_document` | `POST /api/input/documents/{id}/retry` | 仅 `failed` 可重试（其余 409）；从失败阶段续跑。Failed-only retry. |
| 10 | `delete_document` | `DELETE /api/input/documents/{id}` | 删除单文档（级联清向量/chunk/产物）。Delete one doc. |

### 流水线语义（摘要）/ Pipeline semantics (excerpt)

- 状态机 `queued → parsing → chunking → embedding → upserting → ready | failed`；轮询 `get_document`，间隔 2~5s（MinerU 云排队退避 10~30s），到 `ready`/`failed` 停止。
- 进程内并发 2 执行槽；**MinerU 等待不占槽**，大批量 PDF 不堵其他文档。
- **秒传**：同 KB 内 `sha256(内容)+解析配置` 相同的重复上传不产生新文档（`deduplicated: true`，直接复用既有 doc id，无需再轮询）。
- 阶段失败自动重试 3 次；心跳 20s / 僵死 120s 自动回收；MinerU 断点续传不重新上传。
- 单文件 200MB、单请求总量 500MB；白名单 30 种扩展名（.exe 等进 `failures`）。

EN: state machine `queued → … → ready | failed`; poll `get_document` every 2–5 s; in-process concurrency 2 (MinerU waits don't occupy slots); content-hash dedup (`deduplicated: true` reuses the existing doc); per-stage auto-retry ×3; 200 MB/file & 500 MB/request; 30 whitelisted extensions.

## 安全注意 / Security notes

- **Key 角色权限**：`readonly`（仅 GET）/ `operator`（读写）/ `admin`（读写）。写入类工具（2/4/5/6/9/10）用 readonly Key 会得到 403——按最小权限发放 Key。
- **绝不把 Key 提交进 git**：不要写死在代码 / 配置文件 / 提交信息里。MCP 客户端配置文件（`claude_desktop_config.json`、`mcp.json`）属于本机私有配置，也不要提交；本仓库 `.gitignore` 已忽略 `node_modules`。
- Key 明文**仅创建时展示一次**（平台落库只存 sha256）；泄露请在「Agent API」视图禁用或删除后重建。
- Server 与平台间流量建议处于可信网络（本地/内网）；如经公网请套 HTTPS 反代。
- EN: least-privilege roles (readonly GET-only; write tools need operator/admin); never commit keys to git; plaintext key shown once at creation; keep server↔platform traffic on a trusted network (HTTPS reverse proxy if exposed).

## 故障排查 / Troubleshooting

| 症状 / Symptom | 原因 / Cause | 处理 / Fix |
|---|---|---|
| 启动失败 `缺少必需的环境变量 INKRAG_API_KEY` | 未配置 env | 在 MCP 客户端配置 `env.INKRAG_API_KEY`；在平台「Agent API」视图创建 Key（明文仅展示一次） |
| 工具返回 `无效的 API Key`（401 透传） | Key 复制不完整 / 已删除 | 检查 `rag-` 前缀与 32 位 hex 是否完整；在「Agent API」视图核对/重建 |
| 写操作返回 403（readonly / 已禁用） | Key 角色为 readonly 或 enabled=false | 换用 operator / admin 角色的启用 Key |
| 工具返回 `无法连接平台（…）：fetch failed` | `INKRAG_BASE_URL` 错误 / 平台未启动 | 核对地址（默认 `http://localhost:2607`），确认平台服务在线后重试 |
| 建库返回 400「未配置 Qdrant 连接 / 未配置 Embedding API」 | 平台级前置未满足（部署问题） | 管理员在平台「设置 → Qdrant / Embedding」配置并测试连通；重试同样请求不会成功 |
| 上传后 `chunkCount` 为 0 | 流水线异步执行 | 轮询 `get_document` 到 `ready` 再读 chunkCount（正常现象） |
| `get_document` 一直 `parsing` | MinerU 云免费档排队（可达小时级） | 属预期（等待上限 6h，超时自动 failed 可 retry）；轮询退避 10~30s |

## 开发 / Development

```bash
bun run dev      # 热重载
npm run build    # tsc --noEmit 类型检查
```

结构：`src/index.ts`（stdio transport + 10 工具注册）｜`src/client.ts`（`/api/input` 薄封装：fetch、Bearer、`{error}` 透传）。依赖 `@modelcontextprotocol/sdk` + `zod`，仅这两个运行时依赖。

License: Apache-2.0.
