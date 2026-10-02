/**
 * 解析客户端：MinerU 三 Provider（自部署 V1 / 官方云·精准 v4 / 官方云·Agent 轻量）+ 内置降级解析器
 *
 * 【MinerU Provider 抽象】（指南《MinerU_API_完整指南》，Task 14-e）
 *   provider = 'selfhost'（默认）：六步协议（/v1/uploads 三步 + /v1/parse/jobs + 轮询 + /v1/files/{id}/content）
 *   provider = 'cloud'：官方云·精准 API v4 —— POST /api/v4/file-urls/batch {files:[{name,data_id}]}（Bearer Token）
 *     → data.batch_id + data.file_urls[0] → PUT 上传字节（无 Content-Type、不带 Token）
 *     → 轮询 GET /api/v4/extract-results/batch/{batch_id}（state done→full_zip_url / failed→err_msg）
 *     → GET full_zip_url 下载 zip → 解压取 .md（+ middle json 若有，无则合成空）
 *   provider = 'cloud-agent'：官方云·Agent 轻量（免 Token、IP 限频）—— POST /api/v1/agent/parse/file
 *     {file_name} → data.task_id + data.file_url → PUT 上传 → 轮询 GET /api/v1/agent/parse/{task_id}
 *     （done→markdown_url / failed→err_msg+err_code）→ 下载 markdown（无 middle → 合成空）
 *
 * 【并发与循环】用户强调：
 *   - 模块级信号量（globalThis 单例）限制同时进行的 MinerU 解析数 = 2（流水线引擎并发也是 2，
 *     此处防 UI 触发的直跑/重试等并发叠加打爆服务）
 *   - 轮询一律有界循环 + jitter 退避（cloud/cloud-agent：3s 起步 ×1.5 max 20s ≤200 次；
 *     selfhost 保留原 2s ×1.6 max 30s ≤600 次）
 *
 * 【错误分类】沿用 StoreError retryable/nonRetryable（云错误码：A0202 Token 错误→nonRetryable；
 *   -30001/-30002/-30003 轻量限制→nonRetryable 带清晰中文提示；-10001 服务异常→retryable）
 *
 * 【图片支持】MinerU 链路对图片（png/jpg/jpeg/jp2/webp/gif/bmp）与 pdf 一视同仁
 *   （云 v4 与自部署 V1 均原生支持），无需特判。
 *
 * 【降级解析器（Node 引擎）】扩展类型（Task 14-e 矩阵见 parsers/formats.ts）：
 *   - md/markdown 原文直转；txt 分段；html/htm/shtml → 共享清洗器；docx → mammoth
 *   - pptx/xlsx/odt/ods/odp → OOXML/ODF 解包（office-xml.ts）；doc/rtf → legacy.ts
 *   - csv/tsv → RFC4180 表格（tabular.ts）；epub → OPF spine（epub.ts）
 *   - ofd → TextCode 提取（ofd.ts）；mhtml/mht → MIME multipart（mhtml.ts）
 *   - 图片 → 抛 nonRetryable（需 MinerU 引擎）
 *   - middle.json 统一格式，charStart/charEnd 与 full.md 严格对齐（synthesizeLayout 合成分页）
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { unzipSync } from 'fflate'
import { parseMarkdownBlocks } from './chunking'
import { htmlToMarkdown } from './parsers/html-clean'
import { docxToMarkdown } from './parsers/docx'
import { pptxToMarkdown, xlsxToMarkdown, odfToMarkdown } from './parsers/office-xml'
import { docToMarkdown, rtfToMarkdown } from './parsers/legacy'
import { delimitedToMarkdown } from './parsers/tabular'
import { epubToMarkdown } from './parsers/epub'
import { ofdToMarkdown } from './parsers/ofd'
import { mhtmlToMarkdown } from './parsers/mhtml'
import { isImageExt, isMineruExt } from './parsers/formats'
import { ensureDocDir, markdownPath, middleJsonPath } from './artifacts'
import { StoreError } from './vectorstore'
import type { RagSettings, MinerUProviderKind } from './settings'
import type { LayoutBlock, MiddleJson, ParseArtifacts, ParseProgressEvent } from './types'

const MINERU_TIMEOUT_MS = 120_000
const MINERU_CLOUD_BASE = 'https://mineru.net'

function nonRetryable(code: string, message: string): StoreError {
  const e = new StoreError(`${code}: ${message}`, { retryable: false })
  e.name = code
  return e
}
function retryable(message: string): StoreError {
  return new StoreError(message, { retryable: true })
}

// ---------------------------------------------------------------------------
// 统一入口（per-doc 引擎优先级：engineChoice > 全局 parseMode）
// ---------------------------------------------------------------------------

export interface ParseDocumentInput {
  docId: string
  kbId: string
  filename: string
  localPath: string
  mimeType: string
  settings: RagSettings
  /** per-doc 引擎覆盖（上传/URL 导入时选择；优先级高于全局 parseMode） */
  engine?: 'mineru' | 'node'
  onProgress?: (e: ParseProgressEvent) => void
}

export async function parseDocument(input: ParseDocumentInput): Promise<ParseArtifacts> {
  if (input.engine === 'node') {
    // 显式 Node 引擎：跳过全局判定（即便全局 parseMode=mineru 也强制走内置解析器）
    return parseWithFallback(input)
  }
  if (input.engine === 'mineru') {
    // 显式 MinerU 引擎：强制走 MinerU（未配置 → parseWithMineru 内给出明确报错）
    return parseWithMineru(input)
  }
  if (input.settings.parseMode === 'mineru') {
    return parseWithMineru(input)
  }
  if (input.settings.parseMode === 'fallback') {
    return parseWithFallback(input)
  }
  throw nonRetryable(
    'PARSE_NOT_CONFIGURED',
    '未配置 MinerU API 且未启用降级解析器，无法解析文档（请在设置中配置 MinerU 或开启 useFallbackParser）'
  )
}

// ---------------------------------------------------------------------------
// MinerU 并发闸门（globalThis 信号量，同时进行的 MinerU 解析 ≤ 2）
// ---------------------------------------------------------------------------

interface MinerUGate {
  active: number
  queue: Array<() => void>
}

const gateG = globalThis as unknown as { __ragMinerUGate?: MinerUGate }
const MINERU_MAX_CONCURRENT = 2

function getGate(): MinerUGate {
  if (!gateG.__ragMinerUGate) gateG.__ragMinerUGate = { active: 0, queue: [] }
  return gateG.__ragMinerUGate
}

/** 有界并发闸门：超出上限的解析请求排队等待（防 UI 直跑与流水线并发叠加） */
async function withMineruSlot<T>(fn: () => Promise<T>): Promise<T> {
  const gate = getGate()
  if (gate.active >= MINERU_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => gate.queue.push(resolve))
  }
  gate.active++
  try {
    return await fn()
  } finally {
    gate.active--
    const next = gate.queue.shift()
    if (next) next()
  }
}

/** 退避 sleep（base + 20% jitter） */
function sleepJitter(baseMs: number): Promise<void> {
  const jitter = baseMs * 0.2 * Math.random()
  return new Promise((r) => setTimeout(r, baseMs + jitter))
}

// ---------------------------------------------------------------------------
// 云错误分类（指南 §2.6 / §3.6 错误码表）
// ---------------------------------------------------------------------------

/** 文案级硬失败识别（批量结果项只有 err_msg 无 err_code） */
const CLOUD_FAIL_HARD_RE =
  /超出|超过|不支持|上限|额度|空文件|大小|页数|类型|权限|Token|token|无效|损坏|格式/

function classifyCloudError(code: number | string | undefined, msg: string, prefix: string): StoreError {
  const c = String(code ?? '')
  const m = String(msg ?? '').slice(0, 200) || '（服务未返回错误信息）'
  if (c === 'A0202' || c === 'A0211' || c === '401') {
    return nonRetryable(
      'MINERU_AUTH',
      `${prefix}: Token 无效或已过期（${m}）——请在「设置 → MinerU」检查 API Token`
    )
  }
  if (c === '-30001') {
    return nonRetryable(
      'MINERU_AGENT_LIMIT',
      `${prefix}: 文件超出轻量接口大小限制（10MB）——请改用官方云·精准 API（Token）或拆分文件`
    )
  }
  if (c === '-30002') {
    return nonRetryable(
      'MINERU_AGENT_LIMIT',
      `${prefix}: 轻量接口不支持该文件类型（支持 PDF/图片/Docx/PPTx/Xlsx）——请改用精准 API 或 Node 引擎`
    )
  }
  if (c === '-30003') {
    return nonRetryable(
      'MINERU_AGENT_LIMIT',
      `${prefix}: 文件超出轻量接口页数限制（20 页）——请拆分文件或改用官方云·精准 API（Token）`
    )
  }
  if (c === '-10001') {
    return retryable(`${prefix}: MinerU 云服务异常（${m}），稍后自动重试`)
  }
  if (c === '-60002') {
    return nonRetryable(
      'MINERU_BAD_FILE',
      `${prefix}: 不支持该文件类型/文件名后缀（${m}）——云·精准支持 pdf/图片/doc/docx/ppt/pptx/xls/xlsx`
    )
  }
  if (c === '-60004' || c === '-60005' || c === '-60006' || c === '-60017' || c === '-60018' || c === '-60019') {
    return nonRetryable('MINERU_QUOTA', `${prefix}: ${m}（文件/额度限制，请调整文件或明日再试）`)
  }
  const num = Number(code)
  if (Number.isInteger(num) && num > 0) {
    if (num === 400 || num === 403 || num === 404) {
      return nonRetryable('MINERU_API', `${prefix} (HTTP ${num}): ${m}`)
    }
    if (num === 429 || num >= 500) {
      return retryable(`${prefix} (HTTP ${num}): ${m}`)
    }
  }
  return retryable(`${prefix}: ${m}`)
}

// ---------------------------------------------------------------------------
// Provider 抽象
// ---------------------------------------------------------------------------

export interface MinerUParseInput {
  localPath: string
  filename: string
  /** 产物输出目录（full.md / middle.json） */
  outDir: string
  onProgress?: (e: ParseProgressEvent) => void
}

export interface MinerUParseOutput {
  markdownPath: string
  middleJsonPath: string
  /** 远端任务 ID（断点续传/观测） */
  jobId?: string
  fileId?: string
}

interface MinerUProvider {
  readonly kind: MinerUProviderKind
  parseFile(input: MinerUParseInput): Promise<MinerUParseOutput>
}

// ---------------------------------------------------------------------------
// Provider · selfhost（自部署 V1 —— 六步协议，原样保留）
// ---------------------------------------------------------------------------

const UploadResSchema = z.object({ id: z.string().min(1), upload_url: z.string().min(1) })
const CompleteResSchema = z.object({ id: z.string().min(1) })
const JobResSchema = z.object({ id: z.string().min(1) })
const TERMINAL_STATES = new Set(['completed', 'partial', 'failed', 'canceled'])

interface MinerUJob {
  id?: string
  status: string
  error?: string
}

class MinerUClient {
  constructor(
    private base: string,
    private apiKey: string,
    private tier: string,
    private ocrMode: string
  ) {}

  private async fetchJson<T>(
    p: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const url = this.base.replace(/\/+$/, '') + p
    let res: Response
    try {
      res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(MINERU_TIMEOUT_MS),
      })
    } catch (e) {
      throw retryable(`MinerU 不可达: ${(e as Error).message}`)
    }
    const text = await res.text()
    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      if (!res.ok) {
        throw new StoreError(`MinerU 非 JSON 错误响应 (${res.status}): ${text.slice(0, 200)}`, {
          status: res.status,
          retryable: res.status !== 400 && res.status !== 404,
        })
      }
      throw retryable(`MinerU 返回非 JSON: ${text.slice(0, 200)}`)
    }
    if (!res.ok) {
      const msg = json?.error || json?.message || json?.detail || `HTTP ${res.status}`
      throw new StoreError(`MinerU 错误 (${res.status}): ${String(msg).slice(0, 300)}`, {
        status: res.status,
        // 401/403/404/400 参数与凭据错误不重试；429/5xx 重试
        retryable: !(res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404),
      })
    }
    return json as T
  }

  /** ① 创建上传会话 + ② 流式上传（无 Authorization）+ ③ 完成上传 → fileId */
  async uploadFile(localPath: string, filename: string): Promise<string> {
    const stat = await fs.stat(localPath)
    // ①
    const createRes = await this.fetchJson<any>('/v1/uploads', {
      method: 'POST',
      body: { purpose: 'parse', filename, bytes: stat.size },
    })
    const parsed = UploadResSchema.safeParse(createRes)
    if (!parsed.success) {
      // HTTP 200 ≠ 业务成功（坑#4：可能 id:null）
      throw nonRetryable('MINERU_BAD_RESPONSE', `uploads 响应结构非法: ${JSON.stringify(createRes).slice(0, 200)}`)
    }
    const { id: uploadId, upload_url: uploadUrl } = parsed.data
    // ② 预签名 URL 上传 —— 🔴 绝不带 Authorization 头（坑#3，会泄露 MinerU Key）
    const stream = Readable.toWeb(createReadStream(localPath)) as unknown as ReadableStream<Uint8Array>
    let putRes: Response
    try {
      putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: stream,
        // @ts-expect-error Node fetch 需要 duplex 支持流式请求体
        duplex: 'half',
        signal: AbortSignal.timeout(MINERU_TIMEOUT_MS),
      })
    } catch (e) {
      throw retryable(`MinerU 上传失败: ${(e as Error).message}`)
    }
    if (!putRes.ok) {
      throw new StoreError(`MinerU 上传失败 (${putRes.status}): ${(await putRes.text().catch(() => '')).slice(0, 200)}`, {
        status: putRes.status,
        retryable: !(putRes.status === 400 || putRes.status === 403 || putRes.status === 404),
      })
    }
    // ③
    const completeRes = await this.fetchJson<any>(`/v1/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
    })
    const cParsed = CompleteResSchema.safeParse(completeRes)
    if (!cParsed.success) {
      throw nonRetryable('MINERU_BAD_RESPONSE', `complete 响应结构非法: ${JSON.stringify(completeRes).slice(0, 200)}`)
    }
    return cParsed.data.id
  }

  /** ④ 提交解析任务 */
  async submitJob(fileId: string): Promise<string> {
    const res = await this.fetchJson<any>('/v1/parse/jobs', {
      method: 'POST',
      body: {
        files: [{ source: { type: 'file_id', file_id: fileId } }],
        tier: this.tier,
        ocr_mode: this.ocrMode,
        output_formats: ['markdown', 'middle_json'],
        // callback 不传：本地 Parse Server 不支持 webhook（坑#5），统一轮询
      },
    })
    const parsed = JobResSchema.safeParse(res)
    if (!parsed.success) {
      throw nonRetryable('MINERU_BAD_RESPONSE', `parse/jobs 响应结构非法: ${JSON.stringify(res).slice(0, 200)}`)
    }
    return parsed.data.id
  }

  /** ⑤ 有界轮询（初始 2s，×1.6 退避 + 20% jitter，max 30s，maxAttempts 600） */
  async pollJob(
    jobId: string,
    opts: { onProgress?: (p: number) => void } = {}
  ): Promise<MinerUJob> {
    let delay = 2_000
    const maxAttempts = 600
    for (let i = 0; i < maxAttempts; i++) {
      let job: MinerUJob
      try {
        job = await this.fetchJson<MinerUJob>(`/v1/parse/jobs/${encodeURIComponent(jobId)}`)
      } catch (e) {
        // 轮询期间任务被清理（坑#8）→ 可重试（重试时重新提交）
        if (e instanceof StoreError && e.status === 404) throw retryable(`MinerU job ${jobId} 已不存在（服务可能重启）`)
        throw e
      }
      opts.onProgress?.(Math.min(90, 10 + (i / maxAttempts) * 80))
      if (TERMINAL_STATES.has(job.status)) return job
      await sleepJitter(delay)
      delay = Math.min(delay * 1.6, 30_000)
    }
    // 预算耗尽不是终态失败 → 交上层重试（jobId 已持久化可续轮）
    throw retryable(`MinerU job ${jobId} 轮询预算耗尽`)
  }

  /** ⑥ 流式下载产物（.part → 校验 → rename；zip 则解压取 full.md + middle.json） */
  async downloadArtifact(fileId: string, outDir: string): Promise<{ markdownPath: string; middleJsonPath: string }> {
    const url = this.base.replace(/\/+$/, '') + `/v1/files/${encodeURIComponent(fileId)}/content`
    let res: Response
    try {
      res = await fetch(url, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(MINERU_TIMEOUT_MS),
      })
    } catch (e) {
      throw retryable(`MinerU 下载失败: ${(e as Error).message}`)
    }
    if (!res.ok || !res.body) {
      throw new StoreError(`MinerU 下载失败 (${res.status})`, {
        status: res.status,
        retryable: res.status !== 404,
      })
    }
    const partPath = path.join(outDir, 'artifact.part')
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(partPath))
    const buf = await fs.readFile(partPath)
    if (buf.length === 0) {
      throw retryable('MinerU 产物为空')
    }
    const { markdownPath: mdPath, middleJsonPath: midPath } = await writeArtifactFromBytes(buf, outDir)
    await fs.rm(partPath, { force: true })
    return { markdownPath: mdPath, middleJsonPath: midPath }
  }
}

/** zip/markdown 字节 → outDir 产物（full.md + middle.json；zip 内取 .md 与 middle json，缺失合成空） */
async function writeArtifactFromBytes(
  buf: Buffer,
  outDir: string
): Promise<{ markdownPath: string; middleJsonPath: string }> {
  const mdPath = path.join(outDir, 'full.md')
  const midPath = path.join(outDir, 'middle.json')
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b // PK
  if (isZip) {
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(new Uint8Array(buf)) as Record<string, Uint8Array>
    } catch (e) {
      throw nonRetryable('MINERU_BAD_ARTIFACT', `产物 zip 解压失败: ${(e as Error).message}`)
    }
    const entries = Object.entries(files)
    const mdEntry =
      entries.find(([name]) => name === 'full.md') ??
      entries.find(([name]) => name.endsWith('.md'))
    const midEntry =
      entries.find(([name]) => name === 'middle.json') ??
      entries.find(([name]) => name.endsWith('middle.json') || name.endsWith('middleJson.json'))
    if (!mdEntry) {
      throw nonRetryable('MINERU_BAD_ARTIFACT', 'zip 产物中未找到 markdown 文件')
    }
    await fs.writeFile(mdPath, mdEntry[1])
    if (midEntry) {
      await fs.writeFile(midPath, midEntry[1])
    } else {
      await fs.writeFile(midPath, JSON.stringify({ pages: [], blocks: [] }))
    }
  } else {
    // 直接是 markdown 文本（middle_json 可能独立端点或缺失）
    await fs.writeFile(mdPath, buf)
    await fs.writeFile(midPath, JSON.stringify({ pages: [], blocks: [] }))
  }
  return { markdownPath: mdPath, middleJsonPath: midPath }
}

class MinerUSelfhostProvider implements MinerUProvider {
  readonly kind = 'selfhost' as const
  constructor(private client: MinerUClient) {}

  async parseFile(input: MinerUParseInput): Promise<MinerUParseOutput> {
    const { localPath, filename, outDir, onProgress } = input
    onProgress?.({ progress: 5, message: '上传文件至 MinerU（自部署）' })
    const fileId = await this.client.uploadFile(localPath, filename)
    onProgress?.({ progress: 20, message: '提交解析任务' })
    const jobId = await this.client.submitJob(fileId)

    const job = await this.client.pollJob(jobId, {
      onProgress: (p) => onProgress?.({ progress: p, message: 'MinerU 解析中' }),
    })

    // §5.4 状态映射
    if (job.status === 'partial') {
      throw nonRetryable('MINERU_PARTIAL', `MinerU 任务部分完成（单文件任务不应出现）: ${job.error ?? ''}`)
    }
    if (job.status === 'failed') {
      throw retryable(`MINERU_FAILED: ${job.error ?? 'MinerU 解析失败'}`)
    }
    if (job.status === 'canceled') {
      throw nonRetryable('MINERU_CANCELED', 'MinerU 任务已取消')
    }

    onProgress?.({ progress: 92, message: '下载解析产物' })
    const { markdownPath: mdPath, middleJsonPath: midPath } = await this.client.downloadArtifact(fileId, outDir)
    return { markdownPath: mdPath, middleJsonPath: midPath, jobId, fileId }
  }
}

// ---------------------------------------------------------------------------
// Provider · cloud（官方云·精准 API v4，Bearer Token）
// ---------------------------------------------------------------------------

/** 云批量结果轮询参数（指南 §2.4.3 语义：3s 起步 ×1.5 max 20s，最多 200 次） */
const CLOUD_POLL_MAX_ATTEMPTS = 200
const CLOUD_POLL_INITIAL_MS = 3_000
const CLOUD_POLL_MAX_MS = 20_000

const CLOUD_STATE_LABELS: Record<string, string> = {
  'waiting-file': '等待文件',
  uploading: '上传中',
  pending: '排队中',
  running: '解析中',
  converting: '转换中',
}

class MinerUCloudProvider implements MinerUProvider {
  readonly kind = 'cloud' as const
  constructor(private token: string) {}

  private async apiJson<T>(
    p: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(MINERU_CLOUD_BASE + p, {
        method: init.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(MINERU_TIMEOUT_MS),
      })
    } catch (e) {
      throw retryable(`MinerU 云服务不可达: ${(e as Error).message}`)
    }
    const text = await res.text()
    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      if (!res.ok) {
        throw new StoreError(`MinerU 云非 JSON 错误响应 (${res.status}): ${text.slice(0, 200)}`, {
          status: res.status,
          retryable: res.status >= 500 || res.status === 429,
        })
      }
      throw retryable(`MinerU 云返回非 JSON: ${text.slice(0, 200)}`)
    }
    // 官方云协议：HTTP 200 也可能携带业务错误码（code != 0；部分端点用 msgCode 字段）
    const bizCode = json?.code !== undefined ? json.code : json?.msgCode
    if (json && bizCode !== undefined && Number(bizCode) !== 0) {
      throw classifyCloudError(bizCode, json.msg ?? json.message, 'MinerU 云·精准 API')
    }
    if (!res.ok) {
      throw classifyCloudError(res.status, text.slice(0, 200), 'MinerU 云·精准 API')
    }
    return json as T
  }

  async parseFile(input: MinerUParseInput): Promise<MinerUParseOutput> {
    const { localPath, filename, outDir, onProgress } = input

    // ① 申请批量上传链接（本地文件必须走 file-urls/batch 签名上传，指南 §2.4.1）
    onProgress?.({ progress: 5, message: '申请云上传链接（精准 API）' })
    const dataId = randomUUID().replace(/-/g, '').slice(0, 24)
    const createRes = await this.apiJson<any>('/api/v4/file-urls/batch', {
      method: 'POST',
      body: { files: [{ name: filename, data_id: dataId }] },
    })
    const batchId: unknown = createRes?.data?.batch_id
    const uploadUrl: unknown = createRes?.data?.file_urls?.[0]
    if (typeof batchId !== 'string' || !batchId || typeof uploadUrl !== 'string' || !uploadUrl) {
      throw nonRetryable(
        'MINERU_BAD_RESPONSE',
        `file-urls/batch 响应结构非法: ${JSON.stringify(createRes).slice(0, 200)}`
      )
    }

    // ② PUT 字节到签名 URL —— 无 Content-Type、不带 Authorization（OSS 签名要求）
    onProgress?.({ progress: 15, message: '上传文件至 MinerU 云' })
    const buf = await fs.readFile(localPath)
    let putRes: Response
    try {
      putRes = await fetch(uploadUrl, {
        method: 'PUT',
        body: new Uint8Array(buf),
        signal: AbortSignal.timeout(MINERU_TIMEOUT_MS),
      })
    } catch (e) {
      throw retryable(`MinerU 云上传失败: ${(e as Error).message}`)
    }
    if (!putRes.ok) {
      const t = await putRes.text().catch(() => '')
      throw new StoreError(`MinerU 云上传失败 (${putRes.status}): ${t.slice(0, 200)}`, {
        status: putRes.status,
        retryable: putRes.status >= 500 || putRes.status === 429,
      })
    }

    // ③ 有界轮询批量结果（上传完成后系统自动提交解析，无需再调提交接口）
    onProgress?.({ progress: 25, message: 'MinerU 云解析中' })
    let delay = CLOUD_POLL_INITIAL_MS
    let lastState = ''
    for (let attempt = 1; attempt <= CLOUD_POLL_MAX_ATTEMPTS; attempt++) {
      const res = await this.apiJson<any>(`/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`)
      const item = res?.data?.extract_result?.[0]
      if (!item || typeof item.state !== 'string') {
        throw nonRetryable(
          'MINERU_BAD_RESPONSE',
          `extract-results 响应结构非法: ${JSON.stringify(res).slice(0, 200)}`
        )
      }
      lastState = item.state
      if (item.state === 'done') {
        const zipUrl = item.full_zip_url
        if (typeof zipUrl !== 'string' || !zipUrl) {
          throw nonRetryable('MINERU_BAD_RESPONSE', '任务 done 但缺少 full_zip_url')
        }
        // ④ 下载 zip 产物（CDN 直链，无鉴权）
        onProgress?.({ progress: 90, message: '下载解析产物' })
        let zipRes: Response
        try {
          zipRes = await fetch(zipUrl, { signal: AbortSignal.timeout(MINERU_TIMEOUT_MS) })
        } catch (e) {
          throw retryable(`MinerU 云产物下载失败: ${(e as Error).message}`)
        }
        if (!zipRes.ok) {
          throw new StoreError(`MinerU 云产物下载失败 (${zipRes.status})`, {
            status: zipRes.status,
            retryable: zipRes.status >= 500 || zipRes.status === 429,
          })
        }
        const zipBuf = Buffer.from(await zipRes.arrayBuffer())
        if (zipBuf.length === 0) throw retryable('MinerU 云产物为空')
        const { markdownPath: mdPath, middleJsonPath: midPath } = await writeArtifactFromBytes(zipBuf, outDir)
        return { markdownPath: mdPath, middleJsonPath: midPath, jobId: batchId }
      }
      if (item.state === 'failed') {
        const errMsg = String(item.err_msg ?? '')
        if (item.err_code !== undefined) {
          throw classifyCloudError(item.err_code, errMsg, 'MinerU 云解析失败')
        }
        // 结果项仅有 err_msg：文案级硬失败识别（大小/页数/类型/额度等不重试）
        if (CLOUD_FAIL_HARD_RE.test(errMsg)) {
          throw nonRetryable('MINERU_CLOUD_FAILED', `MinerU 云解析失败: ${errMsg.slice(0, 200)}`)
        }
        throw retryable(`MINERU_CLOUD_FAILED: ${errMsg.slice(0, 200) || 'MinerU 云解析失败'}`)
      }
      const label = CLOUD_STATE_LABELS[item.state] ?? item.state
      onProgress?.({ progress: Math.min(88, 25 + attempt * 0.3), message: `MinerU 云解析中（${label}）` })
      await sleepJitter(delay)
      delay = Math.min(delay * 1.5, CLOUD_POLL_MAX_MS)
    }
    throw retryable(`MinerU 云任务 ${batchId} 轮询预算耗尽（最后状态 ${lastState || '未知'}）`)
  }
}

// ---------------------------------------------------------------------------
// Provider · cloud-agent（官方云·Agent 轻量，免 Token、IP 限频）
// ---------------------------------------------------------------------------

class MinerUAgentProvider implements MinerUProvider {
  readonly kind = 'cloud-agent' as const

  private async apiJson<T>(
    p: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(MINERU_CLOUD_BASE + p, {
        method: init.method ?? 'GET',
        headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(MINERU_TIMEOUT_MS),
      })
    } catch (e) {
      throw retryable(`MinerU 云（Agent）不可达: ${(e as Error).message}`)
    }
    if (res.status === 429) {
      throw retryable('MinerU 云（Agent）IP 限频（每分钟请求数超限），稍后自动重试')
    }
    const text = await res.text()
    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      if (!res.ok) {
        throw new StoreError(`MinerU 云（Agent）非 JSON 错误响应 (${res.status}): ${text.slice(0, 200)}`, {
          status: res.status,
          retryable: res.status >= 500 || res.status === 429,
        })
      }
      throw retryable(`MinerU 云（Agent）返回非 JSON: ${text.slice(0, 200)}`)
    }
    const bizCode = json?.code !== undefined ? json.code : json?.msgCode
    if (json && bizCode !== undefined && Number(bizCode) !== 0) {
      throw classifyCloudError(bizCode, json.msg ?? json.message, 'MinerU 云·Agent')
    }
    if (!res.ok) {
      throw classifyCloudError(res.status, text.slice(0, 200), 'MinerU 云·Agent')
    }
    return json as T
  }

  async parseFile(input: MinerUParseInput): Promise<MinerUParseOutput> {
    const { localPath, filename, outDir, onProgress } = input

    // ① 签名上传（免 Token；单文件，不支持批量）
    onProgress?.({ progress: 5, message: '申请上传链接（Agent 轻量）' })
    const createRes = await this.apiJson<any>('/api/v1/agent/parse/file', {
      method: 'POST',
      body: { file_name: filename },
    })
    const taskId: unknown = createRes?.data?.task_id
    const fileUrl: unknown = createRes?.data?.file_url
    if (typeof taskId !== 'string' || !taskId || typeof fileUrl !== 'string' || !fileUrl) {
      throw nonRetryable(
        'MINERU_BAD_RESPONSE',
        `agent/parse/file 响应结构非法: ${JSON.stringify(createRes).slice(0, 200)}`
      )
    }

    // ② PUT 上传（无鉴权）
    onProgress?.({ progress: 15, message: '上传文件至 MinerU 云（Agent）' })
    const buf = await fs.readFile(localPath)
    let putRes: Response
    try {
      putRes = await fetch(fileUrl, {
        method: 'PUT',
        body: new Uint8Array(buf),
        signal: AbortSignal.timeout(MINERU_TIMEOUT_MS),
      })
    } catch (e) {
      throw retryable(`MinerU 云（Agent）上传失败: ${(e as Error).message}`)
    }
    if (!putRes.ok) {
      const t = await putRes.text().catch(() => '')
      throw new StoreError(`MinerU 云（Agent）上传失败 (${putRes.status}): ${t.slice(0, 200)}`, {
        status: putRes.status,
        retryable: putRes.status >= 500 || putRes.status === 429,
      })
    }

    // ③ 有界轮询（3s 起步 ×1.5 max 20s ≤200 次）
    onProgress?.({ progress: 25, message: 'MinerU 云解析中（Agent）' })
    let delay = CLOUD_POLL_INITIAL_MS
    let lastState = ''
    for (let attempt = 1; attempt <= CLOUD_POLL_MAX_ATTEMPTS; attempt++) {
      const res = await this.apiJson<any>(`/api/v1/agent/parse/${encodeURIComponent(taskId as string)}`)
      const data = res?.data
      if (!data || typeof data.state !== 'string') {
        throw nonRetryable(
          'MINERU_BAD_RESPONSE',
          `agent/parse 轮询响应结构非法: ${JSON.stringify(res).slice(0, 200)}`
        )
      }
      lastState = data.state
      if (data.state === 'done') {
        const mdUrl = data.markdown_url
        if (typeof mdUrl !== 'string' || !mdUrl) {
          throw nonRetryable('MINERU_BAD_RESPONSE', '任务 done 但缺少 markdown_url')
        }
        // ④ 下载 markdown（仅 Markdown 输出，无 middle → 合成空）
        onProgress?.({ progress: 90, message: '下载解析产物' })
        let mdRes: Response
        try {
          mdRes = await fetch(mdUrl, { signal: AbortSignal.timeout(MINERU_TIMEOUT_MS) })
        } catch (e) {
          throw retryable(`MinerU 云（Agent）产物下载失败: ${(e as Error).message}`)
        }
        if (!mdRes.ok) {
          throw new StoreError(`MinerU 云（Agent）产物下载失败 (${mdRes.status})`, {
            status: mdRes.status,
            retryable: mdRes.status >= 500 || mdRes.status === 429,
          })
        }
        const mdBuf = Buffer.from(await mdRes.arrayBuffer())
        if (mdBuf.length === 0) throw retryable('MinerU 云（Agent）产物为空')
        const mdPath = path.join(outDir, 'full.md')
        const midPath = path.join(outDir, 'middle.json')
        await fs.writeFile(mdPath, mdBuf)
        await fs.writeFile(midPath, JSON.stringify({ pages: [], blocks: [] }))
        return { markdownPath: mdPath, middleJsonPath: midPath, jobId: taskId as string }
      }
      if (data.state === 'failed') {
        const errMsg = String(data.err_msg ?? '')
        if (data.err_code !== undefined) {
          throw classifyCloudError(data.err_code, errMsg, 'MinerU 云（Agent）解析失败')
        }
        if (CLOUD_FAIL_HARD_RE.test(errMsg)) {
          throw nonRetryable('MINERU_AGENT_FAILED', `MinerU 云（Agent）解析失败: ${errMsg.slice(0, 200)}`)
        }
        throw retryable(`MINERU_AGENT_FAILED: ${errMsg.slice(0, 200) || 'MinerU 云（Agent）解析失败'}`)
      }
      const label = CLOUD_STATE_LABELS[data.state] ?? data.state
      onProgress?.({ progress: Math.min(88, 25 + attempt * 0.3), message: `MinerU 云解析中（${label}）` })
      await sleepJitter(delay)
      delay = Math.min(delay * 1.5, CLOUD_POLL_MAX_MS)
    }
    throw retryable(`MinerU 云（Agent）任务 ${taskId} 轮询预算耗尽（最后状态 ${lastState || '未知'}）`)
  }
}

// ---------------------------------------------------------------------------
// Provider 工厂 + MinerU 主链路
// ---------------------------------------------------------------------------

function createMinerUProvider(s: RagSettings['mineru']): MinerUProvider {
  switch (s.provider) {
    case 'cloud':
      return new MinerUCloudProvider(s.apiKey)
    case 'cloud-agent':
      return new MinerUAgentProvider()
    default:
      return new MinerUSelfhostProvider(new MinerUClient(s.url, s.apiKey, s.tier, s.ocrMode))
  }
}

/** MinerU middle.json 尽力归一化为统一格式（真实结构 M0 实测前 best-effort） */
function normalizeMiddleJson(raw: unknown, markdown: string): MiddleJson {
  const empty: MiddleJson = { pages: [], blocks: [] }
  if (!raw || typeof raw !== 'object') return empty
  const obj = raw as any
  // 已是统一格式
  if (Array.isArray(obj.pages) && Array.isArray(obj.blocks)) {
    return obj as MiddleJson
  }
  // MinerU 风格：[{ page_idx, blocks: [{ type, bbox, text }] }]（兼容 pdf_info 包装）
  const pages: { w: number; h: number }[] = []
  const blocks: LayoutBlock[] = []
  let cursor = 0
  let idx = 0
  const pageList = Array.isArray(obj) ? obj : (obj.pages ?? obj.pdf_info ?? [])
  for (const page of pageList) {
    const pi = typeof page.page_idx === 'number' ? page.page_idx : pages.length
    if (!pages[pi]) pages[pi] = { w: page.width ?? page.w ?? 595, h: page.height ?? page.h ?? 842 }
    for (const b of page.blocks ?? []) {
      const text = typeof b.text === 'string' ? b.text : ''
      if (!text.trim()) continue
      // 顺序对齐 markdown 字符偏移（单调向前查找）
      let charStart = 0
      let charEnd = 0
      const found = markdown.indexOf(text.slice(0, 60), cursor)
      if (found >= 0) {
        charStart = found
        charEnd = found + text.length
        cursor = charEnd
      }
      const typeNum = typeof b.type === 'number' ? b.type : -1
      blocks.push({
        idx: idx++,
        type: typeNum === 1 ? 'title' : typeNum === 2 ? 'table' : typeNum === 3 ? 'image' : 'text',
        page: pi + 1,
        bbox: Array.isArray(b.bbox) && b.bbox.length === 4 ? [b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3]] : [0, 0, 0, 0],
        charStart,
        charEnd,
        text: text.slice(0, 200),
      })
    }
  }
  return { pages, blocks }
}

async function parseWithMineru(input: ParseDocumentInput): Promise<ParseArtifacts> {
  const { settings, onProgress } = input
  const s = settings.mineru
  // 配置完备性（engine 强制或全局 mineru 模式都给出可操作的明确报错）
  if (s.provider === 'selfhost' && !s.url) {
    throw nonRetryable(
      'MINERU_NOT_CONFIGURED',
      'MinerU 引擎已选定（自部署 V1），但服务地址未配置——请在「设置 → MinerU」填写 API 地址，或将该文档改用 Node 引擎解析'
    )
  }
  if (s.provider === 'cloud' && !s.apiKey) {
    throw nonRetryable(
      'MINERU_NOT_CONFIGURED',
      'MinerU 引擎已选定（官方云·精准 API），但 API Token 未配置——请在「设置 → MinerU」填写 Token，或将该文档改用 Node 引擎解析'
    )
  }
  // cloud-agent：免凭据，恒可用

  const outDir = await ensureDocDir(input.kbId, input.docId)
  const provider = createMinerUProvider(s)
  // 并发闸门：全局同时进行的 MinerU 解析 ≤ 2（含轮询占用期）
  const out = await withMineruSlot(() =>
    provider.parseFile({
      localPath: input.localPath,
      filename: input.filename,
      outDir,
      onProgress,
    })
  )

  // middle.json 归一化
  onProgress?.({ progress: 95, message: '归一化布局元数据' })
  const markdown = await fs.readFile(out.markdownPath, 'utf-8')
  let rawMiddle: unknown = {}
  try {
    rawMiddle = JSON.parse(await fs.readFile(out.middleJsonPath, 'utf-8'))
  } catch {}
  const middle = normalizeMiddleJson(rawMiddle, markdown)
  await fs.writeFile(out.middleJsonPath, JSON.stringify(middle))

  onProgress?.({ progress: 100, message: '解析完成' })
  return {
    engine: 'mineru',
    markdownPath: out.markdownPath,
    middleJsonPath: out.middleJsonPath,
    pages: middle.pages.length,
    blockCount: middle.blocks.length,
    mineruJobId: out.jobId,
    mineruFileId: out.fileId,
  }
}

// ---------------------------------------------------------------------------
// 降级解析器（Node 引擎）
// ---------------------------------------------------------------------------

/** 文本显示宽度（CJK=2，其余=1） */
function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe6f\uff00-\uffef]/.test(ch) ? 2 : 1
  }
  return w
}

const SYNTH_PAGE = { w: 595, h: 842, margin: 50, lineHeight: 16, unitsPerLine: 88 }
const SYNTH_LINES_PER_PAGE = Math.floor((SYNTH_PAGE.h - 2 * SYNTH_PAGE.margin) / SYNTH_PAGE.lineHeight)

/** 文本类文件合成布局（A4 分页 + 按块分配行位） */
function synthesizeLayout(markdown: string): MiddleJson {
  const blocks = parseMarkdownBlocks(markdown)
  const pages: { w: number; h: number }[] = []
  const layout: LayoutBlock[] = []

  let pageIdx = 0
  let lineIdx = 0
  pages.push({ w: SYNTH_PAGE.w, h: SYNTH_PAGE.h })
  let blockIdx = 0

  const newPage = () => {
    pageIdx++
    lineIdx = 0
    pages.push({ w: SYNTH_PAGE.w, h: SYNTH_PAGE.h })
  }
  const linesFor = (text: string): number => Math.max(1, Math.ceil(displayWidth(text) / SYNTH_PAGE.unitsPerLine))
  const bboxFor = (l0: number, l1: number): [number, number, number, number] => {
    const yTop = SYNTH_PAGE.h - SYNTH_PAGE.margin - l0 * SYNTH_PAGE.lineHeight
    const yBottom = SYNTH_PAGE.h - SYNTH_PAGE.margin - l1 * SYNTH_PAGE.lineHeight
    return [SYNTH_PAGE.margin, yBottom, SYNTH_PAGE.w - SYNTH_PAGE.margin, yTop]
  }

  for (const b of blocks) {
    if (!b.text.trim()) continue
    const type: LayoutBlock['type'] =
      b.type === 'heading' ? 'title' : b.type === 'code' ? 'code' : b.type === 'table' ? 'table' : b.type === 'image' ? 'image' : 'text'
    let remaining = b.text
    let charStart = b.charStart
    // 块可能跨页：按页容量切分（按显示宽度比例折算字符数）
    while (remaining.length > 0) {
      const linesNeeded = linesFor(remaining)
      const linesAvail = SYNTH_LINES_PER_PAGE - lineIdx
      if (linesNeeded > linesAvail) {
        if (linesAvail <= 0 || linesNeeded > SYNTH_LINES_PER_PAGE) {
          // 需要切到下一页 / 单块超过整页 → 按比例切字符
          if (linesAvail <= 0) {
            newPage()
            continue
          }
          const ratio = Math.min(0.95, linesAvail / linesNeeded)
          const cutChars = Math.max(1, Math.floor(remaining.length * ratio))
          // 在 rune 边界回退（避免切断 surrogate pair）
          let cut = cutChars
          while (cut > 1 && (remaining.charCodeAt(cut - 1) & 0xfc00) === 0xd800) cut--
          const head = remaining.slice(0, cut)
          layout.push({
            idx: blockIdx++,
            type,
            page: pageIdx + 1,
            bbox: bboxFor(lineIdx, linesAvail),
            charStart,
            charEnd: charStart + cut,
            text: head.slice(0, 200),
          })
          charStart += cut
          remaining = remaining.slice(cut)
          newPage()
          continue
        }
        // 剩余空间放不下且块不超整页 → 换页
        newPage()
        continue
      }
      layout.push({
        idx: blockIdx++,
        type,
        page: pageIdx + 1,
        bbox: bboxFor(lineIdx, lineIdx + linesNeeded),
        charStart,
        charEnd: b.charEnd,
        text: b.text.slice(0, 200),
      })
      lineIdx += linesNeeded
      remaining = ''
    }
  }
  return { pages, blocks: layout }
}

/** PDF 行数据 */
interface PdfLine {
  text: string
  bbox: [number, number, number, number]
}

async function parsePdf(
  filePath: string,
  onProgress?: (e: ParseProgressEvent) => void
): Promise<{ markdown: string; middle: MiddleJson }> {
  // 服务端引用 legacy build（serverExternalPackages 外部化；Node 下自动 fake worker）
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await fs.readFile(filePath))

  // standard fonts 目录尽力解析（Helvetica 等标准字体度量）
  let standardFontDataUrl: string | undefined
  try {
    const require = (await import('node:module')).createRequire(import.meta.url)
    standardFontDataUrl =
      path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep
  } catch {}

  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    isEvalSupported: false,
    standardFontDataUrl,
  }).promise

  const pages: { w: number; h: number }[] = []
  const blocks: LayoutBlock[] = []
  let md = ''
  let blockIdx = 0

  for (let p = 1; p <= doc.numPages; p++) {
    onProgress?.({ progress: Math.min(85, 10 + (p / doc.numPages) * 75), message: `提取第 ${p}/${doc.numPages} 页` })
    const page = await doc.getPage(p)
    const viewport = page.getViewport({ scale: 1 })
    pages.push({ w: viewport.width, h: viewport.height })
    const tc = await page.getTextContent()
    // items → 行聚合（transform[4]=x，transform[5]=y，PDF 点空间原点左下）
    interface Item {
      str: string
      x: number
      y: number
      w: number
      h: number
    }
    const items: Item[] = []
    for (const it of tc.items as any[]) {
      if (typeof it.str !== 'string' || it.str.length === 0) continue
      const tr = it.transform as number[]
      items.push({ str: it.str, x: tr[4], y: tr[5], w: it.width ?? 0, h: it.height ?? tr[3] ?? 10 })
    }
    // 按 y 聚合成行（0.5pt 容差），行内按 x 排序
    const lineMap = new Map<number, Item[]>()
    for (const it of items) {
      const key = Math.round(it.y * 2) / 2
      const arr = lineMap.get(key) ?? []
      arr.push(it)
      lineMap.set(key, arr)
    }
    const lines: PdfLine[] = [...lineMap.entries()]
      .sort((a, b) => b[0] - a[0]) // y 大（页面上方）在前
      .map(([y, arr]) => {
        arr.sort((a, b) => a.x - b.x)
        let text = ''
        let prevEnd: number | null = null
        for (const it of arr) {
          if (prevEnd !== null && it.x - prevEnd > 3) text += ' '
          text += it.str
          prevEnd = it.x + it.w
        }
        const minX = Math.min(...arr.map((a) => a.x))
        const maxX = Math.max(...arr.map((a) => a.x + a.w))
        const maxH = Math.max(...arr.map((a) => a.h))
        // 基线 y：下探 0.25h、上伸 0.85h
        const bbox: [number, number, number, number] = [minX, y - maxH * 0.25, maxX, y + maxH * 0.85]
        return { text: text.replace(/\s+/g, ' ').trim(), bbox }
      })
      .filter((l) => l.text.length > 0)

    if (md.length > 0) md += '\n\n'
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      const charStart = md.length
      md += line.text
      const charEnd = md.length
      md += '\n'
      blocks.push({
        idx: blockIdx++,
        type: 'text',
        page: p,
        bbox: line.bbox,
        charStart,
        charEnd,
        text: line.text.slice(0, 200),
      })
      // 段落启发：行尾句末标点后补空行
      if (/[。．！？!?；;：:]$/.test(line.text) && li < lines.length - 1) {
        md += '\n'
      }
    }
  }

  onProgress?.({ progress: 90, message: '生成布局元数据' })
  return { markdown: md, middle: { pages, blocks } }
}

/** 新增 Node 解析器错误包装：确定性解析失败不烧重试次数 */
async function runNodeParser(label: string, p: Promise<string>): Promise<string> {
  try {
    return await p
  } catch (e) {
    if (e instanceof StoreError) throw e
    throw nonRetryable('PARSE_NODE_FAILED', `${label}: ${(e as Error).message ?? String(e)}`)
  }
}

export async function parseWithFallback(input: ParseDocumentInput): Promise<ParseArtifacts> {
  const { filename, localPath, onProgress } = input
  const ext = path.extname(filename).toLowerCase().replace('.', '')
  const outDir = await ensureDocDir(input.kbId, input.docId)
  const mdPath = markdownPath(input.kbId, input.docId)
  const midPath = middleJsonPath(input.kbId, input.docId)

  onProgress?.({ progress: 10, message: '读取文件' })
  let markdown = ''
  let middle: MiddleJson

  if (ext === 'md' || ext === 'markdown') {
    markdown = await fs.readFile(localPath, 'utf-8')
    onProgress?.({ progress: 45, message: '生成布局元数据' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'txt') {
    const raw = await fs.readFile(localPath, 'utf-8')
    // 按空行分段转 markdown
    markdown = raw
      .split(/\n\s*\n/)
      .map((para) => para.split('\n').map((l) => l.trim()).join('\n'))
      .filter((para) => para.trim().length > 0)
      .join('\n\n')
    onProgress?.({ progress: 45, message: '生成布局元数据' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'html' || ext === 'htm' || ext === 'shtml') {
    // 共享 HTML→Markdown 清洗器（契约 §26：主内容抽取 + 结构化转换，替换原剥标签弱实现）
    const raw = await fs.readFile(localPath, 'utf-8')
    onProgress?.({ progress: 30, message: 'HTML 主内容抽取与结构转换' })
    markdown = htmlToMarkdown(raw)
    onProgress?.({ progress: 60, message: '生成布局元数据' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'docx') {
    // docx 本地解析（RAGFlow 同款思路：mammoth → 共享清洗器，契约 §26）
    onProgress?.({ progress: 25, message: '解析 docx 结构' })
    const r = await docxToMarkdown(localPath)
    markdown = r.markdown
    onProgress?.({ progress: 60, message: '清洗与布局合成' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'doc') {
    // Word 97-2003 二进制（word-extractor）
    onProgress?.({ progress: 25, message: '解析 doc（Word 97-2003）' })
    markdown = await runNodeParser('doc 解析失败', docToMarkdown(localPath))
    onProgress?.({ progress: 60, message: '布局合成' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'rtf') {
    onProgress?.({ progress: 25, message: '解析 rtf' })
    markdown = await runNodeParser('rtf 解析失败', rtfToMarkdown(localPath))
    onProgress?.({ progress: 60, message: '布局合成' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'csv' || ext === 'tsv') {
    onProgress?.({ progress: 25, message: `解析 ${ext} 表格` })
    markdown = await runNodeParser(`${ext} 解析失败`, delimitedToMarkdown(localPath, ext === 'csv' ? ',' : '\t'))
    onProgress?.({ progress: 60, message: '布局合成' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'pptx') {
    onProgress?.({ progress: 25, message: '解析 pptx（幻灯片 + 备注）' })
    markdown = await runNodeParser('pptx 解析失败', pptxToMarkdown(localPath))
    onProgress?.({ progress: 60, message: '布局合成' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'xlsx') {
    onProgress?.({ progress: 25, message: '解析 xlsx 工作表' })
    markdown = await runNodeParser('xlsx 解析失败', xlsxToMarkdown(localPath))
    onProgress?.({ progress: 60, message: '布局合成' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'odt' || ext === 'ods' || ext === 'odp') {
    onProgress?.({ progress: 25, message: `解析 ${ext}（ODF）` })
    const kind = ext === 'odt' ? 'text' : ext === 'ods' ? 'spreadsheet' : 'presentation'
    markdown = await runNodeParser(`${ext} 解析失败`, odfToMarkdown(localPath, kind))
    onProgress?.({ progress: 60, message: '布局合成' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'epub') {
    onProgress?.({ progress: 25, message: '解析 epub（OPF 阅读顺序）' })
    markdown = await runNodeParser('epub 解析失败', epubToMarkdown(localPath))
    onProgress?.({ progress: 60, message: '布局合成' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'ofd') {
    onProgress?.({ progress: 25, message: '解析 ofd 版式文档' })
    markdown = await runNodeParser('ofd 解析失败', ofdToMarkdown(localPath))
    onProgress?.({ progress: 60, message: '布局合成' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'mhtml' || ext === 'mht') {
    onProgress?.({ progress: 25, message: '解析 mhtml（MIME 分块）' })
    markdown = await runNodeParser('mhtml 解析失败', mhtmlToMarkdown(localPath))
    onProgress?.({ progress: 60, message: '布局合成' })
    middle = synthesizeLayout(markdown)
  } else if (ext === 'pdf') {
    const r = await parsePdf(localPath, onProgress)
    markdown = r.markdown
    middle = r.middle
  } else if (isImageExt(ext)) {
    // 图片与 pdf 在 MinerU 链路一视同仁，但 Node 引擎无 OCR/视觉能力
    throw nonRetryable(
      'PARSE_NEEDS_MINERU',
      `图片解析需要 MinerU（设置中配置并在上传时选择 MinerU 引擎）——Node 引擎不支持 .${ext}`
    )
  } else if (ext === 'ppt' || ext === 'xls') {
    throw nonRetryable(
      'PARSE_NEEDS_MINERU',
      `.${ext} 为旧版 Office 二进制格式，仅 MinerU 引擎支持——请在设置中配置 MinerU 并在上传时选择 MinerU 引擎`
    )
  } else {
    const mineruHint = isMineruExt(ext, input.settings.mineru.provider)
      ? '（MinerU 引擎支持该类型，请在上传时选择 MinerU 引擎）'
      : ''
    throw nonRetryable(
      'PARSE_UNSUPPORTED_FORMAT',
      `Node 引擎不支持 .${ext} 格式${mineruHint}，请配置 MinerU（设置 → MinerU）后重试`
    )
  }

  onProgress?.({ progress: 80, message: '写入产物' })
  await fs.writeFile(mdPath, markdown, 'utf-8')
  await fs.writeFile(midPath, JSON.stringify(middle), 'utf-8')
  onProgress?.({ progress: 95, message: '解析完成' })

  return {
    engine: 'fallback',
    markdownPath: mdPath,
    middleJsonPath: midPath,
    pages: middle.pages.length,
    blockCount: middle.blocks.length,
  }
}
