/**
 * URL 导入（契约 §26 + Task 14-e）：POST /api/kb/[id]/import-url  Body { url, filename?, engine? }
 *
 * - 单 URL 一次调用（客户端逐个调度并发 2，避免网关 30s 超时）；多 URL 编排在 UI 层（chips）
 * - 服务端 fetch：AbortSignal.timeout(15s)、浏览器 UA、redirect follow
 * - 解析引擎 engine（'mineru' | 'node'，默认 node；body 或 query 参数）：
 *   引擎不影响抓取逻辑（两种引擎都先把内容下载到本地），仅写入 metaJson.engineChoice，
 *   由流水线 execParse 按 engineChoice 分派（优先级高于全局 parseMode）
 * - text/html → html-clean 主内容抽取；text/plain|markdown → 原文清洗（保存为 .md 源文件）
 * - 二进制文档（pdf/Office/图片等权威清单类型）→ 原始字节直接落盘为 source（按内容类型/URL 后缀定扩展名），
 *   解析交由所选引擎在流水线完成
 * - 建 Document：filename = body.filename > URL/文档派生名、sha256 秒传（复用唯一索引逻辑）、
 *   metaJson {sourceUrl,site,importedAt,engineChoice}、enqueueDocument parse
 * - 响应：201 { doc, deduplicated } | 4xx/422 { error }
 * - Task 14-e：删除 sitemap 递归导入分支（wiki 解析，按用户要求移除）
 */
import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { db } from '@/lib/db'
import { ensureDocDir, sourcePath } from '@/lib/rag/artifacts'
import { enqueueDocument } from '@/lib/rag/pipeline'
import { toDocSummary } from '@/lib/rag/serialize'
import { htmlToMarkdown, extractPageTitle, cleanMarkdownText } from '@/lib/rag/parsers/html-clean'
import { ALL_ACCEPTED_EXTS, mimeToExt } from '@/lib/rag/parsers/formats'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

const FETCH_TIMEOUT_MS = 15_000
const MAX_TEXT_BYTES = 8 * 1024 * 1024 // 8MB
const MAX_FILENAME_LEN = 80
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 RAGWorkbench/1.0'

function fetchHeaders(): Record<string, string> {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/pdf,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
}

async function fetchBytes(url: string): Promise<{ res: Response; buf: ArrayBuffer }> {
  const res = await fetch(url, {
    headers: fetchHeaders(),
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`目标返回 HTTP ${res.status}`)
  }
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_TEXT_BYTES) {
    throw new Error(`响应过大（${(buf.byteLength / 1024 / 1024).toFixed(1)}MB，上限 8MB）`)
  }
  return { res, buf }
}

/** 文件名清洗：非法字符替换、长度截断、空兜底 */
function safeFilename(name: string, fallback: string): string {
  const cleaned = name
    // 控制字符与文件系统非法字符
    .replace(/[\x00-\x1F\x7F\\/:*?"<>|]/g, ' ')
    // 零宽/全角空白
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00A0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim()
  const base = cleaned.length > 0 ? cleaned : fallback
  return base.length > MAX_FILENAME_LEN ? base.slice(0, MAX_FILENAME_LEN) : base
}

/** URL 路径末段文件名（带受支持扩展名时） */
function urlDerivedName(parsed: URL): { name: string; ext: string } | null {
  const seg = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
  if (!seg) return null
  const dot = seg.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = seg.slice(dot + 1).toLowerCase()
  if (!ALL_ACCEPTED_EXTS.includes(ext)) return null
  return { name: safeFilename(seg.slice(0, dot), ''), ext }
}

/** POST /api/kb/[id]/import-url */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const body = await req.json().catch(() => null)
    const rawUrl = typeof body?.url === 'string' ? body.url.trim() : ''
    if (!rawUrl) return NextResponse.json({ error: '缺少 url 字段' }, { status: 400 })
    let target: URL
    try {
      target = new URL(rawUrl)
    } catch {
      return NextResponse.json({ error: `URL 不合法：${rawUrl.slice(0, 200)}` }, { status: 400 })
    }
    if (!/^https?:$/.test(target.protocol)) {
      return NextResponse.json({ error: '仅支持 http/https 协议的 URL' }, { status: 400 })
    }

    // 解析引擎选择（body 优先，query 兜底；默认 node —— 抓取逻辑与引擎无关，仅记录 engineChoice）
    const engineRaw =
      (typeof body?.engine === 'string' ? body.engine : '') || req.nextUrl.searchParams.get('engine') || ''
    let engineChoice: 'mineru' | 'node'
    if (engineRaw.trim()) {
      const v = engineRaw.trim()
      if (v !== 'mineru' && v !== 'node') {
        return NextResponse.json({ error: `无效 engine: ${v}（可选 mineru / node）` }, { status: 400 })
      }
      engineChoice = v
    } else {
      engineChoice = 'node'
    }

    let fetched: { res: Response; buf: ArrayBuffer }
    try {
      fetched = await fetchBytes(target.toString())
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? `抓取超时（${FETCH_TIMEOUT_MS / 1000}s）` : (e as Error).message
      return NextResponse.json({ error: `抓取失败：${msg}` }, { status: 422 })
    }
    const { res, buf } = fetched
    const finalUrl = res.url || target.toString()
    const finalParsed = new URL(finalUrl)
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const startedAt = Date.now()

    const isTextContent =
      contentType.includes('html') ||
      contentType.includes('xhtml') ||
      contentType.includes('text/plain') ||
      contentType.includes('markdown') ||
      contentType === ''

    // ---- 文本内容（html / plain / markdown）：抽取转 markdown，源文件保存为 .md ----
    if (isTextContent) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
      let markdown = ''
      if (contentType.includes('html') || contentType.includes('xhtml')) {
        markdown = htmlToMarkdown(text, { baseUrl: finalUrl })
      } else {
        // 纯文本 / markdown 原文（同款清洗）
        markdown = cleanMarkdownText(text)
      }
      markdown = markdown.trim()
      if (markdown.length === 0) {
        return NextResponse.json(
          { error: '页面正文为空（可能被站点脚本渲染或主内容抽取未命中）' },
          { status: 422 },
        )
      }

      // --- 文件名派生：body.filename > <title> > h1 > host+path ---
      const { title, h1 } = extractPageTitle(text)
      let displayName = ''
      if (typeof body?.filename === 'string' && body.filename.trim()) {
        displayName = safeFilename(body.filename, '')
      }
      if (!displayName) displayName = safeFilename(title, '')
      if (!displayName) displayName = safeFilename(h1, '')
      if (!displayName) {
        const hostPath = `${finalParsed.hostname}${decodeURIComponent(finalParsed.pathname).replace(/\/$/, '')}`
        displayName = safeFilename(hostPath, finalParsed.hostname)
      }
      if (!/\.md$/i.test(displayName)) displayName += '.md'

      // --- 秒传判定（抽取文本 sha256，复用唯一索引语义） ---
      const contentHash = createHash('sha256').update(markdown, 'utf-8').digest('hex')
      const sizeBytes = Buffer.byteLength(markdown, 'utf-8')
      const parseConfigV = 1
      const dup = await db.document.findFirst({
        where: { kbId: id, contentHash, parseConfigV },
      })
      if (dup) {
        const [chunkCount, enabledChunkCount] = await Promise.all([
          db.chunk.count({ where: { documentId: dup.id, isParent: false } }),
          db.chunk.count({ where: { documentId: dup.id, isParent: false, enabled: true } }),
        ])
        return NextResponse.json(
          { doc: toDocSummary(dup, { chunkCount, enabledChunkCount }), deduplicated: true },
          { status: 201 },
        )
      }

      // --- 建文档 + source 产物（.md） ---
      const docId = randomUUID()
      await ensureDocDir(id, docId)
      await fs.writeFile(sourcePath(id, docId, 'md'), markdown, 'utf-8')

      let doc
      try {
        doc = await db.document.create({
          data: {
            id: docId,
            kbId: id,
            filename: displayName,
            mimeType: 'text/markdown',
            sizeBytes,
            contentHash,
            status: 'queued',
            stageProgress: 0,
            parseConfigV,
            chunkConfigSnap: kb.chunkConfig,
            storageKey: `${id}/${docId}/`,
            sourceUrl: finalUrl,
            metaJson: JSON.stringify({
              sourceUrl: finalUrl,
              site: finalParsed.hostname,
              importedAt: new Date().toISOString(),
              importTookMs: Date.now() - startedAt,
              engineChoice,
            }),
          },
        })
      } catch (e: any) {
        if (String(e?.code) === 'P2002') {
          // 并发同 URL 竞争唯一索引 → 秒传返回
          const existing = await db.document.findFirst({ where: { kbId: id, contentHash, parseConfigV } })
          if (existing) {
            await fs.rm(sourcePath(id, docId, 'md'), { force: true })
            return NextResponse.json({ doc: toDocSummary(existing), deduplicated: true }, { status: 201 })
          }
        }
        throw e
      }

      await enqueueDocument(doc.id, 'parse')

      return NextResponse.json(
        { doc: toDocSummary(doc, { chunkCount: 0, enabledChunkCount: 0 }), deduplicated: false },
        { status: 201 },
      )
    }

    // ---- 二进制文档：原始字节直接作为 source（引擎无关，均先下载到本地） ----
    // 支持类型 = 权威清单（formats.ts）；扩展名优先 URL 后缀，其次内容类型反推
    const urlName = urlDerivedName(finalParsed)
    let ext = urlName?.ext ?? ''
    let baseName = urlName?.name ?? ''
    if (!ext) {
      ext = mimeToExt(contentType)
    }
    if (!ext) {
      return NextResponse.json(
        {
          error: `不支持的内容类型：${contentType.split(';')[0] || '未知'}（文本页 text/html、text/plain，或文档 pdf/Office/图片/epub/ofd 等类型）`,
        },
        { status: 422 },
      )
    }
    const raw = Buffer.from(buf)
    if (raw.length === 0) {
      return NextResponse.json({ error: '目标文件为空' }, { status: 422 })
    }
    if (!baseName) {
      if (typeof body?.filename === 'string' && body.filename.trim()) {
        baseName = safeFilename(body.filename, '')
        // body 提供的文件名若带扩展名则剥离（统一用 ext）
        baseName = baseName.replace(/\.[a-zA-Z0-9]+$/, '')
      }
      if (!baseName) {
        const hostPath = `${finalParsed.hostname}${decodeURIComponent(finalParsed.pathname).replace(/\/$/, '')}`
        baseName = safeFilename(hostPath, finalParsed.hostname)
      }
    }
    const displayName = `${baseName}.${ext}`

    // --- 秒传判定（原始字节 sha256） ---
    const contentHash = createHash('sha256').update(raw).digest('hex')
    const sizeBytes = raw.length
    const parseConfigV = 1
    const dup = await db.document.findFirst({
      where: { kbId: id, contentHash, parseConfigV },
    })
    if (dup) {
      const [chunkCount, enabledChunkCount] = await Promise.all([
        db.chunk.count({ where: { documentId: dup.id, isParent: false } }),
        db.chunk.count({ where: { documentId: dup.id, isParent: false, enabled: true } }),
      ])
      return NextResponse.json(
        { doc: toDocSummary(dup, { chunkCount, enabledChunkCount }), deduplicated: true },
        { status: 201 },
      )
    }

    const docId = randomUUID()
    await ensureDocDir(id, docId)
    await fs.writeFile(sourcePath(id, docId, ext), raw)

    let doc
    try {
      doc = await db.document.create({
        data: {
          id: docId,
          kbId: id,
          filename: displayName,
          mimeType: contentType.split(';')[0] || 'application/octet-stream',
          sizeBytes,
          contentHash,
          status: 'queued',
          stageProgress: 0,
          parseConfigV,
          chunkConfigSnap: kb.chunkConfig,
          storageKey: `${id}/${docId}/`,
          sourceUrl: finalUrl,
          metaJson: JSON.stringify({
            sourceUrl: finalUrl,
            site: finalParsed.hostname,
            importedAt: new Date().toISOString(),
            importTookMs: Date.now() - startedAt,
            engineChoice,
          }),
        },
      })
    } catch (e: any) {
      if (String(e?.code) === 'P2002') {
        const existing = await db.document.findFirst({ where: { kbId: id, contentHash, parseConfigV } })
        if (existing) {
          await fs.rm(sourcePath(id, docId, ext), { force: true })
          return NextResponse.json({ doc: toDocSummary(existing), deduplicated: true }, { status: 201 })
        }
      }
      throw e
    }

    await enqueueDocument(doc.id, 'parse')

    return NextResponse.json(
      { doc: toDocSummary(doc, { chunkCount: 0, enabledChunkCount: 0 }), deduplicated: false },
      { status: 201 },
    )
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
