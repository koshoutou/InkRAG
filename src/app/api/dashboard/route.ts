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
    const [kbs, docs, chunks, enabledChunks, pointAgg] = await Promise.all([
      db.knowledgeBase.count(),
      db.document.count(),
      db.chunk.count({ where: { isParent: false } }),
      db.chunk.count({ where: { isParent: false, enabled: true } }),
      // v1.6：向量点存于 Qdrant，面板计数用库行快照 pointCount（pipeline 回写）
      db.knowledgeBase.aggregate({ _sum: { pointCount: true } }),
    ])
    const points = pointAgg._sum.pointCount ?? 0

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

    const stats = await pipelineStats()

    // §32（Task 17-1）：recentLogs（最近检索日志）已随对外检索 API 一同移除——
    // 平台定位收敛为「知识库管理」，检索调用与审计由外部独立平台承担
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
        jobs: { pending: stats.pending, active: stats.active, failed: stats.failed },
        statusFlow,
        // FE-005：流水线引擎状态（paused=备份/恢复期间暂停认领；draining=优雅关闭进行中）
        // 前端据此在仪表盘/系统运维页展示横幅，让用户直观看到引擎非正常态
        pipeline: {
          pending: stats.pending,
          active: stats.active,
          waiting: stats.waiting,
          completed: stats.completed,
          failed: stats.failed,
          uptimeSec: stats.uptimeSec,
          concurrency: stats.concurrency,
          paused: stats.paused,
          pausedReason: stats.pausedReason,
          pausedAt: stats.pausedAt,
          draining: stats.draining,
          drainingAt: stats.drainingAt,
        },
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
