/**
 * Next.js instrumentation
 *
 * register()（F-CONC-04/18）：服务进程启动即自启动——
 *   - 流水线引擎 ensurePipelineEngine()：此前仅靠上传/任务中心等 API 惰性触发，进程重启后
 *     若无人打开页面（仅经 MCP / /api/input / Dify 兼容层使用），waiting_mineru 与 pending
 *     任务会永久挂起（轮询器不启动）
 *   - 备份调度器 ensureScheduler() 与程序日志清理调度器 ensureOplogCleanScheduler()：
 *     此前同样惰性启动——不开对应页面 = 自动备份/日志清理不执行（审计 F-CONC-18）
 *
 * 全局异常钩子（F-CONC-15）：unhandledRejection / uncaughtException 记录程序日志
 * （category=system）+ console，不退出进程——单机无守护进程的场景下保活优先，
 * Next 路由级错误已有隔离，此处仅兜「漏网」的 Promise 拒绝与同步异常。
 *
 * onRequestError：任何路由/页面未捕获的运行时错误兜底（ProgramLog，system/api.request_error）。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // ---- 全局异常兜底（先装钩子，再启动子系统；钩子实现隔离在 process-guards.ts，
  //      避免 Edge 编译静态检查 process.on 报错）----
  try {
    const { installProcessGuards } = await import('./lib/rag/process-guards')
    installProcessGuards()
  } catch {
    /* 钩子注册失败不阻断启动 */
  }

  // ---- 子系统自启动（各自内部有异常兜底，失败仅告警不影响其他子系统）----
  try {
    const { ensurePipelineEngine } = await import('./lib/rag/pipeline')
    ensurePipelineEngine()
  } catch (e) {
    console.warn('[instrumentation] 流水线引擎自启动失败:', (e as Error).message)
  }
  try {
    const { ensureScheduler } = await import('./lib/rag/backup')
    void ensureScheduler().catch(() => {})
  } catch (e) {
    console.warn('[instrumentation] 备份调度器自启动失败:', (e as Error).message)
  }
  try {
    const { ensureOplogCleanScheduler } = await import('./lib/rag/oplog')
    void ensureOplogCleanScheduler().catch(() => {})
  } catch (e) {
    console.warn('[instrumentation] 程序日志清理调度器自启动失败:', (e as Error).message)
  }

  // ---- BE-010：优雅关闭——SIGTERM / SIGINT 时排空活跃任务再退出 ----
  // 无此处理时，docker stop / k8s rolling update 发送的 SIGTERM 会在 10s 宽限期后
  // 被 SIGKILL 强杀，正在跑的 embed / mineru 任务被粗暴中断，留下 active 僵尸任务
  // 与半写产物。本处理先 drainForShutdown（暂停新任务 + Abort 活跃 + 等待排空或超时），
  // 再 process.exit；超时仍强制退出，保证不卡死容器编排。
  let shuttingDown = false
  const shutdownHandler = (sig: 'SIGTERM' | 'SIGINT') => {
    if (shuttingDown) {
      console.log(`[instrumentation] 二次收到 ${sig}，立即强制退出`)
      process.exit(1)
    }
    shuttingDown = true
    console.log(`[instrumentation] 收到 ${sig}，开始优雅关闭（最长等待 30s）`)
    void (async () => {
      try {
        const { drainForShutdown } = await import('./lib/rag/pipeline')
        const r = await drainForShutdown(30_000)
        console.log(`[instrumentation] 优雅关闭完成（drained=${r.drained}, waitedMs=${r.waitedMs}）`)
      } catch (e) {
        console.error('[instrumentation] 优雅关闭失败:', (e as Error).message)
      } finally {
        // drained 或超时都退出；超时强制退出码 1，正常退出 0
        process.exit(0)
      }
    })()
    // 兜底硬超时：即使 drainForShutdown 卡住，35s 后也强制退出
    setTimeout(() => {
      console.error('[instrumentation] 优雅关闭硬超时 35s，强制退出')
      process.exit(1)
    }, 35_000).unref?.()
  }
  process.on('SIGTERM', () => shutdownHandler('SIGTERM'))
  process.on('SIGINT', () => shutdownHandler('SIGINT'))
}

/**
 * onRequestError：全局兜底——任何路由/页面未捕获的运行时错误都会进入这里。
 * 写入程序日志（ProgramLog，category=system，action=api.request_error），运维面板可见。
 * 以下错误已被业务路由 catch 并返回 { error } JSON 的（HTTP 4xx/5xx JSON 响应），
 * 不会走到这里；本钩子捕获的是「漏网」的未处理异常（如渲染期抛错）。
 */
export async function onRequestError(
  request: Request,
  error: Error,
  context: { routerKind: 'app' | 'routes'; routePath: string; routeType: string },
): Promise<void> {
  try {
    const { recordOp } = await import('./lib/rag/oplog')
    const url = new URL(request.url)
    recordOp({
      level: 'error',
      category: 'system',
      action: 'api.request_error',
      message: `未捕获请求错误：${error.message}`,
      detail: {
        stack: error.stack?.slice(0, 4000),
        method: request.method,
        path: url.pathname,
        routerKind: context.routerKind,
        routePath: context.routePath,
        routeType: context.routeType,
      },
      statusCode: 500,
    })
  } catch {
    // instrumentation 最早期兜底，连 oplog 都失败时静默（不得抛出）
  }
}
