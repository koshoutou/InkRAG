import { NextRequest, NextResponse } from 'next/server'
import { qdrantFetch } from '@/lib/qdrant'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/qdrant/collections/[name]/points （scroll 分页）—— 真实 Qdrant scroll（基座结构不变）。
 * v1.6：本地向量引擎已移除，未配置/不可达时直接报错引导配置。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const limit = Math.min(Math.max(parseInt(body.limit) || 20, 1), 100)
  const offset = body.offset === undefined || body.offset === null ? null : body.offset
  const withPayload = body.with_payload === undefined ? true : body.with_payload
  const withVector = body.with_vector === undefined ? false : body.with_vector
  try {
    const result = await qdrantFetch<{
      points: any[]
      next_page_offset: string | number | null
      total?: number
    }>({
      path: `/collections/${encodeURIComponent(name)}/points/scroll`,
      method: 'POST',
      body: {
        limit,
        offset,
        with_payload: withPayload,
        with_vector: withVector,
        filter: body.filter ?? null,
        order_by: body.order_by ?? undefined,
      },
    })
    return NextResponse.json({
      points: result.points ?? [],
      next_page_offset: result.next_page_offset ?? null,
      total: result.total ?? (result.points?.length ?? 0),
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
