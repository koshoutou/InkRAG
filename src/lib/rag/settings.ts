/**
 * RAG 平台设置读取 + 双模式判定（契约 §0 / §8 settings）
 *
 * 设置存于 Prisma QdrantSetting 单行（id='default'），首次读取时自动播种。
 * 双模式判定规则：
 *   - vectorMode: url 非空 → 'qdrant'，否则 'unconfigured'
 *     （v1.6：本地向量引擎已移除；未配置或不可达时向量读写硬失败，绝不静默降级）
 *   - parseMode（MinerU 三 Provider，指南《MinerU_API_完整指南》）：
 *       provider='cloud-agent' → 'mineru'（免 Token 恒可用）
 *       provider='cloud'       → mineruApiKey 非空 → 'mineru'
 *       provider='selfhost'    → mineruApiUrl 非空 → 'mineru'
 *       否则 useFallbackParser → 'fallback'；再否则 'none'（解析时抛错）
 *   - embedMode:  embedApiBase + embedModel 非空 → 'real'；否则 useMockEmbedding（显式离线调试开关）→ 'mock'；否则 'none'
 *   - rerankMode: rerankApiBase + rerankModel 非空 → 'real'；否则 useMockRerank → 'mock'；否则 'none'
 */
import { db } from '@/lib/db'
import type { EmbedMode, ParseMode, RerankMode, VectorMode } from './types'

/** MinerU 接入方式（三种官方接入方式的统一抽象） */
export type MinerUProviderKind = 'selfhost' | 'cloud' | 'cloud-agent'

export const MINERU_PROVIDERS: MinerUProviderKind[] = ['selfhost', 'cloud', 'cloud-agent']

export function normalizeMinerUProvider(v: unknown): MinerUProviderKind {
  return MINERU_PROVIDERS.includes(v as MinerUProviderKind) ? (v as MinerUProviderKind) : 'selfhost'
}

export interface RagSettings {
  /** 原始设置行 */
  row: {
    id: string
    url: string
    apiKey: string
    defaultCollection: string
    qdrantHnswM: number
    embedApiBase: string
    embedApiKey: string
    embedModel: string
    rerankApiBase: string
    rerankApiKey: string
    rerankModel: string
    mineruProvider: string
    mineruApiUrl: string
    mineruApiKey: string
    mineruTier: string
    mineruOcrMode: string
    mineruPdfAutoSplit: boolean
    mineruPdfPartPages: number
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
  mineru: {
    provider: MinerUProviderKind
    url: string
    apiKey: string
    tier: string
    ocrMode: string
    /** 16-b：超大 PDF 自动拆分 */
    pdfAutoSplit: boolean
    /** 16-b：每段页数上限（0 = Provider 默认：cloud 200 / cloud-agent 20 / selfhost 不拆） */
    pdfPartPages: number
  }
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

// ---------------------------------------------------------------------------
// F-LOC-08：设置进程内短 TTL 缓存（tick 1.2s / 轮询 5s / 每次 embedTexts 都查 DB → 读放大）
// 写设置时主动失效（invalidateRagSettingsCache），保证热更新安全；TTL 3s 兜底直改 DB 的场景。
// ---------------------------------------------------------------------------

const SETTINGS_TTL_MS = 3_000
const settingsCacheG = globalThis as unknown as {
  __ragSettingsCache?: { value: RagSettings; at: number }
}

/** 写设置后主动失效（settings PUT 路由调用）；也可在直改 DB 后手动调用 */
export function invalidateRagSettingsCache(): void {
  settingsCacheG.__ragSettingsCache = undefined
}

/** 读取设置并做双模式判定（不发起任何网络请求，纯配置判定；带 3s 进程内缓存） */
export async function getRagSettings(): Promise<RagSettings> {
  const cached = settingsCacheG.__ragSettingsCache
  if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) {
    return cached.value
  }
  const value = await computeRagSettings()
  settingsCacheG.__ragSettingsCache = { value, at: Date.now() }
  return value
}

/** 实际计算（原 getRagSettings 主体） */
async function computeRagSettings(): Promise<RagSettings> {
  const row = await getSettingsRow()

  const vectorMode: VectorMode = row.url.trim() ? 'qdrant' : 'unconfigured'

  const mineruProvider = normalizeMinerUProvider(row.mineruProvider)
  let parseMode: ParseMode
  const mineruConfigured =
    mineruProvider === 'cloud-agent' ||
    (mineruProvider === 'cloud' ? row.mineruApiKey.trim().length > 0 : row.mineruApiUrl.trim().length > 0)
  if (mineruConfigured) {
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
      qdrantHnswM: row.qdrantHnswM ?? 0,
      embedApiBase: row.embedApiBase,
      embedApiKey: row.embedApiKey,
      embedModel: row.embedModel,
      rerankApiBase: row.rerankApiBase,
      rerankApiKey: row.rerankApiKey,
      rerankModel: row.rerankModel,
      mineruProvider,
      mineruApiUrl: row.mineruApiUrl,
      mineruApiKey: row.mineruApiKey,
      mineruTier: row.mineruTier,
      mineruOcrMode: row.mineruOcrMode,
      mineruPdfAutoSplit: row.mineruPdfAutoSplit,
      mineruPdfPartPages: row.mineruPdfPartPages,
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
      provider: mineruProvider,
      url: row.mineruApiUrl.trim(),
      apiKey: row.mineruApiKey,
      tier: row.mineruTier || 'standard',
      ocrMode: row.mineruOcrMode || 'auto',
      pdfAutoSplit: row.mineruPdfAutoSplit,
      pdfPartPages: row.mineruPdfPartPages || 0,
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
