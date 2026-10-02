import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { qdrantFetch, getSettings, callEmbed, callRerank } from '@/lib/qdrant'
import { getVectorStore, type LocalVectorStore } from '@/lib/rag/vectorstore'
import { embedQuery } from '@/lib/rag/embed'
import { rerankDocs } from '@/lib/rag/rerank'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Extract the main content text from a point's payload. */
function payloadToText(payload: any): string {
  if (!payload) return ''
  const directCandidates = ['content', 'text', 'page_content', 'chunk', 'segment', 'document', 'doc_text', 'text_preview', 'parent_text']
  for (const k of directCandidates) {
    if (typeof payload[k] === 'string' && payload[k].trim()) return payload[k]
  }
  if (typeof payload._node_content === 'string' && payload._node_content.trim()) {
    try {
      const nc = JSON.parse(payload._node_content)
      if (typeof nc.text === 'string' && nc.text.trim()) return nc.text
    } catch {}
  }
  const parts: string[] = []
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string' && v.length > 0 && !k.startsWith('_')) parts.push(`${k}: ${v}`)
  }
  return parts.join('\n').slice(0, 4000)
}

export interface SearchReq {
  query: string
  mode?: 'dense' | 'sparse' | 'hybrid' | 'recommend'
  vector_name?: string | null
  sparse_name?: string | null
  recommend_point_id?: string | number | null
  limit?: number
  score_threshold?: number
  filter?: any | null
  with_payload?: boolean
  with_vector?: boolean
  rerank?: boolean
  rerank_top_n?: number
  fusion?: 'rrf' | 'dists'
  params?: any | null
  save_history?: boolean
}

/** Persist a call log entry (unified audit + history). */
async function logCall(entry: {
  collection: string
  query: string
  mode: string
  topK: number
  scoreThreshold: number
  reranked: boolean
  took_ms: number
  result_count: number
  params: any
  results_preview: any[]
  embed_dim?: number
}) {
  try {
    await db.qdrantCallLog.create({ data: {
      source: 'web-ui',
      collection: entry.collection,
      query: entry.query,
      mode: entry.mode,
      topK: entry.topK,
      scoreThreshold: entry.scoreThreshold,
      reranked: entry.reranked,
      tookMs: entry.took_ms,
      resultCount: entry.result_count,
      paramsJson: JSON.stringify(entry.params),
      resultsJson: JSON.stringify(entry.results_preview),
    } })
  } catch {
    // ignore persistence errors
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params
  const started = Date.now()
  let body: SearchReq
  try {
    body = (await req.json()) as SearchReq
  } catch {
    return NextResponse.json({ error: '无效的 JSON 请求体' }, { status: 400 })
  }
  const mode = body.mode ?? 'dense'
  const limit = Math.min(Math.max(parseInt(String(body.limit ?? 10)), 1), 100)
  const scoreThreshold = body.score_threshold ?? 0
  const filter = body.filter ?? null
  const withPayload = body.with_payload ?? true
  const withVector = body.with_vector ?? false
  const rerank = body.rerank ?? false
  const fusion = body.fusion ?? 'rrf'

  if (!body.query && mode !== 'recommend')
    return NextResponse.json({ error: '请输入查询文本' }, { status: 400 })

  try {
    const store = await getVectorStore()

    // =====================================================================
    // local 模式：内置向量引擎 + embed.ts / rerank.ts 双模式适配
    // =====================================================================
    if (store.mode === 'local') {
      const local = store as LocalVectorStore
      let results: { id: any; score: number; payload: any; vector?: any }[] = []
      let queryVector: number[] | null = null
      let querySparse: { indices: number[]; values: number[] } | null = null
      let reranked = false
      let embedDim: number | undefined
      let embedProvider = 'mock-deterministic'

      if (mode === 'recommend') {
        if (body.recommend_point_id === undefined || body.recommend_point_id === null) {
          return NextResponse.json({ error: 'recommend 模式需要 recommend_point_id' }, { status: 400 })
        }
        const pts = await local.getPoints(name, [String(body.recommend_point_id)], { withVector: true })
        const ref = pts[0]?.vector?.dense
        if (!ref) return NextResponse.json({ error: '参考点不存在或无 dense 向量' }, { status: 404 })
        queryVector = ref
        embedDim = ref.length
        results = await local.queryDense(name, ref, { limit, filter: filter ?? undefined })
      } else {
        // mock/real 自动路由（OpenAI 兼容 / 确定性哈希特征）
        const embedded = await embedQuery(body.query!)
        queryVector = embedded.dense
        querySparse = embedded.sparse
        embedDim = embedded.dim
        embedProvider = embedded.provider
        if (mode === 'dense') {
          results = await local.queryDense(name, embedded.dense, { limit, filter: filter ?? undefined })
        } else if (mode === 'sparse') {
          results = await local.querySparse(name, embedded.sparse, { limit, filter: filter ?? undefined })
        } else if (mode === 'hybrid') {
          results = await local.queryHybrid(name, {
            dense: embedded.dense,
            sparse: embedded.sparse,
            limit,
            prefetchLimit: Math.max(50, limit),
            filter: filter ?? undefined,
            fusion: fusion === 'dists' ? 'dbsf' : 'rrf',
          })
        } else {
          return NextResponse.json({ error: `不支持的 mode: ${mode}` }, { status: 400 })
        }
        // 分数阈值
        if (scoreThreshold > 0) {
          results = results.filter((r) => r.score >= scoreThreshold)
        }
      }

      // 可选重排（rerank.ts：real/mock）
      if (rerank && results.length > 1) {
        try {
          const docs = results.map((r) => payloadToText(r.payload))
          const ranked = await rerankDocs(
            body.query ?? '',
            docs,
            Math.min(body.rerank_top_n ?? limit, results.length)
          )
          results = ranked
            .map((r) => ({
              id: results[r.index]?.id,
              score: r.score,
              payload: results[r.index]?.payload,
              original_score: results[r.index]?.score,
            }))
            .filter((r) => r.id !== undefined)
          reranked = true
        } catch (e: any) {
          console.warn('rerank failed:', e?.message)
        }
      }

      const took_ms = Date.now() - started
      const results_preview = results.map((r) => ({
        id: r.id,
        score: r.score,
        payload_summary: payloadToText(r.payload).slice(0, 200),
        file: r.payload?.source || r.payload?.file || r.payload?.doc_name || r.payload?.document_id || r.payload?.path || null,
      }))

      if (body.save_history !== false) {
        await logCall({
          collection: name,
          query: body.query ?? '',
          mode, topK: limit, scoreThreshold, reranked,
          took_ms, result_count: results.length,
          params: { mode: 'local-engine', filter, fusion, rerank, embed_provider: embedProvider },
          results_preview, embed_dim: embedDim,
        })
      }

      return NextResponse.json({
        results: withPayload
          ? results
          : results.map((r) => ({ id: r.id, score: r.score })),
        query_vector: queryVector,
        query_sparse: querySparse,
        mode, reranked, took_ms,
        count: results.length,
        embed_dim: embedDim,
        embed_provider: embedProvider,
      })
    }

    // =====================================================================
    // qdrant 模式：保持基座原有行为（真实 Qdrant REST）
    // =====================================================================
    const settings = await getSettings()
    if (!settings) return NextResponse.json({ error: '请先配置 Qdrant' }, { status: 400 })

    let qdrantResults: { id: any; score: number; payload: any; vector?: any }[] = []
    let queryVector: number[] | null = null
    let querySparse: { indices: number[]; values: number[] } | null = null
    let reranked = false
    let embedDim: number | undefined

    if (mode === 'recommend') {
      if (body.recommend_point_id === undefined || body.recommend_point_id === null) {
        return NextResponse.json({ error: 'recommend 模式需要 recommend_point_id' }, { status: 400 })
      }
      const result = await qdrantFetch<any>({
        path: `/collections/${encodeURIComponent(name)}/points/query`,
        method: 'POST',
        body: {
          query: { recommend: body.recommend_point_id },
          using: body.vector_name ?? undefined,
          filter, limit,
          with_payload: withPayload, with_vector: withVector,
          params: body.params ?? undefined,
          score_threshold: scoreThreshold || undefined,
        },
      })
      qdrantResults = (result?.points ?? []).map((p: any) => ({
        id: p.id, score: p.score ?? 0, payload: p.payload, vector: p.vector,
      }))
    } else if (mode === 'dense') {
      const embed = await callEmbed([body.query!], settings)
      queryVector = embed.vectors[0]
      embedDim = embed.dim
      const result = await qdrantFetch<any>({
        path: `/collections/${encodeURIComponent(name)}/points/search`,
        method: 'POST',
        body: {
          vector: body.vector_name
            ? { name: body.vector_name, vector: queryVector }
            : queryVector,
          filter, limit,
          with_payload: withPayload, with_vector: withVector,
          score_threshold: scoreThreshold || undefined,
          params: body.params ?? undefined,
        },
      })
      qdrantResults = (result ?? []).map((p: any) => ({
        id: p.id, score: p.score ?? 0, payload: p.payload, vector: p.vector,
      }))
    } else if (mode === 'sparse' || mode === 'hybrid') {
      if (!body.sparse_name)
        return NextResponse.json({ error: `${mode} 模式需要 sparse_name（集合中的稀疏向量字段名）` }, { status: 400 })
      const embed = await callEmbed([body.query!], settings)
      queryVector = embed.vectors[0]
      embedDim = embed.dim
      // Derive sparse from dense by picking top-N dims with largest |value|
      const dv = queryVector
      const idxs = dv
        .map((v, i) => [i, Math.abs(v)] as [number, number])
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.min(64, dv.length))
        .filter(([, mag]) => mag > 0.05)
      querySparse = {
        indices: idxs.map(([i]) => i),
        values: idxs.map(([i]) => dv[i]),
      }
      const queryBody: any = mode === 'hybrid'
        ? {
            query: [queryVector, { indices: querySparse.indices, values: querySparse.values }],
            using: body.vector_name ?? undefined,
            fusion: { mode: fusion },
          }
        : {
            query: { indices: querySparse.indices, values: querySparse.values },
            using: body.sparse_name,
          }
      const result = await qdrantFetch<any>({
        path: `/collections/${encodeURIComponent(name)}/points/query`,
        method: 'POST',
        body: {
          ...queryBody,
          filter, limit,
          with_payload: withPayload, with_vector: withVector,
          score_threshold: scoreThreshold || undefined,
          params: body.params ?? undefined,
        },
      })
      qdrantResults = (result?.points ?? []).map((p: any) => ({
        id: p.id, score: p.score ?? 0, payload: p.payload, vector: p.vector,
      }))
    } else {
      return NextResponse.json({ error: `不支持的 mode: ${mode}` }, { status: 400 })
    }

    // Optional rerank
    if (rerank && qdrantResults.length > 1) {
      try {
        const docs = qdrantResults.map((r) => payloadToText(r.payload))
        const ranked = await callRerank(
          body.query!, docs,
          Math.min(body.rerank_top_n ?? limit, qdrantResults.length),
          settings
        )
        qdrantResults = ranked
          .map((r) => ({
            id: qdrantResults[r.index]?.id,
            score: r.score,
            payload: qdrantResults[r.index]?.payload,
            vector: qdrantResults[r.index]?.vector,
            original_score: qdrantResults[r.index]?.score,
          }))
          .filter((r) => r.id !== undefined)
        reranked = true
      } catch (e: any) {
        console.warn('rerank failed:', e?.message)
      }
    }

    const took_ms = Date.now() - started
    const results_preview = qdrantResults.map((r) => ({
      id: r.id,
      score: r.score,
      payload_summary: payloadToText(r.payload).slice(0, 200),
      file: r.payload?.source || r.payload?.file || r.payload?.doc_name || r.payload?.document_id || r.payload?.path || null,
    }))

    if (body.save_history !== false) {
      await logCall({
        collection: name,
        query: body.query ?? '',
        mode, topK: limit, scoreThreshold, reranked,
        took_ms, result_count: qdrantResults.length,
        params: {
          vector_name: body.vector_name ?? null,
          sparse_name: body.sparse_name ?? null,
          filter, fusion, rerank,
          embed_api_base: settings.embedApiBase,
          embed_model: settings.embedModel,
          embed_dim: embedDim,
          rerank_model: settings.rerankModel,
        },
        results_preview, embed_dim: embedDim,
      })
    }

    return NextResponse.json({
      results: qdrantResults,
      query_vector: queryVector,
      query_sparse: querySparse,
      mode, reranked, took_ms,
      count: qdrantResults.length,
      embed_dim: embedDim,
      embed_provider: 'openai-compatible',
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
