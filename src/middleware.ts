/**
 * 管理面 API 鉴权中间件（审计 F-E2E-01 🔴 P0：管理面 API 全链路无鉴权——任意可达者可删库/取 Key/改设置）
 *
 * 保护范围：/api/** 全部管理端点（kb / documents / apikeys / system / qdrant / dashboard /
 *           metrics / activity / dify …）
 * 豁免清单（各有独立鉴权或本就公开）：
 *   - /api/auth/**      面板登录鉴权本身
 *   - /api/input/**     入库 API（Bearer API Key 鉴权，供 AI/MCP 调用；含公开文档 /api/input/docs）
 *   - /v1/**            Dify 兼容层（Bearer dataset Key，MinerU 面板导出直连）
 *   - 非 /api 路径       页面与静态资源（SPA 登录遮罩在前端呈现）
 *
 * 会话校验：HttpOnly Cookie panel_session = `${exp}.${HMAC(db/.panel.secret)}`（nodejs runtime，
 * 密钥文件读取 + globalThis 缓存，见 src/lib/rag/panel-auth.ts）。
 *
 * 注意：Next.js middleware 需显式声明 nodejs runtime（Next 16 稳定支持）以使用 node:crypto / fs。
 */
import { NextRequest, NextResponse } from 'next/server'
import { PANEL_SESSION_COOKIE, verifySessionToken } from '@/lib/rag/panel-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 无需面板会话即可访问的 API 前缀（各有独立鉴权或公开文档） */
const PUBLIC_API_PREFIXES = ['/api/auth', '/api/input']

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (!pathname.startsWith('/api/')) return NextResponse.next()
  if (PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next()
  }

  const token = req.cookies.get(PANEL_SESSION_COOKIE)?.value
  if (await verifySessionToken(token)) return NextResponse.next()

  return NextResponse.json(
    { error: '面板未登录或会话已过期，请先登录', code: 'PANEL_AUTH_REQUIRED' },
    { status: 401 },
  )
}

export const config = {
  matcher: '/api/:path*',
}
