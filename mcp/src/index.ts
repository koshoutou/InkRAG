#!/usr/bin/env bun
/**
 * inkrag-mcp —— InkRAG 知识库平台的 MCP（Model Context Protocol）Server。
 *
 * 把平台入库 API（/api/input，docs/input-api.md）封装为 MCP 工具，供
 * Claude Desktop / Cursor 等 MCP 客户端零 HTTP 代码接入：建库、上传文件、
 * 文本入库、状态轮询、失败重试、删除。鉴权复用平台 API Key（Bearer）。
 *
 * 环境变量：
 *   INKRAG_BASE_URL  平台地址（默认 http://localhost:3000）
 *   INKRAG_API_KEY   必填。在平台「Agent API」视图创建（明文仅创建时展示一次，形如 rag-<32位hex>）
 *
 * 运行：stdio transport（bun src/index.ts 或 npm/bin 入口）。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { isAbsolute, basename } from 'node:path'
import { InputApiError, InputClient } from './client.js'

// ---------------------------------------------------------------------------
// 启动配置
// ---------------------------------------------------------------------------

const BASE_URL = process.env.INKRAG_BASE_URL?.trim() || 'http://localhost:3000'

if (!process.env.INKRAG_API_KEY || !process.env.INKRAG_API_KEY.trim()) {
  process.stderr.write(
    [
      '[inkrag-mcp] 启动失败：缺少必需的环境变量 INKRAG_API_KEY。',
      '',
      '获取方式：在平台「Agent API」视图创建 API Key（完整 Key 形如 rag-<32位hex>，仅创建时展示一次，请立即复制）。',
      '然后在 MCP 客户端配置的 env 中设置：',
      '  "env": { "INKRAG_API_KEY": "rag-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }',
      '',
      '可选：INKRAG_BASE_URL（默认 http://localhost:3000）指向平台地址。',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

const client = new InputClient({
  baseUrl: BASE_URL,
  apiKey: process.env.INKRAG_API_KEY.trim(),
})

// ---------------------------------------------------------------------------
// 文案常量（抄录/浓缩自 docs/input-api.md）
// ---------------------------------------------------------------------------

const CHUNK_CONFIG_DESC = `切分配置（可选，整体省略则用 KB 默认）。字段：
- size: 子 chunk 目标 token 数（默认 512，建议 200~1024）
- overlap: 硬切时相邻子 chunk 的 token 重叠（默认 0，0~size/2 合理）
- parentSize: 父 chunk token 上限（默认 2000；父块过大时按标题/段落二分）
- strategy: "token"（纯顺序切）/"title"（标题树切）/"hybrid"（标题优先+token 兜底，默认）
- protects: 原子保护块类型数组（默认 ["code","table"]，代码块/表格不跨 chunk 切断）
父子索引：先按 parentSize 切父块（检索上下文），父块内再按 size 切子块（命中粒度）；chunkCount 口径为子 chunk。`

const ENGINE_DESC = `解析引擎："mineru"（云端高保真，适合扫描件/复杂版式 PDF/图片；云免费档可能排队分钟~小时级）/"node"（本地降级引擎，秒级完成，无页数限制）；缺省跟随平台全局设置+扩展名智能路由。实际使用的引擎在文档详情 parseEngine 字段回显（取值 mineru | fallback）。`

const PIPELINE_DESC = `流水线语义：文档状态机 queued → parsing → chunking → embedding → upserting → ready | failed；
- 轮询建议用 get_document，间隔 2~5 秒（MinerU 云排队可退避 10~30 秒），到 ready/failed 停止；
- 进程内并发 2 个执行槽，MinerU 等待（waiting_mineru）不占槽，大批量 PDF 不会堵死其他文档；
- 阶段失败自动重试最多 3 次；心跳 20 秒、僵死 120 秒自动回收；MinerU 断点续传不重新上传；
- 秒传：同 KB 内 sha256(内容)+parseConfigV 相同的重复上传不产生新文档（deduplicated=true，直接复用既有 doc id，无需再轮询）。`

/** 把任意错误转成 MCP 文本内容（保持平台 error 文案原样透传） */
function errorText(e: unknown): string {
  if (e instanceof InputApiError) {
    return e.body && typeof e.body === 'object' && 'error' in (e.body as object)
      ? String((e.body as { error: unknown }).error)
      : e.message
  }
  return e instanceof Error ? e.message : String(e)
}

/** 工具成功返回：JSON 序列化（紧凑、可读） */
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

const err = (e: unknown) => ({
  content: [{ type: 'text' as const, text: `API 调用失败：${errorText(e)}` }],
  isError: true,
})

// ---------------------------------------------------------------------------
// Server + 工具注册（与 /api/input 11 端点中的 10 个一一对应；docs 端点不封装）
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: 'inkrag-mcp', version: '1.0.0' },
  {
    instructions: `InkRAG 知识库平台入库 MCP。本平台只做知识入库（建库/上传/切分/向量化），不执行检索（检索由外部平台直连 Qdrant 完成）。
典型流程：list_knowledge_bases → create_knowledge_base → upload_files / ingest_text → get_document 轮询到 ready →（失败则 retry_document）。
${PIPELINE_DESC}`,
  },
)

// 1. list_knowledge_bases ---------------------------------------------------
server.registerTool(
  'list_knowledge_bases',
  {
    title: '知识库列表',
    description: `列出平台全部知识库（按创建时间倒序），返回精简表：名称/ID/描述/文档数/子chunk数/向量点数/retrievalMode（hybrid|dense|sparse，给外部检索平台读的元数据）。另含 Qdrant collection 名、embeddingModel、dim、rerankEnabled、sparseScheme——外部检索平台对接 Qdrant 时需要这些字段。只读操作，readonly 角色 Key 也可用。`,
    inputSchema: {},
  },
  async () => {
    try {
      const r = await client.get<{ kbs: Array<Record<string, unknown>> }>('/api/input/knowledge-bases')
      return ok({
        total: r.kbs.length,
        kbs: r.kbs.map((k) => ({
          name: k.name,
          id: k.id,
          description: k.description,
          docCount: k.docCount,
          chunkCount: k.chunkCount,
          pointCount: k.pointCount,
          retrievalMode: k.retrievalMode,
          rerankEnabled: k.rerankEnabled,
          collection: k.collection,
          embeddingModel: k.embeddingModel,
          dim: k.dim,
          sparseScheme: k.sparseScheme,
          createdAt: k.createdAt,
        })),
      })
    } catch (e) {
      return err(e)
    }
  },
)

// 2. create_knowledge_base --------------------------------------------------
server.registerTool(
  'create_knowledge_base',
  {
    title: '创建知识库',
    description: `创建知识库并自动创建 Qdrant 向量集合（与平台 UI 建库完全一致）。名称全局唯一（重名 409）。
前置条件：平台管理员须已在「设置」配置 Qdrant 连接与 Embedding API（未配置返回 400 引导错误，重试同样请求不会成功）。
建库时会实测嵌入维度并锁定 dim/embeddingModel/sparseScheme——建库后不可换模型（换模型=新建库重导）。
retrievalMode/rerankEnabled 是给外部检索平台读的元数据（本平台不执行检索），建库后可在平台 UI 调整。
注意：写操作，readonly 角色 Key 返回 403。`,
    inputSchema: {
      name: z.string().min(1).describe('知识库名称（全局唯一，非空；重名返回 409）'),
      description: z.string().optional().describe('知识库描述（可选，默认空字符串）'),
      retrievalMode: z
        .enum(['hybrid', 'dense', 'sparse'])
        .optional()
        .describe('检索模式元数据（默认 hybrid）。hybrid=稠密+稀疏，dense=仅稠密，sparse=仅稀疏；供外部检索平台选择召回策略'),
      rerankEnabled: z.boolean().optional().describe('库级 Rerank 开关建议（默认 false），供外部检索平台在召回后决定是否重排'),
      chunkConfig: z
        .object({
          size: z.number().int().min(1).optional().describe('子 chunk 目标 token 数（默认 512，建议 200~1024）'),
          overlap: z.number().int().min(0).optional().describe('硬切时相邻子 chunk 的 token 重叠（默认 0，0~size/2 合理）'),
          parentSize: z.number().int().min(1).optional().describe('父 chunk token 上限（默认 2000，父块过大时按标题/段落二分）'),
          strategy: z.enum(['token', 'title', 'hybrid']).optional().describe('切分策略（默认 hybrid：标题优先+token 兜底合并）'),
          protects: z.array(z.string()).optional().describe('原子保护块类型（默认 ["code","table"]，代码块/表格不跨 chunk 切断；≤size 整块保留，超长按行二分）'),
        })
        .optional()
        .describe(CHUNK_CONFIG_DESC),
    },
  },
  async ({ name, description, retrievalMode, rerankEnabled, chunkConfig }) => {
    try {
      const body: Record<string, unknown> = { name }
      if (description !== undefined) body.description = description
      if (retrievalMode !== undefined) body.retrievalMode = retrievalMode
      if (rerankEnabled !== undefined) body.rerankEnabled = rerankEnabled
      if (chunkConfig !== undefined) body.chunkConfig = chunkConfig
      const r = await client.json<{ kb: Record<string, unknown> }>('/api/input/knowledge-bases', 'POST', body)
      return ok(r.kb)
    } catch (e) {
      return err(e)
    }
  },
)

// 3. get_knowledge_base -----------------------------------------------------
server.registerTool(
  'get_knowledge_base',
  {
    title: '知识库详情',
    description: '按 ID 获取知识库详情（KbSummary：doc/chunk/point 计数、切分配置、检索元数据、Qdrant collection 等）。docCount/chunkCount 为实时计数，pointCount 为库行快照。不存在返回 404。',
    inputSchema: {
      id: z.string().min(1).describe('知识库 ID（list_knowledge_bases 返回的 id）'),
    },
  },
  async ({ id }) => {
    try {
      const r = await client.get<{ kb: Record<string, unknown> }>(`/api/input/knowledge-bases/${encodeURIComponent(id)}`)
      return ok(r.kb)
    } catch (e) {
      return err(e)
    }
  },
)

// 4. delete_knowledge_base --------------------------------------------------
server.registerTool(
  'delete_knowledge_base',
  {
    title: '删除知识库',
    description: `⚠️ 危险操作（不可恢复）：级联删除该库全部文档与向量数据。语义：取消在途任务 → 删除 Qdrant 集合 → 级联删除 Chunk/Document/PipelineJob/KB 行 → 清理磁盘产物。返回删除统计 { docs, chunks, points, cancelledJobs }。Qdrant 不可达时跳过向量集合删除（仅告警），行数据与磁盘仍正常清理。写操作，readonly 角色 403。`,
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      id: z.string().min(1).describe('要删除的知识库 ID（级联删除其全部文档、chunk、向量点与产物）'),
    },
  },
  async ({ id }) => {
    try {
      const r = await client.json<{ ok: boolean; deleted: Record<string, unknown> }>(
        `/api/input/knowledge-bases/${encodeURIComponent(id)}`,
        'DELETE',
      )
      return ok(r)
    } catch (e) {
      return err(e)
    }
  },
)

// 5. upload_files ------------------------------------------------------------
server.registerTool(
  'upload_files',
  {
    title: '上传文件入库',
    description: `从本机读取一个或多个文件（绝对路径），multipart 上传到指定知识库并进入解析流水线（初始状态 queued，需轮询 get_document 到 ready）。
要点：
- localPaths 是运行 MCP Server 的本机上的绝对路径（不是客户端相对路径）；文件名取 basename；
- 多文件并发处理（Promise.allSettled 语义），单文件失败不影响其余文件——失败明细在 failures 数组逐文件透传，整体仍返回成功；
- 白名单 30 种扩展名：pdf/doc/docx/pptx/xlsx（双引擎）｜ppt/xls/png/jpg/jpeg/jp2/webp/gif/bmp（仅 MinerU 云）｜md/markdown/txt/html/htm/shtml/csv/tsv/rtf/odt/ods/odp/epub/ofd/mhtml/mht（仅本地）；
- 限额：单文件 200MB、单请求总量 500MB，超限该文件进 failures（413）；
- 秒传：同 KB 内 sha256+解析配置相同的重复上传不产生新文档（出现在 deduplicated 数组，状态可能已是 ready，无需再轮询）；
- 上传响应的 chunkCount 为 0 属正常（流水线异步），ready 后再读。
${ENGINE_DESC}`,
    inputSchema: {
      kbId: z.string().min(1).describe('目标知识库 ID'),
      localPaths: z.array(z.string().min(1)).min(1).describe('本机文件的绝对路径数组（运行 MCP Server 的机器上；如 ["/data/notes.md", "/data/report.pdf"]）'),
      chunkConfig: z
        .object({
          size: z.number().int().min(1).optional().describe('子 chunk 目标 token 数（默认 512，建议 200~1024）'),
          overlap: z.number().int().min(0).optional().describe('相邻子 chunk 的 token 重叠（默认 0）'),
          parentSize: z.number().int().min(1).optional().describe('父 chunk token 上限（默认 2000）'),
          strategy: z.enum(['token', 'title', 'hybrid']).optional().describe('切分策略（默认 hybrid）'),
          protects: z.array(z.string()).optional().describe('原子保护块类型（默认 ["code","table"]）'),
        })
        .optional()
        .describe(`一次性覆盖 KB 默认切分配置（仅本次入库生效）。${CHUNK_CONFIG_DESC}`),
      engine: z.enum(['mineru', 'node']).optional().describe(ENGINE_DESC),
    },
  },
  async ({ kbId, localPaths, chunkConfig, engine }) => {
    // 先做本机读取校验（读不到文件的错误单独透传，不整体失败）
    // bytes 运行时为 Node Buffer（合法 BlobPart）；类型上经 client.ts 内部收窄
    const loaded: Array<{ filename: string; bytes: BlobPart; mimeType?: string }> = []
    const localFailures: Array<{ path: string; error: string }> = []
    for (const p of localPaths) {
      if (!isAbsolute(p)) {
        localFailures.push({ path: p, error: '必须是绝对路径（相对于运行 MCP Server 的机器）' })
        continue
      }
      try {
        const bytes = readFileSync(p) as Buffer
        if (bytes.length === 0) {
          localFailures.push({ path: p, error: '文件为空（0 字节），平台拒绝空文件' })
          continue
        }
        // 拷贝进独立 ArrayBuffer（类型干净的 BlobPart；Buffer 底层可能是池化视图，slice/set 拷贝最稳）
        const ab = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(ab).set(bytes)
        loaded.push({ filename: basename(p), bytes: ab })
      } catch (e) {
        localFailures.push({ path: p, error: `本机读取失败：${e instanceof Error ? e.message : String(e)}` })
      }
    }

    let remote: Record<string, unknown> | null = null
    let remoteError: string | null = null
    if (loaded.length > 0) {
      try {
        remote = (await client.upload(kbId, loaded, { chunkConfig, engine })) as Record<string, unknown>
      } catch (e) {
        remoteError = errorText(e)
      }
    }

    if (remoteError && loaded.length > 0) {
      // 平台整体拒绝（鉴权/KB 不存在/非 multipart 等）——直接透传
      return err(remoteError)
    }

    const result: Record<string, unknown> = {}
    if (remote) {
      result.docs = remote.docs
      result.deduplicated = remote.deduplicated
      const failures = [...(Array.isArray(remote.failures) ? (remote.failures as unknown[]) : [])]
      if (localFailures.length > 0) failures.push(...localFailures)
      if (failures.length > 0) result.failures = failures
    } else {
      result.docs = []
      result.deduplicated = []
      if (localFailures.length > 0) result.failures = localFailures
    }
    return ok(result)
  },
)

// 6. ingest_text -------------------------------------------------------------
server.registerTool(
  'ingest_text',
  {
    title: '文本直接入库',
    description: `把一段文本（如会议纪要、代码片段说明、抓取到的网页正文）直接提交入库，不经过本地文件。等价于上传一个 Markdown 文件。
- name 缺省 untitled.md；无扩展名或不支持的扩展名自动补 .md；
- text 参与 sha256 秒传判定（同 KB 内相同内容+配置不产生新文档）；
- 响应含 doc（初始 queued，轮询 get_document 到 ready）与 deduplicated 布尔。
写操作，readonly 角色 403。`,
    inputSchema: {
      kbId: z.string().min(1).describe('目标知识库 ID'),
      name: z.string().optional().describe('文档名（默认 untitled.md；无/不支持扩展名自动补 .md）'),
      text: z.string().min(1).describe('UTF-8 文本内容（≤200MB；建议直接粘贴 Markdown）'),
      chunkConfig: z
        .object({
          size: z.number().int().min(1).optional().describe('子 chunk 目标 token 数（默认 512）'),
          overlap: z.number().int().min(0).optional().describe('相邻子 chunk 的 token 重叠（默认 0）'),
          parentSize: z.number().int().min(1).optional().describe('父 chunk token 上限（默认 2000）'),
          strategy: z.enum(['token', 'title', 'hybrid']).optional().describe('切分策略（默认 hybrid）'),
          protects: z.array(z.string()).optional().describe('原子保护块类型（默认 ["code","table"]）'),
        })
        .optional()
        .describe(`一次性覆盖 KB 默认切分配置（仅本次入库生效）。${CHUNK_CONFIG_DESC}`),
      engine: z.enum(['mineru', 'node']).optional().describe(`解析引擎（文本默认按 Markdown 走 Node 引擎，一般无需指定）。${ENGINE_DESC}`),
    },
  },
  async ({ kbId, name, text, chunkConfig, engine }) => {
    try {
      const body: Record<string, unknown> = { text }
      if (name !== undefined) body.name = name
      if (chunkConfig !== undefined) body.chunkConfig = chunkConfig
      if (engine !== undefined) body.engine = engine
      const r = await client.json<Record<string, unknown>>(
        `/api/input/knowledge-bases/${encodeURIComponent(kbId)}/text`,
        'POST',
        body,
      )
      return ok(r)
    } catch (e) {
      return err(e)
    }
  },
)

// 7. list_documents ----------------------------------------------------------
server.registerTool(
  'list_documents',
  {
    title: '文档列表',
    description: `查询文档列表（按创建时间倒序）。可跨全库，也可按 kbId 过滤（kbId 不存在返回 404）；status 过滤流水线状态（queued/parsing/chunking/embedding/upserting/ready/failed）；q 按文件名模糊匹配。每个文档附实时 chunkCount / enabledChunkCount。分页：limit（默认 50，1..200）+ offset，配合 total 翻页。只读操作。`,
    inputSchema: {
      kbId: z.string().optional().describe('知识库 ID（缺省返回全库文档）'),
      status: z.enum(['queued', 'parsing', 'chunking', 'embedding', 'upserting', 'ready', 'failed']).optional().describe('状态过滤（如 failed 列出全部失败文档）'),
      q: z.string().optional().describe('文件名模糊匹配（contains）'),
      limit: z.number().int().min(1).max(200).optional().describe('分页大小（默认 50，最大 200）'),
      offset: z.number().int().min(0).optional().describe('分页偏移（默认 0）'),
    },
  },
  async (args) => {
    try {
      const r = await client.get<{ docs: unknown[]; total: number }>('/api/input/documents', {
        kbId: args.kbId,
        status: args.status,
        q: args.q,
        limit: args.limit,
        offset: args.offset,
      })
      return ok(r)
    } catch (e) {
      return err(e)
    }
  },
)

// 8. get_document ------------------------------------------------------------
server.registerTool(
  'get_document',
  {
    title: '文档详情（轮询进度）',
    description: `按 ID 获取文档详情，是流水线轮询的主端点。返回 status（状态机）+ stageProgress（当前阶段内 0-100 进度，阶段切换会重置）+ errorCode/errorMessage（failed 时非空，可直接展示或作为 retry 决策）+ chunkCount/enabledChunkCount + parseEngine（实际引擎：mineru|fallback）+ chunkConfigSnap（本次入库实际生效的切分配置快照）+ 产物可用性（markdownAvailable/middleJsonAvailable/sourceAvailable）。
${PIPELINE_DESC}`,
    inputSchema: {
      id: z.string().min(1).describe('文档 ID（upload_files / ingest_text / list_documents 返回的 id）'),
    },
  },
  async ({ id }) => {
    try {
      const r = await client.get<{ doc: Record<string, unknown> }>(`/api/input/documents/${encodeURIComponent(id)}`)
      return ok(r.doc)
    } catch (e) {
      return err(e)
    }
  },
)

// 9. retry_document ----------------------------------------------------------
server.registerTool(
  'retry_document',
  {
    title: '重试失败文档',
    description: `重试 failed 状态的文档，从失败阶段续跑（返回续跑起点 stage: parse|chunk|embed），不产生新版本。仅 failed 可重试——ready/处理中文档返回 409（流水线自身失败会自动重试 3 次，多数情况无需手动干预）。重试会先取消该文档在途任务再入队，可安全重复调用。写操作，readonly 角色 403。`,
    inputSchema: {
      id: z.string().min(1).describe('文档 ID（须处于 failed 状态）'),
    },
  },
  async ({ id }) => {
    try {
      const r = await client.json<Record<string, unknown>>(`/api/input/documents/${encodeURIComponent(id)}/retry`, 'POST')
      return ok(r)
    } catch (e) {
      return err(e)
    }
  },
)

// 10. delete_document --------------------------------------------------------
server.registerTool(
  'delete_document',
  {
    title: '删除文档',
    description: `⚠️ 危险操作（不可恢复）：删除单个文档并级联清理其向量点、chunk、流水线任务与磁盘产物（返回 deletedChunks 计数）。向量库抖动不阻塞行删除。与秒传交互：删除后同内容可重新入库产生新文档。写操作，readonly 角色 403。`,
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      id: z.string().min(1).describe('要删除的文档 ID'),
    },
  },
  async ({ id }) => {
    try {
      const r = await client.json<{ ok: boolean; deletedChunks: number }>(
        `/api/input/documents/${encodeURIComponent(id)}`,
        'DELETE',
      )
      return ok(r)
    } catch (e) {
      return err(e)
    }
  },
)

// ---------------------------------------------------------------------------
// stdio 启动
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[inkrag-mcp] ready → ${BASE_URL} (stdio transport, 10 tools)\n`)
}

main().catch((e) => {
  process.stderr.write(`[inkrag-mcp] fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
  process.exit(1)
})
