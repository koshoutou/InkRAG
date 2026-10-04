/**
 * 面板访问鉴权核心（审计 F-E2E-01 🔴 P0：管理面 API 全链路无鉴权）
 *
 * 设计（轻量优先，无外部依赖）：
 * - 密码：scrypt(password, salt) 哈希存 PanelAuth 表（首次启动随机生成 32 位初始口令，
 *   落盘 db/.panel.pass 并打印 stdout，可在设置中修改——取代早期硬编码默认口令，见 A02）
 * - 会话：HttpOnly Cookie `panel_session` = `${expTs}.${HMAC-SHA256(secret, 'session:'+expTs)}`
 * - 事件票据：socket.io 握手 auth.ticket = `${expTs}.${HMAC(secret, 'events:'+expTs)}`
 *   （mini-service pipeline-events 用同一密钥文件校验，见 mini-services/pipeline-events/index.ts）
 * - emit 密钥：`x-emit-secret: HMAC(secret, 'emit')`（Next → 2609 /emit 服务间调用头）
 *
 * 密钥文件：db/.panel.secret（32 字节随机 hex，gitignore 覆盖 /db/；首次访问自动生成，
 * 跨重启稳定 → 已登录会话与事件票据不失效）。可用环境变量 PANEL_SECRET 覆盖（部署时注入）。
 *
 * 本模块刻意不依赖 Prisma（middleware nodejs runtime 只做令牌校验，密码校验在 /api/auth/* 路由内）。
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const PANEL_SESSION_COOKIE = 'panel_session'
/** 会话有效期（12h，与事件票据一致；改密后旧会话立即失效见下） */
export const SESSION_TTL_MS = 12 * 60 * 60_000

// ---------------------------------------------------------------------------
// 密钥文件（globalThis 缓存 + 文件持久化）
// ---------------------------------------------------------------------------

const secretCacheG = globalThis as unknown as { __panelSecret?: string }

function secretFilePath(): string {
  // standalone 生产模式下 cwd 为 .next/standalone，退回项目根的 db/（server.js 与 db/ 同级部署时）
  // 同时接受 PANEL_SECRET_FILE（主服务名）与 RAG_EVENTS_SECRET_FILE（mini-service 历史名），
  // 两服务共享同一密钥文件——见 A01/A07 修复说明
  return (
    process.env.PANEL_SECRET_FILE ??
    process.env.RAG_EVENTS_SECRET_FILE ??
    path.join(process.cwd(), 'db', '.panel.secret')
  )
}

/** 读取（或生成并落盘）面板密钥；环境变量 PANEL_SECRET 优先（RAG_EVENTS_SECRET 为历史兼容别名） */
export async function getPanelSecret(): Promise<string> {
  if (secretCacheG.__panelSecret) return secretCacheG.__panelSecret
  // 主服务变量名 PANEL_SECRET 优先；RAG_EVENTS_SECRET 作为历史别名兼容（与 mini-service 双向对称）
  const fromEnv = (process.env.PANEL_SECRET ?? process.env.RAG_EVENTS_SECRET)?.trim()
  if (fromEnv) {
    secretCacheG.__panelSecret = fromEnv
    return fromEnv
  }
  const file = secretFilePath()
  try {
    const existing = (await fs.readFile(file, 'utf-8')).trim()
    if (existing.length >= 32) {
      secretCacheG.__panelSecret = existing
      return existing
    }
  } catch {
    /* 不存在则生成 */
  }
  const fresh = randomBytes(32).toString('hex')
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, fresh, 'utf-8')
  } catch (e) {
    // 只读文件系统等场景：退回内存密钥（重启后会话失效，功能可用）
    console.warn('[panel-auth] 密钥文件写入失败（退回进程内密钥，重启后会话将失效）:', (e as Error).message)
  }
  secretCacheG.__panelSecret = fresh
  return fresh
}

// ---------------------------------------------------------------------------
// HMAC 令牌（session / events ticket / emit secret 三用途）
// ---------------------------------------------------------------------------

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/** 恒定时间比对两个 hex 串（长度不等直接 false） */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'))
  } catch {
    return false
  }
}

function makeToken(secret: string, purpose: string, ttlMs: number): { token: string; exp: number } {
  const exp = Date.now() + ttlMs
  return { token: `${exp}.${hmacHex(secret, `${purpose}:${exp}`)}`, exp }
}

function verifyToken(secret: string, purpose: string, token: string | undefined | null): boolean {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const expStr = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  return safeEqualHex(sig, hmacHex(secret, `${purpose}:${expStr}`))
}

/** 签发面板会话令牌（登录成功后写 HttpOnly Cookie） */
export async function createSessionToken(): Promise<{ token: string; exp: number }> {
  return makeToken(await getPanelSecret(), 'session', SESSION_TTL_MS)
}

/** 校验面板会话令牌（middleware 与 /api/auth/* 共用） */
export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  return verifyToken(await getPanelSecret(), 'session', token)
}

/** 签发 socket.io 事件票据（前端握手 auth.ticket；TTL 与会话一致） */
export async function createEventsTicket(): Promise<{ ticket: string; exp: number }> {
  const { token, exp } = makeToken(await getPanelSecret(), 'events', SESSION_TTL_MS)
  return { ticket: token, exp }
}

/** 校验 socket.io 事件票据（mini-service 侧用同一密钥文件独立实现） */
export async function verifyEventsTicket(ticket: string | undefined | null): Promise<boolean> {
  return verifyToken(await getPanelSecret(), 'events', ticket)
}

/** 服务间 emit 调用密钥（Next 流水线 → 2609 /emit 请求头 x-emit-secret） */
export async function eventsEmitSecret(): Promise<string> {
  return hmacHex(await getPanelSecret(), 'emit')
}

// ---------------------------------------------------------------------------
// 密码哈希（scrypt；仅 /api/auth/* 路由使用，middleware 不涉及）
// ---------------------------------------------------------------------------

// 初始面板口令文件（gitignore 覆盖 /db/；首次启动随机生成并落盘，取代早期硬编码默认口令）
// 历史问题（A02 P0）：DEFAULT_PANEL_PASSWORD 曾硬编码为 'koshoutou'，且该字符串同时是
// 作者联系 ID（任何拿到仓库者皆知初始口令）。现改为每实例首次启动随机生成 32 位口令，
// 落盘 db/.panel.pass（0600）并打印到 stdout，登录后建议立即在「设置 → 面板安全」修改。
const INITIAL_PASS_FILE = process.env.PANEL_INITIAL_PASS_FILE ?? path.join(process.cwd(), 'db', '.panel.pass')
const initialPassCacheG = globalThis as unknown as { __panelInitialPass?: string }

/** 生成易读随机口令（去除 IO01lo 等易混字符，32 位） */
function generateRandomPassword(len = 32): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/**
 * 读取（或生成并落盘）首次启动的初始面板口令。
 *
 * 来源优先级：
 *   1) 环境变量 PANEL_INITIAL_PASSWORD（部署时显式注入，跳过文件生成）
 *   2) 文件 db/.panel.pass（已存在则复用，保持跨重启稳定，避免每次启动口令都变）
 *   3) 首次启动：生成 32 位随机口令 → 写文件（0600）→ 打印到 stdout
 *
 * 该口令仅在 PanelAuth 表为空时用于播种；用户改密后该口令即失效（但文件保留作为「是否仍为
 * 初始口令」的比对基准，见 /api/auth/session 的 defaultPassword 判定）。
 */
export async function getInitialPanelPassword(): Promise<string> {
  if (initialPassCacheG.__panelInitialPass) return initialPassCacheG.__panelInitialPass
  // 1) 环境变量优先（部署注入）
  const fromEnv = process.env.PANEL_INITIAL_PASSWORD?.trim()
  if (fromEnv && fromEnv.length >= 6) {
    initialPassCacheG.__panelInitialPass = fromEnv
    return fromEnv
  }
  // 2) 文件复用
  try {
    const existing = (await fs.readFile(INITIAL_PASS_FILE, 'utf-8')).trim()
    if (existing.length >= 16) {
      initialPassCacheG.__panelInitialPass = existing
      return existing
    }
  } catch {
    /* 不存在则生成 */
  }
  // 3) 首次生成
  const fresh = generateRandomPassword(32)
  try {
    await fs.mkdir(path.dirname(INITIAL_PASS_FILE), { recursive: true })
    await fs.writeFile(INITIAL_PASS_FILE, fresh, { mode: 0o600 })
    // 醒目输出，避免运维错过；登录后应立即修改
    console.warn('\n========================================================')
    console.warn('[panel-auth] 首次启动：已生成随机初始面板口令（32 位）')
    console.warn(`[panel-auth] 初始口令：${fresh}`)
    console.warn(`[panel-auth] 已写入 ${INITIAL_PASS_FILE}（0600，gitignore）`)
    console.warn('[panel-auth] 请用此口令登录后，立即在「设置 → 面板安全」修改为自己的密码。')
    console.warn('========================================================\n')
  } catch (e) {
    // 只读文件系统等场景：退回进程内口令（重启后失效，需重新生成）
    console.warn('[panel-auth] 初始口令文件写入失败（退回进程内口令，重启后将重新生成）:', (e as Error).message)
    console.warn('[panel-auth] 本次启动初始口令：', fresh)
  }
  initialPassCacheG.__panelInitialPass = fresh
  return fresh
}

/**
 * @deprecated 早期硬编码默认口令（已移除）。保留导出名以兼容可能的旧引用，
 * 实际首次口令请改用 getInitialPanelPassword()（异步，每实例随机）。
 * 访问该属性会抛出，强制调用方迁移到新接口。
 */
export const DEFAULT_PANEL_PASSWORD: string = new Proxy(
  {},
  {
    get() {
      throw new Error(
        'DEFAULT_PANEL_PASSWORD 已移除（硬编码默认口令不安全），请改用 getInitialPanelPassword()',
      )
    },
  },
) as string

export function hashPassword(password: string, saltHex?: string): { hash: string; salt: string } {
  const salt = saltHex ?? randomBytes(16).toString('hex')
  const hash = scryptHash(password, salt)
  return { hash, salt }
}

function scryptHash(password: string, saltHex: string): string {
  // 登录为低频操作，同步 scrypt 可接受（64 字素 = 128 hex；N=16384/r=8/p=1 ≈ 100ms）
  return scryptSync(password, saltHex, 64, { N: 16384, r: 8, p: 1 }).toString('hex')
}

export function verifyPassword(password: string, saltHex: string, expectedHashHex: string): boolean {
  try {
    const actual = Buffer.from(scryptHash(password, saltHex), 'hex')
    const expected = Buffer.from(expectedHashHex, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 登录防爆破（进程内限流：同 IP 连续失败 5 次 → 锁 30s）
// ---------------------------------------------------------------------------

interface FailState {
  fails: number
  lockedUntil: number
}
const failG = globalThis as unknown as { __panelLoginFails?: Map<string, FailState> }

function failTable(): Map<string, FailState> {
  if (!failG.__panelLoginFails) failG.__panelLoginFails = new Map()
  return failG.__panelLoginFails
}

/** 登录前检查：返回剩余锁定秒数（0 = 可尝试） */
export function loginLockRemaining(ip: string): number {
  const s = failTable().get(ip)
  if (!s) return 0
  if (s.lockedUntil > Date.now()) return Math.ceil((s.lockedUntil - Date.now()) / 1000)
  return 0
}

/** 登录失败记账（连续 5 次锁 30s；成功即清零） */
export function recordLoginFail(ip: string): void {
  const t = failTable()
  const s = t.get(ip) ?? { fails: 0, lockedUntil: 0 }
  s.fails += 1
  if (s.fails >= 5) {
    s.lockedUntil = Date.now() + 30_000
    s.fails = 0
  }
  t.set(ip, s)
  // 惰性清扫过期条目（防 Map 无限增长）
  if (t.size > 1000) {
    const now = Date.now()
    for (const [k, v] of t) {
      if (v.lockedUntil < now && v.fails === 0) t.delete(k)
    }
  }
}

export function recordLoginSuccess(ip: string): void {
  failTable().delete(ip)
}
