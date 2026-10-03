import { NextRequest, NextResponse } from 'next/server'
import { qdrantFetch } from '@/lib/qdrant'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/qdrant/collections/[name]/points/[id] —— 真实 Qdrant 取点。
 * v1.6：本地向量引擎已移除，未配置/不可达时直接报错引导配置。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string; id: string }> }) {
  const { name, id } = await ctx.params
  const url = new URL(req.url)
  const withVector = url.searchParams.get('with_vector') === '1'
  try {
    const result = await qdrantFetch<any>({
      path: `/collections/${encodeURIComponent(name)}/points/${encodeURIComponent(id)}`,
      query: withVector ? { with_vector: 'true' } : {},
    })
    return NextResponse.json({ point: result })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
