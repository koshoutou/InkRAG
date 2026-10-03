import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { kbSummaryWithCounts, kbSummaries } from '@/lib/rag/kb'
import { createKnowledgeBaseCore } from '@/lib/rag/kbcreate'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** GET /api/kb → { kbs: KbSummary[] } */
export async function GET() {
  try {
    const kbs = await db.knowledgeBase.findMany({ orderBy: { createdAt: 'desc' } })
    return NextResponse.json({ kbs: await kbSummaries(kbs) })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/**
 * POST /api/kb
 * Body: { name, description?, chunkConfig?, rerankEnabled?, retrievalMode? }
 * → 201 { kb: KbSummary }
 *
 * v1.6 建库强校验 + Task 17-2 retrievalMode：
 * - 未配置 Qdrant → 400（引导到设置页）
 * - 未配置 Embedding API → 400
 * - probeEmbedding() 实测 dim 与稀疏方案并锁定（kb.dim / kb.sparseScheme / embeddingModel）
 * - Qdrant 不可达 → 硬失败（不再静默跳过建集合）
 * 实现抽取至 lib/rag/kbcreate.ts（与 /api/input、/v1/datasets 三链路共用，语义完全一致）
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const r = await createKnowledgeBaseCore({
      name: String(body.name ?? ''),
      description: body.description,
      chunkConfig: body.chunkConfig,
      rerankEnabled: body.rerankEnabled === true,
      retrievalMode: body.retrievalMode,
      dim: Number(body.dim) > 0 ? Number(body.dim) : undefined,
    })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ kb: await kbSummaryWithCounts(r.kb) }, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
