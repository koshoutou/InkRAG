/**
 * 面板访问鉴权路由（审计 F-E2E-01 🔴）
 *
 * 端点（catch-all /api/auth/[...action]）：
 *   POST /api/auth/login    { password } → 会话 Cookie（HttpOnly 12h）；防爆破限流 5 次/30s
 *   POST /api/auth/logout   → 清除会话 Cookie
 *   GET  /api/auth/session  → { authenticated, defaultPassword }（前端决定是否显示登录遮罩与默认密码提示）
 *   POST /api/auth/password { current, next } → 修改面板密码（需已登录）
 *   GET  /api/auth/events-ticket → socket.io 握手票据（需已登录）
 *
 * 密码存储：PanelAuth 单行（scrypt + 盐）；首次访问播种默认密码 koshoutou。
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recordOp } from '@/lib/rag/oplog'
import {
  DEFAULT_PANEL_PASSWORD,
  PANEL_SESSION_COOKIE,
  SESSION_TTL_MS,
  createEventsTicket,
  createSessionToken,
  hashPassword,
  loginLockRemaining,
  recordLoginFail,
  recordLoginSuccess,
  verifyPassword,
  verifySessionToken,
} from '@/lib/rag/panel-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ action?: string[] }> }

/** 读取（或播种）面板密码行 */
async function getPasswordRow() {
  let row = await db.panelAuth.findUnique({ where: { id: 'default' } })
  if (!row) {
    const seeded = hashPassword(DEFAULT_PANEL_PASSWORD)
    row = await db.panelAuth.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default', passwordHash: seeded.hash, passwordSalt: seeded.salt },
    })
    recordOp({
      level: 'info',
      category: 'auth',
      action: 'auth.panel_seeded',
      message: '面板访问密码未初始化，已播种默认密码（请在设置中修改）',
    })
  }
  return row
}

function clientIp(req: NextRequest): string {
  // Caddy 网关转发 X-Real-IP / X-Forwarded-For；直连时回退 'local'
  return (
    req.headers.get('x-real-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'local'
  )
}

/** 会话 Cookie 通用属性（HttpOnly + SameSite=Lax + 12h） */
function sessionCookie(token: string) {
  return {
    name: PANEL_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { action } = await ctx.params
  const kind = action?.[0] ?? ''
  try {
    if (kind === 'login') return await handleLogin(req)
    if (kind === 'logout') return handleLogout()
    if (kind === 'password') return await handlePasswordChange(req)
    return NextResponse.json({ error: '未知鉴权操作' }, { status: 404 })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

async function handleLogin(req: NextRequest) {
  const ip = clientIp(req)
  const locked = loginLockRemaining(ip)
  if (locked > 0) {
    return NextResponse.json({ error: `失败次数过多，已锁定 ${locked} 秒后再试` }, { status: 429 })
  }
  const body = await req.json().catch(() => ({}))
  const password = typeof body.password === 'string' ? body.password : ''
  if (!password) return NextResponse.json({ error: '请输入密码' }, { status: 400 })

  const row = await getPasswordRow()
  if (!verifyPassword(password, row.passwordSalt, row.passwordHash)) {
    recordLoginFail(ip)
    recordOp({
      level: 'warn',
      category: 'auth',
      action: 'auth.panel_login_failed',
      message: `面板登录失败（IP ${ip}）`,
    })
    return NextResponse.json({ error: '密码错误' }, { status: 401 })
  }

  recordLoginSuccess(ip)
  const { token } = await createSessionToken()
  recordOp({
    level: 'info',
    category: 'auth',
    action: 'auth.panel_login',
    message: '面板登录成功',
    detail: { ip },
  })
  const res = NextResponse.json({ ok: true })
  res.cookies.set(sessionCookie(token))
  return res
}

function handleLogout() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set({ name: PANEL_SESSION_COOKIE, value: '', httpOnly: true, path: '/', maxAge: 0 })
  recordOp({ level: 'info', category: 'auth', action: 'auth.panel_logout', message: '面板登出' })
  return res
}

async function handlePasswordChange(req: NextRequest) {
  // 需已登录（middleware 已放行 /api/auth/*，这里自行校验会话）
  const token = req.cookies.get(PANEL_SESSION_COOKIE)?.value
  if (!(await verifySessionToken(token))) {
    return NextResponse.json({ error: '面板未登录' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({}))
  const current = typeof body.current === 'string' ? body.current : ''
  const next = typeof body.next === 'string' ? body.next : ''
  if (next.length < 6 || next.length > 64) {
    return NextResponse.json({ error: '新密码长度需在 6-64 位之间' }, { status: 400 })
  }
  const row = await getPasswordRow()
  if (!verifyPassword(current, row.passwordSalt, row.passwordHash)) {
    return NextResponse.json({ error: '当前密码错误' }, { status: 401 })
  }
  const hashed = hashPassword(next)
  await db.panelAuth.update({
    where: { id: 'default' },
    data: { passwordHash: hashed.hash, passwordSalt: hashed.salt },
  })
  // 改密后换发新会话（语义清晰：旧 Cookie 继续有效但建议以新会话为准）
  const { token: newToken } = await createSessionToken()
  recordOp({
    level: 'warn',
    category: 'auth',
    action: 'auth.panel_password_changed',
    message: '面板访问密码已修改',
  })
  const res = NextResponse.json({ ok: true })
  res.cookies.set(sessionCookie(newToken))
  return res
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { action } = await ctx.params
  const kind = action?.[0] ?? ''
  try {
    const token = req.cookies.get(PANEL_SESSION_COOKIE)?.value
    const authenticated = await verifySessionToken(token)

    if (kind === 'events-ticket') {
      if (!authenticated) {
        return NextResponse.json({ error: '面板未登录' }, { status: 401 })
      }
      const { ticket, exp } = await createEventsTicket()
      return NextResponse.json({ ticket, exp })
    }
    if (kind === 'session') {
      // 附带是否仍为默认密码（提示用户修改）
      let defaultPassword = false
      if (authenticated) {
        const row = await db.panelAuth.findUnique({ where: { id: 'default' } })
        if (row) defaultPassword = verifyPassword(DEFAULT_PANEL_PASSWORD, row.passwordSalt, row.passwordHash)
      }
      return NextResponse.json({ authenticated, defaultPassword })
    }
    return NextResponse.json({ error: '未知鉴权查询' }, { status: 404 })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
