import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensurePipelineEngine } from '@/lib/rag/pipeline'
import { jobUpdate } from '@/lib/rag/events'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** POST /api/system/jobs/[id]/retry —— failed → pending 重排队 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    ensurePipelineEngine()
    const { id } = await ctx.params
    const job = await db.pipelineJob.findUnique({ where: { id } })
    if (!job) return NextResponse.json({ error: '任务不存在' }, { status: 404 })
    if (job.status !== 'failed') {
      return NextResponse.json({ error: `仅 failed 任务可重试（当前 ${job.status}）` }, { status: 400 })
    }
    await db.pipelineJob.update({
      where: { id },
      data: { status: 'pending', attempts: 0, error: null, startedAt: null, finishedAt: null },
    })
    // 关联文档若处于 failed → 回 queued（并刷新本次运行起点，供 document:done tookMs 用）
    const doc = await db.document.findUnique({ where: { id: job.documentId } })
    if (doc && doc.status === 'failed') {
      let meta: Record<string, unknown> = {}
      try {
        const v = JSON.parse(doc.metaJson || '{}')
        if (typeof v === 'object' && v) meta = v
      } catch {}
      await db.document.update({
        where: { id: doc.id },
        data: {
          status: 'queued',
          stageProgress: 0,
          errorCode: null,
          errorMessage: null,
          metaJson: JSON.stringify({ ...meta, runStartedAt: Date.now() }),
        },
      })
    }
    await jobUpdate({
      jobId: job.id,
      documentId: job.documentId,
      type: job.type,
      status: 'pending',
    })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
