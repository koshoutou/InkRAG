import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireDatasetKey, difyError, notFoundDataset } from '../../_guard'
import { toDifyDataset } from '../../_map'
import { deleteKnowledgeBaseCore } from '@/lib/rag/kb'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ dataset_id: string }> }

async function getKb(id: string) {
  return db.knowledgeBase.findUnique({ where: { id } })
}

/** GET /v1/datasets/{dataset_id}（Dify 兼容）→ 数据集详情 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const g = await requireDatasetKey(req)
  if (!g.ok) return g.response
  const { dataset_id } = await ctx.params
  const kb = await getKb(dataset_id)
  if (!kb) return notFoundDataset()
  const [docCount, chunkCount] = await Promise.all([
    db.document.count({ where: { kbId: kb.id } }),
    db.chunk.count({ where: { kbId: kb.id, isParent: false } }),
  ])
  return NextResponse.json(toDifyDataset(kb, { docCount, chunkCount }))
}

/** PATCH /v1/datasets/{dataset_id}（Dify 兼容）→ 重命名 / 改描述 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const g = await requireDatasetKey(req, { write: true })
  if (!g.ok) return g.response
  const { dataset_id } = await ctx.params
  const kb = await getKb(dataset_id)
  if (!kb) return notFoundDataset()
  try {
    const body = await req.json().catch(() => ({}))
    const data: Record<string, string> = {}
    if (typeof body.name === 'string' && body.name.trim()) {
      const name = body.name.trim()
      if (name.length > 40) return difyError(400, 'invalid_param', 'name must be at most 40 characters')
      const dup = await db.knowledgeBase.findUnique({ where: { name } })
      if (dup && dup.id !== kb.id) return difyError(409, 'dataset_name_duplicate', `知识库名称已存在：${name}`)
      data.name = name
    }
    if (typeof body.description === 'string') data.description = body.description
    const updated = await db.knowledgeBase.update({ where: { id: kb.id }, data })
    const [docCount, chunkCount] = await Promise.all([
      db.document.count({ where: { kbId: kb.id } }),
      db.chunk.count({ where: { kbId: kb.id, isParent: false } }),
    ])
    return NextResponse.json(toDifyDataset(updated, { docCount, chunkCount }))
  } catch (e: any) {
    return difyError(500, 'internal_error', e?.message ?? String(e))
  }
}

/** DELETE /v1/datasets/{dataset_id}（Dify 兼容）→ 204 空体（级联删除文档/向量/产物） */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const g = await requireDatasetKey(req, { write: true })
  if (!g.ok) return g.response
  const { dataset_id } = await ctx.params
  const r = await deleteKnowledgeBaseCore(dataset_id)
  if (!r.ok) return notFoundDataset()
  return new NextResponse(null, { status: 204 })
}
