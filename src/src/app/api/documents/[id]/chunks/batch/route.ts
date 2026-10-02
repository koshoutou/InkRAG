import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getVectorStore } from '@/lib/rag/vectorstore'
import { updateKbStats } from '@/lib/rag/pipeline'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/documents/[id]/chunks/batch  （契约 §13）
 * Body: { action: 'enable'|'disable', chunkIds?: string[], scope?: 'children'|'all' }
 * - chunkIds 指定集合（校验全部属于该文档）；否则按 scope 查询
 *   （children = 仅子 chunk，默认；all = 含父 chunk）
 * - DB updateMany + 向量 setPayload 批量同步；payload 同步失败仅计数，不回滚 DB
 * → ChunkBatchResult = { ok, action, updated, payloadSyncFailed }
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const action = body?.action
    if (action !== 'enable' && action !== 'disable') {
      return NextResponse.json({ error: "action 必须为 'enable' 或 'disable'" }, { status: 400 })
    }
    const enabled = action === 'enable'

    // 目标 id 集合：显式 chunkIds（校验归属）或按 scope 全量查询
    let ids: string[]
    if (Array.isArray(body.chunkIds) && body.chunkIds.length > 0) {
      const uniqueIds = [...new Set(body.chunkIds.filter((x: unknown): x is string => typeof x === 'string'))]
      if (uniqueIds.length === 0) {
        return NextResponse.json({ error: 'chunkIds 为空或格式不合法' }, { status: 400 })
      }
      const found = await db.chunk.findMany({
        where: { id: { in: uniqueIds }, documentId: id },
        select: { id: true },
      })
      if (found.length !== uniqueIds.length) {
        return NextResponse.json(
          { error: '部分 chunkId 不属于该文档（批量操作不允许跨文档）' },
          { status: 400 },
        )
      }
      ids = found.map((c) => c.id)
    } else {
      const scope = body?.scope === 'all' ? 'all' : 'children'
      const found = await db.chunk.findMany({
        where: { documentId: id, ...(scope === 'children' ? { isParent: false } : {}) },
        select: { id: true },
      })
      ids = found.map((c) => c.id)
    }

    // DB 更新（updated=0 时仍 200）
    const res = await db.chunk.updateMany({
      where: { id: { in: ids }, documentId: id },
      data: { enabled },
    })

    // 向量 payload 批量同步（失败仅计数，不回滚 DB —— 与单条启停语义一致）
    let payloadSyncFailed = 0
    if (ids.length > 0) {
      try {
        const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
        if (kb) {
          const store = await getVectorStore()
          await store.setPayload(kb.collection, ids, { enabled })
        }
      } catch (e: any) {
        payloadSyncFailed = res.count
        console.warn('[chunks/batch] 向量 payload 同步失败:', e?.message ?? e)
      }
    }

    // KB 统计（enabledChunkCount 口径）刷新
    try {
      await updateKbStats(doc.kbId)
    } catch {}

    return NextResponse.json({ ok: true, action, updated: res.count, payloadSyncFailed })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
