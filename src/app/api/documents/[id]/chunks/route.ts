import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toChunkItem } from '@/lib/rag/serialize'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/documents/[id]/chunks?limit=50&offset=0&parentOnly=false&q= */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })

    const url = new URL(req.url)
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50') || 50, 1), 1000)
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0') || 0, 0)
    // 兼容 parentOnly=true / parentOnly=1 两种传参
    const parentOnlyParam = url.searchParams.get('parentOnly')
    const parentOnly = parentOnlyParam === 'true' || parentOnlyParam === '1'
    const q = url.searchParams.get('q')?.trim() || undefined

    const where: Record<string, unknown> = { documentId: id }
    if (parentOnly) where.isParent = true
    else where.isParent = false
    if (q) where.textPreview = { contains: q }

    const [chunks, total] = await Promise.all([
      db.chunk.findMany({ where, orderBy: { seq: 'asc' }, take: limit, skip: offset }),
      db.chunk.count({ where }),
    ])
    return NextResponse.json({ chunks: chunks.map(toChunkItem), total })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
