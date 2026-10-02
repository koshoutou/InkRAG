import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { getRagSettings } from '@/lib/rag/settings'
import { getVectorStore } from '@/lib/rag/vectorstore'
import { kbSummaryWithCounts, kbSummaries } from '@/lib/rag/kb'
import { parseChunkConfig } from '@/lib/rag/serialize'
import { DEFAULT_CHUNK_CONFIG } from '@/lib/rag/chunking'
import { embedQuery } from '@/lib/rag/embed'

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
 * Body: { name, description?, embeddingModel?, dim?, chunkConfig?, rerankEnabled? }
 * → 201 { kb: KbSummary }（qdrant 模式按计划书 §6.3 固化配置建集合）
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: '知识库名称不能为空' }, { status: 400 })

    const exists = await db.knowledgeBase.findUnique({ where: { name } })
    if (exists) return NextResponse.json({ error: `知识库名称已存在：${name}` }, { status: 409 })

    const settings = await getRagSettings()
    // dim 判定：显式传入优先；未传时 real 嵌入模式实测探测（一次最小嵌入调用），
    // mock/none 模式回退 1024（与 DEFAULT_EMBED_DIM 一致）。
    // 修复：此前硬编码 1024，换用非 1024 维真实模型（如 768d）会建出维度不匹配的集合导致 upsert 失败。
    let dim = Number(body.dim) > 0 ? Math.floor(Number(body.dim)) : 0
    if (dim <= 0) {
      if (settings.embedMode === 'real') {
        try {
          const probe = await embedQuery('dim', undefined)
          dim = probe.dim > 0 ? probe.dim : 1024
          console.log(`[kb] dim 自动探测（${settings.embed.model}）→ ${dim}`)
        } catch (e: any) {
          console.warn('[kb] dim 探测失败，回退 1024:', e?.message ?? e)
          dim = 1024
        }
      } else {
        dim = 1024
      }
    }
    const embeddingModel =
      String(body.embeddingModel ?? '').trim() || settings.embed.model || 'mock-bge-m3'
    const chunkConfig = body.chunkConfig
      ? parseChunkConfig(JSON.stringify(body.chunkConfig))
      : { ...DEFAULT_CHUNK_CONFIG }
    const rerankEnabled = body.rerankEnabled === true

    const id = randomUUID()
    const collection = `kb_${id.replace(/-/g, '').slice(0, 12)}`
    const kb = await db.knowledgeBase.create({
      data: {
        id,
        name,
        description: String(body.description ?? ''),
        collection,
        embeddingModel,
        dim,
        chunkConfig: JSON.stringify(chunkConfig),
        vectorMode: settings.vectorMode,
        rerankEnabled,
      },
    })

    // 建集合（qdrant 模式固化配置 §6.3；local 模式幂等 no-op）
    try {
      const store = await getVectorStore()
      await store.ensureCollection(collection, dim)
    } catch (e: any) {
      // 集合创建失败不阻断建库（upsert 阶段会再 ensure）
      console.warn('[kb] 建集合失败（稍后重试）:', e?.message ?? e)
    }

    return NextResponse.json({ kb: await kbSummaryWithCounts(kb) }, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
