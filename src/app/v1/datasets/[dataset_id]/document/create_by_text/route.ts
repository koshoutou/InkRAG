import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireDatasetKey, notFoundDataset } from '../../../../_guard'
import { handleCreateByText } from '../_text_impl'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ dataset_id: string }> }

/**
 * POST /v1/datasets/{dataset_id}/document/create_by_text（Dify 兼容 · 废弃别名）
 * Dify 同时暴露连字符（create-by-text）与下划线（create_by_text）两路径；本路由为下划线别名。
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const g = await requireDatasetKey(req, { write: true })
  if (!g.ok) return g.response
  const { dataset_id } = await ctx.params
  const kb = await db.knowledgeBase.findUnique({ where: { id: dataset_id } })
  if (!kb) return notFoundDataset()
  return handleCreateByText(req, kb)
}
