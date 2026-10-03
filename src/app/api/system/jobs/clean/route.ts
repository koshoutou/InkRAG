import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** POST /api/system/jobs/clean Body: { status?='completed', olderThanHours?=24 } → { cleaned }（status 亦支持 failed/cancelled） */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const status = ['completed', 'failed', 'cancelled'].includes(body.status) ? body.status : 'completed'
    // olderThanHours 显式传 0 = 清理该状态全部任务（仅缺省/非法值才回退 24h）
    const rawHours = Number(body.olderThanHours)
    const olderThanHours =
      body.olderThanHours === undefined || body.olderThanHours === null || !Number.isFinite(rawHours) || rawHours < 0
        ? 24
        : rawHours
    const cutoff = new Date(Date.now() - olderThanHours * 3600_000)

    const res = await db.pipelineJob.deleteMany({
      where: { status, finishedAt: { lt: cutoff } },
    })
    return NextResponse.json({ cleaned: res.count })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
