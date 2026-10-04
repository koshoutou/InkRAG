/**
 * 进程级异常兜底钩子（仅 Node.js runtime 加载，Edge 编译不包含——见 instrumentation.ts）
 * F-CONC-15：unhandledRejection / uncaughtException 记录程序日志 + console，不退出进程
 * （单机无守护进程场景保活优先；Next 路由级错误已有隔离，此处兜「漏网」异常）。
 */
import { recordOp } from './oplog'

const seen = new Set<string>()

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
  process.on('unhandledRejection', (reason) => record('unhandledRejection', reason))
  process.on('uncaughtException', (err) => record('uncaughtException', err))
  console.log('[process-guards] 全局异常兜底钩子已安装')
}
