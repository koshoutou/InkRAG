/**
 * 向量存储抽象：VectorStore 接口 + Qdrant 实现 + 路由（契约 §0/§8）
 *
 * v1.6：本地向量引擎（LocalVectorStore / SQLite VectorPoint 表）已整体移除。
 * - 未配置 Qdrant（url 为空）→ getVectorStore() 硬失败（StoreError，不可重试），
 *   绝不静默降级，避免「写 SQLite 读 Qdrant」的索引断裂。
 * - 已配置但不可达 → 硬失败（StoreError，可重试），错误信息引导用户检查连接。
 * - QdrantVectorStore：REST 实现，建集合严格按计划书 §6.3 固化配置
 *   （memory tier 冷存 + int8 量化 + payload index 对象形式 field_schema）。
 *   点级 sparse 向量可选（sparseScheme=none 的库允许点不带稀疏向量，只传 dense+payload）。
 */
import { getRagSettings } from './settings'
import type {
  PointInput,
  QueryHit,
  SparseVector,
  VectorFilter,
  VectorFilterCondition,
} from './types'

// 类型再导出：chunkedit 等模块历史沿用 `from './vectorstore'` 的类型导入路径（保持兼容）
export type { PointInput, QueryHit, SparseVector, VectorFilter, VectorFilterCondition }

// ---------------------------------------------------------------------------
// 错误分类（计划书 §6.9 铁律：400/404 NonRetryable；5xx/429/网络 Retryable）
// ---------------------------------------------------------------------------

export class StoreError extends Error {
  status?: number
  /** false = 业务错误（不可重试）；true = 瞬时错误（可重试） */
  retryable: boolean
  constructor(message: string, opts: { status?: number; retryable: boolean } = { retryable: true }) {
    super(message)
    this.name = 'StoreError'
    this.status = opts.status
    this.retryable = opts.retryable
  }
}

export function isNonRetryable(e: unknown): boolean {
  return e instanceof StoreError && !e.retryable
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

export interface VectorStore {
  mode: 'qdrant'
  ensureCollection(name: string, dim: number): Promise<void>
  deleteCollection(name: string): Promise<void>
  listCollections(): Promise<{ name: string; pointsCount: number; dim?: number }[]>
  upsertPoints(name: string, points: PointInput[]): Promise<void>
  queryDense(
    name: string,
    dense: number[],
    opts: { limit: number; filter?: VectorFilter }
  ): Promise<QueryHit[]>
  querySparse(
    name: string,
    sparse: SparseVector,
    opts: { limit: number; filter?: VectorFilter }
  ): Promise<QueryHit[]>
  queryHybrid(
    name: string,
    opts: {
      dense: number[]
      sparse: SparseVector
      limit: number
      prefetchLimit: number
      filter?: VectorFilter
      rrfK?: number
      weights?: [number, number]
      fusion?: 'rrf' | 'dbsf'
    }
  ): Promise<QueryHit[]>
  scroll(
    name: string,
    opts: { filter?: VectorFilter; limit: number; offset?: unknown; withVector?: boolean }
  ): Promise<{ points: QueryHit[]; nextOffset: unknown }>
  deleteByFilter(name: string, filter: VectorFilter): Promise<void>
  deletePoints(name: string, ids: string[]): Promise<void>
  setPayload(name: string, ids: string[], payloadPatch: Record<string, unknown>): Promise<void>
  getPoints(
    name: string,
    ids: string[],
    opts?: { withVector?: boolean }
  ): Promise<(QueryHit & { vector?: { dense?: number[]; sparse?: SparseVector } })[]>
  count(name: string, filter?: VectorFilter): Promise<number>
}

// ---------------------------------------------------------------------------
// 过滤构造（检索管线用）
// ---------------------------------------------------------------------------

/** 契约检索 filter → Qdrant 风格 filter（检索管线用） */
export function buildSearchFilter(input: {
  docIds?: string[]
  pageRange?: [number, number]
  extra?: VectorFilterCondition[]
}): VectorFilter {
  const must: VectorFilterCondition[] = [{ key: 'enabled', match: { value: true } }]
  if (input.docIds?.length) must.push({ key: 'doc_id', match: { any: input.docIds } })
  if (input.pageRange) {
    // 重叠语义（§6.4 坐标链路）：chunk 覆盖区间与请求页区间相交即命中
    // （page_from <= rangeEnd 且 page_to >= rangeStart；跨页 chunk 的内容落在请求页上也应召回）
    must.push({ key: 'page_from', range: { lte: input.pageRange[1] } })
    must.push({ key: 'page_to', range: { gte: input.pageRange[0] } })
  }
  for (const c of input.extra ?? []) must.push(c)
  return { must }
}

// ---------------------------------------------------------------------------
// RRF 融合（search 管线进程内融合，与 Qdrant 语义一致）
// ---------------------------------------------------------------------------

export function rrfFuse(
  denseRanked: { id: string; score: number; payload: Record<string, unknown> }[],
  sparseRanked: { id: string; score: number; payload: Record<string, unknown> }[],
  opts: { limit: number; k?: number; weights?: [number, number] }
): QueryHit[] {
  const k = opts.k ?? 60
  const [wd, ws] = opts.weights ?? [0.5, 0.5]
  const scores = new Map<string, number>()
  const payloads = new Map<string, Record<string, unknown>>()
  denseRanked.forEach((h, i) => {
    scores.set(h.id, (scores.get(h.id) ?? 0) + wd / (k + i + 1))
    payloads.set(h.id, h.payload)
  })
  sparseRanked.forEach((h, i) => {
    scores.set(h.id, (scores.get(h.id) ?? 0) + ws / (k + i + 1))
    payloads.set(h.id, h.payload)
  })
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, payload: payloads.get(id) ?? {} }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
}

/** DBSF（Distribution-Based Score Fusion）：各路 z-score 归一后加权和 */
export function dbsfFuse(
  denseRanked: { id: string; score: number; payload: Record<string, unknown> }[],
  sparseRanked: { id: string; score: number; payload: Record<string, unknown> }[],
  opts: { limit: number; weights?: [number, number] }
): QueryHit[] {
  const [wd, ws] = opts.weights ?? [0.5, 0.5]
  const znorm = (
    arr: { id: string; score: number }[]
  ): Map<string, number> => {
    const out = new Map<string, number>()
    if (arr.length === 0) return out
    const mean = arr.reduce((s, x) => s + x.score, 0) / arr.length
    const variance = arr.reduce((s, x) => s + (x.score - mean) ** 2, 0) / arr.length
    const std = Math.sqrt(variance)
    for (const x of arr) out.set(x.id, std > 0 ? (x.score - mean) / std : 0)
    return out
  }
  const dz = znorm(denseRanked)
  const sz = znorm(sparseRanked)
  const payloads = new Map<string, Record<string, unknown>>()
  denseRanked.forEach((h) => payloads.set(h.id, h.payload))
  sparseRanked.forEach((h) => payloads.set(h.id, h.payload))
  const scores = new Map<string, number>()
  for (const [id, z] of dz) scores.set(id, (scores.get(id) ?? 0) + wd * z)
  for (const [id, z] of sz) scores.set(id, (scores.get(id) ?? 0) + ws * z)
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, payload: payloads.get(id) ?? {} }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
}

// ---------------------------------------------------------------------------
// QdrantVectorStore（真实 REST）
// ---------------------------------------------------------------------------

const QDRANT_TIMEOUT_MS = 10_000
/** 写操作（PUT/POST/DELETE，含大批量 upsert）超时：远程实例 + ~2MB/批向量载荷，10s 偏紧（实测超时失败案例） */
const QDRANT_WRITE_TIMEOUT_MS = 30_000
/** 网络瞬断 / 429 / 5xx 的批内退避重试间隔 */
const QDRANT_RETRY_DELAYS_MS = [1_000, 3_000]

export interface QdrantConn {
  url: string
  apiKey: string
}

export class QdrantVectorStore implements VectorStore {
  mode = 'qdrant' as const
  private base: string

  constructor(private conn: QdrantConn) {
    this.base = conn.url.replace(/\/+$/, '')
  }

  private async fetchJson<T>(
    path: string,
    init: {
      method?: string
      body?: unknown
      query?: Record<string, string>
      timeoutMs?: number
    } = {}
  ): Promise<T> {
    const method = init.method ?? 'GET'
    const timeoutMs =
      init.timeoutMs ?? (method === 'GET' ? QDRANT_TIMEOUT_MS : QDRANT_WRITE_TIMEOUT_MS)
    let url = this.base + path
    if (init.query && Object.keys(init.query).length) {
      url += (url.includes('?') ? '&' : '?') + new URLSearchParams(init.query).toString()
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.conn.apiKey) headers['api-key'] = this.conn.apiKey

    // 瞬时错误（网络超时/断连、429、5xx）批内退避重试；400/404 等业务错误立即抛出
    let lastErr: StoreError | undefined
    for (let attempt = 0; attempt <= QDRANT_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = QDRANT_RETRY_DELAYS_MS[Math.min(attempt - 1, QDRANT_RETRY_DELAYS_MS.length - 1)]
        console.warn(
          `[vectorstore] Qdrant ${method} ${path} 瞬时错误，${delay}ms 后重试（第 ${attempt} 次）: ${lastErr?.message.slice(0, 160)}`
        )
        await new Promise((r) => setTimeout(r, delay))
      }
      let res: Response
      try {
        res = await fetch(url, {
          method,
          headers,
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          cache: 'no-store',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        // 网络层（超时/DNS/断连）→ 瞬时可重试
        lastErr = new StoreError(`Qdrant 不可达: ${(e as Error).message}`, { retryable: true })
        continue
      }
      const text = await res.text()
      let json: any
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        const err = new StoreError(`Qdrant 返回非 JSON：${res.status} ${text.slice(0, 300)}`, {
          status: res.status,
          retryable: !(res.status === 400 || res.status === 404),
        })
        if (err.retryable && attempt < QDRANT_RETRY_DELAYS_MS.length) {
          lastErr = err
          continue
        }
        throw err
      }
      if (!res.ok) {
        const msg = json?.error || json?.message || json?.status?.error || `HTTP ${res.status}`
        // §6.9 铁律：400/404 NonRetryable；429/5xx Retryable
        const err = new StoreError(`Qdrant 错误 (${res.status}): ${String(msg).slice(0, 300)}`, {
          status: res.status,
          retryable: !(res.status === 400 || res.status === 404),
        })
        if (err.retryable && attempt < QDRANT_RETRY_DELAYS_MS.length) {
          lastErr = err
          continue
        }
        throw err
      }
      if (json && typeof json === 'object' && 'result' in json) return json.result as T
      return json as T
    }
    throw lastErr ?? new StoreError('Qdrant 请求失败（重试耗尽）', { retryable: true })
  }

  /** 版本守卫（§6.1）：非 1.19.x 打 warning，不崩溃 */
  private static versionChecked = false
  private async versionGuard(): Promise<void> {
    if (QdrantVectorStore.versionChecked) return
    QdrantVectorStore.versionChecked = true
    try {
      const info = await this.fetchJson<{ version?: string }>('/')
      if (info?.version && !info.version.startsWith('1.19')) {
        console.warn(
          `[vectorstore] Qdrant Server ${info.version} 与固化配置对齐版本 1.19.x 不一致，可能存在兼容性问题`
        )
      }
    } catch (e) {
      // 版本探测失败不阻断（后续操作会给出明确错误）
      console.warn('[vectorstore] Qdrant 版本探测失败:', (e as Error).message)
      QdrantVectorStore.versionChecked = false
    }
  }

  async ensureCollection(name: string, dim: number): Promise<void> {
    await this.versionGuard()
    try {
      await this.fetchJson(`/collections/${encodeURIComponent(name)}`)
      return // 已存在 → 幂等返回
    } catch (e) {
      if (!(e instanceof StoreError) || e.status !== 404) throw e
    }
    // §6.3 固化配置（禁止 UI / 环境变量注入，N4）
    // sparse 向量索引保留（Qdrant 允许点名稀疏向量按点可选）：
    // sparseScheme=none 的库写入不带 sparse 的点、检索强制 dense，集合级稀疏索引不产生冲突
    const schema = {
      vectors: {
        dense: { size: dim, distance: 'Cosine', memory: 'cold' },
      },
      sparse_vectors: {
        sparse: { index: { memory: 'cold' } },
      },
      payload: { memory: 'cold' },
      hnsw_config: { m: 0, payload_m: 16, memory: 'cold', full_scan_threshold: 10_000 },
      quantization_config: { scalar: { type: 'int8', quantile: 0.99, memory: 'pinned' } },
      optimizers_config: {
        indexing_threshold: 20_000,
        max_optimization_threads: 1,
        default_segment_number: 2,
      },
      wal_config: { wal_capacity_mb: 32 },
      replication_factor: 1,
    }
    await this.fetchJson(`/collections/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: schema,
    })
    // §6.5 payload index：对象形式 field_schema（memory 显式 cold + keyword 禁 HNSW 辅助图）
    const indexes: { field_name: string; field_schema: Record<string, unknown> }[] = [
      { field_name: 'kb_id', field_schema: { type: 'keyword', memory: 'cold', enable_hnsw: false } },
      { field_name: 'doc_id', field_schema: { type: 'keyword', memory: 'cold', enable_hnsw: false } },
      { field_name: 'parent_id', field_schema: { type: 'keyword', memory: 'cold', enable_hnsw: false } },
      { field_name: 'page', field_schema: { type: 'integer', memory: 'cold', range: true, lookup: true } },
    ]
    for (const idx of indexes) {
      try {
        await this.fetchJson(`/collections/${encodeURIComponent(name)}/index`, {
          method: 'PUT',
          body: idx,
        })
      } catch (e) {
        // 版本兼容降级：对象形式 field_schema（含 memory/enable_hnsw/range/lookup）为 1.10+/1.11+/1.14+ 特性，
        // 老版本（1.9.x）PayloadFieldSchema 仅接受字符串简写（"keyword"/"integer"）→ 400。
        // 两级降级：① 最简对象 { type } ② 字符串简写；index 仅影响过滤性能，不阻塞功能。
        if (e instanceof StoreError && e.status === 400) {
          console.warn(
            `[vectorstore] payload index 对象 schema 不被当前 Qdrant 版本支持，降级字符串简写（${idx.field_name}）:`,
            e.message.slice(0, 160)
          )
          await this.fetchJson(`/collections/${encodeURIComponent(name)}/index`, {
            method: 'PUT',
            body: { field_name: idx.field_name, field_schema: String(idx.field_schema.type) },
          })
        } else {
          throw e
        }
      }
    }
  }

  async deleteCollection(name: string): Promise<void> {
    await this.fetchJson(`/collections/${encodeURIComponent(name)}`, { method: 'DELETE' })
  }

  async listCollections(): Promise<{ name: string; pointsCount: number; dim?: number }[]> {
    const list = await this.fetchJson<{ collections: { name: string }[] }>('/collections')
    const out: { name: string; pointsCount: number; dim?: number }[] = []
    for (const c of list?.collections ?? []) {
      try {
        const info = await this.fetchJson<{
          points_count?: number
          config?: { params?: { vectors?: any } }
        }>(`/collections/${encodeURIComponent(c.name)}`)
        let dim: number | undefined
        const vectors = info?.config?.params?.vectors
        if (vectors?.dense?.size) dim = vectors.dense.size
        else if (vectors?.size) dim = vectors.size
        out.push({ name: c.name, pointsCount: info?.points_count ?? 0, dim })
      } catch {
        out.push({ name: c.name, pointsCount: 0 })
      }
    }
    return out
  }

  async upsertPoints(name: string, points: PointInput[]): Promise<void> {
    // §6.9：wait=false 批量写。64/批（实测远程实例联调：256/批 ≈ 1.8MB 请求体在
    // 慢速上行链路（<60KB/s 窗口）下连续超时；64/批 ≈ 460KB 可在 30s 写超时内完成，
    // 且幂等重 PUT 使部分成功无害）
    // sparseScheme=none 的库允许 sparse 为空（{indices:[],values:[]}）：
    // 空的点只上传 dense + payload，不携带稀疏向量（Qdrant 点级可选）
    const BATCH = 64
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH).map((p) => {
        const hasSparse = p.sparse?.indices?.length > 0
        return {
          id: p.id,
          vector: hasSparse
            ? {
                dense: p.dense,
                sparse: { indices: p.sparse.indices, values: p.sparse.values },
              }
            : { dense: p.dense },
          payload: p.payload,
        }
      })
      await this.fetchJson(`/collections/${encodeURIComponent(name)}/points`, {
        method: 'PUT',
        query: { wait: 'false' },
        body: { points: batch },
      })
    }
  }

  async queryDense(
    name: string,
    dense: number[],
    opts: { limit: number; filter?: VectorFilter }
  ): Promise<QueryHit[]> {
    const result = await this.fetchJson<{ points: { id: any; score: number; payload?: any }[] }>(
      `/collections/${encodeURIComponent(name)}/points/query`,
      {
        method: 'POST',
        body: {
          query: dense,
          using: 'dense',
          limit: opts.limit,
          filter: opts.filter,
          with_payload: true,
        },
      }
    )
    return (result?.points ?? []).map((p) => ({
      id: String(p.id),
      score: p.score ?? 0,
      payload: p.payload ?? {},
    }))
  }

  async querySparse(
    name: string,
    sparse: SparseVector,
    opts: { limit: number; filter?: VectorFilter }
  ): Promise<QueryHit[]> {
    // 空稀疏查询（sparseScheme=none 的 provider）无召回语义，直接返回空
    if (!sparse || sparse.indices.length === 0) return []
    const result = await this.fetchJson<{ points: { id: any; score: number; payload?: any }[] }>(
      `/collections/${encodeURIComponent(name)}/points/query`,
      {
        method: 'POST',
        body: {
          query: { indices: sparse.indices, values: sparse.values },
          using: 'sparse',
          limit: opts.limit,
          filter: opts.filter,
          with_payload: true,
        },
      }
    )
    return (result?.points ?? []).map((p) => ({
      id: String(p.id),
      score: p.score ?? 0,
      payload: p.payload ?? {},
    }))
  }

  async queryHybrid(
    name: string,
    opts: {
      dense: number[]
      sparse: SparseVector
      limit: number
      prefetchLimit: number
      filter?: VectorFilter
      rrfK?: number
      weights?: [number, number]
      fusion?: 'rrf' | 'dbsf'
    }
  ): Promise<QueryHit[]> {
    // §6.6 Query API 原生 prefetch + fusion（一次请求完成双路召回与融合）
    const query =
      opts.fusion === 'dbsf'
        ? { fusion: 'dbsf' }
        : opts.rrfK !== undefined || opts.weights !== undefined
          ? { rrf: { k: opts.rrfK ?? 60, weights: opts.weights ?? [0.5, 0.5] } }
          : { fusion: 'rrf' }
    // 空稀疏查询（sparseScheme=none）：退化为纯 dense 单路（等价 queryDense）
    const hasSparse = opts.sparse?.indices?.length > 0
    const prefetch = hasSparse
      ? [
          {
            query: opts.dense,
            using: 'dense',
            limit: opts.prefetchLimit,
            filter: opts.filter,
          },
          {
            query: { indices: opts.sparse.indices, values: opts.sparse.values },
            using: 'sparse',
            limit: opts.prefetchLimit,
            filter: opts.filter,
          },
        ]
      : [
          {
            query: opts.dense,
            using: 'dense',
            limit: opts.prefetchLimit,
            filter: opts.filter,
          },
        ]
    const result = await this.fetchJson<{ points: { id: any; score: number; payload?: any }[] }>(
      `/collections/${encodeURIComponent(name)}/points/query`,
      {
        method: 'POST',
        body: {
          prefetch,
          query,
          limit: opts.limit,
          with_payload: true,
        },
      }
    )
    return (result?.points ?? []).map((p) => ({
      id: String(p.id),
      score: p.score ?? 0,
      payload: p.payload ?? {},
    }))
  }

  async scroll(
    name: string,
    opts: { filter?: VectorFilter; limit: number; offset?: unknown; withVector?: boolean }
  ): Promise<{ points: QueryHit[]; nextOffset: unknown }> {
    const result = await this.fetchJson<{
      points: { id: any; payload?: any; vector?: any }[]
      next_page_offset: unknown
    }>(`/collections/${encodeURIComponent(name)}/points/scroll`, {
      method: 'POST',
      body: {
        limit: opts.limit,
        offset: opts.offset ?? undefined,
        with_payload: true,
        with_vector: opts.withVector ?? false,
        filter: opts.filter ?? undefined,
      },
    })
    return {
      points: (result?.points ?? []).map((p) => ({
        id: String(p.id),
        score: 0,
        payload: p.payload ?? {},
        ...(opts.withVector ? { vector: p.vector } : {}),
      })) as QueryHit[],
      nextOffset: result?.next_page_offset ?? null,
    }
  }

  async deleteByFilter(name: string, filter: VectorFilter): Promise<void> {
    await this.fetchJson(`/collections/${encodeURIComponent(name)}/points/delete`, {
      method: 'POST',
      query: { wait: 'true' },
      body: { filter },
    })
  }

  async deletePoints(name: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.fetchJson(`/collections/${encodeURIComponent(name)}/points/delete`, {
      method: 'POST',
      query: { wait: 'true' },
      body: { points: ids },
    })
  }

  async setPayload(
    name: string,
    ids: string[],
    payloadPatch: Record<string, unknown>
  ): Promise<void> {
    if (ids.length === 0) return
    await this.fetchJson(`/collections/${encodeURIComponent(name)}/points/payload`, {
      method: 'POST',
      query: { wait: 'true' },
      body: { payload: payloadPatch, points: ids },
    })
  }

  async getPoints(
    name: string,
    ids: string[],
    opts?: { withVector?: boolean }
  ): Promise<(QueryHit & { vector?: { dense?: number[]; sparse?: SparseVector } })[]> {
    const result = await this.fetchJson<
      { id: any; payload?: any; vector?: any }[]
    >(`/collections/${encodeURIComponent(name)}/points/get`, {
      method: 'POST',
      body: { ids, with_payload: true, with_vector: opts?.withVector ?? false },
    })
    return (result ?? []).map((p) => ({
      id: String(p.id),
      score: 0,
      payload: p.payload ?? {},
      ...(opts?.withVector ? { vector: p.vector } : {}),
    })) as (QueryHit & { vector?: { dense?: number[]; sparse?: SparseVector } })[]
  }

  async count(name: string, filter?: VectorFilter): Promise<number> {
    const result = await this.fetchJson<{ count: number }>(
      `/collections/${encodeURIComponent(name)}/points/count`,
      {
        method: 'POST',
        body: { filter: filter ?? undefined, exact: true },
      }
    )
    return result?.count ?? 0
  }
}

// ---------------------------------------------------------------------------
// 健康探测 + 路由（未配置 / 不可达一律硬失败，v1.6 起无本地降级）
// ---------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean
  version?: string
  message: string
  at: number
}

const gProbe = globalThis as unknown as { __ragQdrantProbe?: Map<string, ProbeResult> }
const probeCache: Map<string, ProbeResult> = (gProbe.__ragQdrantProbe ??= new Map())
const PROBE_TTL_MS = 30_000
/** 失败探测短缓存：链路抖动时让重试尽快重新探测（审计实测发现） */
const PROBE_FAIL_TTL_MS = 5_000

/** Qdrant 健康探测（默认 10s 超时——远程高延迟实例实测 3s 过紧导致误判不可达；30s 缓存，noCache 强制实时） */
export async function isQdrantReachable(
  conn: QdrantConn,
  opts: { timeoutMs?: number; noCache?: boolean } = {}
): Promise<ProbeResult> {
  const key = conn.url
  if (!opts.noCache) {
    const cached = probeCache.get(key)
    // 成功探测缓存 30s；失败探测只缓存 5s——链路抖动时 job 的重试不应
    // 全部落在同一个“不可达”缓存窗口内瞬败（否则 3 次重试形同虚设）
    if (cached && Date.now() - cached.at < (cached.ok ? PROBE_TTL_MS : PROBE_FAIL_TTL_MS)) {
      return cached
    }
  }
  let result: ProbeResult
  try {
    const base = conn.url.replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (conn.apiKey) headers['api-key'] = conn.apiKey
    const res = await fetch(base + '/readyz', {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    })
    if (!res.ok) {
      result = { ok: false, message: `连接失败：HTTP ${res.status}`, at: Date.now() }
    } else {
      let version: string | undefined
      try {
        const vRes = await fetch(base + '/', {
          headers,
          cache: 'no-store',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        })
        if (vRes.ok) version = (await vRes.json())?.version
      } catch {}
      result = { ok: true, version, message: '连接成功', at: Date.now() }
    }
  } catch (e) {
    result = { ok: false, message: `连接失败：${(e as Error).message}`, at: Date.now() }
  }
  probeCache.set(key, result)
  return result
}

/**
 * 获取向量存储（唯一实现：Qdrant）。
 * - 未配置（url 为空）→ 硬失败（StoreError，retryable=false），引导用户到设置页配置
 * - 已配置但不可达 → 硬失败（StoreError，retryable=true），已禁止降级本地写入以避免索引断裂
 */
export async function getVectorStore(): Promise<VectorStore> {
  const settings = await getRagSettings()
  if (settings.vectorMode !== 'qdrant' || !settings.qdrant.url) {
    throw new StoreError('未配置 Qdrant 连接：请到「设置 → Qdrant」配置服务器地址', {
      retryable: false,
      status: 503,
    })
  }
  const probe = await isQdrantReachable(settings.qdrant)
  if (probe.ok) return new QdrantVectorStore(settings.qdrant)
  throw new StoreError(
    `Qdrant 不可达（${probe.message}）：已禁止降级本地写入以避免索引断裂，请检查连接后重试`,
    { retryable: true, status: 503 }
  )
}
