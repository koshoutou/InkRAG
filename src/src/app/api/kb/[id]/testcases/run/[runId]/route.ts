import { NextRequest, NextResponse } from 'next/server'
import { getTestRun } from '@/lib/rag/testset'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string; runId: string }> }

/** GET /api/kb/[id]/testcases/run/[runId] → { run: TestRunState | null }（404 = 不存在或已清理） */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { runId } = await ctx.params
    const run = getTestRun(runId)
    if (!run) return NextResponse.json({ error: '运行记录不存在或已被清理' }, { status: 404 })
    return NextResponse.json({ run })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
