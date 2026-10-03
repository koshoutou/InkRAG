/**
 * 程序日志（Task 17-5）
 *
 * 面板操作 / 运行信息 / 报错信息的统一记录：
 *   - level:    info（常规操作）| warn（可恢复异常/拒绝）| error（失败/未捕获错误）
 *   - category: api | kb | document | chunk | pipeline | auth | backup | system
 *   - action:   稳定标识符（如 doc.upload / kb.create / pipeline.job_failed / api.request_error）
 *
 * 写入约定：recordOp 为 fire-and-forget（调用方不 await，失败仅打 console，绝不影响业务路径）。
 * 全局兜底：instrumentation.ts onRequestError（未捕获请求错误 → api.request_error）。
 */
import { db } from '@/lib/db'

export type OpLevel = 'info' | 'warn' | 'error'
export type OpCategory = 'api' | 'kb' | 'document' | 'chunk' | 'pipeline' | 'auth' | 'backup' | 'system'

export interface RecordOpInput {
  level: OpLevel
  category: OpCategory
  action: string
  message: string
  /** 结构化补充（对象自动 JSON 化；error 实例自动取 message+stack） */
  detail?: unknown
  durationMs?: number
  statusCode?: number
  kbId?: string
  docId?: string
}

function normalizeDetail(detail: unknown): string | null {
  if (detail == null) return null
  if (detail instanceof Error) {
    return JSON.stringify({ message: detail.message, stack: detail.stack?.slice(0, 4000) })
  }
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

/** 记录一条程序日志（fire-and-forget；失败静默，仅 console.warn） */
export function recordOp(input: RecordOpInput): void {
  void db.programLog
    .create({
      data: {
        level: input.level,
        category: input.category,
        action: input.action,
        message: String(input.message).slice(0, 2000),
        detailJson: normalizeDetail(input.detail),
        ...(input.durationMs != null ? { durationMs: Math.max(0, Math.floor(input.durationMs)) } : {}),
        ...(input.statusCode != null ? { statusCode: input.statusCode } : {}),
        ...(input.kbId ? { kbId: input.kbId } : {}),
        ...(input.docId ? { docId: input.docId } : {}),
      },
    })
    .catch((e) => {
      console.warn('[oplog] 写入失败（不影响业务）:', e?.message ?? e)
    })
}

/** 清理程序日志（olderThanHours=0 = 全部；返回删除条数） */
export async function cleanOplogs(olderThanHours: number): Promise<number> {
  const hours = Number.isFinite(olderThanHours) && olderThanHours >= 0 ? olderThanHours : 24
  const cutoff = new Date(Date.now() - hours * 3600_000)
  const r = await db.programLog.deleteMany({ where: { ts: { lt: cutoff } } })
  return r.count
}
