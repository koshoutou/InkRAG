import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getRagSettings } from '@/lib/rag/settings'
import { getVectorStore, isQdrantReachable } from '@/lib/rag/vectorstore'
import { pipelineStats } from '@/lib/rag/pipeline'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/system/health —— 聚合健康检查
 * { qdrant, vectorStore, embedding, mineru, rerank, pipeline }
 */
export async function GET() {
  try {
    const settings = await getRagSettings()

    // ---- Qdrant 探测 ----
    let qdrant: { mode: string; ok: boolean; version?: string; message: string }
    if (!settings.qdrant.url) {
      qdrant = { mode: 'local', ok: true, message: '未配置 Qdrant，使用内置向量引擎（沙箱演示）' }
    } else {
      const probe = await isQdrantReachable(settings.qdrant, { noCache: true })
      qdrant = {
        mode: probe.ok ? 'qdrant' : 'local',
        ok: probe.ok,
        ...(probe.version ? { version: probe.version } : {}),
        message: probe.ok
          ? `连接成功${probe.version ? ` · ${probe.version}` : ''}`
          : `${probe.message}（运行时自动降级 local）`,
      }
    }

    // ---- VectorStore 聚合 ----
    let vectorStore: { mode: string; ok: boolean; collections: number; points: number }
    try {
      const store = await getVectorStore()
      const cols = await store.listCollections()
      vectorStore = {
        mode: store.mode,
        ok: true,
        collections: cols.length,
        points: cols.reduce((s, c) => s + c.pointsCount, 0),
      }
    } catch (e: any) {
      vectorStore = { mode: settings.vectorMode, ok: false, collections: 0, points: 0 }
      console.warn('[health] vectorStore 聚合失败:', e?.message ?? e)
    }

    // ---- Embedding ----
    let embedding: { mode: string; ok: boolean; dim?: number; model: string; message: string }
    if (settings.embedMode === 'real') {
      const dim = (await db.knowledgeBase.findFirst({ orderBy: { createdAt: 'desc' } }))?.dim
      embedding = {
        mode: 'real',
        ok: true,
        ...(dim ? { dim } : {}),
        model: settings.embed.model,
        message: 'OpenAI 兼容 /embeddings',
      }
    } else if (settings.embedMode === 'mock') {
      embedding = {
        mode: 'mock',
        ok: true,
        dim: 1024,
        model: 'mock-deterministic',
        message: '确定性哈希特征向量（沙箱演示）',
      }
    } else {
      embedding = {
        mode: 'none',
        ok: false,
        model: '',
        message: '未配置 Embedding 且未启用 Mock',
      }
    }

    // ---- MinerU ----
    let mineru: { mode: string; ok: boolean; message: string }
    if (!settings.mineru.url) {
      mineru = { mode: 'fallback', ok: true, message: '未配置 MinerU，使用内置降级解析器（md/txt/html/pdf）' }
    } else {
      try {
        const base = settings.mineru.url.replace(/\/+$/, '')
        const res = await fetch(base + '/v1/health', {
          headers: settings.mineru.apiKey
            ? { Authorization: `Bearer ${settings.mineru.apiKey}` }
            : {},
          signal: AbortSignal.timeout(3_000),
        })
        mineru = res.ok
          ? { mode: 'mineru', ok: true, message: `MinerU 连接成功（HTTP ${res.status}）` }
          : { mode: 'mineru', ok: false, message: `MinerU 健康检查失败：HTTP ${res.status}` }
      } catch (e: any) {
        mineru = { mode: 'mineru', ok: false, message: `MinerU 不可达：${e?.message ?? e}` }
      }
    }

    // ---- Rerank ----
    const rerank: { mode: string; ok: boolean; model: string }
      = settings.rerankMode === 'real'
        ? { mode: 'real', ok: true, model: settings.rerank.model }
        : settings.rerankMode === 'mock'
          ? { mode: 'mock', ok: true, model: 'mock-bm25' }
          : { mode: 'none', ok: false, model: '' }

    // ---- Pipeline ----
    const stats = await pipelineStats()
    const pipeline = {
      mode: 'engine',
      ok: true,
      message: `队列运行中 · pending ${stats.pending} / active ${stats.active} / failed ${stats.failed}`,
      pending: stats.pending,
      active: stats.active,
      failed: stats.failed,
      uptimeSec: stats.uptimeSec,
    }

    return NextResponse.json({
      health: {
        qdrant,
        vectorStore,
        embedding,
        mineru,
        rerank,
        pipeline,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
