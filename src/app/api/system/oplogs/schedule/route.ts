import { NextRequest, NextResponse } from 'next/server'
import {
  ensureOplogCleanScheduler,
  updateOplogCleanConfig,
  type OplogCleanConfig,
  type OpLevel,
} from '@/lib/rag/oplog'
import { recordOp } from '@/lib/rag/oplog'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * /api/system/oplogs/schedule（契约 §35 扩展）
 *
 * - GET  获取当前清理配置 + 调度器状态，同时惰性拉起调度器（未启用不占资源）
 * - PUT  更新清理策略 { enabled?, olderThanHours?, maxLevel? }，热重载调度器
 *
 * 前端 OpLogsCard 轮询本端点读取 nextRunAt/lastRunAt 等状态；
 * 缺失时前端拿到 404，导致「自动清理」面板无法读写。
 */

/** PUT body 形态：全字段可选 */
interface UpdateBody {
  enabled?: unknown
  olderThanHours?: unknown
  maxLevel?: unknown
}

function pickBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function pickNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function pickMaxLevel(v: unknown): OpLevel | undefined {
  if (typeof v !== 'string') return undefined
  const lv = v.trim().toLowerCase()
  if (lv === 'info' || lv === 'warn' || lv === 'error') return lv
  return undefined
}

/** GET /api/system/oplogs/schedule → { schedule: OplogCleanSchedule } */
export async function GET() {
  try {
    const schedule = await ensureOplogCleanScheduler()
    return NextResponse.json({ schedule })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/**
 * PUT /api/system/oplogs/schedule body { enabled?, olderThanHours?, maxLevel? }
 * → { schedule: OplogCleanSchedule }
 *
 * 校验：
 * - 空体或全空字段 → 400（至少提供一个字段）
 * - olderThanHours 范围 1-8760（lib 内 clamp，越界不报错只收敛）
 * - maxLevel 必须是 info/warn/error 之一
 */
export async function PUT(req: NextRequest) {
  try {
    let body: UpdateBody = {}
    try {
      body = (await req.json()) as UpdateBody
    } catch {
      // 空 body → 400
    }

    const patch: Partial<OplogCleanConfig> = {}
    const hasEnabled = body.enabled !== undefined
    const hasOlder = body.olderThanHours !== undefined
    const hasLevel = body.maxLevel !== undefined

    if (!hasEnabled && !hasOlder && !hasLevel) {
      return NextResponse.json(
        { error: '请至少提供一个字段：enabled / olderThanHours / maxLevel' },
        { status: 400 }
      )
    }

    if (hasEnabled) {
      const en = pickBoolean(body.enabled)
      if (en === undefined) {
        return NextResponse.json({ error: 'enabled 必须是布尔值' }, { status: 400 })
      }
      patch.enabled = en
    }

    if (hasOlder) {
      const h = pickNumber(body.olderThanHours)
      if (h === undefined) {
        return NextResponse.json({ error: 'olderThanHours 必须是数字' }, { status: 400 })
      }
      if (h < 1 || h > 8760) {
        return NextResponse.json(
          { error: 'olderThanHours 取值范围 1-8760（小时）' },
          { status: 400 }
        )
      }
      patch.olderThanHours = Math.round(h)
    }

    if (hasLevel) {
      const lv = pickMaxLevel(body.maxLevel)
      if (!lv) {
        return NextResponse.json(
          { error: 'maxLevel 必须是 info / warn / error 之一' },
          { status: 400 }
        )
      }
      patch.maxLevel = lv
    }

    const t0 = Date.now()
    const schedule = await updateOplogCleanConfig(patch)
    recordOp({
      level: 'info',
      category: 'system',
      action: 'system.oplog_clean_config_update',
      message: `更新日志清理配置：enabled=${schedule.enabled} olderThanHours=${schedule.olderThanHours} maxLevel=${schedule.maxLevel}`,
      durationMs: Date.now() - t0,
      detail: { ...patch },
    })
    return NextResponse.json({ schedule })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
