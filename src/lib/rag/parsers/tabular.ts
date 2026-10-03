/**
 * csv / tsv → markdown 表格（Task 14-e —— Node 引擎扩展类型）
 *
 * - RFC 4180 引号语义：双引号字段、"" 转义、字段内换行/分隔符原样保留
 * - 首行作表头；BOM 剥离；| 转义；行列防御上限（10000 行 × 512 列）
 */
import { promises as fs } from 'node:fs'

const MAX_ROWS = 10_000
const MAX_COLS = 512

/** RFC 4180 分隔文本解析 → 行列（不闭合引号按文件结束兜底） */
export function parseDelimited(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      if (rows.length >= MAX_ROWS) break
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      if (rows.length >= MAX_ROWS) break
      continue
    }
    field += ch
    i++
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
    .map((r) => (r.length > MAX_COLS ? r.slice(0, MAX_COLS) : r))
    .filter((r) => r.some((c) => c.trim().length > 0))
}

/** 行列 → markdown 管道表格（首行表头，列数对齐） */
function rowsToTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length))
  const norm = rows.map((r) => {
    const copy = r.map((c) => c.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim())
    while (copy.length < width) copy.push('')
    return copy
  })
  const sep = '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |'
  const lines = ['| ' + norm[0].join(' | ') + ' |', sep]
  for (const r of norm.slice(1)) lines.push('| ' + r.join(' | ') + ' |')
  return lines.join('\n')
}

export async function delimitedToMarkdown(filePath: string, delimiter: ',' | '\t'): Promise<string> {
  let raw = await fs.readFile(filePath, 'utf-8')
  if (raw.length === 0) throw new Error('文件为空')
  // UTF-8 BOM
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  const rows = parseDelimited(raw, delimiter)
  if (rows.length === 0) {
    throw new Error('未解析到任何数据行（文件内容为空或全为分隔符）')
  }
  return rowsToTable(rows) + '\n'
}
