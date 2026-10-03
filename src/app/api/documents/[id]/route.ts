import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { getVectorStore } from '@/lib/rag/vectorstore'
import { markdownPath, middleJsonPath, removeDocDir, sourcePath } from '@/lib/rag/artifacts'
import { toDocSummary } from '@/lib/rag/serialize'
import { cancelDocumentJobs, updateKbStats } from '@/lib/rag/pipeline'
import type { Document, KnowledgeBase } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

async function loadDoc(id: string): Promise<{ doc: Document; kb: KnowledgeBase } | null> {
  const doc = await db.document.findUnique({ where: { id } })
  if (!doc) return null
  const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
  if (!kb) return null
  return { doc, kb }
}

/** GET /api/documents/[id] → { doc: DocSummary & 附加信息 } */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const loaded = await loadDoc(id)
    if (!loaded) return NextResponse.json({ error: '文档不存在' }, { status: 404 })
    const { doc } = loaded

    const [chunkCount, enabledChunkCount] = await Promise.all([
      db.chunk.count({ where: { documentId: id, isParent: false } }),
      db.chunk.count({ where: { documentId: id, isParent: false, enabled: true } }),
    ])
    const ext = path.extname(doc.filename).toLowerCase().replace('.', '') || 'bin'
    const [markdownAvailable, middleAvailable, sourceAvailable] = await Promise.all([
      fs
        .access(markdownPath(doc.kbId, doc.id))
        .then(() => true)
        .catch(() => false),
      fs
        .access(middleJsonPath(doc.kbId, doc.id))
        .then(() => true)
        .catch(() => false),
      fs
        .access(sourcePath(doc.kbId, doc.id, ext))
        .then(() => true)
        .catch(() => false),
    ])

    return NextResponse.json({
      doc: {
        ...toDocSummary(doc, { chunkCount, enabledChunkCount }),
        chunkConfigSnap: JSON.parse(doc.chunkConfigSnap || '{}'),
        storageKey: doc.storageKey,
        markdownAvailable,
        middleJsonAvailable: middleAvailable,
        sourceAvailable,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/** DELETE /api/documents/[id] 级联：向量 → chunks → document → 磁盘 → count 校验 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const loaded = await loadDoc(id)
    if (!loaded) return NextResponse.json({ error: '文档不存在' }, { status: 404 })
    const { doc, kb } = loaded

    // 0) 先取消该文档全部在途任务（pending/active/waiting_mineru → cancelled + abort；审计#N13 同 KB 删除）
    await cancelDocumentJobs(id)

    // 1) 向量 delete(filter doc_id)
    try {
      const store = await getVectorStore()
      await store.deleteByFilter(kb.collection, {
        must: [{ key: 'doc_id', match: { value: doc.id } }],
      })
    } catch (e: any) {
      console.warn('[doc] 删除向量失败（可能无数据）:', e?.message ?? e)
    }
    // 2) chunk 行 + document 行 + 任务
    const deletedChunks = await db.chunk.count({ where: { documentId: id } })
    await db.chunk.deleteMany({ where: { documentId: id } })
    await db.pipelineJob.deleteMany({ where: { documentId: id } })
    await db.document.delete({ where: { id } })
    // 3) 磁盘产物
    await removeDocDir(doc.kbId, doc.id)
    // 4) count 校验
    const remain = await db.chunk.count({ where: { documentId: id } })
    if (remain !== 0) console.warn(`[doc] 删除校验失败：仍残留 ${remain} chunks`)

    await updateKbStats(doc.kbId)
    return NextResponse.json({ ok: true, deletedChunks })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
