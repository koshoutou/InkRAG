/**
 * POST /api/input/documents/[id]/retry（契约 §33）→ { ok, stage }
 * 失败文档重试：从失败阶段续跑（不产生新版本）。
 * 实现复用 lib/rag/kb.ts retryFailedDocumentCore —— 与 /api/documents/[id]/action retry 分支同一语义：
 *   - 仅 failed 状态可重试（其余 → 409 流水线保护）
 *   - 续跑前自动取消该文档在途任务（审计#N14）
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireApiKey } from '../../../_guard'
import { retryFailedDocumentCore } from '@/lib/rag/kb'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiKey(req, { write: true })
  if ('response' in guard) return guard.response
  try {
    const { id } = await ctx.params
    const r = await retryFailedDocumentCore(id)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, stage: r.stage })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
