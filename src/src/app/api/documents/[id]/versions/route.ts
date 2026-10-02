import { NextRequest, NextResponse } from 'next/server'
import { listDocVersions } from '@/lib/rag/versions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/documents/[id]/versions
 * 列出文档全部可用版本（current=DB 当前 + 文件快照倒序）
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const versions = await listDocVersions(id)
    return NextResponse.json({ versions })
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    const status = msg.includes('不存在') ? 404 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
