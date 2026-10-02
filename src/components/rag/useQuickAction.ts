'use client'

// 契约 §19 快捷动作事件监听端统一封装（命令面板派发 → 目标视图自动执行）
//
// 关键时序问题：命令面板 runAction 先 setView 再 dispatchEvent（同步），
// 而目标视图是懒加载 dynamic chunk —— 事件派发瞬间组件尚未挂载，
// 挂载后 useEffect 里注册的监听器收不到该事件。
// 解法：本模块加载即在 window 上注册常驻「事件桥」：
//   · 目标视图已挂载 → 实时转发给 liveHandlers（并视为已消费，不记录）
//   · 目标视图未挂载 → 记入 recentDispatch，待 useQuickAction 挂载时回放（TTL 内一次性）
// 桥随默认视图（DashboardView）chunk 加载（见 ensureQuickActionBridge 调用方），
// 保证先于任何快捷动作派发就绪。

import { useEffect, useRef } from 'react'

/** 契约 §19 固定的四个快捷动作事件名（与 CommandPalette QUICK_ACTIONS 对齐） */
const QUICK_EVENT_NAMES = [
  'rag:quick-create-kb',
  'rag:quick-run-tests',
  'rag:quick-backup',
  'rag:quick-create-key',
] as const

/** 回放窗口：覆盖懒加载 chunk 异步拉取的延迟（远大于常规 chunk 加载耗时） */
const REPLAY_TTL_MS = 8000

/** 近期派发记录（事件名 → 时间戳），供挂载后回放（一次性消费） */
const recentDispatch = new Map<string, number>()

/** 已挂载视图的实时处理器（事件名 → handler 集合） */
const liveHandlers = new Map<string, Set<() => void>>()

if (typeof window !== 'undefined') {
  for (const name of QUICK_EVENT_NAMES) {
    window.addEventListener(name, () => {
      const handlers = liveHandlers.get(name)
      if (handlers && handlers.size > 0) {
        // 监听端在线：实时消费，不记录（避免挂载后重复回放）
        for (const h of handlers) h()
        return
      }
      // 监听端离线（视图未挂载 / chunk 未加载）：记录待回放
      recentDispatch.set(name, Date.now())
    })
  }
}

/**
 * 显式语义锚点：确保常驻事件桥随本模块加载就绪。
 * 由默认视图（DashboardView）在模块顶层调用 —— 应用启动即注册，
 * 先于任何快捷动作派发；幂等（实际注册在模块加载时完成）。
 */
export function ensureQuickActionBridge(): void {
  /* 模块加载时已完成注册，此处仅作显式调用语义 */
}

/**
 * 监听命令面板快捷动作事件（契约 §19）。
 *
 * - 挂载时订阅 / 卸载时清理（liveHandlers 增删）
 * - handler 通过 ref 持有最新闭包（事件触发时读取最新 state）
 * - 跨视图时序兜底：事件在视图挂载前派发（命令面板先 setView 后 dispatch），
 *   挂载时回放 TTL 内的一次性记录；已在线消费过的事件不会回放
 *
 * @param eventName 契约事件名（rag:quick-*）
 * @param handler   动作执行函数（读最新 state；自行幂等，如 Dialog 已开则忽略）
 */
export function useQuickAction(eventName: string, handler: () => void): void {
  // latest-ref：渲染后同步最新闭包，避免监听回调捕获过期 state
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => {
    const fn = () => handlerRef.current()
    let set = liveHandlers.get(eventName)
    if (!set) {
      set = new Set()
      liveHandlers.set(eventName, set)
    }
    set.add(fn)

    // 回放：事件先于挂载派发（跨视图跳转 + 懒加载 chunk 延迟）；消费一次即清除
    const ts = recentDispatch.get(eventName)
    if (ts !== undefined && Date.now() - ts <= REPLAY_TTL_MS) {
      recentDispatch.delete(eventName)
      fn()
    }

    return () => {
      const s = liveHandlers.get(eventName)
      if (s) {
        s.delete(fn)
        if (s.size === 0) liveHandlers.delete(eventName)
      }
    }
  }, [eventName])
}
