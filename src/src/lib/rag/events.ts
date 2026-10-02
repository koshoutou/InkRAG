/**
 * 实时事件推送（契约 §9）
 *
 * 后端 → mini-service pipeline-events (port 3004) 的 HTTP emit 通道：
 *   POST http://127.0.0.1:3004/emit { room, event, data }
 * mini-service 收到后向 socket.io 房间广播。
 *
 * 事件是尽力而为（best-effort）：失败仅 console.warn，绝不影响主流程。
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

/** 向多个房间广播同一事件 */
async function emitToRooms(rooms: string[], event: string, data: unknown): Promise<void> {
  await Promise.all(rooms.map((room) => emitToRoom(room, event, data)))
}

/** 文档状态变更 → doc 房间 + kb 房间（文档列表实时刷新） */
export async function documentStatus(payload: DocumentStatusEvent): Promise<void> {
  await emitToRooms([`doc:${payload.docId}`, `kb:${payload.kbId}`], 'document:status', payload)
}

/** 阶段内部进度 → doc 房间 + kb 房间 */
export async function documentProgress(payload: DocumentProgressEvent): Promise<void> {
  await emitToRooms([`doc:${payload.docId}`, `kb:${payload.kbId}`], 'document:progress', payload)
}

/** 文档流水线完成 → doc + kb + global */
export async function documentDone(payload: DocumentDoneEvent): Promise<void> {
  await emitToRooms(
    [`doc:${payload.docId}`, `kb:${payload.kbId}`, 'global'],
    'document:done',
    payload
  )
}

/** 知识库统计更新 → kb 房间 + global（仪表盘） */
export async function kbStats(payload: KbStatsEvent): Promise<void> {
  await emitToRooms([`kb:${payload.kbId}`, 'global'], 'kb:stats', payload)
}

/** 任务状态更新 → global */
export async function jobUpdate(payload: JobUpdateEvent): Promise<void> {
  await emitToRoom('global', 'job:update', payload)
}

/** 运维活动流 → global */
export async function pipelineActivity(payload: PipelineActivityEvent): Promise<void> {
  await emitToRoom('global', 'pipeline:activity', payload)
}
