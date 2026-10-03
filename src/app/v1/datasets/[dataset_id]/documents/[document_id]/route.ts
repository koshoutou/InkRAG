import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireDatasetKey, notFoundDataset, notFoundDocument } from '../../../../_guard'
import { toDifyDocument, docSegments } from '../../../../_map'
import { deleteDocumentCore } from '@/lib/rag/kb'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ dataset_id: string; document_id: string }> }

/** GET /v1/datasets/{dataset_id}/documents/{document_id}（Dify 兼容）→ 文档详情 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const g = await requireDatasetKey(req)
  if (!g.ok) return g.response
  const { dataset_id, document_id } = await ctx.params
  const kb = await db.knowledgeBase.findUnique({ where: { id: dataset_id } })
  if (!kb) return notFoundDataset()
  const doc = await db.document.findUnique({ where: { id: document_id } })
  if (!doc || doc.kbId !== kb.id) return notFoundDocument()
  return NextResponse.json(toDifyDocument(doc, { position: 1, segments: await docSegments(doc.id) }))
}

/** DELETE /v1/datasets/{dataset_id}/documents/{document_id}（Dify 兼容）→ 204 空体 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const g = await requireDatasetKey(req, { write: true })
  if (!g.ok) return g.response
  const { dataset_id, document_id } = await ctx.params
  const doc = await db.document.findUnique({ where: { id: document_id } })
  if (!doc || doc.kbId !== dataset_id) return notFoundDocument()
  const r = await deleteDocumentCore(document_id)
  if (!r.ok) return notFoundDocument()
  return new NextResponse(null, { status: 204 })
}
