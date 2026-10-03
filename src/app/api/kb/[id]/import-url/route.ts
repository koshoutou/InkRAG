/**
 * URL 导入（契约 §26 + Task 14-e + Task 15-b SSRF 加固）：POST /api/kb/[id]/import-url  Body { url, filename?, engine? }
 *
 * - 单 URL 一次调用（客户端逐个调度并发 2，避免网关 30s 超时）；多 URL 编排在 UI 层（chips）
 * - Task 15-b（审计 #1）SSRF 防护：
 *   * 协议白名单 http/https；禁止 userinfo（http://user:pass@host）
 *   * isPrivateHost：IP 直连判私网/保留段（127/8、10/8、172.16/12、192.168/16、169.254/16 链路本地、
 *     0.0.0.0、100.64/10 CGNAT、IPv6 ::1/fc00::/7/fe80::/10/::、IPv4-mapped ::ffff:x）；
 *     域名用 node:dns lookup({all:true}) 解析全部 IP 逐一校验；.localhost/.local/.internal 后缀拒绝
 *   * redirect:'manual' 手动跟随重定向（最多 3 跳），每一跳重新走协议 + 内网校验，Location 相对地址转绝对
 *     —— 否则 302 可跳 169.254.169.254 云元数据等内网目标
 *   * 流式限额：Content-Length > 8MB 直接拒；无头则边读边累计，超 8MB 中断（不再全量 arrayBuffer 进内存）
 * - 解析引擎 engine（'mineru' | 'node'，默认 node；body 或 query 参数）：
 *   引擎不影响抓取逻辑（两种引擎都先把内容下载到本地），仅写入 metaJson.engineChoice，
 *   由流水线 execParse 按 engineChoice 分派（优先级高于全局 parseMode）
 * - text/html → html-clean 主内容抽取；text/plain|markdown → 原文清洗（保存为 .md 源文件）
 * - 二进制文档（pdf/Office/图片等权威清单类型）→ 原始字节直接落盘为 source（按内容类型/URL 后缀定扩展名），
 *   解析交由所选引擎在流水线完成
 * - 建 Document：filename = body.filename > URL/文档派生名、sha256 秒传（复用唯一索引逻辑）、
 *   metaJson {sourceUrl,site,importedAt,engineChoice}、enqueueDocument parse
 * - 响应：201 { doc, deduplicated } | 400（URL/SSRF 拒绝）| 413（超限）| 422 { error }
 * - Task 14-e：删除 sitemap 递归导入分支（wiki 解析，按用户要求移除）
 */
import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
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
const MAX_REDIRECTS = 3 // 手动跟随重定向上限
const MAX_FILENAME_LEN = 80
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 RAGWorkbench/1.0'

/** SSRF 拒绝（400）；其它抓取错误（DNS 失败/超时/HTTP 错误码/超限）走 422 */
class SsrfError extends Error {}

function fetchHeaders(): Record<string, string> {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/pdf,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
}

// ---------------------------------------------------------------------------
// SSRF 防护：私网/保留 IP 判定（Task 15-b / 审计 #1）
// ---------------------------------------------------------------------------

/** 点分十进制 → 无符号 32 位整数（非法返回 null） */
function ipv4ToLong(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n >>> 0
}

function inCidr4(ipLong: number, cidr: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipLong & mask) === (ipv4ToLong(cidr)! & mask)
}

/** IPv4 私网/保留段黑名单 */
function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToLong(ip)
  if (n === null) return true // 解析失败按私网处理（保守拒绝）
  return (
    inCidr4(n, '0.0.0.0', 8) || // 0.0.0.0/8（"任意地址"，常被解析到本机）
    inCidr4(n, '10.0.0.0', 8) || // 10/8 私网
    inCidr4(n, '100.64.0.0', 10) || // 100.64/10 CGNAT（云商内部网络）
    inCidr4(n, '127.0.0.0', 8) || // 127/8 环回
    inCidr4(n, '169.254.0.0', 16) || // 169.254/16 链路本地（含云元数据 169.254.169.254）
    inCidr4(n, '172.16.0.0', 12) || // 172.16/12 私网
    inCidr4(n, '192.168.0.0', 16) || // 192.168/16 私网
    inCidr4(n, '192.0.2.0', 24) || // 192.0.2/24 TEST-NET（文档示例段）
    inCidr4(n, '198.18.0.0', 15) || // 198.18/15 基准测试段
    inCidr4(n, '224.0.0.0', 4) || // 224/4 组播
    inCidr4(n, '240.0.0.0', 4) // 240/4 保留（含 255.255.255.255 广播）
  )
}

/** IPv6 私网/保留段（含 IPv4-mapped ::ffff:a.b.c.d 透传校验） */
function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase()
  if (addr === '::' || addr === '::1') return true // 未指定 / 环回
  // IPv4-mapped：::ffff:a.b.c.d 或 ::ffff:hex 形式 → 按 IPv4 再判
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/) || addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mapped) {
    if (mapped[0].includes('.')) return isPrivateIPv4(mapped[1])
    // hex 形式：低 32 位按 IPv4 展开
    const hi = Number.parseInt(mapped[1], 16)
    const lo = Number.parseInt(mapped[2], 16)
    return isPrivateIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)
  }
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true // fc00::/7 唯一本地（ULA）
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true // fe80::/10 链路本地
  if (/^::ffff:0:0/.test(addr)) return true // ::ffff:0:0/96 兼容映射段
  return false
}

function isPrivateIpLiteral(ip: string): boolean {
  const t = isIP(ip)
  if (t === 4) return isPrivateIPv4(ip)
  if (t === 6) return isPrivateIPv6(ip)
  return true // 不是合法 IP 字面量 → 保守拒绝
}

/**
 * 校验目标 URL 可安全抓取：
 * 1. 协议 http/https、无 userinfo
 * 2. 主机名后缀黑名单（localhost/.local/.internal）
 * 3. IP 直连 → 私网段判定；域名 → DNS lookup({all:true}) 解析全部 IP 逐一判定
 *    （DNS rebinding 缓解：至少校验解析结果；fetch 时的二次解析窗口为本方案的已知边界）
 */
async function assertPublicHttpUrl(u: URL): Promise<void> {
  if (!/^https?:$/.test(u.protocol)) {
    throw new SsrfError('仅支持 http/https 协议的 URL')
  }
  if (u.username || u.password) {
    throw new SsrfError('不允许携带用户名/密码的 URL（userinfo 形式）')
  }
  // URL.hostname 对 IPv6 自带 [] 括号，统一剥离
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new SsrfError(`目标主机 ${u.hostname} 属于本地/内网域名，已拒绝（SSRF 防护）`)
  }

  const ipType = isIP(host)
  if (ipType !== 0) {
    if (isPrivateIpLiteral(host)) {
      throw new SsrfError(`目标地址 ${u.hostname} 是内网/保留 IP，已拒绝（SSRF 防护）`)
    }
    return
  }

  // 域名：解析全部 A/AAAA 记录逐一校验（任一命中私网即拒绝）
  let addrs: { address: string; family: number }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new Error(`目标域名 ${u.hostname} DNS 解析失败`)
  }
  if (addrs.length === 0) {
    throw new Error(`目标域名 ${u.hostname} 未解析到任何 IP`)
  }
  const bad = addrs.find((a) => isPrivateIpLiteral(a.address))
  if (bad) {
    throw new SsrfError(`目标域名 ${u.hostname} 解析到内网/保留 IP ${bad.address}，已拒绝（SSRF 防护）`)
  }
}

// ---------------------------------------------------------------------------
// 抓取：手动重定向（每跳重校验）+ 流式限额
// ---------------------------------------------------------------------------

/** 流式读取响应体，超 8MB 中断（先看 Content-Length 头提前拒绝） */
async function readBodyLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const lenHeader = res.headers.get('content-length')
  if (lenHeader) {
    const declared = Number.parseInt(lenHeader, 10)
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`响应过大（Content-Length 声明 ${(declared / 1024 / 1024).toFixed(1)}MB，上限 8MB）`)
    }
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`响应过大（已读 ${(total / 1024 / 1024).toFixed(1)}MB 超过 8MB 上限），已中断下载`)
      }
      chunks.push(Buffer.from(value))
    }
  }
  return Buffer.concat(chunks)
}

/**
 * 带内网防护的抓取：redirect:'manual' 最多 3 跳，每一跳重新 assertPublicHttpUrl；
 * Location 相对地址基于当前 URL 转绝对。返回最终响应（已限额读入）与最终 URL。
 */
async function fetchBytesWithGuard(
  startUrl: URL
): Promise<{ res: Response; buf: Buffer; finalUrl: string }> {
  let current = startUrl
  for (let hop = 0; ; hop++) {
    await assertPublicHttpUrl(current) // 每一跳（含首跳与重定向目标）都重新校验
    const res = await fetch(current.toString(), {
      headers: fetchHeaders(),
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel().catch(() => {})
      const loc = res.headers.get('location')
      if (!loc) throw new Error(`目标返回 HTTP ${res.status} 但缺少 Location 头，无法跟随重定向`)
      if (hop >= MAX_REDIRECTS) {
        throw new Error(`重定向次数超过上限（${MAX_REDIRECTS} 跳），已停止抓取`)
      }
      let next: URL
      try {
        next = new URL(loc, current) // 相对地址基于当前跳转源转绝对
      } catch {
        throw new Error(`重定向地址不合法：${loc.slice(0, 200)}`)
      }
      current = next
      continue
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`目标返回 HTTP ${res.status}`)
    }
    const buf = await readBodyLimited(res, MAX_TEXT_BYTES)
    return { res, buf, finalUrl: current.toString() }
  }
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

    let fetched: { res: Response; buf: Buffer; finalUrl: string }
    try {
      fetched = await fetchBytesWithGuard(target)
    } catch (e) {
      if (e instanceof SsrfError) {
        // SSRF 拒绝属于请求本身不合法 → 400
        return NextResponse.json({ error: `已拒绝该 URL：${e.message}` }, { status: 400 })
      }
      const msg = (e as Error).name === 'TimeoutError' ? `抓取超时（${FETCH_TIMEOUT_MS / 1000}s）` : (e as Error).message
      return NextResponse.json({ error: `抓取失败：${msg}` }, { status: 422 })
    }
    const { res, buf, finalUrl } = fetched
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
    const raw = buf
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
