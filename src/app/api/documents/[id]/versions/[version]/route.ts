import { NextRequest, NextResponse } from 'next/server'
import { deleteDocVersion } from '@/lib/rag/versions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string; version: string }> }

/**
 * DELETE /api/documents/[id]/versions/[version]（契约 §27）
 * 删除历史版本快照（'current' 无文件不可删 → 400）
 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, version } = await ctx.params
    await deleteDocVersion(id, version)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    const status = /不存在|无效版本|不可删除/.test(String(e?.message ?? '')) ? 400 : 500
    return NextResponse.json({ error: e?.message ?? String(e) }, { status })
  }
}
