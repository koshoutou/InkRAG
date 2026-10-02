import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { getVectorStore } from '@/lib/rag/vectorstore'
import { chunksDir } from '@/lib/rag/artifacts'
import { updateKbStats } from '@/lib/rag/pipeline'
import { toChunkItem } from '@/lib/rag/serialize'
import { editChunkText, revertChunkText } from '@/lib/rag/chunkedit'
import { bumpDocVersion } from '@/lib/rag/versions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string; chunkId: string }> }

/**
 * GET /api/documents/[id]/chunk/[chunkId]?full=1
 * → { chunk: ChunkItem & { text, parentText? } }
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id, chunkId } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })
    const chunk = await db.chunk.findUnique({ where: { id: chunkId } })
    if (!chunk || chunk.documentId !== id) {
      return NextResponse.json({ error: 'chunk 不存在' }, { status: 404 })
    }

    const url = new URL(req.url)
    const full = url.searchParams.get('full') === '1'
    if (!full) return NextResponse.json({ chunk: toChunkItem(chunk) })

    let text = ''
    try {
      text = await fs.readFile(path.join(chunksDir(doc.kbId, doc.id), `${chunkId}.txt`), 'utf-8')
    } catch {
      text = chunk.textPreview
    }
    let parentText: string | undefined
    if (chunk.parentId) {
      const parent = await db.chunk.findUnique({ where: { id: chunk.parentId } })
      if (parent) {
        try {
          parentText = await fs.readFile(
            path.join(chunksDir(doc.kbId, doc.id), `${parent.id}.txt`),
            'utf-8'
          )
        } catch {
          parentText = parent.textPreview
        }
      }
    }
    return NextResponse.json({ chunk: { ...toChunkItem(chunk), text, parentText } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/**
 * PATCH /api/documents/[id]/chunk/[chunkId] Body: { enabled } | { text } | { revert: true }
 * - enabled：软禁用（payload.enabled + 检索恒过滤，对标 RAGFlow）
 * - text：编辑全文 → 备份原文 → 重嵌入 → 同 ID 原地 upsert（M6 T6.6）
 * - revert：从 .orig.txt 还原 → 重嵌入 → editedAt 置空
 * §27：三个分支统一先归档当前 chunk 集并递增文档版本号（bumpDocVersion），
 *      三屏联动的启用/停用/编辑/还原均可通过「文档版本管理」回滚
 * 仅子 chunk 支持编辑（父 chunk 由切分器生成，编辑会在下次重切时丢失）
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id, chunkId } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })
    const chunk = await db.chunk.findUnique({ where: { id: chunkId } })
    if (!chunk || chunk.documentId !== id) {
      return NextResponse.json({ error: 'chunk 不存在' }, { status: 404 })
    }
    const body = await req.json().catch(() => ({}))

    // ---- 分支 1：编辑全文重入库（§27 先归档 + 版本号递增） ----
    if (typeof body.text === 'string') {
      if (chunk.isParent) {
        return NextResponse.json(
          { error: '父 chunk 不支持编辑（由切分器生成，请编辑其子 chunk）' },
          { status: 400 }
        )
      }
      const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
      if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })
      try {
        const newVersion = await bumpDocVersion(id)
        const result = await editChunkText(kb, doc, chunk, body.text)
        const updated = await db.chunk.findUnique({ where: { id: chunkId } })
        return NextResponse.json({ chunk: toChunkItem(updated!), result, version: newVersion })
      } catch (e: any) {
        const status = /流水线中/.test(String(e?.message)) ? 409 : 400
        return NextResponse.json({ error: e?.message ?? String(e) }, { status })
      }
    }

    // ---- 分支 2：还原原文（§27 先归档 + 版本号递增） ----
    if (body.revert === true) {
      if (chunk.isParent) {
        return NextResponse.json({ error: '父 chunk 不支持还原' }, { status: 400 })
      }
      const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
      if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })
      try {
        const newVersion = await bumpDocVersion(id)
        const result = await revertChunkText(kb, doc, chunk)
        const updated = await db.chunk.findUnique({ where: { id: chunkId } })
        return NextResponse.json({ chunk: toChunkItem(updated!), result, version: newVersion })
      } catch (e: any) {
        const status = /流水线中/.test(String(e?.message)) ? 409 : 400
        return NextResponse.json({ error: e?.message ?? String(e) }, { status })
      }
    }

    // ---- 分支 3：软禁用（§27 先归档 + 版本号递增，原 payload 同步逻辑保留） ----
    if (body.enabled === undefined) {
      return NextResponse.json({ error: '缺少 enabled 字段' }, { status: 400 })
    }
    const enabled = body.enabled === true
    const newVersion = await bumpDocVersion(id).catch((e: Error) => {
      throw new Error(e.message)
    })
    const updated = await db.chunk.update({ where: { id: chunkId }, data: { enabled } })

    // 同步向量 payload（qdrant 模式 setPayload；local 模式同样更新 payloadJson）
    try {
      const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
      if (kb) {
        const store = await getVectorStore()
        await store.setPayload(kb.collection, [chunkId], { enabled })
      }
    } catch (e: any) {
      console.warn('[chunk] 同步向量 enabled 失败:', e?.message ?? e)
    }

    return NextResponse.json({ chunk: toChunkItem(updated), version: newVersion })
  } catch (e: any) {
    const status = /流水线中/.test(String(e?.message)) ? 409 : 500
    return NextResponse.json({ error: e?.message ?? String(e) }, { status })
  }
}

/**
 * DELETE /api/documents/[id]/chunk/[chunkId]：向量点 + 行 + 磁盘
 * §27：删除前先归档当前 chunk 集并递增文档版本号（可从历史版本恢复）
 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, chunkId } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })
    const chunk = await db.chunk.findUnique({ where: { id: chunkId } })
    if (!chunk || chunk.documentId !== id) {
      return NextResponse.json({ error: 'chunk 不存在' }, { status: 404 })
    }

    // §27：先归档 + 版本号递增（流水线中会抛错 → 409）
    const newVersion = await bumpDocVersion(id)

    // 1) 向量点
    try {
      const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
      if (kb) {
        const store = await getVectorStore()
        await store.deletePoints(kb.collection, [chunkId])
      }
    } catch (e: any) {
      console.warn('[chunk] 删除向量点失败:', e?.message ?? e)
    }
    // 2) 子 chunk 引用置空 + 删行
    await db.chunk.updateMany({
      where: { parentId: chunkId },
      data: { parentId: null },
    })
    await db.chunk.delete({ where: { id: chunkId } })
    // 3) 磁盘
    await fs.rm(path.join(chunksDir(doc.kbId, doc.id), `${chunkId}.txt`), { force: true })
    await fs.rm(path.join(chunksDir(doc.kbId, doc.id), `${chunkId}.orig.txt`), { force: true })

    await updateKbStats(doc.kbId)
    return NextResponse.json({ ok: true, version: newVersion })
  } catch (e: any) {
    const status = /流水线中/.test(String(e?.message)) ? 409 : 500
    return NextResponse.json({ error: e?.message ?? String(e) }, { status })
  }
}
