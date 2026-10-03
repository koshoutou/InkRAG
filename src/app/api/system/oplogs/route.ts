import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cleanOplogs } from '@/lib/rag/oplog'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const LEVELS = new Set(['info', 'warn', 'error'])
const CATEGORIES = new Set(['api', 'kb', 'document', 'chunk', 'pipeline', 'auth', 'backup', 'system'])

/**
 * GET /api/system/oplogs?level=&category=&q=&hours=&limit=&offset=（Task 17-5）
 * → { logs, total }（新→旧；时间默认 24h，hours=0 = 全部）
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const level = url.searchParams.get('level') || undefined
    const category = url.searchParams.get('category') || undefined
    const q = (url.searchParams.get('q') || '').trim() || undefined
    const hoursRaw = url.searchParams.get('hours')
    const hours = hoursRaw != null && hoursRaw !== '' ? Math.max(0, Number(hoursRaw) || 24) : 24
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '60') || 60, 1), 200)
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0') || 0, 0)

    const where: Record<string, unknown> = {}
    if (level && LEVELS.has(level)) where.level = level
    if (category && CATEGORIES.has(category)) where.category = category
    if (q) {
      where.OR = [
        { message: { contains: q } },
        { action: { contains: q } },
      ]
    }
    if (hours > 0) {
      where.ts = { gte: new Date(Date.now() - hours * 3600_000) }
    }

    const [rows, total, statsRows] = await Promise.all([
      db.programLog.findMany({ where, orderBy: { ts: 'desc' }, take: limit, skip: offset }),
      db.programLog.count({ where }),
      // 全量统计（忽略过滤条件）：总条数 + 估算占用（字段字节和 + 每行 ~120B 固定开销）
      db.$queryRaw`SELECT COUNT(*) AS cnt,
        COALESCE(SUM(LENGTH(message)), 0) + COALESCE(SUM(LENGTH(COALESCE(detailJson, ''))), 0)
        + COALESCE(SUM(LENGTH(action)), 0) AS payload
        FROM ProgramLog`.catch(() => [] as Array<{ cnt: number | bigint; payload: number | bigint }>),
    ])
    const logs = rows.map((r) => ({
      id: r.id,
      ts: r.ts.toISOString(),
      level: r.level,
      category: r.category,
      action: r.action,
      message: r.message,
      detail: (() => {
        try {
          return r.detailJson ? JSON.parse(r.detailJson) : null
        } catch {
          return r.detailJson
        }
      })(),
      durationMs: r.durationMs,
      statusCode: r.statusCode,
      kbId: r.kbId,
      docId: r.docId,
    }))
    const st = (statsRows as Array<{ cnt: number | bigint; payload: number | bigint }>)[0]
    const stats = {
      totalAll: Number(st?.cnt ?? 0),
      estBytes: Number(st?.payload ?? 0) + Number(st?.cnt ?? 0) * 120,
    }
    return NextResponse.json({ logs, total, stats })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/** DELETE /api/system/oplogs?olderThanHours=（0 = 全部清空）→ { deleted } */
export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const h = Number(url.searchParams.get('olderThanHours'))
    const hours = Number.isFinite(h) && h >= 0 ? h : 24
    const deleted = await cleanOplogs(hours)
    return NextResponse.json({ deleted })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
