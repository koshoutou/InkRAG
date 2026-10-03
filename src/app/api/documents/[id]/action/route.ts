import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getVectorStore } from '@/lib/rag/vectorstore'
import { enqueueDocument } from '@/lib/rag/pipeline'
import { parseChunkConfig } from '@/lib/rag/serialize'
import { retryFailedDocumentCore } from '@/lib/rag/kb'
import { snapshotDocVersion } from '@/lib/rag/versions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/documents/[id]/action
 * Body: { action: 'reparse' | 'rechunk' | 'retry', chunkConfig? }
 * - reparse：重走全流水线（parseConfigV+1；旧版本先归档快照，供文档版本管理）
 * - rechunk：只重切分（跳过解析，parseConfigV+1，chunk job 内清旧 chunk/向量；旧版本先归档快照）
 * - retry：失败重试（从失败阶段续跑，不产生新版本）
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })
    const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const action = String(body.action ?? '')
    if (!['reparse', 'rechunk', 'retry'].includes(action)) {
      return NextResponse.json({ error: `无效 action: ${action}` }, { status: 400 })
    }

    if (action === 'reparse') {
      // 新版本产生前归档当前 chunk 集（best-effort，失败不阻塞动作）
      await snapshotDocVersion(id)
      await db.document.update({
        where: { id },
        data: {
          status: 'queued',
          stageProgress: 0,
          parseConfigV: doc.parseConfigV + 1,
          errorCode: null,
          errorMessage: null,
          mineruJobId: null,
          mineruFileId: null,
        },
      })
      await clearVectors(doc.id, doc.kbId, kb.collection)
      await enqueueDocument(id, 'parse')
    } else if (action === 'rechunk') {
      // 新版本产生前归档当前 chunk 集（best-effort，失败不阻塞动作）
      await snapshotDocVersion(id)
      const patch: Record<string, unknown> = {
        status: 'queued',
        stageProgress: 0,
        parseConfigV: doc.parseConfigV + 1,
        errorCode: null,
        errorMessage: null,
      }
      if (body.chunkConfig) {
        patch.chunkConfigSnap = JSON.stringify(parseChunkConfig(JSON.stringify(body.chunkConfig)))
      }
      await db.document.update({ where: { id }, data: patch })
      await clearVectors(doc.id, doc.kbId, kb.collection)
      await enqueueDocument(id, 'chunk')
    } else {
      // retry：从失败阶段续跑（实现抽取至 lib/rag/kb.ts retryFailedDocumentCore，Task 17-2；
      // 仅 failed 文档可重试（409），与 /api/input/documents/[id]/retry 同一语义）
      const r = await retryFailedDocumentCore(id)
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    }

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

async function clearVectors(docId: string, kbId: string, collection: string) {
  void kbId
  try {
    const store = await getVectorStore()
    await store.deleteByFilter(collection, {
      must: [{ key: 'doc_id', match: { value: docId } }],
    })
  } catch (e: any) {
    console.warn('[action] 清理旧向量跳过:', e?.message ?? e)
  }
}
