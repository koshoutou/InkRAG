/**
 * MHTML / MHT（MIME HTML 单文件网页）→ markdown（Task 14-e —— Node 引擎扩展类型）
 *
 * 流程（自实现 MIME multipart 解析，无外部依赖）：
 *   ① 解析文件头（折叠行合并）→ Content-Type boundary
 *   ② 按 --boundary 切分 part；每 part 头（Content-Type / Content-Transfer-Encoding / Charset）
 *   ③ 取第一个 text/html part（base64 / quoted-printable 解码 → 按 charset 解码）
 *   ④ htmlToMarkdown 主内容清洗（复用共享清洗器）
 * 无 html part 时取第一个 text/plain part 兜底。
 */
import { promises as fs } from 'node:fs'
import { htmlToMarkdown, cleanMarkdownText } from './html-clean'

interface MimeHeaders {
  get(name: string): string | undefined
}

/** 解析 MIME 头块（头部行以空行结束；折叠行以空白开头续行） */
function parseHeaders(block: string): MimeHeaders {
  const map = new Map<string, string>()
  const lines = block.split(/\r?\n/)
  let curName: string | null = null
  for (const line of lines) {
    if (/^[ \t]/.test(line) && curName) {
      map.set(curName, (map.get(curName) ?? '') + ' ' + line.trim())
      continue
    }
    const idx = line.indexOf(':')
    if (idx > 0) {
      curName = line.slice(0, idx).trim().toLowerCase()
      map.set(curName, line.slice(idx + 1).trim())
    } else if (line.trim().length === 0) {
      curName = null
    }
  }
  return {
    get: (name: string) => map.get(name.toLowerCase()),
  }
}

/** quoted-printable 解码（=XX；行尾 = 软换行） */
function decodeQuotedPrintable(s: string): Uint8Array {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '=' && i + 2 < s.length + 1) {
      if (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n')) {
        // 软换行：跳过
        i += s[i + 1] === '\r' ? 2 : 1
        continue
      }
      const hex = s.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
    }
    // ASCII 直传（其余按 latin1 字节）
    bytes.push(ch.charCodeAt(0) & 0xff)
  }
  return new Uint8Array(bytes)
}

function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '')
  try {
    return new Uint8Array(Buffer.from(clean, 'base64'))
  } catch {
    return new Uint8Array(0)
  }
}

/** 字节按 charset 解码（默认 utf-8；兼容 gbk/gb2312/big5/shift_jis 等标签） */
function decodeCharset(bytes: Uint8Array, charset?: string): string {
  let cs = (charset ?? '').split('"')[0].trim().toLowerCase()
  if (!cs || cs === 'utf8') cs = 'utf-8'
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

export async function mhtmlToMarkdown(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, 'latin1')
  if (raw.length === 0) throw new Error('mhtml 文件为空')
  // 文件头（首个空行前）+ 邮件体
  const headerEnd = raw.search(/\r?\n\r?\n/)
  if (headerEnd < 0) throw new Error('mhtml 文件缺少头部（格式不合法）')
  const fileHeaders = parseHeaders(raw.slice(0, headerEnd))
  const sepMatch = raw.slice(headerEnd).match(/^(\r?\n)\r?\n/)
  const body = sepMatch ? raw.slice(headerEnd + sepMatch[0].length) : raw.slice(headerEnd)

  const contentType = fileHeaders.get('content-type') ?? ''
  const boundaryMatch = contentType.match(/boundary\s*=\s*"?([^";\s]+)"?/i)
  if (!contentType.includes('multipart') || !boundaryMatch) {
    throw new Error('mhtml 缺少 multipart boundary（格式不合法或扩展名伪装）')
  }
  const boundary = boundaryMatch[1]

  // 切分 part：--boundary 起，--boundary-- 止
  const parts = body.split('--' + boundary)
  let htmlPart: { body: string; headers: MimeHeaders } | null = null
  let plainPart: { body: string; headers: MimeHeaders } | null = null
  for (const seg of parts) {
    const piece = seg.replace(/^\r?\n/, '')
    if (!piece.trim() || piece.trim() === '--') continue
    const sep = piece.search(/\r?\n\r?\n/)
    if (sep < 0) continue
    const partHeaders = parseHeaders(piece.slice(0, sep))
    const partSepMatch = piece.slice(sep).match(/^(\r?\n)\r?\n/)
    let partBody = partSepMatch ? piece.slice(sep + partSepMatch[0].length) : piece.slice(sep)
    // 去掉结尾的 boundary 前缀残留
    partBody = partBody.replace(/\r?\n$/, '')
    const ct = (partHeaders.get('content-type') ?? '').toLowerCase()
    if (ct.includes('text/html') && !htmlPart) {
      htmlPart = { body: partBody, headers: partHeaders }
    } else if (ct.includes('text/plain') && !plainPart) {
      plainPart = { body: partBody, headers: partHeaders }
    }
  }

  const target = htmlPart ?? plainPart
  if (!target) {
    throw new Error('mhtml 中未找到 text/html 或 text/plain 内容块')
  }
  const cte = (target.headers.get('content-transfer-encoding') ?? '').toLowerCase()
  const charset = target.headers.get('content-type')?.match(/charset\s*=\s*"?([^";\s]+)"?/i)?.[1]
  let bytes: Uint8Array
  if (cte.includes('base64')) {
    bytes = decodeBase64(target.body)
  } else if (cte.includes('quoted-printable')) {
    bytes = decodeQuotedPrintable(target.body)
  } else {
    // 7bit/8bit/binary：latin1 逐字节还原
    bytes = new Uint8Array(target.body.length)
    for (let i = 0; i < target.body.length; i++) bytes[i] = target.body.charCodeAt(i) & 0xff
  }
  const text = decodeCharset(bytes, charset)
  if (htmlPart) {
    const md = htmlToMarkdown(text)
    if (md.trim().length === 0) throw new Error('mhtml 主内容抽取结果为空')
    return md
  }
  const md = cleanMarkdownText(text)
  if (md.trim().length === 0) throw new Error('mhtml 文本内容为空')
  return md
}
