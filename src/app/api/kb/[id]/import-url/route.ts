/**
 * URL 导入（契约 §26）：POST /api/kb/[id]/import-url  Body { url, filename? }
 *
 * - 单 URL 一次调用（客户端逐个调度并发 2，避免网关 30s 超时）
 * - 服务端 fetch：AbortSignal.timeout(15s)、浏览器 UA、redirect follow
 * - sitemap 分支：URL 含 sitemap.xml 或 body 含 <urlset>/<sitemapindex>
 *   （sitemapindex 递归一层，子图最多 5 张）→ 200 { sitemap:true, urls:[去重≤30] }，不建文档
 * - text/html → html-clean 主内容抽取；text/plain|markdown → 原文清洗
 * - 建 Document：filename = <title>||h1||host+path 清洗后 + .md、mimeType text/markdown、
 *   sha256 秒传（复用唯一索引逻辑）、metaJson {sourceUrl,site,importedAt}、source 产物 .md、
 *   enqueueDocument parse
 * - 响应：201 { doc, deduplicated } | 200 { sitemap, urls } | 4xx/422 { error }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { db } from '@/lib/db'
import { ensureDocDir, sourcePath } from '@/lib/rag/artifacts'
import { enqueueDocument } from '@/lib/rag/pipeline'
import { toDocSummary } from '@/lib/rag/serialize'
import { htmlToMarkdown, extractPageTitle, cleanMarkdownText } from '@/lib/rag/parsers/html-clean'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

const FETCH_TIMEOUT_MS = 15_000
const MAX_SITEMAP_URLS = 30
const MAX_CHILD_SITEMAPS = 5
const MAX_TEXT_BYTES = 8 * 1024 * 1024 // 8MB
const MAX_FILENAME_LEN = 80
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 RAGWorkbench/1.0'

function fetchHeaders(): Record<string, string> {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
}

async function fetchText(url: string): Promise<{ res: Response; text: string }> {
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
  return { res, text: new TextDecoder('utf-8', { fatal: false }).decode(buf) }
}

/** 从 sitemap XML 提取 <loc> 列表 */
function extractSitemapUrls(xml: string): string[] {
  const out: string[] = []
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const u = m[1]
    if (/^https?:\/\//i.test(u)) out.push(u)
  }
  return out
}

function looksLikeSitemap(url: URL, body: string): boolean {
  if (/sitemap.*\.xml/i.test(url.pathname)) return true
  return /<(urlset|sitemapindex)[\s>]/i.test(body.slice(0, 5000))
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

    let fetched: { res: Response; text: string }
    try {
      fetched = await fetchText(target.toString())
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? `抓取超时（${FETCH_TIMEOUT_MS / 1000}s）` : (e as Error).message
      return NextResponse.json({ error: `抓取失败：${msg}` }, { status: 422 })
    }
    const { res, text } = fetched
    const finalUrl = res.url || target.toString()
    const finalParsed = new URL(finalUrl)
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()

    // --- sitemap 分支：展开子链接返回，不建文档 ---
    if (looksLikeSitemap(finalParsed, text)) {
      let urls = extractSitemapUrls(text)
      const isIndex = /<sitemapindex[\s>]/i.test(text.slice(0, 5000))
      if (isIndex) {
        const children = urls.slice(0, MAX_CHILD_SITEMAPS)
        const collected: string[] = []
        for (const child of children) {
          try {
            const sub = await fetchText(child)
            collected.push(...extractSitemapUrls(sub.text))
          } catch {
            /* 子图不可达则跳过 */
          }
          if (collected.length >= MAX_SITEMAP_URLS) break
        }
        if (collected.length > 0) urls = collected
      }
      const seen = new Set<string>()
      const out: string[] = []
      for (const u of urls) {
        if (!seen.has(u)) {
          seen.add(u)
          out.push(u)
        }
        if (out.length >= MAX_SITEMAP_URLS) break
      }
      return NextResponse.json({ sitemap: true, urls: out })
    }

    // --- 正文抽取 ---
    const startedAt = Date.now()
    let markdown = ''
    if (contentType.includes('html') || contentType.includes('xhtml')) {
      markdown = htmlToMarkdown(text, { baseUrl: finalUrl })
    } else if (contentType.includes('text/plain') || contentType.includes('markdown') || contentType === '') {
      // 纯文本 / markdown 原文（同款清洗）
      markdown = cleanMarkdownText(text)
    } else {
      return NextResponse.json(
        { error: `不支持的内容类型：${contentType.split(';')[0] || '未知'}（仅支持 text/html 与 text/plain）` },
        { status: 422 },
      )
    }
    markdown = markdown.trim()
    if (markdown.length === 0) {
      return NextResponse.json({ error: '页面正文为空（可能被站点脚本渲染或主内容抽取未命中）' }, { status: 422 })
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

    // --- 建文档 + source 产物（.md，fallback 解析器直转） ---
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
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
