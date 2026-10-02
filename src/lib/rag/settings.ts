/**
 * RAG 平台设置读取 + 双模式判定（契约 §0 / §8 settings）
 *
 * 设置存于 Prisma QdrantSetting 单行（id='default'），首次读取时自动播种。
 * 双模式判定规则：
 *   - vectorMode: url 非空 → 'qdrant'（运行时不可达由 getVectorStore 自动降级 local 并告警），否则 'local'
 *   - parseMode:  mineruApiUrl 非空 → 'mineru'；否则 useFallbackParser → 'fallback'；否则 'none'（解析时抛错）
 *   - embedMode:  embedApiBase + embedModel 非空 → 'real'；否则 useMockEmbedding → 'mock'；否则 'none'
 *   - rerankMode: rerankApiBase + rerankModel 非空 → 'real'；否则 useMockRerank → 'mock'；否则 'none'
 */
import { db } from '@/lib/db'
import type { EmbedMode, ParseMode, RerankMode, VectorMode } from './types'

export interface RagSettings {
  /** 原始设置行 */
  row: {
    id: string
    url: string
    apiKey: string
    defaultCollection: string
    embedApiBase: string
    embedApiKey: string
    embedModel: string
    rerankApiBase: string
    rerankApiKey: string
    rerankModel: string
    mineruApiUrl: string
    mineruApiKey: string
    mineruTier: string
    mineruOcrMode: string
    useLocalVectorStore: boolean
    useFallbackParser: boolean
    useMockEmbedding: boolean
    useMockRerank: boolean
    updatedAt: Date
  }
  vectorMode: VectorMode
  parseMode: ParseMode
  embedMode: EmbedMode
  rerankMode: RerankMode
  qdrant: { url: string; apiKey: string }
  mineru: { url: string; apiKey: string; tier: string; ocrMode: string }
  embed: { apiBase: string; apiKey: string; model: string }
  rerank: { apiBase: string; apiKey: string; model: string }
}

/** 读取（或播种）单例设置行 */
export async function getSettingsRow() {
  let row = await db.qdrantSetting.findUnique({ where: { id: 'default' } })
  if (!row) {
    row = await db.qdrantSetting.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default' },
    })
  }
  return row
}

/** 读取设置并做双模式判定（不发起任何网络请求，纯配置判定） */
export async function getRagSettings(): Promise<RagSettings> {
  const row = await getSettingsRow()

  const vectorMode: VectorMode = row.url.trim() ? 'qdrant' : 'local'

  let parseMode: ParseMode
  if (row.mineruApiUrl.trim()) {
    parseMode = 'mineru'
  } else if (row.useFallbackParser) {
    parseMode = 'fallback'
  } else {
    parseMode = 'none'
  }

  let embedMode: EmbedMode
  if (row.embedApiBase.trim() && row.embedModel.trim()) {
    embedMode = 'real'
  } else if (row.useMockEmbedding) {
    embedMode = 'mock'
  } else {
    embedMode = 'none'
  }

  let rerankMode: RerankMode
  if (row.rerankApiBase.trim() && row.rerankModel.trim()) {
    rerankMode = 'real'
  } else if (row.useMockRerank) {
    rerankMode = 'mock'
  } else {
    rerankMode = 'none'
  }

  return {
    row: {
      id: row.id,
      url: row.url,
      apiKey: row.apiKey,
      defaultCollection: row.defaultCollection,
      embedApiBase: row.embedApiBase,
      embedApiKey: row.embedApiKey,
      embedModel: row.embedModel,
      rerankApiBase: row.rerankApiBase,
      rerankApiKey: row.rerankApiKey,
      rerankModel: row.rerankModel,
      mineruApiUrl: row.mineruApiUrl,
      mineruApiKey: row.mineruApiKey,
      mineruTier: row.mineruTier,
      mineruOcrMode: row.mineruOcrMode,
      useLocalVectorStore: row.useLocalVectorStore,
      useFallbackParser: row.useFallbackParser,
      useMockEmbedding: row.useMockEmbedding,
      useMockRerank: row.useMockRerank,
      updatedAt: row.updatedAt,
    },
    vectorMode,
    parseMode,
    embedMode,
    rerankMode,
    qdrant: { url: row.url.trim(), apiKey: row.apiKey },
    mineru: {
      url: row.mineruApiUrl.trim(),
      apiKey: row.mineruApiKey,
      tier: row.mineruTier || 'standard',
      ocrMode: row.mineruOcrMode || 'auto',
    },
    embed: {
      apiBase: row.embedApiBase.trim(),
      apiKey: row.embedApiKey,
      model: row.embedModel.trim(),
    },
    rerank: {
      apiBase: row.rerankApiBase.trim(),
      apiKey: row.rerankApiKey,
      model: row.rerankModel.trim(),
    },
  }
}
