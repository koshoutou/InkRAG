import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { pipelineStats } from '@/lib/rag/pipeline'
import { toDocSummary } from '@/lib/rag/serialize'
import type { Document, KnowledgeBase } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** GET /api/dashboard —— 仪表盘聚合（契约 §7） */
export async function GET() {
  try {
    const [kbs, docs, chunks, enabledChunks, points] = await Promise.all([
      db.knowledgeBase.count(),
      db.document.count(),
      db.chunk.count({ where: { isParent: false } }),
      db.chunk.count({ where: { isParent: false, enabled: true } }),
      db.vectorPoint.count(),
    ])

    const [docsReady, docsFailed, docsProcessing, statusFlowRows] = await Promise.all([
      db.document.count({ where: { status: 'ready' } }),
      db.document.count({ where: { status: 'failed' } }),
      db.document.count({
        where: { status: { in: ['queued', 'parsing', 'chunking', 'embedding', 'upserting'] } },
      }),
      db.document.groupBy({ by: ['status'], _count: { _all: true } }),
    ])
    const statusFlow: Record<string, number> = {}
    for (const row of statusFlowRows) statusFlow[row.status] = row._count._all

    // 最近 10 文档（带 kbName）
    const recentDocRows: (Document & { kbName: string })[] = await db.document.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    const kbIds = [...new Set(recentDocRows.map((d) => d.kbId))]
    const kbRows: KnowledgeBase[] = kbIds.length
      ? await db.knowledgeBase.findMany({ where: { id: { in: kbIds } } })
      : []
    const kbNameMap = new Map(kbRows.map((k) => [k.id, k.name]))
    const recentDocs = await Promise.all(
      recentDocRows.map(async (d) => {
        const [chunkCount, enabledChunkCount] = await Promise.all([
          db.chunk.count({ where: { documentId: d.id, isParent: false } }),
          db.chunk.count({ where: { documentId: d.id, isParent: false, enabled: true } }),
        ])
        return {
          ...toDocSummary(d, { chunkCount, enabledChunkCount }),
          kbName: kbNameMap.get(d.kbId) ?? '',
        }
      })
    )

    // 最近 10 检索日志
    const logRows = await db.qdrantCallLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    const recentLogs = logRows.map((l) => ({
      id: l.id,
      query: l.query,
      collection: l.collection,
      mode: l.mode,
      tookMs: l.tookMs,
      resultCount: l.resultCount,
      source: l.source,
      createdAt: l.createdAt.toISOString(),
    }))

    const stats = await pipelineStats()

    return NextResponse.json({
      dashboard: {
        totals: {
          kbs,
          docs,
          chunks,
          points,
          enabledChunks,
          docsReady,
          docsFailed,
          docsProcessing,
        },
        recentDocs,
        recentLogs,
        jobs: { pending: stats.pending, active: stats.active, failed: stats.failed },
        statusFlow,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
