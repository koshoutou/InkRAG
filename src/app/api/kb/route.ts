import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { getRagSettings } from '@/lib/rag/settings'
import { getVectorStore, StoreError } from '@/lib/rag/vectorstore'
import { kbSummaryWithCounts, kbSummaries } from '@/lib/rag/kb'
import { parseChunkConfig } from '@/lib/rag/serialize'
import { DEFAULT_CHUNK_CONFIG } from '@/lib/rag/chunking'
import { probeEmbedding } from '@/lib/rag/embed'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** GET /api/kb → { kbs: KbSummary[] } */
export async function GET() {
  try {
    const kbs = await db.knowledgeBase.findMany({ orderBy: { createdAt: 'desc' } })
    return NextResponse.json({ kbs: await kbSummaries(kbs) })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/**
 * POST /api/kb
 * Body: { name, description?, chunkConfig?, rerankEnabled? }
 * → 201 { kb: KbSummary }
 *
 * v1.6 建库强校验（本地向量引擎已移除，建库前后端都要求真实服务）：
 * - 未配置 Qdrant → 400（引导到设置页）
 * - 未配置 Embedding API（embedMode !== 'real'，mock 仅显式调试不允许建库）→ 400
 * - probeEmbedding() 实测 dim 与稀疏方案并锁定（kb.dim / kb.sparseScheme / embeddingModel）
 *   显式传入 dim 且与实测不一致 → 400（防止建出维度不匹配的集合）
 * - Qdrant 不可达 → 硬失败（不再静默跳过建集合）
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: '知识库名称不能为空' }, { status: 400 })

    const exists = await db.knowledgeBase.findUnique({ where: { name } })
    if (exists) return NextResponse.json({ error: `知识库名称已存在：${name}` }, { status: 409 })

    const settings = await getRagSettings()
    if (settings.vectorMode !== 'qdrant' || !settings.qdrant.url) {
      return NextResponse.json(
        { error: '未配置 Qdrant 连接，无法创建知识库（请先到「设置 → Qdrant」配置并测试连通）' },
        { status: 400 }
      )
    }
    if (settings.embedMode !== 'real') {
      return NextResponse.json(
        { error: '未配置 Embedding API，无法创建知识库（请先到「设置 → Embedding」配置）' },
        { status: 400 }
      )
    }

    // 实测探测：dim + sparse 方案（写入库行锁定，中途换模型会被入库断言拦截）
    const probe = await probeEmbedding()
    if (!probe.ok) {
      return NextResponse.json(
        { error: `嵌入 API 探测失败：${probe.error ?? '未知错误'}（请检查「设置 → Embedding」配置）` },
        { status: 400 }
      )
    }
    const dim = probe.dim
    const bodyDim = Number(body.dim) > 0 ? Math.floor(Number(body.dim)) : 0
    if (bodyDim > 0 && bodyDim !== dim) {
      return NextResponse.json(
        {
          error: `指定维度 ${bodyDim} 与嵌入模型实测维度 ${dim} 不一致（模型 ${settings.embed.model}），请以实测维度为准`,
        },
        { status: 400 }
      )
    }

    const embeddingModel = settings.embed.model
    const sparseScheme = probe.sparseScheme
    const chunkConfig = body.chunkConfig
      ? parseChunkConfig(JSON.stringify(body.chunkConfig))
      : { ...DEFAULT_CHUNK_CONFIG }
    const rerankEnabled = body.rerankEnabled === true

    const id = randomUUID()
    const collection = `kb_${id.replace(/-/g, '').slice(0, 12)}`

    // 先建集合（Qdrant 不可达 → 硬失败，不落库行避免孤儿记录）
    try {
      const store = await getVectorStore()
      await store.ensureCollection(collection, dim)
    } catch (e: any) {
      const status = e instanceof StoreError ? (e.status ?? 503) : 500
      return NextResponse.json({ error: e?.message ?? String(e) }, { status })
    }

    const kb = await db.knowledgeBase.create({
      data: {
        id,
        name,
        description: String(body.description ?? ''),
        collection,
        embeddingModel,
        dim,
        chunkConfig: JSON.stringify(chunkConfig),
        vectorMode: 'qdrant',
        sparseScheme,
        rerankEnabled,
      },
    })

    return NextResponse.json({ kb: await kbSummaryWithCounts(kb) }, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
