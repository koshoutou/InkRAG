'use client'

// RAG 知识库平台 · socket.io 实时事件 hook
// 连接单例 + 票据鉴权握手 + 房间订阅 + 事件回调订阅。
// 服务端（mini-services/pipeline-events，port 2608）事件契约见 docs/api-contract.md §9。
//
// F-EXT-14：连接需携带主应用签发的 events ticket（GET /api/auth/events-ticket，
// 需面板登录会话，12h TTL）。未登录 → 不连接（登录遮罩接管）；票据/会话过期 →
// connect_error 后销毁单例并自动取新票重连（会话也过期时取票 401 → panel:unauthorized）。

import { useCallback, useEffect, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

let socket: Socket | null = null
let initPromise: Promise<Socket> | null = null

/** 已订阅房间集合（客户端镜像，便于视图切换时避免重复 emit；单例重建后重放） */
let subscribedRooms = new Set<string>()

/** 已注册事件回调（单例重建时重放，避免 ticket 重连后监听丢失） */
const handlers = new Map<string, Set<(payload: unknown) => void>>()

function createSocket(ticket: string): Socket {
  const s = io('/?XTransformPort=2608', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1500,
    reconnectionDelayMax: 10000,
    auth: { ticket },
  })
  // 票据过期（连接 12h+ 或会话失效）→ 服务端拒绝 → 销毁单例、取新票重建
  s.on('connect_error', (err: Error) => {
    if (/unauthorized|events ticket/i.test(String(err?.message))) {
      s.close()
      if (socket === s) {
        socket = null
        initPromise = null
        subscribedRooms = new Set()
        setTimeout(() => {
          void initSocket().catch(() => {})
        }, 2_000)
      }
    }
  })
  // 单例就绪后重放房间订阅与事件监听（ticket 重建场景）
  s.on('connect', () => {
    const fresh = Array.from(subscribedRooms)
    if (fresh.length > 0) s.emit('subscribe', { rooms: fresh })
    for (const [event, cbs] of handlers) {
      for (const cb of cbs) s.on(event, cb as never)
    }
  })
  return s
}

function initSocket(): Promise<Socket> {
  if (socket) return Promise.resolve(socket)
  if (!initPromise) {
    initPromise = (async () => {
      const r = await fetch('/api/auth/events-ticket', { cache: 'no-store' })
      if (!r.ok) {
        initPromise = null
        throw new Error('no-ticket（未登录或会话过期）')
      }
      const { ticket } = (await r.json()) as { ticket: string }
      socket = createSocket(ticket)
      return socket
    })()
  }
  return initPromise
}

/**
 * 用法：
 *   const { connected, subscribeRooms, on } = useRealtime()
 *   useEffect(() => subscribeRooms(['kb:xxx']), [subscribeRooms, kbId])
 *   useEffect(() => on('document:status', (e) => ...), [on])
 */
export function useRealtime() {
  const [connected, setConnected] = useState<boolean>(() => socket?.connected ?? false)

  useEffect(() => {
    let off: (() => void) | null = null
    let cancelled = false
    void initSocket()
      .then((s) => {
        if (cancelled) return
        const onConnect = () => setConnected(true)
        const onDisconnect = () => setConnected(false)
        s.on('connect', onConnect)
        s.on('disconnect', onDisconnect)
        if (s.connected) setConnected(true)
        off = () => {
          s.off('connect', onConnect)
          s.off('disconnect', onDisconnect)
        }
      })
      .catch(() => {
        /* 未登录/票据失败：不连接（登录遮罩会接管，登录后整页刷新重建） */
      })
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  /** 订阅房间（服务端默认已加入 global）；幂等，重复订阅自动跳过 */
  const subscribeRooms = useCallback((rooms: string[]) => {
    const fresh = rooms.filter((r) => !subscribedRooms.has(r))
    for (const r of rooms) subscribedRooms.add(r)
    if (socket && fresh.length > 0) socket.emit('subscribe', { rooms: fresh })
  }, [])

  /** 订阅服务端事件；返回取消订阅函数（可直接作为 useEffect 的 cleanup） */
  const on = useCallback((event: string, cb: (payload: any) => void) => {
    const set = handlers.get(event) ?? new Set()
    set.add(cb)
    handlers.set(event, set)
    socket?.on(event, cb as never)
    return () => {
      set.delete(cb)
      if (set.size === 0) handlers.delete(event)
      socket?.off(event, cb as never)
    }
  }, [])

  return { connected, socket, subscribeRooms, on }
}

export type Realtime = ReturnType<typeof useRealtime>
export type EventUnsubscribe = () => void
