import { NextRequest, NextResponse } from 'next/server'
import { deleteQdrantSnapshot, toSnapshotErrorPayload } from '@/lib/rag/qdrant-snapshots'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ name: string }> }

function fail(e: unknown) {
  const { status, message } = toSnapshotErrorPayload(e)
  return NextResponse.json({ error: message }, { status })
}

/** DELETE /api/qdrant/snapshots/{name}?collection= → { ok: true }（快照不存在 → 404） */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const { name } = await ctx.params
    const collection = new URL(req.url).searchParams.get('collection')?.trim() ?? ''
    if (!collection || !name) {
      return NextResponse.json({ error: '缺少 collection 参数' }, { status: 400 })
    }
    return NextResponse.json(await deleteQdrantSnapshot(collection, name))
  } catch (e) {
    return fail(e)
  }
}
