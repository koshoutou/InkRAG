import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** GET /api/qdrant/call-logs?collection=xxx&limit=100&offset=0&source=web-ui&q=...
 *  List Qdrant call audit log with offset-based pagination (like chunk browsing).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const collection = url.searchParams.get('collection') || undefined
  const source = url.searchParams.get('source') || undefined
  const q = url.searchParams.get('q') || undefined
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10') || 10, 500)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0') || 0, 0)

  const where: any = {}
  if (collection) where.collection = collection
  if (source) where.source = source
  if (q) where.query = { contains: q }

  const [items, total] = await Promise.all([
    db.qdrantCallLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    db.qdrantCallLog.count({ where }),
  ])

  return NextResponse.json({
    items: items.map((l) => ({
      id: l.id,
      source: l.source,
      collection: l.collection,
      query: l.query,
      mode: l.mode,
      topK: l.topK,
      scoreThreshold: l.scoreThreshold,
      reranked: l.reranked,
      tookMs: l.tookMs,
      resultCount: l.resultCount,
      params: JSON.parse(l.paramsJson || '{}'),
      results: JSON.parse(l.resultsJson || '[]'),
      createdAt: l.createdAt,
    })),
    total,
    offset,
    limit,
  })
}

/** DELETE /api/qdrant/call-logs — 清理检索测试日志
 *  支持(可组合)：
 *    ?all=1                   清空全部
 *    ?keep=N                  只保留最近 N 条（删除更早的）
 *    ?olderThanDays=N         删除 N 天以前的记录
 *    ?before=<ISO 时间>        删除 createdAt 早于该时间的记录
 */
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url)
  const all = url.searchParams.get('all') === '1'
  const keepRaw = url.searchParams.get('keep')
  const olderThanDaysRaw = url.searchParams.get('olderThanDays')
  const beforeRaw = url.searchParams.get('before')

  try {
    const where: any = {}

    // ?before=<ISO> — delete records created strictly before this time.
    if (beforeRaw) {
      const d = new Date(beforeRaw)
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: '无效的 before 时间参数' }, { status: 400 })
      }
      where.createdAt = { lt: d }
    }

    // ?olderThanDays=N — delete records older than N days.
    if (olderThanDaysRaw) {
      const n = parseInt(olderThanDaysRaw)
      if (isNaN(n) || n < 0) {
        return NextResponse.json({ error: '无效的 olderThanDays 参数' }, { status: 400 })
      }
      const cutoff = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
      where.createdAt = { ...(where.createdAt ?? {}), lt: cutoff }
    }

    // ?keep=N — delete everything except the newest N rows.
    let keepCount: number | null = null
    if (keepRaw) {
      const n = parseInt(keepRaw)
      if (isNaN(n) || n < 0) {
        return NextResponse.json({ error: '无效的 keep 参数' }, { status: 400 })
      }
      keepCount = n
    }

    // Gather ids that survive so we can delete the rest.
    if (all || keepCount === 0) {
      await db.qdrantCallLog.deleteMany({})
      return NextResponse.json({ ok: true, deleted: 'all' })
    }

    if (keepCount && keepCount > 0) {
      // Newest N rows (optionally constrained by `where`) are kept.
      const keep = await db.qdrantCallLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: keepCount,
        select: { id: true },
      })
      const keepIds = keep.map((r) => r.id)
      const deleteWhere = keepIds.length ? { ...where, NOT: { id: { in: keepIds } } } : where
      const res = await db.qdrantCallLog.deleteMany({ where: deleteWhere })
      return NextResponse.json({ ok: true, deleted: res.count })
    }

    // Generic filtered delete (before / olderThanDays).
    if (where.createdAt) {
      const res = await db.qdrantCallLog.deleteMany({ where })
      return NextResponse.json({ ok: true, deleted: res.count })
    }

    return NextResponse.json({ error: '请指定 ?all=1 / ?keep=N / ?olderThanDays=N / ?before=<ISO>' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
