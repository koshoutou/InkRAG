import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import { db } from '@/lib/db'
import { getVectorStore } from '@/lib/rag/vectorstore'
import { kbSummaryWithCounts } from '@/lib/rag/kb'
import { parseChunkConfig, toDocSummary } from '@/lib/rag/serialize'
import { ARTIFACTS_ROOT } from '@/lib/rag/artifacts'
import { cancelKbJobs } from '@/lib/rag/pipeline'
import path from 'node:path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/kb/[id] → { kb: KbSummary & { recentDocs: DocSummary[] } } */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })
    const docs = await db.document.findMany({
      where: { kbId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    const docSummaries = await Promise.all(
      docs.map(async (d) => {
        const [chunkCount, enabledChunkCount] = await Promise.all([
          db.chunk.count({ where: { documentId: d.id, isParent: false } }),
          db.chunk.count({ where: { documentId: d.id, isParent: false, enabled: true } }),
        ])
        return toDocSummary(d, { chunkCount, enabledChunkCount })
      })
    )
    return NextResponse.json({
      kb: { ...(await kbSummaryWithCounts(kb)), recentDocs: docSummaries },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/** PATCH /api/kb/[id] Body: { name?, description?, chunkConfig?, rerankEnabled? } */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })
    const body = await req.json().catch(() => ({}))

    const data: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) return NextResponse.json({ error: '名称不能为空' }, { status: 400 })
      if (name !== kb.name) {
        const dup = await db.knowledgeBase.findUnique({ where: { name } })
        if (dup) return NextResponse.json({ error: `知识库名称已存在：${name}` }, { status: 409 })
      }
      data.name = name
    }
    if (body.description !== undefined) data.description = String(body.description)
    if (body.chunkConfig !== undefined) {
      data.chunkConfig = JSON.stringify(parseChunkConfig(JSON.stringify(body.chunkConfig)))
    }
    if (body.rerankEnabled !== undefined) data.rerankEnabled = body.rerankEnabled === true
    // dim / embeddingModel 建库后不可改（换模型 = 新建库重导）
    if (body.dim !== undefined && Number(body.dim) !== kb.dim) {
      return NextResponse.json({ error: 'dim 建库后不可修改（换模型请新建知识库）' }, { status: 400 })
    }
    if (body.embeddingModel !== undefined && String(body.embeddingModel) !== kb.embeddingModel) {
      return NextResponse.json({ error: 'embeddingModel 建库后不可修改' }, { status: 400 })
    }

    const updated = await db.knowledgeBase.update({ where: { id }, data })
    return NextResponse.json({ kb: await kbSummaryWithCounts(updated) })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/** DELETE /api/kb/[id] 级联：文档 + chunks + 向量集合 + 磁盘产物 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const docs = await db.document.findMany({ where: { kbId: id }, select: { id: true } })
    const chunkCount = await db.chunk.count({ where: { kbId: id } })

    // 0) 先取消该 KB 全部在途任务（pending/active/waiting_mineru → cancelled + abort）。
    // 审计#N13：原先不取消 → 删除后 runJob 下轮查 kb=null 抛「知识库不存在」+ 产物目录已删 → 半写状态。
    // 必须先取消再删向量/行/目录。
    const cancelledJobs = await cancelKbJobs(id)

    // 1) 向量集合整体删除（Qdrant deleteCollection；不可达时跳过并告警，行数据仍级联删除）
    let pointsDeleted = 0
    try {
      const store = await getVectorStore()
      pointsDeleted = await store.count(kb.collection).catch(() => 0)
      await store.deleteCollection(kb.collection)
    } catch (e: any) {
      console.warn('[kb] 删除向量集合失败（可能不存在/不可达）:', e?.message ?? e)
    }
    // 2) 行删除（Chunk/Document 级联）
    await db.chunk.deleteMany({ where: { kbId: id } })
    await db.document.deleteMany({ where: { kbId: id } })
    await db.pipelineJob.deleteMany({ where: { kbId: id } })
    await db.knowledgeBase.delete({ where: { id } })
    // 3) 磁盘产物
    await fs.rm(path.join(ARTIFACTS_ROOT, id), { recursive: true, force: true })

    // 4) count 校验
    const remain = await db.chunk.count({ where: { kbId: id } })
    if (remain !== 0) {
      console.warn(`[kb] 级联删除校验失败：仍残留 ${remain} chunks`)
    }

    return NextResponse.json({
      ok: true,
      deleted: { docs: docs.length, chunks: chunkCount, points: pointsDeleted, cancelledJobs },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
