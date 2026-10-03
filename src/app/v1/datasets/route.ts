import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireDatasetKey, difyError } from '../_guard'
import { toDifyDataset } from '../_map'
import { createKnowledgeBaseCore } from '@/lib/rag/kbcreate'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /v1/datasets?page=&limit=&keyword=（Dify 兼容 · Task 17-3）
 * 列出知识库（Dify 数据集形状 { data, has_more, limit, total, page }）。
 * MinerU 面板「导出到 Dify → 检查链接 / 选择导出位置」即调本端点。
 */
export async function GET(req: NextRequest) {
  const g = await requireDatasetKey(req)
  if (!g.ok) return g.response
  try {
    const url = new URL(req.url)
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1') || 1)
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20') || 20, 1), 100)
    const keyword = url.searchParams.get('keyword') || undefined

    const where = keyword ? { name: { contains: keyword } } : {}
    const [kbs, total] = await Promise.all([
      db.knowledgeBase.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: (page - 1) * limit }),
      db.knowledgeBase.count({ where }),
    ])
    const data = await Promise.all(
      kbs.map(async (kb) => {
        const [docCount, chunkCount] = await Promise.all([
          db.document.count({ where: { kbId: kb.id } }),
          db.chunk.count({ where: { kbId: kb.id, isParent: false } }),
        ])
        return toDifyDataset(kb, { docCount, chunkCount })
      })
    )
    return NextResponse.json({ data, has_more: page * limit < total, limit, total, page })
  } catch (e: any) {
    return difyError(500, 'internal_error', e?.message ?? String(e))
  }
}

/**
 * POST /v1/datasets（Dify 兼容）——创建空数据集（= 知识库）。
 * Body: { name (≤40), description?, indexing_technique?（记录性接受）, permission?（仅 only_me 语义） }
 * 复用 createKnowledgeBaseCore（Qdrant/Embedding 强校验 + probeEmbedding 锁定）。
 */
export async function POST(req: NextRequest) {
  const g = await requireDatasetKey(req, { write: true })
  if (!g.ok) return g.response
  try {
    const body = await req.json().catch(() => ({}))
    const name = String(body.name ?? '').trim()
    if (!name) return difyError(400, 'invalid_param', 'name is required')
    if (name.length > 40) return difyError(400, 'invalid_param', 'name must be at most 40 characters')

    const r = await createKnowledgeBaseCore({ name, description: body.description })
    if (!r.ok) {
      const code = r.status === 409 ? 'dataset_name_duplicate' : r.status === 400 ? 'invalid_param' : 'internal_error'
      return difyError(r.status, code, r.error)
    }
    const [docCount, chunkCount] = await Promise.all([
      db.document.count({ where: { kbId: r.kb.id } }),
      db.chunk.count({ where: { kbId: r.kb.id, isParent: false } }),
    ])
    return NextResponse.json(toDifyDataset(r.kb, { docCount, chunkCount }))
  } catch (e: any) {
    return difyError(500, 'internal_error', e?.message ?? String(e))
  }
}
