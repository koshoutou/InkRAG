/**
 * GET /api/input/documents?kbId=&status=&q=&limit=&offset=（契约 §33）
 * → { docs: DocSummary[], total }
 * kbId 省略 = 全库文档；status 过滤状态；q 按文件名模糊匹配；limit 1..200（默认 50）/ offset ≥ 0。
 * 与 /api/kb/[id]/documents GET 同口径（createdAt 倒序 + chunk 计数）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireApiKey } from '../_guard'
import { toDocSummary } from '@/lib/rag/serialize'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const guard = await requireApiKey(req)
  if ('response' in guard) return guard.response
  try {
    const url = new URL(req.url)
    const kbId = url.searchParams.get('kbId') || undefined
    const status = url.searchParams.get('status') || undefined
    const q = url.searchParams.get('q') || undefined
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50') || 50, 1), 200)
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0') || 0, 0)

    // kbId 指定但不存在 → 404（避免静默返回空列表）
    if (kbId) {
      const kb = await db.knowledgeBase.findUnique({ where: { id: kbId } })
      if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })
    }

    const where: Record<string, unknown> = {}
    if (kbId) where.kbId = kbId
    if (status) where.status = status
    if (q) where.filename = { contains: q }

    const [docs, total] = await Promise.all([
      db.document.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      db.document.count({ where }),
    ])

    const docSummaries = await Promise.all(
      docs.map(async (d) => {
        const [chunkCount, enabledChunkCount] = await Promise.all([
          db.chunk.count({ where: { documentId: d.id, isParent: false } }),
          db.chunk.count({ where: { documentId: d.id, isParent: false, enabled: true } }),
        ])
        return toDocSummary(d, { chunkCount, enabledChunkCount })
      })
    )
    return NextResponse.json({ docs: docSummaries, total })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
