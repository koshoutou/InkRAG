import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensurePipelineEngine } from '@/lib/rag/pipeline'
import { toJobItem } from '@/lib/rag/serialize'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** GET /api/system/jobs?status=&type=&limit=50 → { jobs, stats } */
export async function GET(req: NextRequest) {
  try {
    ensurePipelineEngine()
    const url = new URL(req.url)
    const status = url.searchParams.get('status') || undefined
    const type = url.searchParams.get('type') || undefined
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50') || 50, 1), 200)

    const where: Record<string, unknown> = {}
    if (status) where.status = status
    if (type) where.type = type

    const [jobs, pending, active, completed, failed, byTypeRows] = await Promise.all([
      db.pipelineJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
      db.pipelineJob.count({ where: { status: 'pending' } }),
      db.pipelineJob.count({ where: { status: 'active' } }),
      db.pipelineJob.count({ where: { status: 'completed' } }),
      db.pipelineJob.count({ where: { status: 'failed' } }),
      db.pipelineJob.groupBy({ by: ['type'], _count: { _all: true } }),
    ])

    const byType: Record<string, number> = {}
    for (const row of byTypeRows) byType[row.type] = row._count._all

    // docName 关联（一次查询避免 N+1）
    const docIds = [...new Set(jobs.map((j) => j.documentId))]
    const docs = docIds.length
      ? await db.document.findMany({ where: { id: { in: docIds } }, select: { id: true, filename: true } })
      : []
    const nameMap = new Map(docs.map((d) => [d.id, d.filename]))

    return NextResponse.json({
      jobs: jobs.map((j) => toJobItem(j, nameMap.get(j.documentId))),
      stats: { pending, active, completed, failed, byType },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
