import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { listTestRuns } from '@/lib/rag/testset'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/kb/[id]/testruns → { runs: TestRunHistoryItem[] }（契约 §24）
 * 数据源：§21 globalThis 注册表（进程内，重启清零）；按 startedAt 倒序，
 * 含 running + 最近完成的 ≤20 条；done 态给 summary 汇总（不含 cases 明细）。
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })
    return NextResponse.json({ runs: listTestRuns(id) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
