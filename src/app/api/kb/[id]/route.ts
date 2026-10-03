import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { kbSummaryWithCounts, deleteKnowledgeBaseCore } from '@/lib/rag/kb'
import { parseChunkConfig, toDocSummary } from '@/lib/rag/serialize'

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

/**
 * DELETE /api/kb/[id] 级联：文档 + chunks + 向量集合 + 磁盘产物
 * 实现抽取至 lib/rag/kb.ts deleteKnowledgeBaseCore（Task 17-2，与 /api/input 同一语义）
 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const r = await deleteKnowledgeBaseCore(id)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, deleted: r.deleted })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
