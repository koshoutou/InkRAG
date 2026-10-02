/**
 * 旧版/遗留格式解析（Task 14-e —— Node 引擎扩展类型）
 *
 * - doc（Word 97-2003 二进制）：word-extractor（纯 JS OLE 解析，服务端动态导入）；
 *   读取失败时给出明确报错（建议转 docx 或改用 MinerU 引擎）
 * - rtf：自实现轻量解析器——
 *   {\*\…} 目标组忽略；\'hh 十六进制 ANSI 字节（连续字节流按 GBK/cp1252 智能解码）；
 *   \uN? Unicode（负数 +65536，按 \ucN 跳过替换字符）；\par/\line → 换行、\tab → 制表；
 *   其余控制字/控制符号丢弃；fonttbl/colortbl/stylesheet/info/pict 等表格组整组跳过
 */
import { promises as fs } from 'node:fs'

// ---------------------------------------------------------------------------
// doc
// ---------------------------------------------------------------------------

/** 解析 word-extractor 的 getBody 输出（\r\n 分段）为 markdown 段落 */
function docBodyToMarkdown(body: string): string {
  const paragraphs = body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trimEnd())
    .filter((l) => l.trim().length > 0)
  if (paragraphs.length === 0) return ''
  return paragraphs.join('\n\n') + '\n'
}

export async function docToMarkdown(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  if (buffer.length === 0) throw new Error('doc 文件为空')
  // OLE 复合文档魔数 D0 CF（Word 97-2003）
  if (!(buffer[0] === 0xd0 && buffer[1] === 0xcf)) {
    // word-extractor 也接受 docx（zip），但 docx 走专门解析器；扩展名伪装在此快速失败
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
      throw new Error('该文件实际是 docx（zip 容器），请改用 .docx 扩展名上传')
    }
    throw new Error('不是合法的 doc 文件（缺少 OLE 复合文档魔数，可能扩展名伪装）')
  }
  // 动态导入（服务端纯 JS 包，无类型声明 → 结构化 cast）
  const mod: any = await import('word-extractor')
  const WordExtractor = (mod.default ?? mod) as new () => {
    extract(source: Buffer): Promise<{
      getBody(options?: { includeHeadersAndFooters?: boolean }): string
    }>
  }
  try {
    const doc = await new WordExtractor().extract(buffer)
    const body = doc.getBody({ includeHeadersAndFooters: false }) ?? ''
    const markdown = docBodyToMarkdown(body)
    if (markdown.trim().length === 0) {
      throw new Error('doc 文档正文为空（可能只含图形对象，建议改用 MinerU 引擎解析）')
    }
    return markdown
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    if (msg.includes('不是合法的 doc 文件') || msg.includes('正文为空')) throw e
    throw new Error(
      `读取 .doc 失败（${msg.slice(0, 160)}）：建议将文档另存为 .docx 后重新上传，或在上传时选择 MinerU 引擎解析`
    )
  }
}

// ---------------------------------------------------------------------------
// rtf
// ---------------------------------------------------------------------------

/** 整组跳过的目标控制字（字体/颜色/样式表、文档元信息、图片、页眉页脚等） */
const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'listtable', 'listoverridetable',
  'rsidtbl', 'generator', 'latentstyles', 'xmlnstbl', 'themedata', 'colorschememapping', 'datastore',
  'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf',
  'footnote', 'annotation', 'xmlio', 'filetbl', 'faults', 'pnsecpregs', 'panose', 'list',
  'listlevel', 'listtemplate', 'revtbl', 'mmathPr', 'wgrffmtfilter', 'fldinst', 'template',
  'company', 'author', 'title', 'subject', 'keywords', 'comment', 'operator', 'creatim',
  'revtim', 'printim', 'buptim', 'edmins', 'nofchars', 'nofwords', 'id', 'vern',
])

interface RtfGroupState {
  /** 该组整体跳过（{\*\…} 或 skip 目标） */
  skip: boolean
  /** \ucN 的当前值（unicode 替换字符跳过数） */
  uc: number
  /** 组内第一个控制字（判定目标组） */
  firstWord: string | null
}

/** 连续 \'hh 字节流解码：优先尝试 GBK（双字节中文），失败回退 cp1252/latin1 */
function decodeAnsiBytes(bytes: number[]): string {
  if (bytes.length === 0) return ''
  const buf = new Uint8Array(bytes)
  // 含高字节 → 可能是 GBK 双字节序列；GBK 解码容错（非 fatal），混合低字节可读
  if (bytes.some((b) => b >= 0x80)) {
    try {
      return new TextDecoder('gbk', { fatal: false }).decode(buf)
    } catch {
      /* 环境无 GBK 解码器 → 回退 */
    }
  }
  let out = ''
  for (const b of bytes) {
    // cp1252 高位区间（0x80-0x9F 为 C1 控制符，替换为 latin1 兼容字符）
    out += b < 0x80 || b > 0x9f ? String.fromCharCode(b) : ''
  }
  return out
}

/** rtf 源 → 纯文本（段落以 \n 分隔） */
export function rtfToText(rtf: string): string {
  const stack: RtfGroupState[] = [{ skip: false, uc: 1, firstWord: null }]
  let text = ''
  let pendingBytes: number[] = []
  // unicode 替换字符待跳过计数
  let skipChars = 0

  const flushBytes = () => {
    if (pendingBytes.length > 0) {
      text += decodeAnsiBytes(pendingBytes)
      pendingBytes = []
    }
  }
  const cur = (): RtfGroupState => stack[stack.length - 1]

  let i = 0
  const n = rtf.length
  while (i < n) {
    const ch = rtf[i]
    if (ch === '{') {
      flushBytes()
      stack.push({ skip: cur().skip, uc: cur().uc, firstWord: null })
      i++
      continue
    }
    if (ch === '}') {
      flushBytes()
      if (stack.length > 1) stack.pop()
      i++
      continue
    }
    if (ch === '\\') {
      const next = rtf[i + 1]
      // \'hh 十六进制 ANSI 字节
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          if (skipChars > 0) skipChars--
          else if (!cur().skip) pendingBytes.push(parseInt(hex, 16))
          i += 4
          continue
        }
      }
      // 控制符号字面量
      if (next === '{' || next === '}' || next === '\\') {
        flushBytes()
        if (skipChars > 0) skipChars--
        else if (!cur().skip) text += next
        i += 2
        continue
      }
      if (next === '~') {
        flushBytes()
        if (skipChars > 0) skipChars--
        else if (!cur().skip) text += '\u00A0'
        i += 2
        continue
      }
      if (next === '*' ) {
        // {\*\…} 目标组标记：当前组标记为跳过（除非已在跳过组内）
        cur().skip = true
        i += 2
        // 跳过其后紧跟的空格
        if (rtf[i] === ' ') i++
        continue
      }
      // 控制字 \word[N?]
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i))
      if (m) {
        flushBytes()
        const word = m[1]
        const param = m[2] !== undefined ? Number(m[2]) : undefined
        const g = cur()
        if (g.firstWord === null) g.firstWord = word
        // 目标组判定：组首控制字在跳过清单 → 整组跳过
        if (stack.length > 1 && g.firstWord === word && RTF_SKIP_DESTINATIONS.has(word)) {
          g.skip = true
        }
        if (!g.skip) {
          if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') {
            if (skipChars > 0) skipChars--
            else text += '\n'
          } else if (word === 'tab') {
            if (skipChars > 0) skipChars--
            else text += '\t'
          } else if (word === 'u' && param !== undefined) {
            // \uN：Unicode 码点（负数 +65536）；其后 \ucN 个替换字符跳过
            if (skipChars > 0) {
              skipChars--
            } else {
              const code = param < 0 ? param + 65536 : param
              text += String.fromCodePoint(code)
              skipChars = g.uc
            }
          } else if (word === 'uc' && param !== undefined) {
            g.uc = Math.max(0, Math.min(10, param))
          } else if (skipChars > 0) {
            // 控制字本身占位一个替换字符位置（\ucN 计数含控制字）
            skipChars--
          }
        }
        i += m[0].length
        continue
      }
      // 未识别转义（如 \- \: 等）→ 丢弃
      flushBytes()
      i += 2
      continue
    }
    // 普通字符
    flushBytes()
    if (ch === '\r' || ch === '\n') {
      // RTF 规范：文件中的 CR/LF 不属于内容（读取器应忽略）；段落换行仅来自 \par/\line。
      // 不忽略会引入杂散换行（LibreOffice 会在组内控制字后直接换行：{\dbch\n\u…}）
      i++
      continue
    }
    if (skipChars > 0) {
      skipChars--
    } else if (!cur().skip) {
      text += ch
    }
    i++
  }
  flushBytes()
  return text
}

export async function rtfToMarkdown(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, 'latin1') // rtf 为 ASCII 转义协议，按字节读取
  if (raw.length === 0) throw new Error('rtf 文件为空')
  if (!raw.startsWith('{\\rtf')) {
    throw new Error('不是合法的 rtf 文件（缺少 {\\rtf 头，可能扩展名伪装）')
  }
  const text = rtfToText(raw)
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').trimEnd())
    .filter((l) => l.trim().length > 0)
  if (paragraphs.length === 0) {
    throw new Error('rtf 文档正文为空（可能只含图形对象，建议改用 MinerU 引擎解析）')
  }
  return paragraphs.join('\n\n') + '\n'
}
