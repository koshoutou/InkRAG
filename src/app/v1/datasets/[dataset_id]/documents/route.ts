import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireDatasetKey, notFoundDataset } from '../../../_guard'
import { toDifyDocument, docSegments } from '../../../_map'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ dataset_id: string }> }

/**
 * GET /v1/datasets/{dataset_id}/documents?page=&limit=&keyword=（Dify 兼容）
 * 文档列表（indexing_status 映射：waiting/parsing/splitting/indexing/completed/error）。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const g = await requireDatasetKey(req)
  if (!g.ok) return g.response
  const { dataset_id } = await ctx.params
  const kb = await db.knowledgeBase.findUnique({ where: { id: dataset_id } })
  if (!kb) return notFoundDataset()
  try {
    const url = new URL(req.url)
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1') || 1)
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20') || 20, 1), 100)
    const keyword = url.searchParams.get('keyword') || undefined

    const where: Record<string, unknown> = { kbId: kb.id }
    if (keyword) where.filename = { contains: keyword }
    const [docs, total] = await Promise.all([
      db.document.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: (page - 1) * limit }),
      db.document.count({ where }),
    ])
    const data = await Promise.all(
      docs.map(async (doc, i) => toDifyDocument(doc, { position: (page - 1) * limit + i + 1, segments: await docSegments(doc.id) }))
    )
    return NextResponse.json({ data, has_more: page * limit < total, limit, total, page })
  } catch (e: any) {
    return NextResponse.json({ code: 'internal_error', message: e?.message ?? String(e), status: 500 }, { status: 500 })
  }
}
