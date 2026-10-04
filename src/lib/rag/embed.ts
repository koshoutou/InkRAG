/**
 * 嵌入模块（契约 §8）：real（OpenAI 兼容 /embeddings）| mock（确定性哈希特征向量，显式离线调试）
 *
 * v1.6 变更：
 * - real 模式 sparse 输出：从响应 data[i] 上多字段探测原生稀疏（openai-compatible 变体 /
 *   BGE-M3 lexical_weights / Cohere 风格嵌套）。探测不到 → sparse = {indices:[],values:[]}，
 *   **绝不**退化为 mock 词袋（防止两种 sparse 空间静默混用导致索引断裂）。
 * - mock 模式仅由设置页显式开启（useMockEmbedding，离线调试专用），默认关闭。
 * - probeEmbedding()：建库前实测探测 dim + sparse 方案（写入 kb.dim / kb.sparseScheme 锁定）。
 * - assertEmbedScheme()：入库/恢复前断言当前嵌入与建库时锁定的方案一致。
 */
import { tokenizeText } from './chunking'
import { getRagSettings } from './settings'
import { StoreError } from './vectorstore'
import type { EmbedMode, SparseVector } from './types'

const EMBED_TIMEOUT_MS = 30_000
const EMBED_BATCH = 64

/**
 * F-EXT-01：体积感知超时——30s 对 64 条长文本一批偏紧。
 * 基准 30s + 每千字符 40ms（64×2000 字 ≈ +5.1s），封顶 120s；空批回退基准值。
 */
function embedTimeoutMs(texts: string[]): number {
  if (texts.length === 0) return EMBED_TIMEOUT_MS
  let chars = 0
  for (const t of texts) chars += t.length
  return Math.min(120_000, EMBED_TIMEOUT_MS + Math.round((chars / 1000) * 40))
}

// ---------------------------------------------------------------------------
// F-EXT-02：嵌入熔断器（进程内，globalThis 单例）——provider 持续 5xx/不可达时
// 每组仍走完 4 次尝试（最长 ~26s × 组数），失败文档堆积目白白消耗。
// 连续 N 次可重试失败 → 开路 OPEN_MS（直接抛 retryable 快速失败，不发起请求）；
// 半开：开路期满后放行一次探测，成功复位 / 失败重新开路（翻倍遇冷，封 10 分钟）。
// ---------------------------------------------------------------------------

const BREAKER_THRESHOLD = 6
const BREAKER_OPEN_MS = 60_000
const BREAKER_OPEN_CAP_MS = 10 * 60_000

interface EmbedBreakerState {
  consecFails: number
  openUntil: number
  openMs: number
  halfOpenProbe: boolean
}
const breakerG = globalThis as unknown as { __ragEmbedBreaker?: EmbedBreakerState }

function breaker(): EmbedBreakerState {
  if (!breakerG.__ragEmbedBreaker) {
    breakerG.__ragEmbedBreaker = { consecFails: 0, openUntil: 0, openMs: BREAKER_OPEN_MS, halfOpenProbe: false }
  }
  return breakerG.__ragEmbedBreaker
}

/** 熔断开路中返回剩余毫秒，0 = 放行 */
function breakerBlockedMs(): number {
  const b = breaker()
  if (b.openUntil <= Date.now()) return 0
  return b.openUntil - Date.now()
}

function breakerRecord(ok: boolean): void {
  const b = breaker()
  if (ok) {
    b.consecFails = 0
    b.openUntil = 0
    b.openMs = BREAKER_OPEN_MS
    b.halfOpenProbe = false
    return
  }
  b.consecFails += 1
  if (b.consecFails >= BREAKER_THRESHOLD) {
    // 已在开路期再失败 → 退避翻倍（半开探测失败场景）
    b.openMs = Math.min(BREAKER_OPEN_CAP_MS, b.openUntil > Date.now() ? b.openMs * 2 : b.openMs)
    b.openUntil = Date.now() + b.openMs
    b.halfOpenProbe = false
    console.warn(`[embed][breaker] 连续 ${b.consecFails} 次可重试失败，开路 ${Math.round(b.openMs / 1000)}s（快速失败，不再空耗重试）`)
  }
}

/** 开路期满后的首次调用作为半开探测标记 */
function breakerTakeProbe(): boolean {
  const b = breaker()
  if (b.openUntil > 0 && b.openUntil <= Date.now() && !b.halfOpenProbe) {
    b.halfOpenProbe = true
    return true
  }
  return false
}

export const DEFAULT_EMBED_DIM = 1024

// 429/瞬断退避重试（真实 API 实测联调引入：共享 qpm 限流的大文档嵌入会命中 429）
const EMBED_RETRY_DELAYS_MS = [3_000, 8_000, 15_000]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 解析 Retry-After 响应头（秒数或 HTTP 日期），封顶 30s；无法解析返回 undefined */
function parseRetryAfter(res: Response): number | undefined {
  const v = res.headers.get('retry-after')
  if (!v) return undefined
  const sec = Number(v)
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 30_000)
  const at = Date.parse(v)
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 30_000)
  return undefined
}

// ---------------------------------------------------------------------------
// Mock 算法（仅显式离线调试开关 useMockEmbedding=true 时启用）
// ---------------------------------------------------------------------------

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function mockEmbedOne(text: string, dim: number): { dense: number[]; sparse: SparseVector } {
  const tokens = tokenizeText(text).map((t) => t.toLowerCase())
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)

  const dense = new Array<number>(dim).fill(0)
  const sparseMap = new Map<number, number>()

  for (const [tok, count] of tf) {
    const h = fnv1a(tok)
    // dense：hash % dim 为 index，权重 1+log(tf)（同 index 累加）
    dense[h % dim] += 1 + Math.log(count)
    // sparse：hash % 65536 为 index，value = tf（同 index 累加）
    const si = h % 65536
    sparseMap.set(si, (sparseMap.get(si) ?? 0) + count)
  }
  // L2 归一化
  let norm = 0
  for (let i = 0; i < dim; i++) norm += dense[i] * dense[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < dim; i++) dense[i] /= norm

  const indices = [...sparseMap.keys()].sort((a, b) => a - b)
  const values = indices.map((i) => sparseMap.get(i) ?? 0)
  return { dense, sparse: { indices, values } }
}

// ---------------------------------------------------------------------------
// Real 调用（OpenAI 兼容）+ 原生稀疏多字段探测
// ---------------------------------------------------------------------------

interface RealEmbedResponse {
  data: {
    index?: number
    embedding: number[]
    /** openai-compatible 稀疏变体（x-ai / 荷开等网关） */
    sparse_indices?: { indices: number[]; values: number[] }
    /** 备选字段（多字段探测按优先级依次尝试） */
    sparse_embedding?: unknown
    lexical_weights?: unknown
    sparse?: unknown
    /** Cohere 风格嵌套（data[i].embeddings.sparse） */
    embeddings?: { sparse?: unknown }
  }[]
}

/** data[i] 上探测原生稀疏输出的字段候选（按优先级） */
const SPARSE_FIELD_CANDIDATES = ['sparse_embedding', 'sparse_indices', 'lexical_weights', 'sparse'] as const

/** 空稀疏向量（sparseScheme=none：点位不带稀疏，检索强制 dense） */
export const EMPTY_SPARSE: SparseVector = { indices: [], values: [] }

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 归一稀疏向量：indices 升序 + values 同步重排（values 与 indices 一一对应）。
 * 输入允许乱序（providers 可能按词序返回）。
 */
function sortSparse(indices: number[], values: number[]): SparseVector {
  const order = indices.map((_, i) => i).sort((a, b) => indices[a] - indices[b])
  return {
    indices: order.map((i) => indices[i]),
    values: order.map((i) => values[i] ?? 0),
  }
}

/**
 * 从单个字段值解析稀疏向量，兼容多种形态：
 * - {indices:number[], values:number[]}（及 values/data/weights 命名变体）
 * - [[idx, w], ...] 二元组数组
 * - { [token_id]: weight } 对象映射（BGE-M3 lexical_weights 官方命名等）
 * 解析失败（空/形态不符）返回 null。
 */
function parseSparseField(raw: unknown): SparseVector | null {
  if (raw === null || raw === undefined) return null

  // 二元组数组：[[idx, w], ...]
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null
    const indices: number[] = []
    const values: number[] = []
    for (const item of raw) {
      if (
        Array.isArray(item) &&
        item.length >= 2 &&
        isFiniteNumber(item[0]) &&
        isFiniteNumber(item[1])
      ) {
        indices.push(item[0])
        values.push(item[1])
      } else {
        return null // 混合形态视为不匹配
      }
    }
    return indices.length > 0 ? sortSparse(indices, values) : null
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    // {indices, values | data | weights} 形态
    const idx = obj.indices
    if (Array.isArray(idx) && idx.length > 0) {
      const valArr = (obj.values ?? obj.data ?? obj.weights) as unknown
      if (Array.isArray(valArr) && valArr.length === idx.length) {
        const indices: number[] = []
        const values: number[] = []
        let ok = true
        for (let i = 0; i < idx.length; i++) {
          const id = idx[i]
          const w = valArr[i]
          if (!isFiniteNumber(id) || !isFiniteNumber(w)) {
            ok = false
            break
          }
          indices.push(id)
          values.push(w)
        }
        if (ok) return sortSparse(indices, values)
      }
      // {indices, values} 变体长度不齐 → 尝试其它字段
    }
    // { [token_id]: weight } 对象映射（BGE-M3 lexical_weights：{"8980": 0.13, ...}）
    const indices: number[] = []
    const values: number[] = []
    for (const [k, w] of Object.entries(obj)) {
      const id = Number(k)
      if (Number.isInteger(id) && isFiniteNumber(w) && w !== 0) {
        indices.push(id)
        values.push(w)
      }
    }
    if (indices.length > 0) return sortSparse(indices, values)
  }
  return null
}

/**
 * 从响应 data[i] 上探测原生稀疏输出（按字段候选优先级 + Cohere 风格嵌套）。
 * 探测不到返回 null（调用方写入空 sparse，绝不退化 mock 词袋）。
 */
function probeSparseFromDatum(d: RealEmbedResponse['data'][number]): SparseVector | null {
  for (const key of SPARSE_FIELD_CANDIDATES) {
    const v = (d as unknown as Record<string, unknown>)[key]
    if (v === null || v === undefined) continue
    const parsed = parseSparseField(v)
    if (parsed) return parsed
  }
  // Cohere 风格：data[i].embeddings.sparse
  const nested = (d as unknown as Record<string, unknown>)['embeddings']
  if (nested && typeof nested === 'object') {
    const parsed = parseSparseField((nested as Record<string, unknown>)['sparse'])
    if (parsed) return parsed
  }
  return null
}

async function realEmbedBatch(
  texts: string[],
  conn: { apiBase: string; apiKey: string; model: string }
): Promise<{ vectors: number[][]; sparse: SparseVector[] }> {
  const base = conn.apiBase.replace(/\/+$/, '')
  // F-EXT-02：熔断开路中 → 直接 retryable 快速失败（不发起请求不空耗重试）；
  // 开路期满的首个调用作为半开探测放行（成功复位 / 失败重新开路翻倍）
  const blockedMs = breakerBlockedMs()
  if (blockedMs > 0) {
    const isProbe = breakerTakeProbe()
    if (!isProbe) {
      throw new StoreError(
        `Embedding 熔断中（连续 ${BREAKER_THRESHOLD} 次可重试失败），约 ${Math.ceil(blockedMs / 1000)}s 后自动半开探测——期间任务将快速失败回队，不消耗重试预算`,
        { retryable: true }
      )
    }
  }
  // 429/5xx/网络瞬断 → 批内退避重试（避免整文档流水线因共享限流瞬时窗口而失败；
  // 流水线级重试是“从头重跑整个 embed 阶段”，远贵于批内等待）
  interface TransientEmbedError extends StoreError {
    retryAfterMs?: number
  }
  let lastErr: TransientEmbedError | undefined
  for (let attempt = 0; attempt <= EMBED_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay =
        lastErr?.retryAfterMs !== undefined
          ? lastErr.retryAfterMs
          : EMBED_RETRY_DELAYS_MS[Math.min(attempt - 1, EMBED_RETRY_DELAYS_MS.length - 1)]
      console.warn(
        `[embed] 第 ${attempt} 次重试（等待 ${Math.round(delay / 1000)}s）: ${lastErr?.message.slice(0, 160)}`
      )
      await sleep(delay)
    }
    let res: Response
    try {
      res = await fetch(base + '/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: conn.model, input: texts.length === 1 ? texts[0] : texts }),
        cache: 'no-store',
        // F-EXT-01：超时按批字符量动态化
        signal: AbortSignal.timeout(embedTimeoutMs(texts)),
      })
    } catch (e) {
      // 网络层（超时/DNS/断连）→ 瞬时可重试
      lastErr = new StoreError(`Embedding API 不可达: ${(e as Error).message}`, {
        retryable: true,
      }) as TransientEmbedError
      continue
    }
    const text = await res.text()
    let json: RealEmbedResponse
    try {
      json = JSON.parse(text)
    } catch {
      const err = new StoreError(
        `Embedding API 返回非 JSON (${res.status}): ${text.slice(0, 200)}`,
        { status: res.status, retryable: res.status >= 500 || res.status === 429 }
      ) as TransientEmbedError
      if (err.retryable && attempt < EMBED_RETRY_DELAYS_MS.length) {
        lastErr = err
        continue
      }
      throw err
    }
    if (!res.ok) {
      const msg = (json as any)?.error?.message || (json as any)?.error || text.slice(0, 200)
      const transient = res.status === 429 || res.status >= 500
      const err = new StoreError(
        `Embedding API 错误 (${res.status}): ${String(msg).slice(0, 300)}`,
        { status: res.status, retryable: transient }
      ) as TransientEmbedError
      if (res.status === 429) {
        const ra = parseRetryAfter(res)
        if (ra !== undefined) err.retryAfterMs = ra
      }
      if (transient && attempt < EMBED_RETRY_DELAYS_MS.length) {
        lastErr = err
        continue
      }
      throw err
    }
    const data = (json.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    if (data.length !== texts.length) {
      // F-EXT-03：数量不符（provider 截断/异常）→ 纳入批内重试循环（与 429/5xx 同路径），
      // 而非当前循环直接 throw（原先该错误绕过重试直达失败）
      const err = new StoreError(
        `Embedding API 返回数量不匹配（期望 ${texts.length} 实得 ${data.length}）`,
        { retryable: true }
      ) as TransientEmbedError
      if (attempt < EMBED_RETRY_DELAYS_MS.length) {
        lastErr = err
        continue
      }
      throw err
    }
    const vectors = data.map((d) => d.embedding)
    // 原生稀疏多字段探测；探测不到 → 空 sparse（绝不退化 mock 词袋）
    const sparse = data.map((d) => probeSparseFromDatum(d) ?? EMPTY_SPARSE)
    // F-EXT-02：成功 → 熔断计数复位
    breakerRecord(true)
    return { vectors, sparse }
  }
  // F-EXT-02：批内重试耗尽仍失败 → 熔断记账（连续达阈值即开路）
  breakerRecord(false)
  throw (
    lastErr ??
    new StoreError('Embedding API 重试次数耗尽', { retryable: true })
  )
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

export interface EmbedResult {
  vectors: number[][]
  sparse: SparseVector[]
  dim: number
  provider: string
}

export interface EmbedTextsOpts {
  dim?: number
  onProgress?: (done: number, total: number) => void
}

/** 批量嵌入：按当前设置自动路由 real/mock；64/批 */
export async function embedTexts(
  texts: string[],
  opts: EmbedTextsOpts = {}
): Promise<EmbedResult> {
  if (texts.length === 0) {
    return { vectors: [], sparse: [], dim: opts.dim ?? DEFAULT_EMBED_DIM, provider: 'noop' }
  }
  const settings = await getRagSettings()
  const dim = opts.dim ?? DEFAULT_EMBED_DIM

  if (settings.embedMode === 'real') {
    const vectors: number[][] = []
    const sparse: SparseVector[] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH)
      const r = await realEmbedBatch(batch, settings.embed)
      vectors.push(...r.vectors)
      sparse.push(...r.sparse)
      opts.onProgress?.(Math.min(i + EMBED_BATCH, texts.length), texts.length)
    }
    return {
      vectors,
      sparse,
      dim: vectors[0]?.length ?? dim,
      provider: `openai-compatible · ${settings.embed.model}`,
    }
  }

  if (settings.embedMode === 'mock') {
    const vectors: number[][] = []
    const sparse: SparseVector[] = []
    for (let i = 0; i < texts.length; i++) {
      const m = mockEmbedOne(texts[i], dim)
      vectors.push(m.dense)
      sparse.push(m.sparse)
      if ((i + 1) % EMBED_BATCH === 0 || i === texts.length - 1) {
        opts.onProgress?.(i + 1, texts.length)
      }
    }
    return { vectors, sparse, dim, provider: 'mock-deterministic' }
  }

  throw new StoreError('未配置 Embedding API（且未显式开启 Mock 调试开关），请到「设置 → Embedding」配置', {
    retryable: false,
  })
}

/** 查询嵌入（单条，与批量同口径） */
export async function embedQuery(
  text: string,
  dim?: number
): Promise<{ dense: number[]; sparse: SparseVector; dim: number; provider: string }> {
  const r = await embedTexts([text], { dim })
  return { dense: r.vectors[0], sparse: r.sparse[0], dim: r.dim, provider: r.provider }
}

/** 当前嵌入模式（API 展示用） */
export async function currentEmbedMode(): Promise<EmbedMode> {
  return (await getRagSettings()).embedMode
}

// ---------------------------------------------------------------------------
// 建库探测 + 方案断言（v1.6：dim / sparse 方案建库时锁定）
// ---------------------------------------------------------------------------

export interface EmbedProbeResult {
  ok: boolean
  /** 实测向量维度（探测成功时 > 0） */
  dim: number
  /** native：provider 原生稀疏输出 | none：无稀疏输出（检索强制 dense） */
  sparseScheme: 'native' | 'none'
  /** provider 标识（如 openai-compatible · BAAI/bge-m3） */
  provider: string
  error?: string
}

/**
 * 嵌入一条探测文本，实测 dim 与稀疏方案（建库时调用，写入 kb.dim / kb.sparseScheme 锁定）。
 * embedMode !== 'real'（未配置或仅 mock 调试）→ ok:false + 明确错误（不允许以 mock 建库）。
 */
export async function probeEmbedding(): Promise<EmbedProbeResult> {
  const settings = await getRagSettings()
  if (settings.embedMode !== 'real') {
    return {
      ok: false,
      dim: 0,
      sparseScheme: 'none',
      provider: 'unconfigured',
      error: '未配置 Embedding API（请到「设置 → Embedding」配置 API Base 与模型 ID）',
    }
  }
  try {
    const r = await realEmbedBatch(['connectivity probe'], settings.embed)
    const dim = r.vectors[0]?.length ?? 0
    if (dim <= 0) {
      return {
        ok: false,
        dim: 0,
        sparseScheme: 'none',
        provider: 'unknown',
        error: 'Embedding API 返回空向量',
      }
    }
    const hasSparse = r.sparse[0]?.indices?.length > 0
    return {
      ok: true,
      dim,
      sparseScheme: hasSparse ? 'native' : 'none',
      provider: `openai-compatible · ${settings.embed.model}`,
    }
  } catch (e) {
    return {
      ok: false,
      dim: 0,
      sparseScheme: 'none',
      provider: 'unknown',
      error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    }
  }
}

/**
 * 断言当前嵌入产出与建库时锁定的方案一致（pipeline upsert 前 / 版本恢复重嵌入前调用）。
 * - dim 不匹配（kb.dim > 0 且不等）→ 失败
 * - kb.sparseScheme='native' 但存在空 sparse 点 → 失败（原生稀疏库不该出现空点）
 * - kb.sparseScheme='none' 但存在非空 sparse 点 → 失败（none 库检索强制 dense，混入稀疏即方案漂移）
 */
export function assertEmbedScheme(
  kb: { dim: number; sparseScheme: string },
  emb: { vectors: number[][]; sparse: SparseVector[]; dim: number }
): void {
  if (kb.dim > 0 && emb.dim > 0 && emb.dim !== kb.dim) {
    throw new StoreError(
      `嵌入维度与建库时锁定不一致（库 dim=${kb.dim}，当前 ${emb.dim}）：与建库时锁定的方案不一致，请勿中途更换嵌入模型/配置（换模型请新建知识库重导）`,
      { retryable: false }
    )
  }
  const native = kb.sparseScheme === 'native'
  const emptyCount = emb.sparse.filter((s) => !s || s.indices.length === 0).length
  if (native && emptyCount > 0) {
    throw new StoreError(
      `建库锁定 sparseScheme=native（原生稀疏），但本次嵌入存在 ${emptyCount} 个空稀疏点：与建库时锁定的方案不一致，请勿中途更换嵌入模型/配置`,
      { retryable: false }
    )
  }
  if (!native && emptyCount < emb.sparse.length) {
    throw new StoreError(
      `建库锁定 sparseScheme=none（无稀疏输出，检索强制 dense），但本次嵌入携带了稀疏向量：与建库时锁定的方案不一致，请勿中途更换嵌入模型/配置`,
      { retryable: false }
    )
  }
}
