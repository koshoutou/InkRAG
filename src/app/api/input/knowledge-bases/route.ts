/**
 * /api/input/knowledge-bases（契约 §33）
 *   GET  → { kbs: KbSummary[] }（含 retrievalMode 元数据）
 *   POST → 201 { kb: KbSummary }（实现复用 lib/rag/kbcreate.ts createKnowledgeBaseCore，与平台 UI 建库同一语义）
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireApiKey } from '../_guard'
import { createKnowledgeBaseCore } from '@/lib/rag/kbcreate'
import { kbSummaries, kbSummaryWithCounts } from '@/lib/rag/kb'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** GET /api/input/knowledge-bases → { kbs } */
export async function GET(req: NextRequest) {
  const guard = await requireApiKey(req)
  if ('response' in guard) return guard.response
  try {
    const kbs = await db.knowledgeBase.findMany({ orderBy: { createdAt: 'desc' } })
    return NextResponse.json({ kbs: await kbSummaries(kbs) })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/**
 * POST /api/input/knowledge-bases
 * Body: { name, description?, chunkConfig? {size,overlap,parentSize,strategy,protects},
 *         rerankEnabled?, retrievalMode? 'hybrid'|'dense'|'sparse', dim? }
 * → 201 { kb: KbSummary }
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiKey(req, { write: true })
  if ('response' in guard) return guard.response
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体必须是 JSON 对象' }, { status: 400 })
    }
    const r = await createKnowledgeBaseCore(body as Record<string, unknown>)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ kb: await kbSummaryWithCounts(r.kb) }, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
