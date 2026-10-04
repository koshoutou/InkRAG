/**
 * POST /api/input/knowledge-bases/[id]/text（契约 §33）
 * Body: { name, text, chunkConfig?, engine? } → 201 { doc, deduplicated: boolean }
 * 实现复用 lib/rag/ingest.ts ingestTextContent（内容落 .md 产物后走同一流水线）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireApiKey } from '../../../_guard'
import { IngestError, ingestTextContent, type IngestOptions } from '@/lib/rag/ingest'
import { toDocSummary } from '@/lib/rag/serialize'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiKey(req, { write: true })
  if ('response' in guard) return guard.response
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体必须是 JSON 对象' }, { status: 400 })
    }
    if (typeof body.text !== 'string' || !body.text.length) {
      return NextResponse.json({ error: '缺少 text 字段（不能为空）' }, { status: 400 })
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      return NextResponse.json({ error: 'name 必须是字符串' }, { status: 400 })
    }
    let engine: 'mineru' | 'node' | undefined
    if (body.engine !== undefined) {
      if (body.engine !== 'mineru' && body.engine !== 'node') {
        return NextResponse.json({ error: `无效 engine: ${body.engine}（可选 mineru / node）` }, { status: 400 })
      }
      engine = body.engine
    }
    const opts: IngestOptions | undefined =
      body.chunkConfig || engine ? { chunkConfig: body.chunkConfig, engine } : undefined

    const r = await ingestTextContent(kb, String(body.name ?? ''), body.text, opts)
    const [chunkCount, enabledChunkCount] = r.deduplicated
      ? await Promise.all([
          db.chunk.count({ where: { documentId: r.doc.id, isParent: false } }),
          db.chunk.count({ where: { documentId: r.doc.id, isParent: false, enabled: true } }),
        ])
      : [0, 0]
    return NextResponse.json(
      { doc: toDocSummary(r.doc, { chunkCount, enabledChunkCount }), deduplicated: r.deduplicated },
      { status: 201 },
    )
  } catch (e: any) {
    if (e instanceof IngestError) {
      // F-CONC-05：429 背压时附带 Retry-After（秒）
      const res = NextResponse.json({ error: e.message }, { status: e.status })
      if (e.status === 429 && e.retryAfterSec) res.headers.set('Retry-After', String(e.retryAfterSec))
      return res
    }
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
