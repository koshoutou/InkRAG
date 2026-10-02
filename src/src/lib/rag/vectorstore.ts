/**
 * 向量存储抽象：VectorStore 接口 + Local/ Qdrant 双实现 + 路由（契约 §0/§8）
 *
 * - LocalVectorStore：SQLite VectorPoint 表 + 进程内缓存。
 *   ⚠️ 沙箱演示模式：全量点载入内存 + 暴力扫描。生产环境请配置真实 Qdrant
 *   （计划书 §14 内存红线的沙箱豁免项）。
 * - QdrantVectorStore：REST 实现，建集合严格按计划书 §6.3 固化配置
 *   （memory tier 冷存 + int8 量化 + payload index 对象形式 field_schema）。
 * - getVectorStore()：按设置路由；Qdrant 配置但不可达时自动降级 local 并告警。
 */
import { db } from '@/lib/db'
import { getRagSettings } from './settings'
import type {
  PointInput,
  QueryHit,
  SparseVector,
  VectorFilter,
  VectorFilterCondition,
} from './types'

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
  mode: 'local' | 'qdrant'
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
// 过滤匹配（local 实现，结构对齐 Qdrant Filter）
// ---------------------------------------------------------------------------

function matchCondition(payload: Record<string, unknown>, c: VectorFilterCondition): boolean {
  const v = payload[c.key]
  if (c.range) {
    if (typeof v !== 'number') return false
    const { gte, lte, gt, lt } = c.range
    if (gte !== undefined && v < gte) return false
    if (lte !== undefined && v > lte) return false
    if (gt !== undefined && v <= gt) return false
    if (lt !== undefined && v >= lt) return false
    return true
  }
  if (c.match) {
    if (c.match.any) return c.match.any.includes(v as string | number)
    return v === c.match.value
  }
  return false
}

export function matchFilter(
  payload: Record<string, unknown>,
  filter?: VectorFilter
): boolean {
  if (!filter) return true
  for (const c of filter.must ?? []) if (!matchCondition(payload, c)) return false
  for (const c of filter.must_not ?? []) if (matchCondition(payload, c)) return false
  const should = filter.should ?? []
  if (should.length > 0 && !should.some((c) => matchCondition(payload, c))) return false
  return true
}

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
// RRF 融合（local 模式 + search 管线共用）
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
// LocalVectorStore（SQLite + 进程内缓存）
// ⚠️ 沙箱演示模式：内存全量缓存 + 暴力扫描。生产请配置真实 Qdrant（N5 红线沙箱豁免）
// ---------------------------------------------------------------------------

interface CachedPoint {
  id: string
  dense: number[]
  denseNorm: number
  sparseIndices: number[]
  sparseValues: number[]
  payload: Record<string, unknown>
}

/** globalThis 缓存：Next dev 模式每 route 模块独立实例，需跨模块共享 */
const g = globalThis as unknown as {
  __ragLocalVectorCache?: Map<string, CachedPoint[]>
}
const localCache: Map<string, CachedPoint[]> = (g.__ragLocalVectorCache ??= new Map())

function vecNorm(v: number[]): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

function sparseDot(a: SparseVector, p: CachedPoint): number {
  // 双指针（两侧均升序）
  let dot = 0
  let i = 0
  let j = 0
  while (i < a.indices.length && j < p.sparseIndices.length) {
    const ai = a.indices[i]
    const pj = p.sparseIndices[j]
    if (ai === pj) {
      dot += a.values[i] * p.sparseValues[j]
      i++
      j++
    } else if (ai < pj) {
      i++
    } else {
      j++
    }
  }
  return dot
}

export class LocalVectorStore implements VectorStore {
  mode = 'local' as const

  private async load(name: string): Promise<CachedPoint[]> {
    const cached = localCache.get(name)
    if (cached) return cached
    const rows = await db.vectorPoint.findMany({ where: { collection: name } })
    const points = rows
      .map((r) => {
        let dense: number[] = []
        let sparse: SparseVector = { indices: [], values: [] }
        let payload: Record<string, unknown> = {}
        try {
          dense = JSON.parse(r.dense)
          sparse = JSON.parse(r.sparse)
          payload = JSON.parse(r.payloadJson)
        } catch {
          // 损坏行按空值处理
        }
        sparse.indices.sort((a, b) => a - b)
        // 排序后 values 需与 indices 同步重排
        const order = sparse.indices.map((_, i) => i).sort((a, b) => sparse.indices[a] - sparse.indices[b])
        const sortedValues = order.map((i) => sparse.values[i] ?? 0)
        return {
          id: r.id,
          dense,
          denseNorm: vecNorm(dense),
          sparseIndices: sparse.indices,
          sparseValues: sortedValues,
          payload,
        }
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    localCache.set(name, points)
    return points
  }

  private invalidate(name: string) {
    localCache.delete(name)
  }

  async ensureCollection(_name: string, _dim: number): Promise<void> {
    // local 模式集合元数据由 KnowledgeBase 表承载，此处无需操作
  }

  async deleteCollection(name: string): Promise<void> {
    await db.vectorPoint.deleteMany({ where: { collection: name } })
    this.invalidate(name)
  }

  async listCollections(): Promise<{ name: string; pointsCount: number; dim?: number }[]> {
    // 从 KnowledgeBase 表聚合 + 兜底包含 VectorPoint 中独立出现的集合
    const [kbs, distinct] = await Promise.all([
      db.knowledgeBase.findMany({ select: { collection: true, dim: true } }),
      db.vectorPoint.findMany({ select: { collection: true }, distinct: ['collection'] }),
    ])
    const counts = new Map<string, number>()
    for (const c of distinct) {
      counts.set(c.collection, await db.vectorPoint.count({ where: { collection: c.collection } }))
    }
    const out = new Map<string, { name: string; pointsCount: number; dim?: number }>()
    for (const kb of kbs) {
      out.set(kb.collection, {
        name: kb.collection,
        pointsCount: counts.get(kb.collection) ?? 0,
        dim: kb.dim || undefined,
      })
    }
    for (const [name, cnt] of counts) {
      if (!out.has(name)) out.set(name, { name, pointsCount: cnt })
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async upsertPoints(name: string, points: PointInput[]): Promise<void> {
    const ops = points.map((p) =>
      db.vectorPoint.upsert({
        where: { collection_id: { collection: name, id: p.id } },
        update: {
          dense: JSON.stringify(p.dense),
          sparse: JSON.stringify({ indices: p.sparse.indices, values: p.sparse.values }),
          payloadJson: JSON.stringify(p.payload),
        },
        create: {
          id: p.id,
          collection: name,
          dense: JSON.stringify(p.dense),
          sparse: JSON.stringify({ indices: p.sparse.indices, values: p.sparse.values }),
          payloadJson: JSON.stringify(p.payload),
        },
      })
    )
    // 分事务提交，避免超大事务
    const TX = 200
    for (let i = 0; i < ops.length; i += TX) {
      await db.$transaction(ops.slice(i, i + TX))
    }
    // 增量更新缓存（若已加载）
    const cached = localCache.get(name)
    if (cached) {
      const byId = new Map(cached.map((p) => [p.id, p]))
      for (const p of points) {
        byId.set(p.id, {
          id: p.id,
          dense: p.dense,
          denseNorm: vecNorm(p.dense),
          sparseIndices: [...p.sparse.indices].sort((a, b) => a - b),
          sparseValues: p.sparse.indices
            .map((_, i) => i)
            .sort((a, b) => p.sparse.indices[a] - p.sparse.indices[b])
            .map((i) => p.sparse.values[i] ?? 0),
          payload: p.payload,
        })
      }
      const merged = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
      localCache.set(name, merged)
    }
  }

  async queryDense(
    name: string,
    dense: number[],
    opts: { limit: number; filter?: VectorFilter }
  ): Promise<QueryHit[]> {
    const points = await this.load(name)
    const qn = vecNorm(dense)
    const scored: QueryHit[] = []
    for (const p of points) {
      if (!matchFilter(p.payload, opts.filter)) continue
      if (p.dense.length !== dense.length || p.denseNorm === 0 || qn === 0) continue
      let dot = 0
      for (let i = 0; i < dense.length; i++) dot += dense[i] * p.dense[i]
      scored.push({ id: p.id, score: dot / (qn * p.denseNorm), payload: p.payload })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, opts.limit)
  }

  async querySparse(
    name: string,
    sparse: SparseVector,
    opts: { limit: number; filter?: VectorFilter }
  ): Promise<QueryHit[]> {
    const points = await this.load(name)
    const sorted = [...sparse.indices]
      .map((_, i) => i)
      .sort((a, b) => sparse.indices[a] - sparse.indices[b])
    const qIndices = sorted.map((i) => sparse.indices[i])
    const qValues = sorted.map((i) => sparse.values[i])
    const scored: QueryHit[] = []
    for (const p of points) {
      if (!matchFilter(p.payload, opts.filter)) continue
      let dot = 0
      let i = 0
      let j = 0
      while (i < qIndices.length && j < p.sparseIndices.length) {
        const ai = qIndices[i]
        const pj = p.sparseIndices[j]
        if (ai === pj) {
          dot += qValues[i] * p.sparseValues[j]
          i++
          j++
        } else if (ai < pj) i++
        else j++
      }
      if (dot > 0) scored.push({ id: p.id, score: dot, payload: p.payload })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, opts.limit)
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
    const [denseRanked, sparseRanked] = await Promise.all([
      this.queryDense(name, opts.dense, { limit: opts.prefetchLimit, filter: opts.filter }),
      this.querySparse(name, opts.sparse, { limit: opts.prefetchLimit, filter: opts.filter }),
    ])
    const fused =
      opts.fusion === 'dbsf'
        ? dbsfFuse(denseRanked, sparseRanked, { limit: opts.limit, weights: opts.weights })
        : rrfFuse(denseRanked, sparseRanked, {
            limit: opts.limit,
            k: opts.rrfK,
            weights: opts.weights,
          })
    return fused
  }

  async scroll(
    name: string,
    opts: { filter?: VectorFilter; limit: number; offset?: unknown; withVector?: boolean }
  ): Promise<{ points: QueryHit[]; nextOffset: unknown }> {
    const points = await this.load(name)
    const filtered = opts.filter ? points.filter((p) => matchFilter(p.payload, opts.filter)) : points
    const offset = typeof opts.offset === 'number' ? opts.offset : 0
    const slice = filtered.slice(offset, offset + opts.limit)
    const nextOffset = offset + slice.length < filtered.length ? offset + slice.length : null
    return {
      points: slice.map((p) => ({ id: p.id, score: 0, payload: p.payload })),
      nextOffset,
    }
  }

  async deleteByFilter(name: string, filter: VectorFilter): Promise<void> {
    const points = await this.load(name)
    const victims = points.filter((p) => matchFilter(p.payload, filter)).map((p) => p.id)
    if (victims.length === 0) return
    await db.vectorPoint.deleteMany({ where: { collection: name, id: { in: victims } } })
    this.invalidate(name)
  }

  async deletePoints(name: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await db.vectorPoint.deleteMany({ where: { collection: name, id: { in: ids } } })
    this.invalidate(name)
  }

  async setPayload(
    name: string,
    ids: string[],
    payloadPatch: Record<string, unknown>
  ): Promise<void> {
    if (ids.length === 0) return
    const rows = await db.vectorPoint.findMany({ where: { collection: name, id: { in: ids } } })
    const ops = rows.map((r) => {
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(r.payloadJson)
      } catch {}
      return db.vectorPoint.update({
        where: { collection_id: { collection: name, id: r.id } },
        data: { payloadJson: JSON.stringify({ ...payload, ...payloadPatch }) },
      })
    })
    await db.$transaction(ops)
    this.invalidate(name)
  }

  async getPoints(
    name: string,
    ids: string[],
    opts?: { withVector?: boolean }
  ): Promise<(QueryHit & { vector?: { dense?: number[]; sparse?: SparseVector } })[]> {
    const rows = await db.vectorPoint.findMany({ where: { collection: name, id: { in: ids } } })
    return rows.map((r) => {
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(r.payloadJson)
      } catch {}
      const out: QueryHit & { vector?: { dense?: number[]; sparse?: SparseVector } } = {
        id: r.id,
        score: 0,
        payload,
      }
      if (opts?.withVector) {
        try {
          out.vector = {
            dense: JSON.parse(r.dense),
            sparse: JSON.parse(r.sparse),
          }
        } catch {}
      }
      return out
    })
  }

  async count(name: string, filter?: VectorFilter): Promise<number> {
    if (!filter) return db.vectorPoint.count({ where: { collection: name } })
    const points = await this.load(name)
    return points.filter((p) => matchFilter(p.payload, filter)).length
  }
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
    const BATCH = 64
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH).map((p) => ({
        id: p.id,
        vector: {
          dense: p.dense,
          sparse: { indices: p.sparse.indices, values: p.sparse.values },
        },
        payload: p.payload,
      }))
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
    const result = await this.fetchJson<{ points: { id: any; score: number; payload?: any }[] }>(
      `/collections/${encodeURIComponent(name)}/points/query`,
      {
        method: 'POST',
        body: {
          prefetch: [
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
          ],
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
// 路由 + 健康探测
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

/** Qdrant 健康探测（3s 超时；默认 30s 缓存，noCache 强制实时） */
export async function isQdrantReachable(
  conn: QdrantConn,
  opts: { timeoutMs?: number; noCache?: boolean } = {}
): Promise<ProbeResult> {
  const key = conn.url
  if (!opts.noCache) {
    const cached = probeCache.get(key)
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached
  }
  let result: ProbeResult
  try {
    const base = conn.url.replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (conn.apiKey) headers['api-key'] = conn.apiKey
    const res = await fetch(base + '/readyz', {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
    })
    if (!res.ok) {
      result = { ok: false, message: `连接失败：HTTP ${res.status}`, at: Date.now() }
    } else {
      let version: string | undefined
      try {
        const vRes = await fetch(base + '/', {
          headers,
          cache: 'no-store',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
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
 * 按设置路由获取向量存储。
 * Qdrant 配置但不可达 → 自动降级 local 并 console.warn（每次降级一条）。
 */
export async function getVectorStore(): Promise<VectorStore> {
  const settings = await getRagSettings()
  if (settings.vectorMode === 'qdrant') {
    const probe = await isQdrantReachable(settings.qdrant)
    if (probe.ok) return new QdrantVectorStore(settings.qdrant)
    console.warn(
      `[vectorstore] Qdrant（${settings.qdrant.url}）不可达：${probe.message}，自动降级 local 模式`
    )
  }
  return new LocalVectorStore()
}
