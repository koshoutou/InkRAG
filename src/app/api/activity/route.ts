import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toDocSummary } from '@/lib/rag/serialize'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/activity（契约 §28 实时活动流 / 任务中心）
 * 返回进行中文档（六阶段任意运行态）+ 失败文档（可重试 / 可删除 / 报错可展开）。
 * 完成任务不返回（用户约定：完成的任务不显示）。
 * 实时性由 socket 事件（document:status/progress/done，global 房间）驱动前端更新。
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100') || 100, 1), 200)

    const RUNNING = ['queued', 'parsing', 'chunking', 'embedding', 'upserting']
    const [runningDocs, failedDocs, kbs] = await Promise.all([
      db.document.findMany({
        where: { status: { in: RUNNING } },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      }),
      db.document.findMany({
        where: { status: 'failed' },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      }),
      db.knowledgeBase.findMany({ select: { id: true, name: true } }),
    ])

    const kbName = new Map(kbs.map((k) => [k.id, k.name]))
    const [runningCount, failedCount] = await Promise.all([
      db.document.count({ where: { status: { in: RUNNING } } }),
      db.document.count({ where: { status: 'failed' } }),
    ])

    const decorate = (d: (typeof runningDocs)[number]) => {
      return {
        ...toDocSummary(d, { chunkCount: 0, enabledChunkCount: 0 }),
        kbName: kbName.get(d.kbId) ?? d.kbId,
      }
    }

    return NextResponse.json({
      running: runningDocs.map(decorate),
      failed: failedDocs.map(decorate),
      stats: { runningCount, failedCount },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
