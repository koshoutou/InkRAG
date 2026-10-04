/**
 * 安全解压（审计 F-LOC-01 🔴 + F-EXT-06 🟡：unzipSync 同步解压 + 无解压炸弹防护——
 * 高压缩比 zip（200MB → 数 GB）会 OOM 且同步解压期间冻结整个事件循环：HTTP/tick/心跳全停）
 *
 * 两层防护：
 * ① 异步解压（fflate unzip 回调版）：不再阻塞事件循环
 * ② 解压预算（在 fflate filter 回调中于「解压前」读取条目 originalSize 预检，超预算直接拒绝）：
 *    - 条目数上限 5,000
 *    - 单条目解压后上限 256MB
 *    - 累计解压后总量上限 512MB
 *    任一超限 → 抛 ZIP_BUDGET_EXCEEDED（调用方按不可重试业务错误处理，不白烧重试次数）
 *
 * 预算在解压前判定，zip 炸弹不会真正展开到内存（fflate filter 返回 false 即跳过该条目）。
 */
import { unzip, type UnzipFileInfo, type Unzipped } from 'fflate'

export const ZIP_MAX_ENTRIES = 5_000
export const ZIP_MAX_SINGLE_BYTES = 256 * 1024 * 1024
export const ZIP_MAX_TOTAL_BYTES = 512 * 1024 * 1024

export class ZipBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZIP_BUDGET_EXCEEDED'
  }
}

/** 预算信息（供日志/排查） */
export interface ZipBudgetStats {
  entries: number
  totalOriginalBytes: number
}

/**
 * 带预算的异步解压。data 必须先通过 zip 魔数校验（PK）。
 * 返回解压结果与预算统计；超预算抛 ZipBudgetError（不部分返回，防止半真半假的产物）。
 */
export function safeUnzip(
  data: Uint8Array,
  opts?: { maxEntries?: number; maxSingleBytes?: number; maxTotalBytes?: number }
): Promise<{ files: Unzipped; stats: ZipBudgetStats }> {
  const maxEntries = opts?.maxEntries ?? ZIP_MAX_ENTRIES
  const maxSingle = opts?.maxSingleBytes ?? ZIP_MAX_SINGLE_BYTES
  const maxTotal = opts?.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES

  let entries = 0
  let totalOriginal = 0
  let violation: string | null = null

  return new Promise<{ files: Unzipped; stats: ZipBudgetStats }>((resolve, reject) => {
    unzip(
      data,
      {
        // filter 在每个条目「解压前」调用——预算超限时返回 false 跳过展开（炸弹不进内存），
        // 记录违例后统一在完成时抛错（从 filter 内直接抛会破坏 fflate 内部状态机）
        filter: (file: UnzipFileInfo) => {
          entries += 1
          const single = file.originalSize ?? file.size ?? 0
          if (single > maxSingle) {
            violation = `单条目解压后 ${fmtMB(single)} 超过上限 ${fmtMB(maxSingle)}（条目 ${file.name.slice(0, 80)}）`
            return false
          }
          totalOriginal += single
          if (totalOriginal > maxTotal) {
            violation = `累计解压量 ${fmtMB(totalOriginal)} 超过上限 ${fmtMB(maxTotal)}`
            return false
          }
          if (entries > maxEntries) {
            violation = `条目数 ${entries} 超过上限 ${maxEntries}`
            return false
          }
          return true
        },
      },
      (err, unzipped) => {
        if (violation) {
          reject(new ZipBudgetError(`zip 解压预算超限（疑似 zip 炸弹或异常产物）：${violation}`))
          return
        }
        if (err) {
          reject(err)
          return
        }
        resolve({ files: unzipped, stats: { entries, totalOriginalBytes: totalOriginal } })
      }
    )
  })
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
