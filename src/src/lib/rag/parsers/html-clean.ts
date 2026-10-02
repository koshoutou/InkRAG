/**
 * 共享 HTML → Markdown 清洗器（契约 §26）
 *
 * 三个消费方共用同一实现：
 *   1. docx 解析（parsers/docx.ts：mammoth 转出的干净语义 HTML，noExtract 直转）
 *   2. URL 导入（import-url 路由：抓取的网页 → 主内容抽取 → 结构化 md）
 *   3. .html 文件解析（mineru.ts fallback 分支，替换原 htmlToText 剥标签弱实现）
 *
 * 能力：
 *   - 主内容抽取：article > main > [role=main] > #content > .mw-parser-output（MediaWiki）
 *     > 文本密度最大的容器；同时剥离 script/style/nav/header/footer/aside/form/noscript/svg/iframe
 *   - 结构转换：h1-h6 → #/##…、p、ul/ol 嵌套 li、table → md 管道表格、strong/em、
 *     a → [文本](href)、img → [图片:alt](src)、pre/code → 围栏代码块（保留原文）
 *   - 清洗：控制字符、\r\n 统一、零宽/全角空白、行首尾修剪、bullet 字符统一、
 *     >2 连续空行合并为 2 —— 冗余字符清除且结构与内容完整
 */
import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import type { AnyNode, Element } from 'domhandler'

const STRIP_SELECTOR =
  'script,style,noscript,iframe,svg,form,nav,header,footer,aside,button,input,select,textarea,template,link,meta,object,embed'

const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em',
  'i', 'kbd', 'mark', 'q', 'ruby', 's', 'samp', 'small', 'span', 'strong',
  'sub', 'sup', 'time', 'u', 'var', 'wbr', 'img', 'del', 'ins',
])

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

export interface HtmlCleanOptions {
  /** 跳过主内容抽取（输入已是无站点骨架的干净 HTML，如 mammoth 转换结果） */
  noExtract?: boolean
  /** 相对链接解析基准（URL 导入用；提供时 a/img 的相对地址转绝对） */
  baseUrl?: string
}

interface Ctx {
  $: CheerioAPI
  opts: HtmlCleanOptions
  base: URL | null
}

// ---------------------------------------------------------------------------
// 文本清洗
// ---------------------------------------------------------------------------

/** 行内文本清洗：HTML 流文本中换行=空格；清零宽字符 */
function cleanInlineText(s: string): string {
  return s
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
}

/** 终态清洗：控制字符、\r、bullet 统一、行首尾修剪、>2 连续空行 → 2 */
export function cleanMarkdownText(md: string): string {
  let out = md
    // 控制字符（保留 \n \t）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n?/g, '\n')
    // 零宽 / 不换行空格 / 全角空白
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u3000/g, ' ')
    .split('\n')
    .map((line) => {
      const t = line.replace(/[ \t]+$/, '')
      // bullet 字符统一（•‣▪◦·▫ 等）
      return t.replace(/^([ \t]*)[•‣▪▫◦·●○]\s+/, '$1- ')
    })
    .join('\n')
  // >2 连续空行（≥4 个换行）合并为 2 个空行（3 个换行）
  out = out.replace(/\n{4,}/g, '\n\n\n')
  // 强调标记与 CJK 标点之间的多余空格收紧（**粗体** 。→ **粗体**。）
  const CLOSE_PUNCT = '，。；：、！？）】》”’,.;:!?)\\]}'
  const OPEN_PUNCT = '（【《“‘({\\['
  out = out
    .replace(new RegExp(`(\\*\\*|\\*|~~|\`)\\s+([${CLOSE_PUNCT}])`, 'g'), '$1$2')
    .replace(new RegExp(`([${OPEN_PUNCT}])\\s+(\\*\\*|\\*|~~|\`)`, 'g'), '$1$2')
  const trimmed = out.trim()
  return trimmed.length > 0 ? trimmed + '\n' : ''
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function resolveUrl(ctx: Ctx, href: string | undefined): string {
  if (!href) return ''
  const t = href.trim()
  if (!t || t.startsWith('#') || /^(javascript|mailto|tel):/i.test(t)) return ''
  if (!ctx.base) return t
  try {
    return new URL(t, ctx.base).toString()
  } catch {
    return t
  }
}

function renderImage(ctx: Ctx, el: Element): string {
  const $ = ctx.$
  const alt = cleanInlineText($(el).attr('alt') ?? '').trim()
  const src = resolveUrl(ctx, $(el).attr('src'))
  const label = alt ? `图片:${alt}` : '图片'
  return src ? `[${label}](${src})` : `[${label}]`
}

/** 行内节点渲染（strong/em/code/a/img/br 与纯文本） */
function renderInline(ctx: Ctx, nodes: AnyNode[]): string {
  const parts: string[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      parts.push(cleanInlineText((node as unknown as { data: string }).data ?? ''))
    } else if (node.type === 'tag') {
      const el = node as Element
      const tag = el.tagName.toLowerCase()
      if (tag === 'strong' || tag === 'b') {
        const inner = renderInline(ctx, el.children).trim()
        if (inner) parts.push(` **${inner}** `)
      } else if (tag === 'em' || tag === 'i') {
        const inner = renderInline(ctx, el.children).trim()
        if (inner) parts.push(` *${inner}* `)
      } else if (tag === 'del' || tag === 's' || tag === 'strike') {
        const inner = renderInline(ctx, el.children).trim()
        if (inner) parts.push(` ~~${inner}~~ `)
      } else if (tag === 'code') {
        const inner = cleanInlineText(ctx.$(el).text()).trim()
        if (inner) parts.push('`' + inner.replace(/`+/g, "'") + '`')
      } else if (tag === 'a') {
        const href = resolveUrl(ctx, ctx.$(el).attr('href'))
        const inner = renderInline(ctx, el.children).trim()
        if (href && inner) parts.push(`[${inner}](${href})`)
        else if (inner) parts.push(inner)
      } else if (tag === 'img') {
        parts.push(renderImage(ctx, el))
      } else if (tag === 'br') {
        parts.push('\n')
      } else if (INLINE_TAGS.has(tag)) {
        parts.push(renderInline(ctx, el.children))
      } else {
        // 块级元素意外出现在行内上下文 → 按块渲染
        parts.push(renderBlock(ctx, el))
      }
    }
    // comment 等其他节点类型忽略
  }
  return parts.join('')
}

/** 列表渲染（ul/ol 嵌套，缩进 2 空格；li 内嵌 table 原样缩进） */
function renderList(ctx: Ctx, el: Element, depth: number, ordered: boolean): string {
  const lines: string[] = []
  let index = 0
  for (const child of el.children) {
    if (child.type !== 'tag' || (child as Element).tagName.toLowerCase() !== 'li') continue
    const li = child as Element
    let inline = ''
    const subBlocks: Element[] = []
    for (const c of li.children) {
      if (c.type === 'text') {
        inline += cleanInlineText((c as unknown as { data: string }).data ?? '')
      } else if (c.type === 'tag') {
        const cel = c as Element
        const ctag = cel.tagName.toLowerCase()
        if (ctag === 'ul' || ctag === 'ol' || ctag === 'table') {
          subBlocks.push(cel)
        } else if (ctag === 'p') {
          inline += ' ' + renderInline(ctx, cel.children)
        } else {
          inline += renderInline(ctx, [cel])
        }
      }
    }
    const marker = ordered ? `${++index}.` : '-'
    const indent = '  '.repeat(depth)
    const text = inline.replace(/\s+/g, ' ').trim()
    lines.push(`${indent}${marker} ${text}`.trimEnd())
    for (const sub of subBlocks) {
      const stag = sub.tagName.toLowerCase()
      if (stag === 'table') {
        const t = renderTable(ctx, sub)
        if (t) lines.push(indent + '  ' + t.replace(/\n/g, `\n${indent}  `))
      } else {
        lines.push(renderList(ctx, sub, depth + 1, stag === 'ol'))
      }
    }
  }
  return lines.join('\n')
}

/** 表格 → md 管道表格（thead 优先；首行为表头；| 转义） */
function renderTable(ctx: Ctx, el: Element): string {
  const $ = ctx.$
  const rows: string[][] = []
  const pushRow = (tr: AnyNode) => {
    const cells: string[] = []
    for (const cell of (tr as Element).children) {
      if (cell.type !== 'tag') continue
      const ctag = (cell as Element).tagName.toLowerCase()
      if (ctag !== 'td' && ctag !== 'th') continue
      const text = renderInline(ctx, (cell as Element).children)
        .replace(/\|/g, '\\|')
        .replace(/\n+/g, ' ')
        .trim()
      cells.push(text)
    }
    if (cells.length > 0) rows.push(cells)
  }
  const theadRows = $(el).find('thead tr')
  if (theadRows.length > 0) {
    theadRows.each((_, tr) => pushRow(tr as unknown as AnyNode))
    $(el).find('tbody tr').each((_, tr) => pushRow(tr as unknown as AnyNode))
  } else {
    $(el).find('tr').each((_, tr) => pushRow(tr as unknown as AnyNode))
  }
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const norm = rows.map((r) => {
    const copy = [...r]
    while (copy.length < width) copy.push('')
    return copy
  })
  const sep = '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |'
  const lines = ['| ' + norm[0].join(' | ') + ' |', sep]
  for (const r of norm.slice(1)) lines.push('| ' + r.join(' | ') + ' |')
  return lines.join('\n')
}

/** 代码块（pre 保留原文；language-xxx class → 围栏语言标注） */
function renderPre(ctx: Ctx, el: Element): string {
  const $ = ctx.$
  let lang = ''
  const codeEl = $(el).children('code').first()
  if (codeEl.length > 0) {
    const cls = String(codeEl.attr('class') ?? '')
    const m = cls.match(/(?:language|lang)-([\w+-]+)/i)
    if (m) lang = m[1]
  }
  const text = (codeEl.length > 0 ? codeEl.text() : $(el).text()).replace(/\n+$/, '')
  if (!text.trim()) return ''
  const fence = '```'
  return `${fence}${lang}\n${text}\n${fence}`
}

function headingLevel(tag: string): number {
  const n = Number(tag[1])
  return n >= 1 && n <= 6 ? n : 2
}

/** 单个块级元素渲染 → markdown 片段（不含收尾空行） */
function renderBlock(ctx: Ctx, el: Element): string {
  const $ = ctx.$
  const tag = el.tagName.toLowerCase()
  if (HEADINGS.has(tag)) {
    const text = renderInline(ctx, el.children).replace(/\s+/g, ' ').trim()
    if (!text) return ''
    return '#'.repeat(headingLevel(tag)) + ' ' + text
  }
  if (tag === 'p') {
    return renderInline(ctx, el.children).replace(/[ \t]*\n[ \t]*/g, '\n').trim()
  }
  if (tag === 'ul' || tag === 'ol') return renderList(ctx, el, 0, tag === 'ol')
  if (tag === 'table') return renderTable(ctx, el)
  if (tag === 'pre') return renderPre(ctx, el)
  if (tag === 'blockquote') {
    const inner = renderChildren(ctx, el.children)
    if (!inner.trim()) return ''
    return inner
      .split('\n')
      .map((l) => (l.trim() ? `> ${l}` : '>'))
      .join('\n')
  }
  if (tag === 'hr') return '---'
  if (tag === 'br') return ''
  if (tag === 'img') return renderImage(ctx, el)
  if (tag === 'figure' || tag === 'figcaption') {
    return renderChildren(ctx, el.children)
  }
  if (tag === 'dl') {
    // 定义列表 → 术语加粗 + 描述段落
    const out: string[] = []
    $(el).children('dt,dd').each((_, node) => {
      const nel = node as unknown as Element
      const isDt = nel.tagName.toLowerCase() === 'dt'
      const text = renderInline(ctx, nel.children).trim()
      if (text) out.push(isDt ? `**${text}**` : text)
    })
    return out.join('\n\n')
  }
  // 其余容器（div/section/article/main/body…）→ 递归子节点
  return renderChildren(ctx, el.children)
}

/** 块上下文渲染子节点：行内片段聚合成隐式段落，块级元素独立成段 */
function renderChildren(ctx: Ctx, nodes: AnyNode[]): string {
  const out: string[] = []
  let buf = ''
  const flush = () => {
    const t = buf.replace(/\s+/g, ' ').trim()
    if (t) out.push(t)
    buf = ''
  }
  for (const node of nodes) {
    if (node.type === 'text') {
      buf += cleanInlineText((node as unknown as { data: string }).data ?? '')
    } else if (node.type === 'tag') {
      const el = node as Element
      const tag = el.tagName.toLowerCase()
      if (tag === 'br') {
        buf += '\n'
      } else if (INLINE_TAGS.has(tag)) {
        buf += renderInline(ctx, [el])
      } else {
        flush()
        out.push(renderBlock(ctx, el))
      }
    }
  }
  flush()
  return out.filter((s) => s.trim().length > 0).join('\n\n')
}

// ---------------------------------------------------------------------------
// 主内容抽取
// ---------------------------------------------------------------------------

function textLength($: CheerioAPI, el: Element): number {
  return $(el).text().replace(/\s+/g, '').length
}

function pickMainNode($: CheerioAPI): AnyNode {
  const candidates = ['article', 'main', '[role="main"]', '#content', '.mw-parser-output']
  for (const sel of candidates) {
    const found = $(sel).first()
    if (found.length > 0 && textLength($, found[0] as Element) > 80) {
      return found[0] as AnyNode
    }
  }
  // 文本密度兜底：div/section/td 中文本量最大（导航/页脚已在 STRIP 移除，
  // 链接占比过高的容器（目录/推荐位）降权 0.3）
  let best: Element | null = null
  let bestScore = 0
  $('div, section, article, td').each((_, node) => {
    const el = node as Element
    const len = textLength($, el)
    if (len < 200) return
    const linkLen = $(el).find('a').text().replace(/\s+/g, '').length
    const density = len > 0 ? linkLen / len : 1
    const score = density > 0.5 ? len * 0.3 : len
    if (score > bestScore) {
      bestScore = score
      best = el
    }
  })
  if (best && bestScore >= 300) return best as AnyNode
  const body = $('body').first()
  if (body.length > 0) return body[0] as AnyNode
  return $.root()[0] as AnyNode
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** HTML → 清洗后的结构化 markdown */
export function htmlToMarkdown(html: string, opts: HtmlCleanOptions = {}): string {
  const $ = cheerio.load(html)
  $(STRIP_SELECTOR).remove()
  let base: URL | null = null
  if (opts.baseUrl) {
    try {
      base = new URL(opts.baseUrl)
    } catch {
      base = null
    }
  }
  const ctx: Ctx = { $, opts, base }
  let root: AnyNode
  if (opts.noExtract) {
    const body = $('body').first()
    root = body.length > 0 ? (body[0] as AnyNode) : ($.root()[0] as AnyNode)
  } else {
    root = pickMainNode($)
  }
  const md = renderChildren(ctx, (root as Element).children ?? [])
  return cleanMarkdownText(md)
}

/** 页面标题抽取（URL 导入文件名派生：<title> 优先，h1 兜底） */
export function extractPageTitle(html: string): { title: string; h1: string } {
  const $ = cheerio.load(html)
  const title = cleanInlineText($('title').first().text() ?? '').trim()
  const h1 = cleanInlineText($('h1').first().text() ?? '').trim()
  return { title, h1 }
}
