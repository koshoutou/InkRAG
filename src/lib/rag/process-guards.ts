/**
 * 进程级异常兜底钩子（仅 Node.js runtime 加载，Edge 编译不包含——见 instrumentation.ts）
 *
 * F-CONC-15 + A10 修正：
 * - unhandledRejection：仅记录，不退出（Promise 漏网可隔离，进程状态通常仍一致）
 * - uncaughtException：记录后退出（exit 1），交由外部 supervisor（systemd / pm2 / docker
 *   restart）拉起。Node.js 官方明确不建议在 uncaughtException 后继续服务——进程可能处于
 *   不一致状态（堆损坏 / 半写文件），继续响应可能放大损坏。
 *   可忽略的非致命错误（EPIPE / ECONNRESET / ERR_CRYPTO_* 等 I/O 中断）不退出，
 *   避免被客户端断连拖垮进程。
 */
import { recordOp } from './oplog'

const seen = new Set<string>()

/** 可忽略的非致命错误（客户端断连 / I/O 中断等，进程状态仍一致，无需退出） */
const IGNORABLE_ERROR_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_CRYPTO_STREAM_NOT_OPERATION',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_DESTROYED',
])

function isIgnorable(err: Error): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return Boolean(code && IGNORABLE_ERROR_CODES.has(code))
}

function record(kind: string, e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e))
  const key = `${kind}:${err.message}`
  // 同类错误 60s 内只记一次（防钩子自身异常引发循环）
  if (seen.has(key)) return
  seen.add(key)
  setTimeout(() => seen.delete(key), 60_000).unref?.()
  console.error(`[process-guards] ${kind}:`, err)
  try {
    recordOp({
      level: 'error',
      category: 'system',
      action: `process.${kind}`,
      message: `进程级未捕获异常（${kind}）：${err.message}`,
      detail: { stack: err.stack?.slice(0, 4000) },
    })
  } catch {
    /* oplog 自身失败时静默（不得抛出） */
  }
}

export function installProcessGuards(): void {
  // Promise 漏网：隔离于 microtask，进程状态通常仍一致 → 记录不退出
  process.on('unhandledRejection', (reason) => record('unhandledRejection', reason))

  // 同步未捕获异常：进程可能处于不一致状态 → 记录后退出（A10 修正）
  // 可忽略的 I/O 中断（EPIPE / ECONNRESET 等）不退出，避免被客户端断连拖垮
  process.on('uncaughtException', (err) => {
    record('uncaughtException', err)
    if (isIgnorable(err instanceof Error ? err : new Error(String(err)))) {
      console.warn('[process-guards] 可忽略的 I/O 错误，进程继续运行：', (err as Error).message)
      return
    }
    console.error('[process-guards] 不可恢复的 uncaughtException，1s 后退出（交由 supervisor 重启）')
    // 留 1s 让 oplog / 日志刷新落盘，再退出
    setTimeout(() => process.exit(1), 1_000).unref?.()
  })

  console.log('[process-guards] 全局异常兜底钩子已安装（uncaughtException 致命错误将退出进程）')
}
