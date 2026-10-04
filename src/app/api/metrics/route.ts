import { NextRequest, NextResponse } from 'next/server'
import { renderPrometheus } from '@/lib/rag/metrics'
import { PANEL_SESSION_COOKIE, verifySessionToken } from '@/lib/rag/panel-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/metrics —— Prometheus 文本格式（text/plain; version=0.0.4）
 * scrape 配置示例：- job_name: rag, static_configs: [{ targets: ["host:2607"] }], metrics_path: /api/metrics
 *
 * 鉴权（A03 修复）：middleware 已豁免本路由，路由内独立校验，按优先级放行：
 *   1) 配置了 METRICS_SCRAPE_TOKEN 环境变量时，必须携带匹配的 ?token=xxx 或
 *      Authorization: Bearer xxx（Prometheus 抓取场景，避免未授权者读取运行计数）
 *   2) 已登录面板会话（panel_session Cookie 有效）——面板内查看也放行
 *   3) 未配置 METRICS_SCRAPE_TOKEN 且无面板会话 → 401（不再无条件公开指标）
 *
 * 推荐生产部署：在 .env 注入 METRICS_SCRAPE_TOKEN（32 位随机串），Prometheus job 配置
 * bearer_token 或 params.token，即可既不暴露指标给未授权者，又不影响面板内查看。
 */
function extractScrapeToken(req: NextRequest): string | null {
  const fromQuery = req.nextUrl.searchParams.get('token')?.trim()
  if (fromQuery) return fromQuery
  const auth = req.headers.get('authorization')?.trim()
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return null
}

function scrapeTokenConfigured(): string | null {
  const t = process.env.METRICS_SCRAPE_TOKEN?.trim()
  return t && t.length >= 16 ? t : null
}

export async function GET(req: NextRequest) {
  // 鉴权：scrape token 命中 或 面板会话有效 才放行
  const expectedToken = scrapeTokenConfigured()
  const providedToken = extractScrapeToken(req)
  const tokenOk = expectedToken && providedToken && expectedToken === providedToken
  const sessionOk = await verifySessionToken(req.cookies.get(PANEL_SESSION_COOKIE)?.value)
  if (!tokenOk && !sessionOk) {
    return new NextResponse(
      '# 401: metrics 需要 scrape token（?token= 或 Authorization: Bearer，配置 METRICS_SCRAPE_TOKEN）或面板会话\n',
      {
        status: 401,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      },
    )
  }
  try {
    const text = await renderPrometheus()
    return new NextResponse(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return new NextResponse(`# 渲染失败: ${e?.message ?? String(e)}\n`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}
