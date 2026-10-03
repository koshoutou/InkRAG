/**
 * Next.js instrumentation（Task 17-5）
 *
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
