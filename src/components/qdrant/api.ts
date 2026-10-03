// Thin fetch helpers around the Qdrant KB Manager backend routes.
import type {
  CollectionSummary,
  CollectionDetail,
  ScrollResult,
  SearchResponse,
  SearchMode,
  QdrantSettings,
  CallLogItem,
  QdrantPoint,
} from '@/components/qdrant/types'

async function asJson(res: Response) {
  const txt = await res.text()
  let json: any
  try {
    json = txt ? JSON.parse(txt) : {}
  } catch {
    throw new Error(`Non-JSON response: ${res.status} ${txt.slice(0, 200)}`)
  }
  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return json
}

/**
 * 【Task 16-a】fetch 包装：dev server 重启 / 网关闪断窗口的瞬态失败自动重试
 * （网络异常，或 404/502/503/504 且 body 非 JSON 的错误页）。重试 2 次（600ms/1500ms）。
 */
async function req(url: string, init?: RequestInit): Promise<Response> {
  const isTransient = (r: Response | null): boolean => {
    if (!r) return true
    if (![404, 502, 503, 504].includes(r.status)) return false
    return !(r.headers.get('content-type') ?? '').includes('application/json')
  }
  let res: Response | null = null
  try {
    res = await fetch(url, init)
  } catch {
    res = null
  }
  if (isTransient(res)) {
    for (const delay of [600, 1500]) {
      await new Promise((r) => setTimeout(r, delay))
      try {
        res = await fetch(url, init)
      } catch {
        res = null
      }
      if (!isTransient(res)) break
    }
  }
  if (!res) throw new Error('网络请求失败（服务可能正在重启，请稍后刷新重试）')
  return res
}

export const api = {
  async getSettings(): Promise<QdrantSettings> {
    return asJson(await req('/api/qdrant/settings', { cache: 'no-store' }))
  },
  async saveSettings(payload: Partial<QdrantSettings> & { test?: boolean }) {
    return asJson(
      await req('/api/qdrant/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    )
  },
  async testConnection(kind: 'qdrant' | 'embed' | 'rerank', body: { url: string; apiKey?: string; model?: string }) {
    return asJson(
      await req('/api/qdrant/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, ...body }),
      })
    )
  },
  async listCollections(): Promise<{ collections: CollectionSummary[]; total: number }> {
    return asJson(await req('/api/qdrant/collections', { cache: 'no-store' }))
  },
  async getCollection(name: string): Promise<CollectionDetail> {
    return asJson(await req(`/api/qdrant/collections/${encodeURIComponent(name)}`, { cache: 'no-store' }))
  },
  async scrollPoints(name: string, body: {
    limit?: number
    offset?: string | number | null
    with_payload?: boolean | string[]
    with_vector?: boolean | string[]
    filter?: any | null
    order_by?: { key: string; direction: 'asc' | 'desc' } | null
  }): Promise<ScrollResult> {
    return asJson(
      await req(`/api/qdrant/collections/${encodeURIComponent(name)}/points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  },
  async getPoint(name: string, id: string, withVector = false): Promise<{ point: QdrantPoint }> {
    const q = withVector ? '?with_vector=1' : ''
    return asJson(await req(`/api/qdrant/collections/${encodeURIComponent(name)}/points/${encodeURIComponent(id)}${q}`, { cache: 'no-store' }))
  },
  async search(name: string, body: {
    query: string
    mode?: SearchMode
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
  }): Promise<SearchResponse> {
    return asJson(
      await req(`/api/qdrant/collections/${encodeURIComponent(name)}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  },
  async listCallLogs(opts: { collection?: string; source?: string; q?: string; limit?: number; offset?: number } = {}): Promise<{ items: CallLogItem[]; total: number; offset: number; limit: number }> {
    const params = new URLSearchParams()
    if (opts.collection) params.set('collection', opts.collection)
    if (opts.source) params.set('source', opts.source)
    if (opts.q) params.set('q', opts.q)
    params.set('limit', String(opts.limit ?? 20))
    params.set('offset', String(opts.offset ?? 0))
    return asJson(await req(`/api/qdrant/call-logs?${params.toString()}`, { cache: 'no-store' }))
  },
  async deleteCallLog(id: string) {
    return asJson(await req(`/api/qdrant/call-logs/${id}`, { method: 'DELETE' }))
  },
  async clearCallLogs() {
    return asJson(await req('/api/qdrant/call-logs?all=1', { method: 'DELETE' }))
  },
  async cleanupCallLogs(opts: { keep?: number; olderThanDays?: number; before?: string; all?: boolean } = {}) {
    const p = new URLSearchParams()
    if (opts.all) p.set('all', '1')
    if (typeof opts.keep === 'number') p.set('keep', String(opts.keep))
    if (typeof opts.olderThanDays === 'number') p.set('olderThanDays', String(opts.olderThanDays))
    if (opts.before) p.set('before', opts.before)
    return asJson(await req(`/api/qdrant/call-logs?${p.toString()}`, { method: 'DELETE' }))
  },
}

/** Extract the "main content" of a point's payload for display.
 *  Supports Dify-style fields (content/text) AND llama_index-style
 *  `_node_content` (JSON string with `.text` inside).
 */
export function payloadContent(payload: Record<string, any>): string {
  if (!payload) return ''
  const candidates = ['content', 'text', 'page_content', 'chunk', 'segment', 'document', 'doc_text']
  for (const k of candidates) {
    if (typeof payload[k] === 'string' && payload[k].trim()) return payload[k]
  }
  if (typeof payload._node_content === 'string' && payload._node_content.trim()) {
    try {
      const nc = JSON.parse(payload._node_content)
      if (typeof nc.text === 'string' && nc.text.trim()) return nc.text
    } catch {}
  }
  return ''
}

/** Try to find a file location / source identifier inside payload. */
export function payloadFileRef(payload: Record<string, any>): { label: string; value: string } | null {
  if (!payload) return null
  const keys = ['source', 'file', 'file_path', 'doc_name', 'document_name', 'name', 'path', 'doc_id', 'document_id', 'metadata.title']
  for (const k of keys) {
    if (payload[k] && typeof payload[k] === 'string') return { label: k, value: payload[k] }
    if (k.includes('.') && payload.metadata && typeof payload.metadata === 'object') {
      const sub = k.split('.').slice(1).join('.')
      if (payload.metadata[sub]) return { label: k, value: String(payload.metadata[sub]) }
    }
  }
  if (typeof payload._node_content === 'string') {
    try {
      const nc = JSON.parse(payload._node_content)
      const meta = nc.metadata || {}
      for (const k of ['source', 'path', 'file_name']) {
        if (meta[k]) return { label: `metadata.${k}`, value: String(meta[k]) }
      }
    } catch {}
  }
  return null
}
