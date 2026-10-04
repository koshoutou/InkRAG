'use client'

// RAG 知识库平台 · socket.io 实时事件 hook
// 连接单例 + 房间订阅 + 事件回调订阅。
// 服务端（mini-services/pipeline-events，port 2608）事件契约见 docs/api-contract.md §9。

import { useCallback, useEffect, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

let socket: Socket | null = null

function getSocket(): Socket {
  if (!socket) {
    socket = io('/?XTransformPort=2608', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 10000,
    })
  }
  return socket
}

/** 已订阅房间集合（客户端镜像，便于视图切换时避免重复 emit） */
const subscribedRooms = new Set<string>()

/**
 * 用法：
 *   const { connected, subscribeRooms, on } = useRealtime()
 *   useEffect(() => subscribeRooms(['kb:xxx']), [subscribeRooms, kbId])
 *   useEffect(() => on('document:status', (e) => ...), [on])
 */
export function useRealtime() {
  const [connected, setConnected] = useState<boolean>(() => socket?.connected ?? false)

  useEffect(() => {
    const s = getSocket()
    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    s.on('connect', onConnect)
    s.on('disconnect', onDisconnect)
    // 初始值由 useState 惰性初始化读取 socket.connected；
    // 若此后才连上/断开，由事件回调驱动状态更新
    return () => {
      s.off('connect', onConnect)
      s.off('disconnect', onDisconnect)
    }
  }, [])

  /** 订阅房间（服务端默认已加入 global）；幂等，重复订阅自动跳过 */
  const subscribeRooms = useCallback((rooms: string[]) => {
    const s = getSocket()
    const fresh = rooms.filter((r) => !subscribedRooms.has(r))
    for (const r of rooms) subscribedRooms.add(r)
    if (fresh.length > 0) s.emit('subscribe', { rooms: fresh })
  }, [])

  /** 订阅服务端事件；返回取消订阅函数（可直接作为 useEffect 的 cleanup） */
  const on = useCallback((event: string, cb: (payload: any) => void) => {
    const s = getSocket()
    s.on(event, cb as any)
    return () => {
      s.off(event, cb as any)
    }
  }, [])

  return { connected, socket: socket, subscribeRooms, on }
}

export type Realtime = ReturnType<typeof useRealtime>
export type EventUnsubscribe = () => void
