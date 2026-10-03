/**
 * epub → markdown（Task 14-e —— Node 引擎扩展类型）
 *
 * 流程（OPF 规范，fflate 解包 + cheerio xmlMode）：
 *   ① META-INF/container.xml → <rootfile full-path="*.opf">
 *   ② OPF <manifest><item id href> + <spine><itemref idref> → 阅读顺序
 *   ③ 逐章读 XHTML → htmlToMarkdown（noExtract：epub 章节无站点骨架）
 *   ④ 按顺序拼接（每章首行追加书名/章节标题结构由原文 heading 保留）
 */
import { promises as fs } from 'node:fs'
import { unzipSync } from 'fflate'
import * as cheerio from 'cheerio'
import { htmlToMarkdown } from './html-clean'

export async function epubToMarkdown(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath)
  if (buf.length === 0) throw new Error('epub 文件为空')
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error('不是合法的 epub 文件（缺少 zip 容器魔数，可能扩展名伪装）')
  }
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buf)) as Record<string, Uint8Array>
  } catch (e) {
    throw new Error(`epub 解包失败：${(e as Error).message}`)
  }
  const decode = (u: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(u)

  // ① container.xml → OPF 路径
  const container = files['META-INF/container.xml']
  if (container === undefined) {
    throw new Error('epub 缺少 META-INF/container.xml（文件可能损坏）')
  }
  const opfPath = cheerio
    .load(decode(container), { xmlMode: true })('rootfile')
    .first()
    .attr('full-path')
  if (!opfPath || files[opfPath] === undefined) {
    throw new Error('epub container.xml 中未找到有效的 OPF 描述文件')
  }
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  // ② manifest + spine → 有序章节 href
  const $ = cheerio.load(decode(files[opfPath]), { xmlMode: true })
  const hrefById = new Map<string, { href: string; mediaType: string }>()
  $('manifest > item, manifest item').each((_, el) => {
    const id = $(el).attr('id')
    const href = $(el).attr('href')
    const mediaType = $(el).attr('media-type') ?? ''
    if (id && href) hrefById.set(id, { href, mediaType })
  })
  const chapterPaths: string[] = []
  $('spine > itemref, spine itemref').each((_, el) => {
    const idref = $(el).attr('idref')
    if (!idref) return
    const item = hrefById.get(idref)
    if (!item) return
    const mt = item.mediaType.toLowerCase()
    if (mt && !mt.includes('xhtml') && !mt.includes('html') && !mt.includes('xml')) return
    // zip 内路径按 OPF 相对目录解析（URL 解码 + ./ 归一）
    let p: string
    try {
      p = decodeURIComponent(new URL(item.href, 'file:///' + opfDir).pathname).replace(/^\//, '')
    } catch {
      p = opfDir + item.href
    }
    if (files[p] !== undefined) chapterPaths.push(p)
  })
  if (chapterPaths.length === 0) {
    throw new Error('epub spine 中未找到可读章节（文件可能损坏）')
  }

  // ③ 逐章转换
  const parts: string[] = []
  for (const p of chapterPaths) {
    const md = htmlToMarkdown(decode(files[p]), { noExtract: true })
    if (md.trim()) parts.push(md.trim())
  }
  if (parts.length === 0) {
    throw new Error('epub 章节中未提取到文本内容')
  }
  return parts.join('\n\n') + '\n'
}
