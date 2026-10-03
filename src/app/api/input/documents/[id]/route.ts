/**
 * /api/input/documents/[id]（契约 §33）
 *   GET    → { doc: DocSummary & 产物可用性 / 错误字段 } / 404
 *   DELETE → { ok: true, deletedChunks } / 404（语义与 /api/documents/[id] DELETE 一致：
 *            lib/rag/kb.ts deleteDocumentCore —— 向量删除 / 产物清理 / cancelDocumentJobs / updateKbStats）
 */
import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { requireApiKey } from '../../_guard'
import { deleteDocumentCore } from '@/lib/rag/kb'
import { toDocSummary } from '@/lib/rag/serialize'
import { markdownPath, middleJsonPath, sourcePath } from '@/lib/rag/artifacts'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/input/documents/[id] → { doc }（含 chunk 计数、errorCode/errorMessage、产物可用性） */
export async function GET(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiKey(req)
  if ('response' in guard) return guard.response
  try {
    const { id } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })

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

/** DELETE /api/input/documents/[id] → 级联删除（在途任务取消 → 向量 → 行 → 磁盘 → 统计回写） */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiKey(req, { write: true })
  if ('response' in guard) return guard.response
  try {
    const { id } = await ctx.params
    const r = await deleteDocumentCore(id)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, deletedChunks: r.deletedChunks })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
