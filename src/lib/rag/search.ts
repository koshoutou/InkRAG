/**
 * 检索管线（计划书 §12.1 六阶段；§32 后仅供内部质量回归/运维排障使用）
 *
 * Stage A · Embedding: query → dense + sparse（耗时/向量摘要）
 * Stage B · 双路召回: dense/sparse 各自 Top prefetchLimit（各路分数保留展示）
 * Stage C · 融合: RRF（默认 k=60, w=[0.5,0.5]）| DBSF → fusedTop
 * Stage D · Rerank（可选）: fused Top → rerank → Top-N
 * Stage E · 上下文回填: parent_text 冗余直用；缺失则按 parent_id 读父 chunk 全文
 * Stage F · 组装: 结果 + 坐标溯源 + stages 耗时 + 调试信息
 *
 * 说明：对外检索 API（/api/v1/knowledge-bases/…/search 与 /api/search/debug）与检索日志记录
 * 已按「平台只做知识库管理」定位移除（Task 17-1 / 契约 §32）；runSearch 仅由
 * 测试集质量回归（testset.ts）与内部排障调用，不产生任何检索日志。
 */
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { embedQuery } from './embed'
import { rerankDocs } from './rerank'
import { chunkPath, resolveStorageKey } from './artifacts'
import { promises as fs } from 'node:fs'
import { buildSearchFilter, dbsfFuse, getVectorStore, rrfFuse, StoreError } from './vectorstore'
import type {
  DebugTopItem,
  FusedTopItem,
  QueryHit,
  RerankTopItem,
  SearchDebugOpts,
  SearchFilter,
  SearchResponse,
} from './types'

export interface RunSearchOpts {
  source: 'debug-console' | 'external' | 'web-ui'
  kbId: string
  query: string
  topK?: number
  mode?: 'hybrid' | 'dense' | 'sparse'
  rerank?: boolean
  prefetchLimit?: number
  filter?: SearchFilter
  withParentContext?: boolean
  debug?: SearchDebugOpts
}

const DEFAULT_TOP_K = 5
const DEFAULT_PREFETCH = 50

/** 读 chunk 全文（payload 只有 preview，全文落盘在 artifacts） */
async function readChunkFullText(
  kbId: string,
  docId: string,
  chunkId: string,
  fallback: string
): Promise<string> {
  try {
    return await fs.readFile(chunkPath(kbId, docId, chunkId), 'utf-8')
  } catch {
    return fallback
  }
}

export async function runSearch(opts: RunSearchOpts): Promise<SearchResponse> {
  const startedAll = Date.now()
  const topK = Math.min(Math.max(opts.topK ?? DEFAULT_TOP_K, 1), 50)
  const prefetchLimit = Math.min(
    Math.max(opts.debug?.prefetchLimit ?? opts.prefetchLimit ?? DEFAULT_PREFETCH, topK),
    200
  )
  const fusion = opts.debug?.fusion ?? 'rrf'
  const rrfK = opts.debug?.rrfK ?? 60
  const weights = opts.debug?.rrfWeights ?? ([0.5, 0.5] as [number, number])
  const wantRerank = opts.rerank ?? false
  const withParentContext = opts.withParentContext ?? true

  const kb = await db.knowledgeBase.findUnique({ where: { id: opts.kbId } })
  if (!kb) throw new Error('知识库不存在')
  const store = await getVectorStore()
  const dim = kb.dim || 1024
  // v1.6：sparseScheme 建库时锁定。none（provider 无稀疏输出）→ 无论请求何种 mode 都强制
  // dense 检索（空稀疏召回无语义，且避免误触发 sparse 查询报错）；native → 按请求 mode 执行
  const sparseScheme: 'none' | 'native' = kb.sparseScheme === 'native' ? 'native' : 'none'
  const requestedMode = opts.mode ?? 'hybrid'
  const mode: 'hybrid' | 'dense' | 'sparse' =
    sparseScheme === 'none' ? 'dense' : requestedMode

  // ---- Stage A · Embedding ----
  const tEmbed = Date.now()
  const embedded = await embedQuery(opts.query, dim)
  const embedMs = Date.now() - tEmbed
  const denseHash = createHash('sha256')
    .update(embedded.dense.map((v) => v.toFixed(6)).join(','))
    .digest('hex')
    .slice(0, 16)

  // ---- Stage B · 双路召回 ----
  const tRecall = Date.now()
  const vfilter = buildSearchFilter({
    docIds: opts.filter?.docIds,
    pageRange: opts.filter?.pageRange,
  })
  const needDense = mode === 'hybrid' || mode === 'dense'
  const needSparse = mode === 'hybrid' || mode === 'sparse'
  if (needSparse && embedded.sparse.indices.length === 0) {
    // 防御：native 库理论上查询嵌入必有稀疏输出；空则说明嵌入方案与建库锁定不一致
    throw new StoreError(
      `知识库 sparseScheme=native 但查询嵌入无稀疏输出（嵌入配置可能已变更，与建库时锁定的方案不一致）`,
      { retryable: false }
    )
  }
  const [denseRanked, sparseRanked] = await Promise.all([
    needDense
      ? store.queryDense(kb.collection, embedded.dense, { limit: prefetchLimit, filter: vfilter })
      : Promise.resolve([] as QueryHit[]),
    needSparse
      ? store.querySparse(kb.collection, embedded.sparse, { limit: prefetchLimit, filter: vfilter })
      : Promise.resolve([] as QueryHit[]),
  ]).catch((e: unknown) => {
    // 集合在当前 Qdrant 不存在（典型：换实例后未重新入库）→ 转为友好错误而非裸 500，
    // 前端可引导「重新解析/切分入库」
    if (e instanceof StoreError && e.status === 404) {
      throw new Error(
        `向量集合 ${kb.collection} 在当前 Qdrant 中不存在（可能更换了 Qdrant 实例后未重新入库），请在文档中心对该知识库文档执行重解析或重切分`
      )
    }
    throw e
  })
  const recallMs = Date.now() - tRecall

  // ---- Stage C · 融合 ----
  const tFusion = Date.now()
  let fused: QueryHit[]
  if (mode === 'dense') {
    fused = denseRanked.slice(0, topK * 4)
  } else if (mode === 'sparse') {
    fused = sparseRanked.slice(0, topK * 4)
  } else {
    fused =
      fusion === 'dbsf'
        ? dbsfFuse(denseRanked, sparseRanked, { limit: Math.max(prefetchLimit, topK), weights })
        : rrfFuse(denseRanked, sparseRanked, {
            limit: Math.max(prefetchLimit, topK),
            k: rrfK,
            weights,
          })
  }
  const fusionMs = Date.now() - tFusion

  const toDebugTop = (hits: QueryHit[], n: number): DebugTopItem[] =>
    hits.slice(0, n).map((h) => ({
      chunkId: h.id,
      score: Math.round(h.score * 1e6) / 1e6,
      page: Number(h.payload?.page ?? 0),
      preview: String(h.payload?.text_preview ?? '').slice(0, 120),
    }))
  const denseRankMap = new Map(denseRanked.map((h, i) => [h.id, i + 1]))
  const sparseRankMap = new Map(sparseRanked.map((h, i) => [h.id, i + 1]))
  const fusedTop: FusedTopItem[] = fused.slice(0, 50).map((h) => ({
    chunkId: h.id,
    score: Math.round(h.score * 1e6) / 1e6,
    denseRank: denseRankMap.get(h.id),
    sparseRank: sparseRankMap.get(h.id),
  }))

  // ---- Stage D · Rerank（可选）----
  const tRerank = Date.now()
  let rerankMs = 0
  let rerankTop: RerankTopItem[] | undefined
  let finalOrder: QueryHit[] = fused.slice(0, topK)
  const rerankScores = new Map<string, number>()

  if (wantRerank && fused.length > 0) {
    // 重排输入：fused Top（全文，非 preview）
    const rerankCandidates = fused.slice(0, Math.max(prefetchLimit, topK))
    const docIds = new Set(
      rerankCandidates.map((h) => String(h.payload?.doc_id ?? '')).filter(Boolean)
    )
    const docRows = docIds.size
      ? await db.document.findMany({ where: { id: { in: [...docIds] } }, select: { id: true } })
      : []
    const docIdSet = new Set(docRows.map((d) => d.id))
    const texts = await Promise.all(
      rerankCandidates.map((h) => {
        const docId = String(h.payload?.doc_id ?? '')
        if (!docId || !docIdSet.has(docId)) return Promise.resolve(String(h.payload?.text_preview ?? ''))
        return readChunkFullText(kb.id, docId, h.id, String(h.payload?.text_preview ?? ''))
      })
    )
    const ranked = await rerankDocs(opts.query, texts, Math.min(topK, rerankCandidates.length))
    rerankMs = Date.now() - tRerank
    rerankTop = ranked.map((r) => ({
      chunkId: rerankCandidates[r.index]?.id ?? '',
      rerankScore: Math.round(r.score * 1e6) / 1e6,
      prevRank: fused.findIndex((f) => f.id === rerankCandidates[r.index]?.id) + 1 || undefined!,
    }))
    rerankTop = rerankTop.filter((r) => r.chunkId)
    for (const r of ranked) {
      const id = rerankCandidates[r.index]?.id
      if (id) rerankScores.set(id, r.score)
    }
    finalOrder = ranked
      .map((r) => rerankCandidates[r.index])
      .filter((h): h is QueryHit => Boolean(h))
      .slice(0, topK)
  } else {
    rerankMs = Date.now() - tRerank
  }

  // ---- Stage E · 上下文回填 ----
  const tContext = Date.now()
  const finalIds = finalOrder.map((h) => h.id)
  const parentIds = [
    ...new Set(
      finalOrder
        .map((h) => (h.payload?.parent_id ? String(h.payload.parent_id) : null))
        .filter((v): v is string => Boolean(v))
    ),
  ]
  const parentTextCache = new Map<string, string | null>()
  if (parentIds.length > 0) {
    const parentRows = await db.chunk.findMany({
      where: { id: { in: parentIds } },
      select: { id: true, storageKey: true, kbId: true },
    })
    await Promise.all(
      parentRows.map(async (p) => {
        try {
          parentTextCache.set(p.id, await fs.readFile(resolveStorageKey(p.storageKey), 'utf-8'))
        } catch {
          parentTextCache.set(p.id, null)
        }
      })
    )
  }
  // 文件名映射
  const finalDocIds = [
    ...new Set(
      finalOrder.map((h) => String(h.payload?.doc_id ?? '')).filter(Boolean)
    ),
  ]
  const docNameRows = finalDocIds.length
    ? await db.document.findMany({ where: { id: { in: finalDocIds } }, select: { id: true, filename: true } })
    : []
  const filenameMap = new Map(docNameRows.map((d) => [d.id, d.filename]))

  const hits = await Promise.all(
    finalOrder.map(async (h) => {
      const docId = String(h.payload?.doc_id ?? '')
      const fullText = await readChunkFullText(kb.id, docId, h.id, String(h.payload?.text_preview ?? ''))
      let parentText: string | null = null
      if (withParentContext) {
        if (typeof h.payload?.parent_text === 'string' && h.payload.parent_text) {
          parentText = h.payload.parent_text
        } else {
          const pid = h.payload?.parent_id ? String(h.payload.parent_id) : null
          parentText = pid ? (parentTextCache.get(pid) ?? null) : null
        }
      }
      return {
        chunkId: h.id,
        score: Math.round(h.score * 1e6) / 1e6,
        rerankScore: rerankScores.has(h.id)
          ? Math.round((rerankScores.get(h.id) ?? 0) * 1e6) / 1e6
          : null,
        text: fullText,
        parentText,
        source: {
          docId,
          filename: filenameMap.get(docId) ?? '',
          page: Number(h.payload?.page ?? 0),
          bbox: Array.isArray(h.payload?.bbox_from) ? (h.payload.bbox_from as number[]) : null,
          seq: Number(h.payload?.seq ?? 0),
          docType: String(h.payload?.doc_type ?? 'text'),
        },
      }
    })
  )
  const contextMs = Date.now() - tContext
  const tookMs = Date.now() - startedAll

  const response: SearchResponse = {
    tookMs,
    stages: { embedMs, recallMs, fusionMs, rerankMs, contextMs },
    results: hits,
    debug: {
      embed: {
        dim: embedded.dim,
        denseHash,
        denseFirst8: embedded.dense.slice(0, 8).map((v) => Math.round(v * 1e6) / 1e6),
        sparseNnz: embedded.sparse.indices.length,
        provider: embedded.provider,
      },
      denseTop: toDebugTop(denseRanked, 10),
      sparseTop: toDebugTop(sparseRanked, 10),
      fusedTop,
      ...(rerankTop ? { rerankTop } : {}),
      fusion: mode === 'hybrid' ? fusion : mode,
      rrfK: mode === 'hybrid' && fusion === 'rrf' ? rrfK : undefined,
      mode,
      sparseScheme,
    },
  }

  // §32（Task 17-1）：对外检索 API 与检索日志记录已随「平台只做知识库管理」定位移除；
  // runSearch 仅保留内部质量回归（测试集）与运维排障用途，不再写 QdrantCallLog。
  return response
}
