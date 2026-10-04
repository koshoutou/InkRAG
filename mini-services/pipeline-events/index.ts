/**
 * RAG 知识库平台 · 流水线实时事件服务 (pipeline-events)
 *
 * 端口（双服务器架构，v2.0 起默认 2608/2609，可用环境变量 SOCKET_PORT/EMIT_PORT 覆盖）：
 *   - 2608：socket.io 服务（path 必须为 '/'，Caddy 网关 XTransformPort 转发；前端 io('/?XTransformPort=2608')）
 *   - 2609：内部 emit HTTP 服务（Next.js 流水线引擎 → POST http://127.0.0.1:2609/emit）
 *
 * 为什么两个端口：socket.io path='/' 会拦截所有 HTTP 请求（engine.io startsWith 匹配），
 * 普通 REST 端点无法共存于 2608；emit 走服务间直连，不经网关。
 *
 * Room 约定（与 docs/api-contract.md §9 一致）：
 *   - global         全局房间（默认加入）：仪表盘/运维活动流
 *   - kb:{kbId}      知识库房间：文档列表实时刷新
 *   - doc:{docId}    文档房间：三屏视图/详情页进度
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Server, type Socket } from 'socket.io'

const SOCKET_PORT = Number(process.env.SOCKET_PORT) || 2608
const EMIT_PORT = Number(process.env.EMIT_PORT) || 2609

// ---------------------------------------------------------------------------
// F-EXT-14：事件链路鉴权——与主应用共享密钥文件 db/.panel.secret
//
// 密钥来源（按优先级）：
//   1) 字面量环境变量：PANEL_SECRET（主服务名，推荐）或 RAG_EVENTS_SECRET（历史别名，兼容旧部署）
//   2) 密钥文件：PANEL_SECRET_FILE 或 RAG_EVENTS_SECRET_FILE，默认 db/.panel.secret
//      （基址统一为 process.cwd()，与主应用 src/lib/rag/panel-auth.ts 完全一致——
//       避免 cwd 与 import.meta.dir 两套基址导致两服务读到不同文件、票据 HMAC 不匹配）
//
// 密钥派生：events ticket（握手）+ emit secret（服务间）。详见 docs/api-contract.md §36。
// ---------------------------------------------------------------------------
// 历史问题（A01/A07）：早期 mini-service 仅认 RAG_EVENTS_SECRET 变量名与 import.meta.dir 基址，
// 主服务仅认 PANEL_SECRET 与 cwd 基址——运维按主服务文档注入 PANEL_SECRET 后，
// mini-service 读不到密钥 → getSecret() 返回 '' → 所有 socket 握手被拒 + /emit 403，
// 且无启动期告警。现统一两套变量名与基址，并在启动期探测密钥可达性。
const SECRET_FILE =
  process.env.PANEL_SECRET_FILE ??
  process.env.RAG_EVENTS_SECRET_FILE ??
  path.resolve(process.cwd(), 'db/.panel.secret')
let cachedSecret: string | null = null

async function getSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret
  // 主服务变量名 PANEL_SECRET 优先；RAG_EVENTS_SECRET 作为历史别名兼容
  const literal = (process.env.PANEL_SECRET ?? process.env.RAG_EVENTS_SECRET)?.trim()
  if (literal && literal.length >= 32) {
    cachedSecret = literal
    return literal
  }
  try {
    const s = (await fs.readFile(SECRET_FILE, 'utf-8')).trim()
    if (s.length >= 32) {
      cachedSecret = s
      return s
    }
  } catch {
    /* 主应用尚未生成密钥（首次启动未登录）——拒绝所有连接，登录后自动可用 */
  }
  return ''
}

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

/** 校验令牌 `${exp}.${HMAC(secret, purpose:exp)}`（与会话/票据同源协议） */
function verifyToken(secret: string, purpose: string, token: unknown): boolean {
  if (!secret || typeof token !== 'string') return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const expStr = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  return safeEqualHex(sig, hmacHex(secret, `${purpose}:${expStr}`))
}

/** Room 名白名单（F-EXT-14：阻断任意房间名探测/越权订阅）
 *  global | kb:{cuid 等 ≥10 位字母数字} | doc:{uuid 等 ≥6 位字母数字连字符} */
const ROOM_RE = /^(global|kb:[A-Za-z0-9]{10,}|doc:[A-Za-z0-9-]{6,})$/

// ---------------------------------------------------------------------------
// 0) globalThis 单例守护（Task 16：bun --hot 模块重载时复用既有 server/io 实例）
//
// 【根因】热重载会重新执行本模块：旧 server 仍在事件循环里持有全部已连接 socket，
// 而模块级 io 变量被替换成新实例（未绑定端口）→ emit 端点打到新实例、
// 前端 socket 连在旧实例 → 事件全部丢失（healthz clients=0 但实际有连接）。
// 守护后模块重载为幂等 no-op，事件链路永不分裂。
// ---------------------------------------------------------------------------
const g = globalThis as unknown as {
  __pipelineEvents?: { io: Server; started: boolean }
}

// ---------------------------------------------------------------------------
// 1) socket.io 服务（2608，前端实时通道）
// ---------------------------------------------------------------------------
const socketServer = createServer() // 不挂 request handler，全部交给 socket.io
// A11 修复：CORS 收窄。原 origin: '*' 允许任意源发起握手尝试（虽由票据兜底，属不必要暴露面）。
// 现支持 RAG_EVENTS_CORS_ORIGIN 环境变量显式配置允许源（逗号分隔，生产推荐设置）；
// 未配置时回退 origin: true（反射请求 Origin，适配同源面板 + 网关链路，避免发送通配头）。
const corsOrigin: string | boolean | string[] = (() => {
  const raw = process.env.RAG_EVENTS_CORS_ORIGIN?.trim()
  if (raw) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
    return list.length > 0 ? list : true
  }
  return true
})()
const io = g.__pipelineEvents?.io ?? new Server(socketServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] }, // 准入由握手票据控制（F-EXT-14）；CORS 仅收窄探测面
  pingTimeout: 60000,
  pingInterval: 25000,
})

// F-EXT-14：握手鉴权——必须携带主应用签发的 events ticket（登录会话派生，12h TTL）。
// 未登录/票据过期/伪造 → 拒绝连接（前端收到 connect_error 后重新取票或弹登录遮罩）。
io.use(async (socket, next) => {
  const secret = await getSecret()
  const ticket = (socket.handshake.auth as { ticket?: unknown } | undefined)?.ticket
  if (!secret || !verifyToken(secret, 'events', ticket)) {
    console.warn(`[pipeline-events] 拒绝未授权连接（票据缺失/过期/伪造）: ${socket.id}`)
    return next(new Error('unauthorized: invalid or missing events ticket'))
  }
  next()
})

/** 订阅记录：socket.id → Set<room>（断连清理 + 状态查询） */
const subscriptions = new Map<string, Set<string>>()

io.on('connection', (socket: Socket) => {
  socket.join('global')
  subscriptions.set(socket.id, new Set(['global']))
  io.to('global').emit('client:count', { count: io.engine.clientsCount })
  console.log(`[pipeline-events] client connected: ${socket.id} (total ${io.engine.clientsCount})`)

  socket.on('subscribe', (data: { rooms?: string[] }) => {
    // F-EXT-14：room 名白名单校验（仅 global / kb:{id} / doc:{id}）
    const requested = Array.isArray(data?.rooms)
      ? data.rooms.filter((r) => typeof r === 'string' && r.length > 0 && r.length < 128).slice(0, 32)
      : []
    const rooms = requested.filter((r) => {
      if (ROOM_RE.test(r)) return true
      console.warn(`[pipeline-events] 拒绝白名单外房间订阅: ${r.slice(0, 64)}`)
      return false
    })
    const subs = subscriptions.get(socket.id) ?? new Set<string>()
    for (const r of rooms) {
      socket.join(r)
      subs.add(r)
    }
    subscriptions.set(socket.id, subs)
    socket.emit('subscribed', { rooms: Array.from(subs) })
  })

  socket.on('unsubscribe', (data: { rooms?: string[] }) => {
    const rooms = Array.isArray(data?.rooms) ? data.rooms : []
    const subs = subscriptions.get(socket.id)
    for (const r of rooms) {
      socket.leave(r)
      subs?.delete(r)
    }
  })

  // 调试通道：前端连通性测试
  socket.on('ping-events', (data: unknown) => {
    socket.emit('pong-events', { received: data, at: Date.now() })
  })

  socket.on('disconnect', () => {
    subscriptions.delete(socket.id)
    io.to('global').emit('client:count', { count: io.engine.clientsCount })
    console.log(`[pipeline-events] client disconnected: ${socket.id} (total ${io.engine.clientsCount})`)
  })

  socket.on('error', (err: Error) => {
    console.error(`[pipeline-events] socket ${socket.id} error:`, err.message)
  })
})

// ---------------------------------------------------------------------------
// 2) emit HTTP 服务（2609，仅本机后端调用）
// ---------------------------------------------------------------------------
const emitServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true, service: 'pipeline-events',
      socketPort: SOCKET_PORT, emitPort: EMIT_PORT,
      clients: io.engine.clientsCount,
      rooms: io.sockets.adapter.rooms.size,
    }))
    return
  }

  if (req.method === 'POST' && req.url === '/emit') {
    // F-EXT-14：服务间 emit 密钥校验（仅主应用流水线可广播；密钥 = HMAC(secret, 'emit')）
    const provided = String(req.headers['x-emit-secret'] ?? '')
    const expected = hmacHex(await getSecret(), 'emit')
    if (!expected || !provided || !safeEqualHex(provided, expected)) {
      console.warn('[pipeline-events] 拒绝未授权 emit 调用（缺少/错误 x-emit-secret）')
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden: x-emit-secret required' }))
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
      if (body.length > 5 * 1024 * 1024) req.destroy() // 5MB 防护
    })
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}')
        const { room, event, data } = payload as { room?: string; event?: string; data?: unknown }
        if (!event || typeof event !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'event required' }))
          return
        }
        if (room) {
          io.to(room).emit(event, data ?? {})
        } else {
          io.emit(event, data ?? {})
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, room: room ?? 'all', event }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `bad json: ${(e as Error).message}` }))
      }
    })
    req.on('error', () => {
      res.writeHead(400)
      res.end()
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

// 热重载复用：已启动过则跳过 listen（端口仍由旧实例持有；io 已从 globalThis 取回）
if (!g.__pipelineEvents?.started) {
  socketServer.listen(SOCKET_PORT, () => {
    console.log(`[pipeline-events] socket.io listening on :${SOCKET_PORT} (path=/)`)
  })
  emitServer.listen(EMIT_PORT, '127.0.0.1', () => {
    console.log(`[pipeline-events] emit HTTP listening on 127.0.0.1:${EMIT_PORT} (POST /emit)`)
  })
  g.__pipelineEvents = { io, started: true }
  console.log('[pipeline-events] 实例已登记（globalThis 单例守护）')
  // 启动期密钥可达性探测（A01 修复：避免密钥缺失导致事件链路静默瘫痪）
  // 若密钥为空，所有 socket 握手与 /emit 调用都将被拒；此前仅在运行时 console.warn，无启动告警
  void getSecret().then((s) => {
    if (!s) {
      console.warn(
        '[pipeline-events] ⚠ 事件链路密钥不可用：未设置 PANEL_SECRET/RAG_EVENTS_SECRET，' +
          `且密钥文件 ${SECRET_FILE} 不存在或长度不足。` +
          '请先在主应用面板登录一次以生成密钥，或显式注入 PANEL_SECRET 环境变量。' +
          '（未恢复前所有实时事件连接将被拒绝）',
      )
    } else {
      console.log('[pipeline-events] 事件链路密钥已就绪')
    }
  })
} else {
  console.log('[pipeline-events] 热重载：复用既有 server/io 实例（不重复 listen）')
}

process.on('SIGTERM', () => {
  socketServer.close()
  emitServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  socketServer.close()
  emitServer.close(() => process.exit(0))
})
