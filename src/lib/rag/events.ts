/**
 * 实时事件推送（契约 §9）
 *
 * 后端 → mini-service pipeline-events (port 2609) 的 HTTP emit 通道：
 *   POST http://127.0.0.1:2609/emit { room, event, data }
 *   mini-service 收到后向 socket.io 房间广播。
 * emit 地址可用 RAG_EVENTS_EMIT_URL 覆盖（默认 2609，与 mini-services/pipeline-events 的 EMIT_PORT 对应）。
 *
 * Task 15-c（审计#N15）：推送改为 fire-and-forget —— 各 emit 包装函数立即返回，
 * HTTP 请求进入按房间串行的后台链（同一房间内保序，房间之间并行）。
 * 流水线关键路径不再被事件服务拖慢（原先每次 2-3 个同步 HTTP await，
 * 事件服务变慢时流水线被拖到 EMIT_TIMEOUT 10s/次）。
 *
 * 事件仍是尽力而为（best-effort）：失败仅 console.warn，绝不影响主流程；
 * EMIT_TIMEOUT 保留给事件模块自身（超时后链继续推进，不阻塞后续事件）。
 */
import type {
  DocumentDoneEvent,
  DocumentProgressEvent,
  DocumentStatusEvent,
  JobUpdateEvent,
  KbStatsEvent,
  PipelineActivityEvent,
} from './types'
import { eventsEmitSecret } from './panel-auth'

const EMIT_URL = process.env.RAG_EVENTS_EMIT_URL?.trim() || 'http://127.0.0.1:2609/emit'
const EMIT_TIMEOUT_MS = 10_000

/** 向指定房间广播事件（10s 超时，失败静默；F-EXT-14：携带服务间 emit 密钥） */
export async function emitToRoom(
  room: string,
  event: string,
  data: unknown
): Promise<void> {
  try {
    await fetch(EMIT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-inkrag-emit-secret': await eventsEmitSecret(),
      },
      body: JSON.stringify({ room, event, data }),
      signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
    })
  } catch (e) {
    console.warn(`[events] emit 失败 room=${room} event=${event}:`, (e as Error).message)
  }
}

// ---------------------------------------------------------------------------
// 按房间有序的后台投递链（审计#N15：fire-and-forget + 房间内保序）
// ---------------------------------------------------------------------------

const roomChains = new Map<string, Promise<void>>()

/** F-EXT-16：每房间待投递链长度上限（事件服务长停摆时丢弃新事件并告警，防 Map 无限积压） */
const ROOM_CHAIN_MAX = 200
const roomChainLens = new Map<string, number>()
let chainDropWarnedAt = 0

/**
 * 入队一条后台投递：立即返回，不阻塞调用方。
 * 同一房间按提交顺序串行（保证 StageStepper 之类的时序消费者不乱序）；
 * 单条超时/失败仅告警，链继续推进；超过 ROOM_CHAIN_MAX 丢弃并限频告警（F-EXT-16）。
 */
function enqueueEmit(room: string, event: string, data: unknown): void {
  const len = roomChainLens.get(room) ?? 0
  if (len >= ROOM_CHAIN_MAX) {
    const now = Date.now()
    if (now - chainDropWarnedAt > 60_000) {
      chainDropWarnedAt = now
      console.warn(`[events] 房间 ${room} 积压超 ${ROOM_CHAIN_MAX} 条（事件服务停摆？），丢弃新事件并告警`)
    }
    return
  }
  const prev = roomChains.get(room) ?? Promise.resolve()
  const run = prev.then(() => emitToRoom(room, event, data))
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  roomChains.set(room, tail)
  roomChainLens.set(room, len + 1)
  void tail.then(() => {
    // 链尾静默后清理（若期间有新投递则保留新链尾）
    if (roomChains.get(room) === tail) {
      roomChains.delete(room)
      roomChainLens.delete(room)
    } else {
      roomChainLens.set(room, Math.max(0, (roomChainLens.get(room) ?? 1) - 1))
    }
  })
}

/** 文档状态变更 → doc 房间 + kb 房间（文档列表实时刷新） */
export function documentStatus(payload: DocumentStatusEvent): void {
  enqueueEmit(`doc:${payload.docId}`, 'document:status', payload)
  enqueueEmit(`kb:${payload.kbId}`, 'document:status', payload)
}

/** 阶段内部进度 → doc 房间 + kb 房间 */
export function documentProgress(payload: DocumentProgressEvent): void {
  enqueueEmit(`doc:${payload.docId}`, 'document:progress', payload)
  enqueueEmit(`kb:${payload.kbId}`, 'document:progress', payload)
}

/** 文档流水线完成 → doc + kb + global */
export function documentDone(payload: DocumentDoneEvent): void {
  enqueueEmit(`doc:${payload.docId}`, 'document:done', payload)
  enqueueEmit(`kb:${payload.kbId}`, 'document:done', payload)
  enqueueEmit('global', 'document:done', payload)
}

/** 知识库统计更新 → kb 房间 + global（仪表盘） */
export function kbStats(payload: KbStatsEvent): void {
  enqueueEmit(`kb:${payload.kbId}`, 'kb:stats', payload)
  enqueueEmit('global', 'kb:stats', payload)
}

/** 任务状态更新 → global */
export function jobUpdate(payload: JobUpdateEvent): void {
  enqueueEmit('global', 'job:update', payload)
}

/** 运维活动流 → global */
export function pipelineActivity(payload: PipelineActivityEvent): void {
  enqueueEmit('global', 'pipeline:activity', payload)
}
