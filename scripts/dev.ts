/**
 * 开发服务器启动器（默认端口 2607，可用 PANEL_PORT 覆盖）
 *
 * 为什么需要包装器：`next dev -p ${PANEL_PORT:-2607}` 的 shell 展开读不到 .env（bash 不加载 .env），
 * 而 bun 运行本脚本时会自动把 .env 注入 process.env —— 因此「仓库默认 2607 / 本地想换端口只改 .env」
 * 两个诉求可以同时成立（例如开发沙盒在 .env 写 PANEL_PORT=3000 即可保持 3000）。
 *
 * 行为与原 `next dev -p 3000 2>&1 | tee dev.log` 完全一致：
 *   - stdout/stderr 原样转发到控制台，并写入 dev.log（覆盖式）
 *   - Ctrl+C / SIGTERM 转发给子进程，退出码透传
 */
import path from 'node:path'

const PORT = String(process.env.PANEL_PORT || '2607')
const ROOT = path.resolve(import.meta.dir, '..')
const NEXT_BIN = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')

const proc = Bun.spawn({
  cmd: [process.execPath.includes('bun') ? 'node' : 'node', NEXT_BIN, 'dev', '-p', PORT],
  cwd: ROOT,
  stdout: 'pipe',
  stderr: 'pipe',
  env: process.env as unknown as Record<string, string>,
})

// 双写：控制台 + dev.log（与 tee 语义一致，启动时覆盖旧日志）
const logWriter = Bun.file(path.join(ROOT, 'dev.log')).writer()
async function pump(stream: ReadableStream<Uint8Array> | undefined, out: (c: Uint8Array) => void) {
  if (!stream) return
  try {
    for await (const chunk of stream) out(chunk)
  } catch {
    /* 流关闭竞态时静默 */
  }
}
void pump(proc.stdout, (c) => {
  process.stdout.write(c)
  void logWriter.write(c)
})
void pump(proc.stderr, (c) => {
  process.stderr.write(c)
  void logWriter.write(c)
})

const shutdown = (sig: string) => {
  proc.kill(sig as 'SIGTERM' | 'SIGINT')
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

const exitCode = await proc.exited
// FileSink.end() 在不同 Bun 版本返回 Promise 或 void——统一 try/await 包裹
try {
  await logWriter.end()
} catch {
  /* 收尾失败不影响退出码 */
}
process.exit(exitCode ?? 0)
