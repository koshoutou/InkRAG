/**
 * /api/input/knowledge-bases/[id]（契约 §33）
 *   GET    → { kb: KbSummary } / 404
 *   DELETE → { ok: true, deleted: { docs, chunks, points, cancelledJobs } } / 404
 *            （语义与 /api/kb/[id] DELETE 完全一致：lib/rag/kb.ts deleteKnowledgeBaseCore）
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireApiKey } from '../../_guard'
import { kbSummaryWithCounts, deleteKnowledgeBaseCore } from '@/lib/rag/kb'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/input/knowledge-bases/[id] → { kb } */
export async function GET(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiKey(req)
  if ('response' in guard) return guard.response
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })
    return NextResponse.json({ kb: await kbSummaryWithCounts(kb) })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/** DELETE /api/input/knowledge-bases/[id] → 级联删除（在途任务取消 → 向量集合 → 行 → 磁盘产物） */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiKey(req, { write: true })
  if ('response' in guard) return guard.response
  try {
    const { id } = await ctx.params
    const r = await deleteKnowledgeBaseCore(id)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, deleted: r.deleted })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
