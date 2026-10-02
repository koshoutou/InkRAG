import { NextRequest, NextResponse } from 'next/server'
import { compareVersions } from '@/lib/rag/versions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/documents/[id]/versions/compare?v1=1&v2=current
 * 两版本 chunk 级 diff（same/added/removed/changed + 参数差异 + 统计）
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const v1 = req.nextUrl.searchParams.get('v1') ?? ''
    const v2 = req.nextUrl.searchParams.get('v2') ?? 'current'
    if (!v1) return NextResponse.json({ error: '缺少 v1 参数' }, { status: 400 })
    if (v1 === v2) return NextResponse.json({ error: '两个版本相同，无对比意义' }, { status: 400 })
    const compare = await compareVersions(id, v1, v2)
    return NextResponse.json({ compare })
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    const status = msg.includes('不存在') || msg.includes('无对比') ? 404 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
