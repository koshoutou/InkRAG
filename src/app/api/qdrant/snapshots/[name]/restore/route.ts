import { NextRequest, NextResponse } from 'next/server'
import { restoreQdrantSnapshot, toSnapshotErrorPayload } from '@/lib/rag/qdrant-snapshots'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ name: string }> }

function fail(e: unknown) {
  const { status, message } = toSnapshotErrorPayload(e)
  return NextResponse.json({ error: message }, { status })
}

/**
 * POST /api/qdrant/snapshots/{name}/restore?collection= → { ok, message }
 * 语义：priority=snapshot——同名集合被快照内容覆盖（不存在则新建）；破坏性操作，UI 需二次确认。
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { name } = await ctx.params
    const collection = new URL(req.url).searchParams.get('collection')?.trim() ?? ''
    if (!collection || !name) {
      return NextResponse.json({ error: '缺少 collection 参数' }, { status: 400 })
    }
    return NextResponse.json(await restoreQdrantSnapshot(collection, name))
  } catch (e) {
    return fail(e)
  }
}
