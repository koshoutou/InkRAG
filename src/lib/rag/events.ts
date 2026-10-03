/**
 * 实时事件推送（契约 §9）
 *
 * 后端 → mini-service pipeline-events (port 3004) 的 HTTP emit 通道：
 *   POST http://127.0.0.1:3004/emit { room, event, data }
 *   mini-service 收到后向 socket.io 房间广播。
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

const EMIT_URL = 'http://127.0.0.1:3004/emit'
const EMIT_TIMEOUT_MS = 10_000

/** 向指定房间广播事件（10s 超时，失败静默） */
export async function emitToRoom(
  room: string,
  event: string,
  data: unknown
): Promise<void> {
  try {
    await fetch(EMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

/**
 * 入队一条后台投递：立即返回，不阻塞调用方。
 * 同一房间按提交顺序串行（保证 StageStepper 之类的时序消费者不乱序）；
 * 单条超时/失败仅告警，链继续推进（内存积压上限 = 事件服务停摆时长，可接受）。
 */
function enqueueEmit(room: string, event: string, data: unknown): void {
  const prev = roomChains.get(room) ?? Promise.resolve()
  const run = prev.then(() => emitToRoom(room, event, data))
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  roomChains.set(room, tail)
  void tail.then(() => {
    // 链尾静默后清理（若期间有新投递则保留新链尾）
    if (roomChains.get(room) === tail) roomChains.delete(room)
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
