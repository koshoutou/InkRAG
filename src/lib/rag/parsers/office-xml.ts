/**
 * OOXML / ODF 结构化解析（Task 14-e —— Node 引擎扩展类型）
 *
 * - pptx：fflate 解包 → ppt/slides/slideN.xml 按序 + ppt/notesSlides/notesSlideN.xml；
 *   提取 <a:t> 文本（首个段落视为幻灯片标题加粗，其余为要点；备注斜体）
 * - xlsx：xl/sharedStrings.xml + xl/worksheets/sheet*.xml（经 workbook.xml + rels 映射按序）；
 *   每 sheet 输出 `## Sheet名` + markdown 管道表格（行列防御上限 10000 行）
 * - odt/ods/odp：content.xml（cheerio xmlMode）—— office:text 段落 / office:spreadsheet 表格 /
 *   office:presentation 页，提取 text:p / table:table 行列文本
 *
 * 全部输出 markdown 文本，交由 mineru.ts parseWithFallback → synthesizeLayout 合成布局。
 */
import { promises as fs } from 'node:fs'
import { unzipSync } from 'fflate'
import * as cheerio from 'cheerio'

/** zip 魔数校验 + 解包 */
async function readZip(filePath: string, what: string): Promise<Record<string, Uint8Array>> {
  const buf = await fs.readFile(filePath)
  if (buf.length === 0) throw new Error(`${what} 文件为空`)
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error(`不是合法的 ${what} 文件（缺少 zip 容器魔数，可能扩展名伪装）`)
  }
  try {
    return unzipSync(new Uint8Array(buf)) as Record<string, Uint8Array>
  } catch (e) {
    throw new Error(`${what} 解包失败：${(e as Error).message}`)
  }
}

function decode(u: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(u)
}

/** XML 实体反转义 */
function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

// ---------------------------------------------------------------------------
// pptx
// ---------------------------------------------------------------------------

/** 提取一段 <a:p>…</a:p> 内的全部 <a:t> 文本 */
function paragraphText(pXml: string): string {
  const runs: string[] = []
  const re = /<a:t>([\s\S]*?)<\/a:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(pXml)) !== null) {
    runs.push(xmlUnescape(m[1]))
  }
  return runs.join('').replace(/\s+/g, ' ').trim()
}

/** slide XML → 段落文本列表 */
function slideParagraphs(slideXml: string): string[] {
  const out: string[] = []
  const re = /<a:p>([\s\S]*?)<\/a:p>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(slideXml)) !== null) {
    const t = paragraphText(m[1])
    if (t) out.push(t)
  }
  return out
}

/** 提取 <a:t> 全量文本（备注等无段落兜底） */
function allTexts(xml: string): string[] {
  const out: string[] = []
  const re = /<a:t>([\s\S]*?)<\/a:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const t = xmlUnescape(m[1]).replace(/\s+/g, ' ').trim()
    if (t) out.push(t)
  }
  return out
}

/** 按数字后缀排序的文件名键（slide2 < slide10） */
function numericKey(name: string, prefixRe: RegExp): number {
  const m = name.match(prefixRe)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

export async function pptxToMarkdown(filePath: string): Promise<string> {
  const files = await readZip(filePath, 'pptx')
  const slideRe = /^ppt\/slides\/slide(\d+)\.xml$/
  const notesRe = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/
  const slideNames = Object.keys(files)
    .filter((n) => slideRe.test(n))
    .sort((a, b) => numericKey(a, slideRe) - numericKey(b, slideRe))
  if (slideNames.length === 0) {
    throw new Error('pptx 中未找到幻灯片（ppt/slides/slideN.xml 缺失，文件可能损坏）')
  }
  const notesByNo = new Map<number, string>()
  for (const name of Object.keys(files)) {
    const m = name.match(notesRe)
    if (m) {
      const texts = slideParagraphs(decode(files[name]))
      const note = texts.filter((t) => !/^\d+$/.test(t)).join(' ')
      if (note.trim()) notesByNo.set(Number(m[1]), note.trim())
    }
  }

  const parts: string[] = []
  slideNames.forEach((name, i) => {
    const no = Number(name.match(slideRe)![1])
    const paras = slideParagraphs(decode(files[name]))
    const texts = paras.length > 0 ? paras : allTexts(decode(files[name]))
    if (texts.length === 0) return
    const [title, ...body] = texts
    const seg: string[] = [`## 第 ${no} 页`]
    if (title) seg.push(`**${title}**`)
    for (const b of body) {
      // 备注占位符（ slide number only ）已在上面过滤；正文要点作列表
      seg.push(`- ${b}`)
    }
    const note = notesByNo.get(no)
    if (note) seg.push(`*备注：${note}*`)
    parts.push(seg.join('\n\n'))
    void i
  })
  if (parts.length === 0) {
    throw new Error('pptx 幻灯片中未提取到任何文本（可能是纯图片/形状幻灯片，建议改用 MinerU 引擎解析）')
  }
  return parts.join('\n\n') + '\n'
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

const XLSX_MAX_ROWS = 10_000

interface XlsxSheet {
  name: string
  rows: string[][]
}

/** sharedStrings.xml → 字符串表（si 内多个 <t> rich run 拼接） */
function parseSharedStrings(xml: string): string[] {
  const table: string[] = []
  const siRe = /<si>([\s\S]*?)<\/si>/g
  let m: RegExpExecArray | null
  while ((m = siRe.exec(xml)) !== null) {
    const runs: string[] = []
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g
    let t: RegExpExecArray | null
    while ((t = tRe.exec(m[1])) !== null) runs.push(xmlUnescape(t[1]))
    table.push(runs.join(''))
  }
  return table
}

/** worksheet XML → 行列（t="s" 查共享表；t="inlineStr" 取 <is><t>；其余取 <v>） */
function parseWorksheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(xml)) !== null) {
    const cells: string[] = []
    const cRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g
    let cm: RegExpExecArray | null
    while ((cm = cRe.exec(rm[1])) !== null) {
      const attrs = cm[1] ?? cm[3] ?? ''
      const inner = cm[2] ?? ''
      const typeMatch = attrs.match(/t="([^"]*)"/)
      const type = typeMatch ? typeMatch[1] : ''
      let text = ''
      if (type === 's') {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/)
        if (vMatch) {
          const idx = Number(xmlUnescape(vMatch[1]))
          text = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : ''
        }
      } else if (type === 'inlineStr') {
        const runs: string[] = []
        const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g
        let t: RegExpExecArray | null
        while ((t = tRe.exec(inner)) !== null) runs.push(xmlUnescape(t[1]))
        text = runs.join('')
      } else {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/)
        if (vMatch) text = xmlUnescape(vMatch[1])
      }
      cells.push(text.trim())
    }
    if (cells.length > 0) rows.push(cells)
    if (rows.length >= XLSX_MAX_ROWS) break
  }
  return rows
}

/** 行列 → markdown 管道表格（首行表头，列数对齐，| 转义） */
function rowsToTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const norm = rows.slice(0, XLSX_MAX_ROWS).map((r) => {
    const copy = r.map((c) => c.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim())
    while (copy.length < width) copy.push('')
    return copy
  })
  const sep = '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |'
  const lines = ['| ' + norm[0].join(' | ') + ' |', sep]
  for (const r of norm.slice(1)) lines.push('| ' + r.join(' | ') + ' |')
  return lines.join('\n')
}

export async function xlsxToMarkdown(filePath: string): Promise<string> {
  const files = await readZip(filePath, 'xlsx')
  // 共享字符串表（可选）
  const shared =
    files['xl/sharedStrings.xml'] !== undefined ? parseSharedStrings(decode(files['xl/sharedStrings.xml'])) : []
  // workbook.xml：sheet 顺序与名称；rels：rId → worksheet 路径
  const relTargets = new Map<string, string>()
  if (files['xl/_rels/workbook.xml.rels'] !== undefined) {
    const relsXml = decode(files['xl/_rels/workbook.xml.rels'])
    const relRe = /<Relationship[^>]*>/g
    let m: RegExpExecArray | null
    while ((m = relRe.exec(relsXml)) !== null) {
      const id = m[0].match(/Id="([^"]*)"/)?.[1]
      const target = m[0].match(/Target="([^"]*)"/)?.[1]
      if (id && target) relTargets.set(id, target.replace(/^\//, ''))
    }
  }
  const sheets: XlsxSheet[] = []
  const wbXml = files['xl/workbook.xml'] !== undefined ? decode(files['xl/workbook.xml']) : ''
  const sheetRe = /<sheet[^>]*>/g
  let sm: RegExpExecArray | null
  while ((sm = sheetRe.exec(wbXml)) !== null) {
    const tag = sm[0]
    const name = tag.match(/name="([^"]*)"/)?.[1] ?? `Sheet ${sheets.length + 1}`
    const rid = tag.match(/r:id="([^"]*)"/)?.[1] ?? ''
    const target = relTargets.get(rid)
    let entry: string | undefined
    if (target) {
      entry = target.startsWith('xl/') ? target : `xl/${target.replace(/^\.\//, '')}`
    }
    if (!entry || files[entry] === undefined) {
      // 兜底：按序号猜 worksheets/sheetN.xml
      entry = `xl/worksheets/sheet${sheets.length + 1}.xml`
    }
    const ws = files[entry]
    if (ws === undefined) continue
    const rows = parseWorksheet(decode(ws), shared)
    if (rows.length > 0) sheets.push({ name: xmlUnescape(name), rows })
  }
  if (sheets.length === 0) {
    throw new Error('xlsx 中未提取到任何数据行（xl/worksheets/sheet*.xml 缺失或全空）')
  }
  const parts = sheets.map((s) => [`## ${s.name}`, rowsToTable(s.rows)].filter(Boolean).join('\n\n'))
  return parts.join('\n\n') + '\n'
}

// ---------------------------------------------------------------------------
// ODF（odt / ods / odp）
// ---------------------------------------------------------------------------

/** ODF content.xml → markdown（文本 / 表格 / 演示页三种 body 各自处理） */
export async function odfToMarkdown(filePath: string, kind: 'text' | 'spreadsheet' | 'presentation'): Promise<string> {
  const files = await readZip(filePath, `od${kind[0]}`)
  const content = files['content.xml']
  if (content === undefined) {
    throw new Error('ODF 文件中缺少 content.xml（文件可能损坏）')
  }
  const $ = cheerio.load(decode(content), { xmlMode: true })
  const parts: string[] = []

  const cellText = (cell: cheerio.Element): string => {
    const ps: string[] = []
    $(cell)
      .find('text\\:p')
      .each((_, p) => {
        const t = $(p).text().replace(/\s+/g, ' ').trim()
        if (t) ps.push(t)
      })
    return ps.join(' ')
  }

  if (kind === 'spreadsheet') {
    // office:spreadsheet → table:table 列表
    $('table\\:table').each((_, table) => {
      const name = $(table).attr('table:name') ?? ''
      const rows: string[][] = []
      $(table)
        .find('table\\:table-row')
        .each((_, tr) => {
          const cells: string[] = []
          const repeated = Number($(tr).attr('table:number-rows-repeated') ?? '1')
          $(tr)
            .children('table\\:table-cell')
            .each((_, tc) => {
              const colRepeat = Number($(tc).attr('table:number-columns-repeated') ?? '1')
              const text = cellText(tc as cheerio.Element)
              for (let i = 0; i < Math.min(colRepeat, 50); i++) cells.push(text)
            })
          if (cells.some((c) => c)) {
            const capped = rows.length + repeated > XLSX_MAX_ROWS ? 1 : repeated
            for (let i = 0; i < capped; i++) rows.push(cells)
          }
          if (rows.length >= XLSX_MAX_ROWS) return false
        })
      if (rows.length > 0) {
        parts.push([name ? `## ${name}` : '', rowsToTable(rows)].filter(Boolean).join('\n\n'))
      }
    })
  } else if (kind === 'presentation') {
    // draw:page 逐页
    let pageNo = 0
    $('draw\\:page').each((_, page) => {
      pageNo++
      const lines: string[] = []
      $(page)
        .find('text\\:h, text\\:p')
        .each((__, el) => {
          const tag = (el as cheerio.Element).tagName ?? ''
          const t = $(el).text().replace(/\s+/g, ' ').trim()
          if (!t) return
          if (tag === 'text:h') lines.push(`**${t}**`)
          else lines.push(t)
        })
      if (lines.length > 0) parts.push([`## 第 ${pageNo} 页`, lines.join('\n\n')].join('\n\n'))
    })
  } else {
    // office:text → 标题层级 + 段落 + 列表
    const root = $('office\\:text').length > 0 ? $('office\\:text') : $.root()
    const walk = (nodes: cheerio.Element[]): void => {
      nodes.forEach((el) => {
        const tag = (el as cheerio.Element).tagName ?? ''
        const t = $(el).text().replace(/\s+/g, ' ').trim()
        if (tag === 'text:h') {
          if (t) parts.push('# ' + t)
        } else if (tag === 'text:p') {
          if (t) parts.push(t)
        } else if (tag === 'text:list' || tag === 'list') {
          const items: string[] = []
          $(el)
            .find('text\\:list-item text\\:p')
            .each((_, p) => {
              const it = $(p).text().replace(/\s+/g, ' ').trim()
              if (it) items.push(`- ${it}`)
            })
          if (items.length > 0) parts.push(items.join('\n'))
        } else if (tag === 'table:table') {
          const rows: string[][] = []
          $(el)
            .find('table\\:table-row')
            .each((_, tr) => {
              const cells: string[] = []
              $(tr)
                .children('table\\:table-cell')
                .each((_, tc) => cells.push(cellText(tc as cheerio.Element)))
              if (cells.some((c) => c)) rows.push(cells)
            })
          if (rows.length > 0) parts.push(rowsToTable(rows))
        }
      })
    }
    const kids: cheerio.Element[] = []
    root.children().each((_, c) => kids.push(c as cheerio.Element))
    walk(kids)
  }

  if (parts.length === 0) {
    throw new Error(`ODF 文档中未提取到文本（od${kind[0]} 可能是纯图形文档，建议改用 MinerU 引擎解析）`)
  }
  return parts.filter((p) => p.trim()).join('\n\n') + '\n'
}
