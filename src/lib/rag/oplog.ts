/**
 * 程序日志（Task 17-5 + 定时清理扩展）
 *
 * 面板操作 / 运行信息 / 报错信息的统一记录：
 *   - level:    info（常规操作）| warn（可恢复异常/拒绝）| error（失败/未捕获错误）
 *   - category: api | kb | document | chunk | pipeline | auth | backup | system
 *   - action:   稳定标识符（如 doc.upload / kb.create / pipeline.job_failed / api.request_error）
 *
 * 写入约定：recordOp 为 fire-and-forget（调用方不 await，失败仅打 console，绝不影响业务路径）。
 * 全局兜底：instrumentation.ts onRequestError（未捕获请求错误 → api.request_error）。
 *
 * 定时清理（默认关闭）：
 *   - 配置持久化在 QdrantSetting.oplogAutoClean* 三字段；
 *   - 进程内调度器（globalThis 单例 + 模块版本热重载接管，对齐 backup.ts 模式）；
 *   - tick 60s，固定每 1h 执行一次清理（删除 olderThanHours 之前、level ≤ maxLevel 的记录）；
 *   - 模块加载不自动启动：由 GET /api/system/oplogs/schedule 惰性触发（未用不占资源）。
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

// ---------------------------------------------------------------------------
// 清理（手动 + 定时共用）
// ---------------------------------------------------------------------------

/** 级别顺序（info < warn < error）：maxLevel 语义 = 清理「≤ 该级别」的记录 */
const LEVEL_ORDER: Record<string, number> = { info: 0, warn: 1, error: 2 }

export function normalizeMaxLevel(v: unknown): 'info' | 'warn' | 'error' {
  return v === 'info' || v === 'error' ? v : 'warn'
}

/**
 * 清理程序日志。
 * @param olderThanHours 删除多少小时之前的记录（0 = 全部，含刚写入的）
 * @param maxLevel 清理级别上限：'info' 仅 info；'warn' info+warn；'error' 全部（含 error）
 * @returns 删除条数
 */
export async function cleanOplogs(olderThanHours: number, maxLevel: 'info' | 'warn' | 'error' = 'error'): Promise<number> {
  const hours = Number.isFinite(olderThanHours) && olderThanHours >= 0 ? olderThanHours : 24
  const cutoff = new Date(Date.now() - hours * 3600_000)
  const levels = LEVEL_ORDER[normalizeMaxLevel(maxLevel)] >= LEVEL_ORDER.error
    ? ['info', 'warn', 'error']
    : LEVEL_ORDER[normalizeMaxLevel(maxLevel)] >= LEVEL_ORDER.warn
      ? ['info', 'warn']
      : ['info']
  const r = await db.programLog.deleteMany({ where: { ts: { lt: cutoff }, level: { in: levels } } })
  return r.count
}

// ---------------------------------------------------------------------------
// 定时清理调度器（契约 §35 扩展；对齐 backup.ts 的 globalThis 单例模式）
// ---------------------------------------------------------------------------

export interface OplogCleanConfig {
  enabled: boolean
  olderThanHours: number
  maxLevel: 'info' | 'warn' | 'error'
}

/** 对外契约（前端 types.ts OplogCleanSchedule 同构） */
export interface OplogCleanSchedule {
  enabled: boolean
  olderThanHours: number
  maxLevel: 'info' | 'warn' | 'error'
  /** 清理执行间隔（固定 1h，不可配） */
  intervalHours: number
  nextRunAt: string | null
  lastRunAt: string | null
  lastDeleted: number | null
  /** 调度器进程状态（timer 是否在跑） */
  schedulerRunning: boolean
  /** 累计清理条数（进程内，重启清零） */
  totalDeleted: number
  runCount: number
  failCount: number
}

interface OplogSchedState {
  timer: NodeJS.Timeout | null
  nextRunAt: Date | null
  lastRunAt: Date | null
  lastDeleted: number | null
  totalDeleted: number
  runCount: number
  failCount: number
  running: boolean
  moduleVersion: number
}

const OPLOG_TICK_MS = 60_000
const OPLOG_RUN_INTERVAL_MS = 3_600_000 // 固定每小时执行一次
const MIN_OLDER_HOURS = 1
const MAX_OLDER_HOURS = 8760

export const DEFAULT_OPLOG_CLEAN: OplogCleanConfig = { enabled: false, olderThanHours: 720, maxLevel: 'warn' }

const schedG = globalThis as unknown as { __ragOplogCleanScheduler?: OplogSchedState }
const OPLOG_SCHEDULER_MODULE_VERSION = Date.now()

function clampOlderHours(h: number): number {
  if (!Number.isFinite(h)) return DEFAULT_OPLOG_CLEAN.olderThanHours
  return Math.min(MAX_OLDER_HOURS, Math.max(MIN_OLDER_HOURS, Math.round(h)))
}

/** 读配置（QdrantSetting 单行；不存在返回默认值，不播种） */
export async function readOplogCleanConfig(): Promise<OplogCleanConfig> {
  const row = await db.qdrantSetting.findUnique({ where: { id: 'default' } })
  if (!row) return { ...DEFAULT_OPLOG_CLEAN }
  return {
    enabled: row.oplogAutoCleanEnabled,
    olderThanHours: clampOlderHours(row.oplogCleanOlderThanHours),
    maxLevel: normalizeMaxLevel(row.oplogCleanMaxLevel),
  }
}

function state(): OplogSchedState {
  let s = schedG.__ragOplogCleanScheduler
  if (s && s.moduleVersion !== OPLOG_SCHEDULER_MODULE_VERSION) {
    if (s.timer) clearInterval(s.timer)
    console.log('[oplog-clean-scheduler] 检测到模块更新，接管调度器（保留运行统计）')
    s = undefined
  }
  if (!s) {
    s = {
      timer: null, nextRunAt: null, lastRunAt: null, lastDeleted: null,
      totalDeleted: 0, runCount: 0, failCount: 0, running: false,
      moduleVersion: OPLOG_SCHEDULER_MODULE_VERSION,
    }
    schedG.__ragOplogCleanScheduler = s
  }
  return s
}

async function tick(s: OplogSchedState, cfg: OplogCleanConfig): Promise<void> {
  try {
    if (s.running) return
    if (!cfg.enabled) return
    const now = Date.now()
    if (!s.nextRunAt || now < s.nextRunAt.getTime()) return

    s.running = true
    try {
      const deleted = await cleanOplogs(cfg.olderThanHours, cfg.maxLevel)
      s.lastRunAt = new Date()
      s.lastDeleted = deleted
      s.totalDeleted += deleted
      s.runCount++
      // 清理结果自身记一条 info（不受清理影响：刚写入不会命中 olderThanHours ≥1h）
      if (deleted > 0) {
        recordOp({
          level: 'info',
          category: 'system',
          action: 'system.oplog_autoclean',
          message: `定时清理完成：删除 ${cfg.olderThanHours}h 前的 ${deleted} 条日志（级别 ≤ ${cfg.maxLevel}），累计 ${s.totalDeleted} 条`,
        })
      }
    } catch (e) {
      s.failCount++
      console.error('[oplog-clean-scheduler] 清理失败:', e instanceof Error ? e.message : e)
    } finally {
      s.running = false
      s.nextRunAt = new Date(Date.now() + OPLOG_RUN_INTERVAL_MS)
    }
  } catch {
    // 兜底：绝不炸 setInterval
  }
}

/** 启动（已启用时）；未启用只返回状态不占资源 */
async function applyScheduler(): Promise<OplogCleanSchedule> {
  const cfg = await readOplogCleanConfig()
  const s = state()
  if (cfg.enabled) {
    if (!s.timer) {
      s.nextRunAt = s.nextRunAt ?? new Date(Date.now() + OPLOG_RUN_INTERVAL_MS)
      const timer = setInterval(() => {
        void tick(s, cfg)
      }, OPLOG_TICK_MS)
      // Node setTimeout 返回 Timeout；挂 unref 不阻塞进程退出
      timer.unref?.()
      s.timer = timer
      console.log(
        `[oplog-clean-scheduler] 已启动：每小时清理 >${cfg.olderThanHours}h · 级别 ≤${cfg.maxLevel}（下次 ${s.nextRunAt.toISOString()}）`,
      )
    }
  } else if (s.timer) {
    clearInterval(s.timer)
    s.timer = null
    s.nextRunAt = null
    console.log('[oplog-clean-scheduler] 已停止')
  }
  return {
    enabled: cfg.enabled,
    olderThanHours: cfg.olderThanHours,
    maxLevel: cfg.maxLevel,
    intervalHours: OPLOG_RUN_INTERVAL_MS / 3_600_000,
    nextRunAt: s.timer ? (s.nextRunAt?.toISOString() ?? null) : null,
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    lastDeleted: s.lastDeleted,
    schedulerRunning: !!s.timer,
    totalDeleted: s.totalDeleted,
    runCount: s.runCount,
    failCount: s.failCount,
  }
}

/** 惰性恢复调度器（GET /api/system/oplogs/schedule 调用；进程重启后首次访问即拉起） */
export async function ensureOplogCleanScheduler(): Promise<OplogCleanSchedule> {
  return applyScheduler()
}

/** 更新配置（clamp 后落库）并热重载调度器 */
export async function updateOplogCleanConfig(patch: Partial<OplogCleanConfig>): Promise<OplogCleanSchedule> {
  const cur = await readOplogCleanConfig()
  const next: OplogCleanConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    olderThanHours: patch.olderThanHours != null ? clampOlderHours(patch.olderThanHours) : cur.olderThanHours,
    maxLevel: patch.maxLevel != null ? normalizeMaxLevel(patch.maxLevel) : cur.maxLevel,
  }
  await db.qdrantSetting.upsert({
    where: { id: 'default' },
    update: {
      oplogAutoCleanEnabled: next.enabled,
      oplogCleanOlderThanHours: next.olderThanHours,
      oplogCleanMaxLevel: next.maxLevel,
    },
    create: {
      id: 'default',
      oplogAutoCleanEnabled: next.enabled,
      oplogCleanOlderThanHours: next.olderThanHours,
      oplogCleanMaxLevel: next.maxLevel,
    },
  })
  // 热重载：停旧 timer，按新配置重建（保留运行统计）
  const s = state()
  if (s.timer) {
    clearInterval(s.timer)
    s.timer = null
  }
  return applyScheduler()
}
