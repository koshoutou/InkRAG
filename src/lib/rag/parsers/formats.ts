/**
 * 文档类型支持矩阵（后端权威清单，Task 14-e —— 前后端保持一致）
 *
 * 三条解析链路：
 *   - 上传/URL 导入接受类型 = ALL_ACCEPTED_EXTS（入口校验）
 *   - Node 引擎（parseWithFallback）= NODE_PARSEABLE_EXTS
 *   - MinerU 引擎：cloud（官方云·精准 v4）= MINERU_CLOUD_EXTS；
 *     selfhost（自部署 V1）保守 = pdf + 图片（V1 对 Office 二进制取决于部署模型，不承诺）
 *
 * 仅 MinerU：ppt / xls / 图片×7　　仅 Node：md / txt / rtf / csv / tsv / epub / ofd /
 *   mhtml / mht / odt / ods / odp / shtml 等
 */

/** 图片类型（MinerU 云 V4 与自部署 V1 均原生支持，与 pdf 一视同仁） */
export const IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp']

/** MinerU 官方云·精准 API v4 支持类型（指南 §2.1） */
export const MINERU_CLOUD_EXTS: readonly string[] = [
  'pdf',
  ...IMAGE_EXTS,
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
]

/** MinerU 自部署 V1 保守支持类型（指南第四章：上传协议原生 pdf/图片） */
export const MINERU_SELFHOST_EXTS: readonly string[] = ['pdf', ...IMAGE_EXTS]

/** Node 引擎（内置降级解析器）支持类型 */
export const NODE_PARSEABLE_EXTS: readonly string[] = [
  'pdf',
  'docx',
  'md',
  'markdown',
  'txt',
  'html',
  'htm',
  'shtml',
  'csv',
  'tsv',
  'rtf',
  'doc',
  'pptx',
  'xlsx',
  'odt',
  'ods',
  'odp',
  'epub',
  'ofd',
  'mhtml',
  'mht',
]

/** 上传/导入入口接受的全量类型 */
export const ALL_ACCEPTED_EXTS: readonly string[] = [
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'rtf',
  'odt',
  'ods',
  'odp',
  'csv',
  'tsv',
  'epub',
  'ofd',
  'html',
  'htm',
  'shtml',
  'mhtml',
  'mht',
  'md',
  'markdown',
  'txt',
  ...IMAGE_EXTS,
]

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.includes(ext.toLowerCase())
}

/** MinerU 引擎是否支持该类型（按 provider 取矩阵） */
export function isMineruExt(ext: string, provider: 'selfhost' | 'cloud' | 'cloud-agent'): boolean {
  const e = ext.toLowerCase()
  if (provider === 'cloud' || provider === 'cloud-agent') return MINERU_CLOUD_EXTS.includes(e)
  return MINERU_SELFHOST_EXTS.includes(e)
}

/** Node 引擎是否支持该类型 */
export function isNodeExt(ext: string): boolean {
  return NODE_PARSEABLE_EXTS.includes(ext.toLowerCase())
}

/** 扩展名 → MIME（上传路由 guessMime / URL 导入内容类型映射共用） */
export function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'pdf':
      return 'application/pdf'
    case 'doc':
      return 'application/msword'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'ppt':
      return 'application/vnd.ms-powerpoint'
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case 'xls':
      return 'application/vnd.ms-excel'
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'rtf':
      return 'application/rtf'
    case 'odt':
      return 'application/vnd.oasis.opendocument.text'
    case 'ods':
      return 'application/vnd.oasis.opendocument.spreadsheet'
    case 'odp':
      return 'application/vnd.oasis.opendocument.presentation'
    case 'csv':
      return 'text/csv'
    case 'tsv':
      return 'text/tab-separated-values'
    case 'epub':
      return 'application/epub+zip'
    case 'ofd':
      return 'application/ofd'
    case 'html':
    case 'htm':
    case 'shtml':
      return 'text/html'
    case 'mhtml':
    case 'mht':
      return 'message/rfc822'
    case 'md':
    case 'markdown':
      return 'text/markdown'
    case 'txt':
      return 'text/plain'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'jp2':
      return 'image/jp2'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'application/octet-stream'
  }
}

/** MIME → 扩展名（URL 导入二进制保存时反推；未识别返回 ''） */
export function mimeToExt(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase()
  const table: Record<string, string> = {}
  for (const ext of ALL_ACCEPTED_EXTS) table[extToMime(ext)] = ext
  if (table[base]) return table[base]
  // 宽松匹配
  if (base.includes('html')) return 'html'
  if (base.includes('pdf')) return 'pdf'
  if (base === 'image/jpeg') return 'jpg'
  if (base.startsWith('image/')) return base.slice('image/'.length)
  if (base.includes('wordprocessingml')) return 'docx'
  if (base.includes('presentationml')) return 'pptx'
  if (base.includes('spreadsheetml')) return 'xlsx'
  if (base.includes('msword')) return 'doc'
  if (base.includes('ms-powerpoint')) return 'ppt'
  if (base.includes('ms-excel')) return 'xls'
  if (base.includes('opendocument.text')) return 'odt'
  if (base.includes('opendocument.spreadsheet')) return 'ods'
  if (base.includes('opendocument.presentation')) return 'odp'
  if (base.includes('epub')) return 'epub'
  if (base.includes('rtf')) return 'rtf'
  return ''
}
