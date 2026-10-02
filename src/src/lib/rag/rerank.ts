/**
 * 重排模块（契约 §8）：real（OpenAI 兼容 /rerank）| mock（BM25 词法近似，确定性）
 */
import { tokenizeText } from './chunking'
import { getRagSettings } from './settings'
import { StoreError } from './vectorstore'
import type { RerankMode } from './types'

const RERANK_TIMEOUT_MS = 15_000
/** 429/瞬断批内退避重试（真实 API 共享限流场景，检索路径单请求失败代价高） */
const RERANK_RETRY_DELAYS_MS = [2_000, 5_000]

export interface RerankResult {
  index: number
  score: number
}

// ---------------------------------------------------------------------------
// Mock：BM25 近似（k1=1.5, b=0.75），按本批 docs 自身统计，归一化到 0..1
// ---------------------------------------------------------------------------

function mockRerank(query: string, docs: string[], topN: number): RerankResult[] {
  const qTerms = [...new Set(tokenizeText(query).map((t) => t.toLowerCase()))]
  if (qTerms.length === 0) return []
  const docTokens = docs.map((d) => tokenizeText(d).map((t) => t.toLowerCase()))
  const N = Math.max(1, docs.length)
  const avgdl = docTokens.reduce((s, t) => s + t.length, 0) / N || 1

  const df = new Map<string, number>()
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1)
  }

  const k1 = 1.5
  const b = 0.75
  const rawScores = docTokens.map((toks, di) => {
    const tf = new Map<string, number>()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    let s = 0
    for (const t of qTerms) {
      const f = tf.get(t)
      if (!f) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avgdl))
    }
    // 长度归一化因子（BM25 已内含 b；此处再做轻量惩罚超长文档的堆砌）
    return s / (1 + 0.0 * di)
  })

  const max = Math.max(0, ...rawScores)
  const norm = max > 0 ? max : 1
  return rawScores
    .map((score, index) => ({ index, score: score / norm }))
    .filter((r) => r.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, topN)
}

// ---------------------------------------------------------------------------
// Real：POST {base}/rerank
// ---------------------------------------------------------------------------

async function realRerank(
  query: string,
  docs: string[],
  topN: number,
  conn: { apiBase: string; apiKey: string; model: string }
): Promise<RerankResult[]> {
  const base = conn.apiBase.replace(/\/+$/, '')
  // 429/5xx/网络瞬断 → 批内退避重试；400/404 等业务错误立即抛出
  let lastErr: StoreError | undefined
  for (let attempt = 0; attempt <= RERANK_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RERANK_RETRY_DELAYS_MS[Math.min(attempt - 1, RERANK_RETRY_DELAYS_MS.length - 1)]
      console.warn(
        `[rerank] 第 ${attempt} 次重试（等待 ${delay}ms）: ${lastErr?.message.slice(0, 160)}`
      )
      await new Promise((r) => setTimeout(r, delay))
    }
    let res: Response
    try {
      res = await fetch(base + '/rerank', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: conn.model, query, documents: docs, top_n: topN }),
        cache: 'no-store',
        signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
      })
    } catch (e) {
      lastErr = new StoreError(`Rerank API 不可达: ${(e as Error).message}`, { retryable: true })
      continue
    }
    const text = await res.text()
    if (!res.ok) {
      const transient = res.status === 429 || res.status >= 500
      let msg = text.slice(0, 300)
      try {
        msg = JSON.parse(text)?.error?.message || msg
      } catch {}
      const err = new StoreError(`Rerank API 错误 (${res.status}): ${String(msg).slice(0, 300)}`, {
        status: res.status,
        retryable: transient,
      })
      if (transient && attempt < RERANK_RETRY_DELAYS_MS.length) {
        lastErr = err
        continue
      }
      throw err
    }
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      throw new StoreError(`Rerank API 返回非 JSON: ${text.slice(0, 200)}`, { retryable: true })
    }
    const results = (json.results ?? []) as { index?: number; relevance_score?: number; score?: number }[]
    return results
      .map((r) => ({ index: r.index ?? 0, score: r.relevance_score ?? r.score ?? 0 }))
      .filter((r) => r.index >= 0 && r.index < docs.length)
  }
  throw lastErr ?? new StoreError('Rerank API 重试次数耗尽', { retryable: true })
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

export async function rerankDocs(
  query: string,
  docs: string[],
  topN: number
): Promise<RerankResult[]> {
  if (docs.length === 0 || topN <= 0) return []
  const settings = await getRagSettings()
  if (settings.rerankMode === 'real') {
    return realRerank(query, docs, topN, settings.rerank)
  }
  if (settings.rerankMode === 'mock') {
    return mockRerank(query, docs, topN)
  }
  throw new StoreError('未配置 Rerank 且未启用 Mock，请检查平台设置（useMockRerank）', {
    retryable: false,
  })
}

/** 当前重排模式（API 展示用） */
export async function currentRerankMode(): Promise<RerankMode> {
  return (await getRagSettings()).rerankMode
}

/**
 * 重排 provider 标签（供检索日志/白盒数据展示）：
 * real → `openai-compatible · {model}`（携带真实模型名）；mock → 'mock-bm25'；none → 'none'
 */
export async function rerankProviderLabel(): Promise<string> {
  const settings = await getRagSettings()
  if (settings.rerankMode === 'real') {
    return `openai-compatible · ${settings.rerank.model}`
  }
  if (settings.rerankMode === 'mock') return 'mock-bm25'
  return 'none'
}
