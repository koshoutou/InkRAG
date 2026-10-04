import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensurePipelineEngine } from '@/lib/rag/pipeline'
import { jobUpdate } from '@/lib/rag/events'
import { recordOp } from '@/lib/rag/oplog'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/documents/[id]/retry-with-node
 *
 * MinerU 失败后降级重试：把文档 engineChoice 改为 'node'（本地解析器），
 * 失败的 parse job 重置为 pending，文档回 queued。
 *
 * 适用场景：MinerU CDN 证书过期 / MinerU 云服务不可达 / MinerU 配额耗尽 等
 * MinerU 侧问题导致的解析失败，原文用 Node 引擎（fallback parser）仍可解析。
 * （PDF 受 PERF-004/005 限制：100MB 以上拒绝；其他格式无限制）
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    ensurePipelineEngine()
    const { id } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })
    if (doc.status !== 'failed') {
      return NextResponse.json({ error: `仅 failed 文档可降级重试（当前 ${doc.status}）` }, { status: 400 })
    }

    // 解析原 metaJson，覆盖 engineChoice = 'node'（清 MinerU 远端字段避免续传）
    let meta: Record<string, unknown> = {}
    try {
      const v = JSON.parse(doc.metaJson || '{}')
      if (typeof v === 'object' && v) meta = v
    } catch {
      /* 损坏 metaJson 用空对象兜底 */
    }
    meta.engineChoice = 'node'
    meta.fallbackFromMineru = true
    meta.fallbackAt = new Date().toISOString()
    meta.runStartedAt = Date.now()
    // 清 MinerU 续传字段（重入 execParse 会按 node 引擎走，不探测旧 jobId）
    meta.mineruJobId = undefined
    meta.mineruUploadId = undefined
    meta.mineruFileId = undefined

    await db.document.update({
      where: { id },
      data: {
        status: 'queued',
        stageProgress: 0,
        errorCode: null,
        errorMessage: null,
        parseEngine: '',
        mineruJobId: null,
        mineruUploadId: null,
        mineruFileId: null,
        metaJson: JSON.stringify(meta),
      },
    })

    // 失败的 parse job 重置为 pending（type='parse'）
    const failedParseJobs = await db.pipelineJob.findMany({
      where: { documentId: id, type: 'parse', status: 'failed' },
      take: 1,
    })
    if (failedParseJobs.length > 0) {
      const job = failedParseJobs[0]
      await db.pipelineJob.update({
        where: { id: job.id },
        data: { status: 'pending', attempts: 0, error: null, startedAt: null, finishedAt: null },
      })
      await jobUpdate({
        jobId: job.id,
        documentId: id,
        type: 'parse',
        status: 'pending',
      })
    } else {
      // 无失败 parse job（可能被 clean 清掉）→ 新建一个 parse job
      await db.pipelineJob.create({
        data: {
          documentId: id,
          kbId: doc.kbId,
          type: 'parse',
          status: 'pending',
        },
      })
    }

    recordOp({
      level: 'warn',
      category: 'document',
      action: 'document.retry_with_node',
      message: `文档 ${doc.filename} MinerU 失败后降级为 Node 引擎重试`,
      detail: { docId: id, originalEngine: 'mineru', fallbackEngine: 'node' },
    })

    return NextResponse.json({ ok: true, engine: 'node' })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
