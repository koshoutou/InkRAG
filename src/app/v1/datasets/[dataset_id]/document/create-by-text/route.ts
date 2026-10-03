import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireDatasetKey, notFoundDataset } from '../../../../_guard'
import { handleCreateByText } from '../_text_impl'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ dataset_id: string }> }

/**
 * POST /v1/datasets/{dataset_id}/document/create-by-text（Dify 兼容 · Task 17-3）
 * Body: { name, text, process_rule?, indexing_technique?, doc_form?, doc_language? }
 * 文本直接入库（无扩展名自动补 .md）；process_rule 映射同 create-by-file。
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const g = await requireDatasetKey(req, { write: true })
  if (!g.ok) return g.response
  const { dataset_id } = await ctx.params
  const kb = await db.knowledgeBase.findUnique({ where: { id: dataset_id } })
  if (!kb) return notFoundDataset()
  return handleCreateByText(req, kb)
}
