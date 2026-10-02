import { db } from '@/lib/db'

/**
 * Shared Qdrant client helpers (server-side only).
 * Reads connection settings from the Prisma `QdrantSetting` table.
 *
 * Pure Next.js — no Python service required.
 */

export interface QdrantSettings {
  url: string
  apiKey: string
  defaultCollection: string
  embedApiBase: string
  embedApiKey: string
  embedModel: string
  rerankApiBase: string
  rerankApiKey: string
  rerankModel: string
}

const EMPTY_SETTINGS: QdrantSettings = {
  url: '', apiKey: '', defaultCollection: '',
  embedApiBase: '', embedApiKey: '', embedModel: '',
  rerankApiBase: '', rerankApiKey: '', rerankModel: '',
}

export async function getSettings(): Promise<QdrantSettings | null> {
  const row = await db.qdrantSetting.findUnique({ where: { id: 'default' } })
  if (!row) return null
  return {
    url: row.url,
    apiKey: row.apiKey,
    defaultCollection: row.defaultCollection,
    embedApiBase: row.embedApiBase,
    embedApiKey: row.embedApiKey,
    embedModel: row.embedModel,
    rerankApiBase: row.rerankApiBase,
    rerankApiKey: row.rerankApiKey,
    rerankModel: row.rerankModel,
  }
}

export interface QdrantRequestOpts {
  method?: string
  body?: unknown
  /** override path under the Qdrant root, must start with `/` */
  path: string
  /** optional explicit settings to use instead of DB-stored */
  settings?: QdrantSettings
  /** search params appended as query string */
  query?: Record<string, string>
}

/** Make an authenticated request to the configured Qdrant instance. */
export async function qdrantFetch<T = any>(opts: QdrantRequestOpts): Promise<T> {
  const settings = opts.settings ?? (await getSettings())
  if (!settings || !settings.url) {
    throw new Error('Qdrant 未配置：请先在设置中填写 Qdrant 服务地址')
  }
  const base = settings.url.replace(/\/+$/, '')
  let url = base + opts.path
  if (opts.query && Object.keys(opts.query).length) {
    const qs = new URLSearchParams(opts.query).toString()
    url += (url.includes('?') ? '&' : '?') + qs
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.apiKey) headers['api-key'] = settings.apiKey
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  })
  const text = await res.text()
  let json: any
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    if (!res.ok) throw new Error(`Qdrant 返回非 JSON：${res.status} ${text.slice(0, 300)}`)
    throw new Error(`Qdrant 返回非 JSON：${text.slice(0, 300)}`)
  }
  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`
    throw new Error(`Qdrant 错误：${msg}`)
  }
  if (json && typeof json === 'object' && 'result' in json) {
    return json.result as T
  }
  return json as T
}

/** Test connectivity by hitting GET /readyz (or / root). */
export async function testConnection(url: string, apiKey: string): Promise<{ ok: boolean; version?: string; title?: string; message: string }> {
  try {
    const base = url.replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (apiKey) headers['api-key'] = apiKey
    const res = await fetch(base + '/readyz', { headers, cache: 'no-store' })
    if (!res.ok) {
      return { ok: false, message: `连接失败：HTTP ${res.status}` }
    }
    let version: string | undefined
    try {
      const vRes = await fetch(base + '/', { headers, cache: 'no-store' })
      if (vRes.ok) {
        const vJson = await vRes.json()
        version = vJson?.version
      }
    } catch {}
    return { ok: true, version, message: '连接成功' }
  } catch (e: any) {
    return { ok: false, message: `连接失败：${e?.message ?? String(e)}` }
  }
}

/** Test embedding API connectivity. Calls {apiBase}/embeddings with a tiny input. */
export async function testEmbedding(apiBase: string, apiKey: string, model: string): Promise<{ ok: boolean; dim?: number; message: string }> {
  if (!apiBase) return { ok: false, message: 'API Base 为空' }
  if (!model) return { ok: false, message: '模型 ID 为空' }
  try {
    const base = apiBase.replace(/\/+$/, '')
    const res = await fetch(base + '/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: 'ping' }),
      cache: 'no-store',
    })
    const text = await res.text()
    let json: any
    try { json = text ? JSON.parse(text) : {} } catch { throw new Error(`非 JSON 响应：${text.slice(0, 200)}`) }
    if (!res.ok) {
      const msg = json?.error?.message || json?.error || json?.message || `HTTP ${res.status}`
      return { ok: false, message: `Embedding 测试失败：${msg}` }
    }
    const data = json?.data || []
    const dim = data[0]?.embedding?.length
    return { ok: true, dim, message: `连接成功 · 返回 ${dim}d 向量` }
  } catch (e: any) {
    return { ok: false, message: `Embedding 测试失败：${e?.message ?? String(e)}` }
  }
}

/** Test rerank API connectivity. Calls {apiBase}/rerank with a tiny pair. */
export async function testRerank(apiBase: string, apiKey: string, model: string): Promise<{ ok: boolean; message: string }> {
  if (!apiBase) return { ok: false, message: 'API Base 为空' }
  if (!model) return { ok: false, message: '模型 ID 为空' }
  try {
    const base = apiBase.replace(/\/+$/, '')
    // OpenAI-style: POST /v1/rerank with { model, query, documents }
    const res = await fetch(base + '/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, query: 'ping', documents: ['hello', 'world'], top_n: 2 }),
      cache: 'no-store',
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, message: `Rerank 测试失败：HTTP ${res.status} ${text.slice(0, 200)}` }
    }
    return { ok: true, message: 'Rerank API 可用' }
  } catch (e: any) {
    return { ok: false, message: `Rerank 测试失败：${e?.message ?? String(e)}` }
  }
}

/** Embed texts via OpenAI-compatible /v1/embeddings. Returns vectors + dim (auto-inferred). */
export async function callEmbed(texts: string[], settings: QdrantSettings): Promise<{ vectors: number[][]; dim: number; provider: string }> {
  if (!settings.embedApiBase) throw new Error('Embedding API Base 未配置，请在设置中填写')
  if (!settings.embedModel) throw new Error('Embedding 模型 ID 未配置')
  const base = settings.embedApiBase.replace(/\/+$/, '')
  const res = await fetch(base + '/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.embedApiKey ? { Authorization: `Bearer ${settings.embedApiKey}` } : {}),
    },
    body: JSON.stringify({ model: settings.embedModel, input: texts.length === 1 ? texts[0] : texts }),
    cache: 'no-store',
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    let msg = txt
    try { msg = JSON.parse(txt)?.error?.message || txt } catch {}
    throw new Error(`Embedding API 错误 (${res.status}): ${String(msg).slice(0, 300)}`)
  }
  const json: any = await res.json()
  const data: any[] = json.data || []
  const vectors = data
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding)
  if (vectors.length === 0) throw new Error('Embedding API 返回空 data')
  return { vectors, dim: vectors[0].length, provider: 'openai-compatible' }
}

/** Rerank via OpenAI-style /v1/rerank. Returns sorted results. */
export async function callRerank(query: string, documents: string[], topN: number, settings: QdrantSettings): Promise<{ index: number; score: number; document: string }[]> {
  if (!settings.rerankApiBase) throw new Error('Rerank API Base 未配置')
  if (!settings.rerankModel) throw new Error('Rerank 模型 ID 未配置')
  const base = settings.rerankApiBase.replace(/\/+$/, '')
  const res = await fetch(base + '/rerank', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.rerankApiKey ? { Authorization: `Bearer ${settings.rerankApiKey}` } : {}),
    },
    body: JSON.stringify({ model: settings.rerankModel, query, documents, top_n: topN }),
    cache: 'no-store',
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Rerank API 错误 (${res.status}): ${txt.slice(0, 300)}`)
  }
  const json: any = await res.json()
  // OpenAI-compatible: { results: [{index, relevance_score, document}] }
  const results = (json.results || []).map((r: any) => ({
    index: r.index ?? 0,
    score: r.relevance_score ?? r.score ?? 0,
    document: r.document?.text || r.document || documents[r.index ?? 0] || '',
  }))
  return results
}

/** Type helpers for Qdrant collection info. */
export interface QdrantCollectionInfo {
  status: string
  optimizer_status: string
  indexed_vectors_count?: number
  points_count?: number
  segments_count?: number
  config: {
    params: {
      vectors: any
      sparse_vectors?: Record<string, any>
      shard_number: number
      replication_factor: number
      on_disk_payload: boolean
      distance?: string
    }
    hnsw_config: any
    quantization_config?: any
  }
  payload_schema?: Record<string, any>
}

/** Summarize vector config to a short human label. */
export function summarizeVectorConfig(info: QdrantCollectionInfo): {
  text: string
  denseVectors: { name: string | null; size: number; distance: string }[]
  sparseVectors: string[]
} {
  const vectors = info.config?.params?.vectors
  const dense: { name: string | null; size: number; distance: string }[] = []
  if (vectors && typeof vectors === 'object') {
    if ('size' in vectors && 'distance' in vectors) {
      dense.push({ name: null, size: vectors.size, distance: vectors.distance })
    } else {
      for (const [name, cfg] of Object.entries(vectors)) {
        const c = cfg as any
        dense.push({ name, size: c.size, distance: c.distance })
      }
    }
  }
  const sparse = Object.keys(info.config?.params?.sparse_vectors ?? {})
  const parts: string[] = []
  for (const d of dense) {
    parts.push(`dense${d.name ? `:${d.name}` : ''}(${d.size}, ${d.distance})`)
  }
  if (sparse.length) parts.push(`sparse(${sparse.join('+')})`)
  return { text: parts.join(' + ') || 'unknown', denseVectors: dense, sparseVectors: sparse }
}

/** Format bytes / numbers in a friendly way. */
export function formatCount(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
  return (n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '') + 'B'
}

export { EMPTY_SETTINGS }
