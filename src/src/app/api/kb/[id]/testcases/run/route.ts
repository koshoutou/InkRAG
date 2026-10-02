import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runTestSet, startTestRun, getRunningTestRun, ASYNC_THRESHOLD } from '@/lib/rag/testset'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/kb/[id]/testcases/run body { caseIds?; onlyEnabled? = true; async? }
 * 规模 ≤ ASYNC_THRESHOLD 或显式 async=false → 同步直跑（{ report }，兼容旧契约）
 * 规模 > ASYNC_THRESHOLD 或显式 async=true → 后台 job（{ run: TestRunState }，用 runId 轮询状态）
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const opts =
      body && typeof body === 'object'
        ? {
            caseIds: Array.isArray(body.caseIds)
              ? body.caseIds.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
              : undefined,
            onlyEnabled: typeof body.onlyEnabled === 'boolean' ? body.onlyEnabled : undefined,
            forceAsync: body.async === true,
          }
        : { forceAsync: false }

    // 与 runTestSet 相同的筛选语义，先做空集判定（0 条用例 → 400）
    const where: Record<string, unknown> = { kbId: id }
    if (opts.caseIds && opts.caseIds.length > 0) {
      where.id = { in: opts.caseIds }
    } else if (opts.onlyEnabled ?? true) {
      where.enabled = true
    }
    const count = await db.retrievalTestCase.count({ where })
    if (count === 0) {
      return NextResponse.json({ error: '该知识库暂无用例' }, { status: 400 })
    }

    // 防重复启动：已有进行中的运行 → 409 返回现有状态（前端直接接管轮询）
    const running = getRunningTestRun(id)
    if (running) {
      return NextResponse.json(
        { run: running, note: '已有进行中的回归运行' },
        { status: 409 },
      )
    }

    // 分支：显式 async 或规模超阈值 → 后台 job
    if (opts.forceAsync || count > ASYNC_THRESHOLD) {
      const run = await startTestRun(id, { caseIds: opts.caseIds, onlyEnabled: opts.onlyEnabled })
      return NextResponse.json({ run })
    }

    const report = await runTestSet(id, { caseIds: opts.caseIds, onlyEnabled: opts.onlyEnabled })
    return NextResponse.json({ report })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
