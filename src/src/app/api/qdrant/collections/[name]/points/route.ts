import { NextRequest, NextResponse } from 'next/server'
import { qdrantFetch } from '@/lib/qdrant'
import { getVectorStore, type LocalVectorStore } from '@/lib/rag/vectorstore'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/qdrant/collections/[name]/points （scroll 分页）
 * qdrant 模式：真实 scroll（基座结构不变）；local 模式：内置引擎 scroll。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const limit = Math.min(Math.max(parseInt(body.limit) || 20, 1), 100)
  const offset = body.offset === undefined || body.offset === null ? null : body.offset
  const withPayload = body.with_payload === undefined ? true : body.with_payload
  const withVector = body.with_vector === undefined ? false : body.with_vector
  try {
    const store = await getVectorStore()
    if (store.mode === 'qdrant') {
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
    }

    // ---- local 模式 ----
    const local = store as LocalVectorStore
    const result = await local.scroll(name, {
      filter: body.filter ?? undefined,
      limit,
      offset: offset ?? undefined,
      withVector: withVector === true || withVector === 'true',
    })
    const points = result.points.map((p) => ({
      id: p.id,
      payload: withPayload ? p.payload : undefined,
      ...(withVector === true || withVector === 'true'
        ? { vector: (p as any).vector ?? { dense: [], sparse: { indices: [], values: [] } } }
        : {}),
    }))
    return NextResponse.json({
      points,
      next_page_offset: result.nextOffset,
      total: await local.count(name, body.filter),
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
