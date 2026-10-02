/**
 * 嵌入模块（契约 §8）：real（OpenAI 兼容 /embeddings）| mock（确定性哈希特征向量）
 *
 * - real：64/批调用 {base}/embeddings；sparse 优先读响应 data[].sparse_indices/values，
 *   无则退化为词法生成（与 mock 的 sparse 算法一致）。
 *   provider 携带真实模型名（`openai-compatible · {model}`），
 *   供检索白盒/调用日志区分 real/mock（mock 为 'mock-deterministic'）。
 * - mock：tokenize（与 countTokens 同口径）→ FNV-1a hash → index = hash % dim →
 *   权重 = 1+log(tf) → L2 归一化；sparse：index = hash % 65536，value = tf。
 *   同文本必得同向量（确定性，语义近似：共现词越多向量越接近）。
 */
import { tokenizeText } from './chunking'
import { getRagSettings } from './settings'
import { StoreError } from './vectorstore'
import type { EmbedMode, SparseVector } from './types'

const EMBED_TIMEOUT_MS = 30_000
const EMBED_BATCH = 64
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
// Mock 算法
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
// Real 调用（OpenAI 兼容）
// ---------------------------------------------------------------------------

interface RealEmbedResponse {
  data: {
    index?: number
    embedding: number[]
    sparse_indices?: { indices: number[]; values: number[] }
  }[]
}

async function realEmbedBatch(
  texts: string[],
  conn: { apiBase: string; apiKey: string; model: string }
): Promise<{ vectors: number[][]; sparse: SparseVector[] }> {
  const base = conn.apiBase.replace(/\/+$/, '')
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
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
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
      throw new StoreError(
        `Embedding API 返回数量不匹配（期望 ${texts.length} 实得 ${data.length}）`,
        { retryable: true }
      )
    }
    const vectors = data.map((d) => d.embedding)
    const sparse = data.map((d, i) => {
      if (d.sparse_indices?.indices?.length) {
        // 保持与 indices 排序一致
        const order = d.sparse_indices.indices.map((_, j) => j).sort(
          (a, b) => d.sparse_indices!.indices[a] - d.sparse_indices!.indices[b]
        )
        return {
          indices: order.map((j) => d.sparse_indices!.indices[j]),
          values: order.map((j) => d.sparse_indices!.values?.[j] ?? 0),
        }
      }
      // 无原生 sparse → 词法生成（同 mock 口径）
      return mockEmbedOne(texts[i], vectors[i]?.length ?? DEFAULT_EMBED_DIM).sparse
    })
    return { vectors, sparse }
  }
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

  throw new StoreError('未配置 Embedding 且未启用 Mock，请检查平台设置（useMockEmbedding）', {
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
