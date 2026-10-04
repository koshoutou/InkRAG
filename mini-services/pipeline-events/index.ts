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
import { Server, type Socket } from 'socket.io'

const SOCKET_PORT = Number(process.env.SOCKET_PORT) || 2608
const EMIT_PORT = Number(process.env.EMIT_PORT) || 2609

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
const io = g.__pipelineEvents?.io ?? new Server(socketServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

/** 订阅记录：socket.id → Set<room>（断连清理 + 状态查询） */
const subscriptions = new Map<string, Set<string>>()

io.on('connection', (socket: Socket) => {
  socket.join('global')
  subscriptions.set(socket.id, new Set(['global']))
  io.to('global').emit('client:count', { count: io.engine.clientsCount })
  console.log(`[pipeline-events] client connected: ${socket.id} (total ${io.engine.clientsCount})`)

  socket.on('subscribe', (data: { rooms?: string[] }) => {
    const rooms = Array.isArray(data?.rooms)
      ? data.rooms.filter((r) => typeof r === 'string' && r.length > 0 && r.length < 128).slice(0, 32)
      : []
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
const emitServer = createServer((req: IncomingMessage, res: ServerResponse) => {
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
