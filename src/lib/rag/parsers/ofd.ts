/**
 * OFD（版式文档 GB/T 33190）→ markdown（Task 14-e —— Node 引擎扩展类型，尽力而为）
 *
 * 结构（fflate 解包）：
 *   OFD.xml → <DocBody><DocRoot>Doc_0/Document.xml
 *   → Document.xml 的 <Page BaseLoc="Pages/Page_N/Content.xml">（按出现顺序）
 *   → 每 Page Content.xml 提取 <TextCode Text="…">（命名空间前缀可变，正则匹配本地名）
 *
 * 输出：每页 `## 第 N 页` + TextCode 文本逐段（OFD 无语义标题标记，标题不做特判——尽力而为，
 * 失败（结构缺失/无文本）给出明确报错并建议改用 MinerU 引擎）。
 */
import { promises as fs } from 'node:fs'
import { safeUnzip, ZipBudgetError } from './zip-safe'

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

/** 提取一个 XML 片段内全部 TextCode 的 Text 属性（文档顺序） */
function extractTextCodes(xml: string): string[] {
  const out: string[] = []
  const re = /<(?:[\w-]+:)?TextCode\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0]
    const attr = tag.match(/\sText\s*=\s*"([^"]*)"/) ?? tag.match(/\sText\s*=\s*'([^']*)'/)
    if (attr) {
      const t = xmlUnescape(attr[1]).replace(/\s+/g, ' ').trim()
      if (t) out.push(t)
    }
  }
  return out
}

export async function ofdToMarkdown(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath)
  if (buf.length === 0) throw new Error('ofd 文件为空')
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error('不是合法的 ofd 文件（缺少 zip 容器魔数，可能扩展名伪装）')
  }
  let files: Record<string, Uint8Array>
  try {
    // F-LOC-01/EXT-06：异步解压 + 解压预算
    const r = await safeUnzip(new Uint8Array(buf))
    files = r.files as Record<string, Uint8Array>
  } catch (e) {
    if (e instanceof ZipBudgetError) throw e
    throw new Error(`ofd 解包失败：${(e as Error).message}`)
  }
  const decode = (u: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(u)

  // ① OFD.xml → DocRoot
  const ofdRoot = files['OFD.xml']
  if (ofdRoot === undefined) {
    throw new Error('ofd 缺少 OFD.xml 根描述（文件可能损坏）')
  }
  const rootXml = decode(ofdRoot)
  const docRootMatch = rootXml.match(/<DocRoot>([^<]+)<\/DocRoot>/)
  const docRootPath = docRootMatch ? docRootMatch[1].trim() : ''
  let docDir = ''
  let documentXml: string | undefined
  if (docRootPath && files[docRootPath] !== undefined) {
    documentXml = decode(files[docRootPath])
    docDir = docRootPath.includes('/') ? docRootPath.slice(0, docRootPath.lastIndexOf('/') + 1) : ''
  } else {
    // 兜底：Doc_0/Document.xml
    const alt = Object.keys(files).find((k) => /^Doc_\d+\/Document\.xml$/.test(k))
    if (alt) {
      documentXml = decode(files[alt])
      docDir = alt.slice(0, alt.lastIndexOf('/') + 1)
    }
  }

  // ② Document.xml → Page BaseLoc 顺序
  const pagePaths: string[] = []
  if (documentXml) {
    const baseLocRe = /<Page\b[^>]*>/g
    let pm: RegExpExecArray | null
    while ((pm = baseLocRe.exec(documentXml)) !== null) {
      const loc = pm[0].match(/\sBaseLoc\s*=\s*"([^"]*)"/)?.[1]
      if (!loc) continue
      const p = loc.startsWith('/') ? loc.slice(1) : docDir + loc
      if (files[p] !== undefined) pagePaths.push(p)
    }
  }
  // 兜底：Doc_0/Content.xml（简化结构）或 Pages/Page_*/Content.xml 全扫
  if (pagePaths.length === 0) {
    const direct = 'Doc_0/Content.xml'
    if (files[direct] !== undefined) {
      pagePaths.push(direct)
    } else {
      for (const k of Object.keys(files)) {
        if (/^Doc_\d+\/Pages\/Page_\d+\/Content\.xml$/.test(k)) pagePaths.push(k)
      }
      pagePaths.sort((a, b) => {
        const na = Number(a.match(/Page_(\d+)/)?.[1] ?? 0)
        const nb = Number(b.match(/Page_(\d+)/)?.[1] ?? 0)
        return na - nb
      })
    }
  }
  if (pagePaths.length === 0) {
    throw new Error('ofd 中未找到页面内容（Page BaseLoc / Content.xml 缺失，建议改用 MinerU 引擎解析）')
  }

  // ③ 逐页提取
  const parts: string[] = []
  let pageNo = 0
  for (const p of pagePaths) {
    const texts = extractTextCodes(decode(files[p]))
    if (texts.length === 0) continue
    pageNo++
    parts.push([`## 第 ${pageNo} 页`, texts.join('\n\n')].join('\n\n'))
  }
  if (parts.length === 0) {
    throw new Error('ofd 页面中未提取到文本（可能是纯图形/扫描版式，建议改用 MinerU 引擎解析）')
  }
  return parts.join('\n\n') + '\n'
}
