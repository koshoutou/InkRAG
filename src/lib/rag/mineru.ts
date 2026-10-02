/**
 * 解析客户端：MinerU 六步协议（真实）+ 内置降级解析器（fallback）
 *
 * 【真实 MinerU】（计划书 §5.2，仅当 mineruApiUrl 配置时启用）
 *   ① POST /v1/uploads {purpose:'parse',filename,bytes} → {id: uploadId, upload_url}
 *   ② PUT upload_url 流式上传字节（🔴 绝不带 Authorization——坑#3）
 *   ③ POST /v1/uploads/{uploadId}/complete → {id: fileId}
 *   ④ POST /v1/parse/jobs {files:[{source:{type:'file_id',file_id}}], tier, ocr_mode, output_formats}
 *   ⑤ GET  /v1/parse/jobs/{jobId} 有界轮询（2s 起，×1.6 + 20% jitter，max 30s，600 次）
 *   ⑥ GET  /v1/files/{fileId}/content 流式下载 → .part → rename 原子落盘（zip 则解压）
 *
 * 【降级解析器】（沙箱演示）
 *   - .md/.markdown 原文直转 full.md；.txt 按空行分段转 md；.html 剥标签转文本
 *   - .pdf 用 pdfjs-dist 服务端提取（真实 bbox + 分页）
 *   - middle.json 统一格式，charStart/charEnd 与 full.md 严格对齐
 *   - 文本类文件合成分页：A4 595×842pt，margin 50，lineHeight 16，中文≈44 字/行、英文≈88 字符/行
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { unzipSync } from 'fflate'
import { parseMarkdownBlocks } from './chunking'
import { htmlToMarkdown } from './parsers/html-clean'
import { docxToMarkdown } from './parsers/docx'
import { ensureDocDir, markdownPath, middleJsonPath } from './artifacts'
import { StoreError } from './vectorstore'
import type { RagSettings } from './settings'
import type { LayoutBlock, MiddleJson, ParseArtifacts, ParseProgressEvent } from './types'

const MINERU_TIMEOUT_MS = 120_000

function nonRetryable(code: string, message: string): StoreError {
  const e = new StoreError(`${code}: ${message}`, { retryable: false })
  e.name = code
  return e
}
function retryable(message: string): StoreError {
  return new StoreError(message, { retryable: true })
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

export interface ParseDocumentInput {
  docId: string
  kbId: string
  filename: string
  localPath: string
  mimeType: string
  settings: RagSettings
  onProgress?: (e: ParseProgressEvent) => void
}

export async function parseDocument(input: ParseDocumentInput): Promise<ParseArtifacts> {
  if (input.settings.parseMode === 'mineru') {
    return parseWithMineru(input)
  }
  if (input.settings.parseMode === 'fallback') {
    return parseWithFallback(input)
  }
  throw nonRetryable(
    'PARSE_NOT_CONFIGURED',
    '未配置 MinerU API 且未启用降级解析器，无法解析文档（请在设置中配置 mineruApiUrl 或开启 useFallbackParser）'
  )
}

// ---------------------------------------------------------------------------
// MinerU 六步协议
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
      const jitter = delay * 0.2 * Math.random()
      await new Promise((r) => setTimeout(r, delay + jitter))
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
    const mdPath = path.join(outDir, 'full.md')
    const midPath = path.join(outDir, 'middle.json')

    const isZip = buf[0] === 0x50 && buf[1] === 0x4b // PK
    if (isZip) {
      const files = unzipSync(new Uint8Array(buf))
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
    await fs.rm(partPath, { force: true })
    return { markdownPath: mdPath, middleJsonPath: midPath }
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
  // MinerU 风格：[{ page_idx, blocks: [{ type, bbox, text }] }]
  const pages: { w: number; h: number }[] = []
  const blocks: LayoutBlock[] = []
  let cursor = 0
  let idx = 0
  const pageList = Array.isArray(obj) ? obj : (obj.pages ?? [])
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
  const client = new MinerUClient(s.url, s.apiKey, s.tier, s.ocrMode)
  const outDir = await ensureDocDir(input.kbId, input.docId)

  onProgress?.({ progress: 5, message: '上传文件至 MinerU' })
  const fileId = await client.uploadFile(input.localPath, input.filename)
  onProgress?.({ progress: 20, message: '提交解析任务' })
  const jobId = await client.submitJob(fileId)

  const job = await client.pollJob(jobId, { onProgress: (p) => onProgress?.({ progress: p, message: 'MinerU 解析中' }) })

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
  const { markdownPath: mdPath, middleJsonPath: midPath } = await client.downloadArtifact(fileId, outDir)

  // middle.json 归一化
  const markdown = await fs.readFile(mdPath, 'utf-8')
  let rawMiddle: unknown = {}
  try {
    rawMiddle = JSON.parse(await fs.readFile(midPath, 'utf-8'))
  } catch {}
  const middle = normalizeMiddleJson(rawMiddle, markdown)
  await fs.writeFile(midPath, JSON.stringify(middle))

  onProgress?.({ progress: 100, message: '解析完成' })
  return {
    engine: 'mineru',
    markdownPath: mdPath,
    middleJsonPath: midPath,
    pages: middle.pages.length,
    blockCount: middle.blocks.length,
    mineruJobId: jobId,
    mineruFileId: fileId,
  }
}

// ---------------------------------------------------------------------------
// 降级解析器
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
  } else if (ext === 'html' || ext === 'htm') {
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
  } else if (ext === 'pdf') {
    const r = await parsePdf(localPath, onProgress)
    markdown = r.markdown
    middle = r.middle
  } else {
    throw nonRetryable(
      'PARSE_UNSUPPORTED_FORMAT',
      `降级解析器不支持 .${ext} 格式，请配置 MinerU（mineruApiUrl）后重试`
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
