import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireDatasetKey, notFoundDataset, notFoundDocument } from '../../../../../_guard'
import { mapIndexingStatus, docSegments } from '../../../../../_map'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ dataset_id: string; document_id: string }> }

/**
 * GET /v1/datasets/{dataset_id}/documents/{batch}/indexing-status（Dify 兼容）
 * 索引进度查询。Dify 的 batch 即单文件批次——本平台一次上传一个文档，batch = 文档 id。
 * indexing_status 生命周期：waiting → parsing → cleaning → splitting → indexing → completed | error。
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const g = await requireDatasetKey(req)
  if (!g.ok) return g.response
  const { dataset_id, document_id } = await ctx.params
  const kb = await db.knowledgeBase.findUnique({ where: { id: dataset_id } })
  if (!kb) return notFoundDataset()
  const doc = await db.document.findUnique({ where: { id: document_id } })
  if (!doc || doc.kbId !== kb.id) return notFoundDocument()

  const seg = await docSegments(doc.id)
  const data = [
    {
      id: doc.id,
      indexing_status: mapIndexingStatus(doc.status),
      processing_started_at: Math.floor(doc.createdAt.getTime() / 1000),
      parsing_completed_at: null,
      cleaning_completed_at: null,
      splitting_completed_at: null,
      completed_at: doc.status === 'ready' ? Math.floor(doc.updatedAt.getTime() / 1000) : null,
      paused_at: null,
      stopped_at: null,
      error: doc.errorMessage ?? null,
      completed_segments: seg.enabled,
      total_segments: seg.total,
    },
  ]
  return NextResponse.json({ data })
}
