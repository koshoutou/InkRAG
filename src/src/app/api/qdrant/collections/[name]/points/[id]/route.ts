import { NextRequest, NextResponse } from 'next/server'
import { qdrantFetch } from '@/lib/qdrant'
import { getVectorStore, type LocalVectorStore } from '@/lib/rag/vectorstore'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/qdrant/collections/[name]/points/[id]
 * qdrant 模式：真实取点；local 模式：内置引擎取点。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string; id: string }> }) {
  const { name, id } = await ctx.params
  const url = new URL(req.url)
  const withVector = url.searchParams.get('with_vector') === '1'
  try {
    const store = await getVectorStore()
    if (store.mode === 'qdrant') {
      const result = await qdrantFetch<any>({
        path: `/collections/${encodeURIComponent(name)}/points/${encodeURIComponent(id)}`,
        query: withVector ? { with_vector: 'true' } : {},
      })
      return NextResponse.json({ point: result })
    }

    // ---- local 模式 ----
    const local = store as LocalVectorStore
    const found = await local.getPoints(name, [id], { withVector })
    if (found.length === 0) {
      return NextResponse.json({ error: `点 ${id} 不存在` }, { status: 404 })
    }
    const p = found[0]
    return NextResponse.json({
      point: {
        id: p.id,
        payload: p.payload,
        ...(withVector && p.vector ? { vector: p.vector } : {}),
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
