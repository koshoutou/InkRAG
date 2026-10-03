/**
 * 超大 PDF 自动拆分（Task 16-b）
 *
 * 背景：MinerU 对单文件有页数/体积硬限制——官方云·精准 v4：200MB / 200 页；
 * 官方云·Agent 轻量：10MB / 20 页；自部署 V1 无硬限制（由部署方配置决定）。
 * 超限文件直接提交会收到 nonRetryable 业务错误（-60004/-60005/-30001/-30003 等）。
 *
 * 方案：提交前用 pdf-lib（唯一可写 PDF 库；pdfjs-dist 只读）把 PDF 按页切成
 * 若干段（段文件直写 {doc}/parts/，不在内存持有全部段），逐段提交 MinerU
 * （每段独立远端任务，断点续传粒度 = 段），全部完成后下载各段产物并合并
 * （markdown 顺序拼接 + middle.json 页码/字符偏移按段平移）。
 *
 * 每段页数决策（planPdfSplit，mineru.ts）：
 *   1) 用户配置 mineruPdfPartPages > 0 → 直接采用（显式优先）
 *   2) 否则取 Provider 默认（cloud 200 / cloud-agent 20 / selfhost 0=不拆）
 *   3) 体积约束：fileSize 超 Provider 体积上限时，按页密度折算
 *      floor(总页数 × 体积上限 / fileSize × 0.9) 与页数上限取小（下限 1）
 */

import { PDFDocument } from 'pdf-lib'

/** 各 Provider 单文件硬限制（页数 / 字节；0 = 无限制） */
export const MINERU_PART_LIMITS: Record<
  string,
  { pages: number; bytes: number; label: string }
> = {
  cloud: { pages: 200, bytes: 200 * 1024 * 1024, label: '官方云·精准 200MB / 200 页' },
  'cloud-agent': { pages: 20, bytes: 10 * 1024 * 1024, label: '官方云·轻量 10MB / 20 页' },
  selfhost: { pages: 0, bytes: 0, label: '自部署（无默认限制）' },
}

/** 段文件命名（与 mineru.ts 提交/续传共用；padStart 保证字典序 = 段序） */
export function pdfPartFileName(index: number): string {
  return `part-${String(index).padStart(4, '0')}.pdf`
}

/** 读取 PDF 页数（损坏/加密文件抛带上下文的 Error） */
export async function countPdfPages(filePath: string): Promise<number> {
  const { promises: fs } = await import('node:fs')
  let buf: Buffer
  try {
    buf = await fs.readFile(filePath)
  } catch (e) {
    throw new Error(`读取 PDF 失败: ${(e as Error).message}`)
  }
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false })
    return doc.getPageCount()
  } catch (e) {
    throw new Error(`PDF 结构解析失败（可能已损坏或加密）: ${(e as Error).message}`)
  }
}

/**
 * 按每段页数拆分 PDF，段文件直写 outDir（part-0000.pdf / part-0001.pdf / …）。
 * @returns 段元信息（页范围；不持有字节缓冲）
 */
export async function splitPdfToParts(
  filePath: string,
  pagesPerPart: number,
  outDir: string
): Promise<{ total: number; parts: Array<{ index: number; pageFrom: number; pageTo: number }> }> {
  const { promises: fs } = await import('node:fs')
  const buf = await fs.readFile(filePath)
  const src = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false })
  const total = src.getPageCount()
  if (pagesPerPart < 1) throw new Error('每段页数必须 ≥ 1')
  await fs.mkdir(outDir, { recursive: true })
  const parts: Array<{ index: number; pageFrom: number; pageTo: number }> = []
  for (let from = 1; from <= total; from += pagesPerPart) {
    const to = Math.min(from + pagesPerPart - 1, total)
    const out = await PDFDocument.create()
    const indices = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i)
    const copied = await out.copyPages(src, indices)
    for (const p of copied) out.addPage(p)
    const bytes = Buffer.from(await out.save({ useObjectStreams: true }))
    await fs.writeFile(`${outDir}/${pdfPartFileName(parts.length)}`, bytes)
    parts.push({ index: parts.length, pageFrom: from, pageTo: to })
  }
  return { total, parts }
}
