import { NextRequest, NextResponse } from 'next/server'
import { runSearch } from '@/lib/rag/search'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/search/debug —— Web 检索调试台（无需 API Key，source=debug-console 写日志）
 * Body 契约见 docs/api-contract.md §3
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const kbId = String(body.kbId ?? '')
    const query = String(body.query ?? '').trim()
    if (!kbId) return NextResponse.json({ error: '缺少 kbId' }, { status: 400 })
    if (!query) return NextResponse.json({ error: '缺少 query' }, { status: 400 })
    // mode 白名单（search.ts 仅支持三模式；非法值静默 0 结果会误导调试，提前 400）
    if (body.mode !== undefined && !['hybrid', 'dense', 'sparse'].includes(String(body.mode))) {
      return NextResponse.json(
        { error: `无效 mode: ${String(body.mode)}（可选 hybrid / dense / sparse）` },
        { status: 400 },
      )
    }

    const result = await runSearch({
      source: 'debug-console',
      kbId,
      query,
      topK: body.topK !== undefined ? Number(body.topK) : undefined,
      mode: body.mode,
      rerank: body.rerank,
      prefetchLimit: body.prefetchLimit,
      filter: body.filter,
      withParentContext: body.withParentContext,
      debug: body.debug,
    })
    return NextResponse.json({ result })
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    // 404：KB 不存在；422：KB 在但向量集合缺失（模式切换后未重新入库）
    const status = msg === '知识库不存在' ? 404 : msg.includes('向量集合') && msg.includes('不存在') ? 422 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
