import { NextRequest, NextResponse } from 'next/server'
import { downloadSnapshotStream, toSnapshotErrorPayload } from '@/lib/rag/qdrant-snapshots'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ name: string }> }

function fail(e: unknown) {
  const { status, message } = toSnapshotErrorPayload(e)
  return NextResponse.json({ error: message }, { status })
 }

/**
 * GET /api/qdrant/snapshots/{name}/download?collection=
 * → 代理转发 qdrant 快照文件流（application/octet-stream + Content-Disposition attachment，
 *    避免前端直连 qdrant 端口；流式透传不落内存）。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { name } = await ctx.params
    const collection = new URL(req.url).searchParams.get('collection')?.trim() ?? ''
    if (!collection || !name) {
      return NextResponse.json({ error: '缺少 collection 参数' }, { status: 400 })
    }
    const upstream = await downloadSnapshotStream(collection, name)
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
    }
    const len = upstream.headers.get('content-length')
    if (len) headers['Content-Length'] = len
    return new NextResponse(upstream.body, { status: 200, headers })
  } catch (e) {
    return fail(e)
  }
}
