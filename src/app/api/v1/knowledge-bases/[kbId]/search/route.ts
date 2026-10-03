import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runSearch } from '@/lib/rag/search'
import { verifyApiKey } from '@/lib/rag/apikey'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ kbId: string }> }

/**
 * POST /api/v1/knowledge-bases/[kbId]/search —— 对外 Agent API（Bearer 鉴权）
 * - 401 无 Key / Key 不存在；403 Key 已禁用或 readonly 传 debug；404 KB 不存在
 * - external 来源自动写 QdrantCallLog + callCount+1 + lastUsedAt
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { kbId } = await ctx.params

    // ---- 鉴权 ----
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '缺少 Authorization: Bearer <ApiKey>' }, { status: 401 })
    }
    // Task 15-b：keyHash 恒定时间比对 + 存量明文惰性迁移（详见 lib/rag/apikey.ts）
    const apiKey = await verifyApiKey(token)
    if (!apiKey) return NextResponse.json({ error: '无效的 API Key' }, { status: 401 })
    if (!apiKey.enabled) return NextResponse.json({ error: 'API Key 已被禁用' }, { status: 403 })

    // ---- 请求体（一次性解析，供 debug 权限校验与检索共用）----
    const body = await req.json().catch(() => ({}))
    const hasDebugPermission = apiKey.role === 'admin' || apiKey.role === 'operator'
    if (!hasDebugPermission && body.debug !== undefined) {
      return NextResponse.json(
        { error: 'readonly 角色不允许使用 debug 参数（需要 operator 及以上权限）' },
        { status: 400 }
      )
    }

    const kb = await db.knowledgeBase.findUnique({ where: { id: kbId } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const query = String(body.query ?? '').trim()
    if (!query) return NextResponse.json({ error: '缺少 query' }, { status: 400 })

    const result = await runSearch({
      source: 'external',
      kbId,
      query,
      topK: body.topK !== undefined ? Number(body.topK) : undefined,
      mode: body.mode,
      rerank: body.rerank,
      prefetchLimit: body.debug?.prefetchLimit ?? body.prefetchLimit,
      filter: body.filter,
      withParentContext: body.withParentContext,
      debug: hasDebugPermission ? body.debug : undefined,
    })

    // 计费/审计（尽力而为）
    void db.apiKey
      .update({
        where: { id: apiKey.id },
        data: { callCount: { increment: 1 }, lastUsedAt: new Date() },
      })
      .catch(() => {})

    return NextResponse.json(result)
  } catch (e: any) {
    const status = e?.message === '知识库不存在' ? 404 : 500
    return NextResponse.json({ error: e?.message ?? String(e) }, { status })
  }
}
