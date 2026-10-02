import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { testConnection } from '@/lib/qdrant'
import { MINERU_PROVIDERS, normalizeMinerUProvider } from '@/lib/rag/settings'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function serializeSettings(row: {
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
  mineruProvider: string
  mineruApiUrl: string
  mineruApiKey: string
  mineruTier: string
  mineruOcrMode: string
  useLocalVectorStore: boolean
  useFallbackParser: boolean
  useMockEmbedding: boolean
  useMockRerank: boolean
  updatedAt: Date
}) {
  return {
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
    mineruProvider: normalizeMinerUProvider(row.mineruProvider),
    mineruApiUrl: row.mineruApiUrl,
    mineruApiKey: row.mineruApiKey,
    mineruTier: row.mineruTier,
    mineruOcrMode: row.mineruOcrMode,
    useLocalVectorStore: row.useLocalVectorStore,
    useFallbackParser: row.useFallbackParser,
    useMockEmbedding: row.useMockEmbedding,
    useMockRerank: row.useMockRerank,
    updatedAt: row.updatedAt,
  }
}

/** GET /api/qdrant/settings — 完整设置（含 MinerU 与双模式开关） */
export async function GET() {
  const row = await db.qdrantSetting.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default' },
  })
  return NextResponse.json(serializeSettings(row))
}

interface SettingsInput {
  url?: string
  apiKey?: string
  defaultCollection?: string
  embedApiBase?: string
  embedApiKey?: string
  embedModel?: string
  rerankApiBase?: string
  rerankApiKey?: string
  rerankModel?: string
  /** MinerU 接入方式：selfhost | cloud | cloud-agent（缺省保留现值；非法值 400） */
  mineruProvider?: string
  mineruApiUrl?: string
  mineruApiKey?: string
  mineruTier?: string
  mineruOcrMode?: string
  useLocalVectorStore?: boolean
  useFallbackParser?: boolean
  useMockEmbedding?: boolean
  useMockRerank?: boolean
  /** if true, ping the Qdrant URL after saving and return the result */
  test?: boolean
}

/** PUT /api/qdrant/settings — upsert 完整配置（支持全部新字段） */
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as SettingsInput
  if (body.mineruProvider !== undefined && !MINERU_PROVIDERS.includes(body.mineruProvider as never)) {
    return NextResponse.json(
      { error: `无效 mineruProvider: ${body.mineruProvider}（可选 ${MINERU_PROVIDERS.join(' / ')}）` },
      { status: 400 },
    )
  }
  // mineruProvider 缺省时保留现值（旧客户端/基座 SettingsDialog 不携带该字段，避免意外重置回 selfhost）
  const existing = await db.qdrantSetting.findUnique({ where: { id: 'default' } })
  const data = {
    url: (body.url ?? '').trim(),
    apiKey: body.apiKey ?? '',
    defaultCollection: body.defaultCollection ?? '',
    embedApiBase: (body.embedApiBase ?? '').trim(),
    embedApiKey: body.embedApiKey ?? '',
    embedModel: (body.embedModel ?? '').trim(),
    rerankApiBase: (body.rerankApiBase ?? '').trim(),
    rerankApiKey: body.rerankApiKey ?? '',
    rerankModel: (body.rerankModel ?? '').trim(),
    mineruProvider:
      body.mineruProvider !== undefined
        ? normalizeMinerUProvider(body.mineruProvider)
        : normalizeMinerUProvider(existing?.mineruProvider ?? 'selfhost'),
    mineruApiUrl: (body.mineruApiUrl ?? '').trim(),
    mineruApiKey: body.mineruApiKey ?? '',
    mineruTier: body.mineruTier ?? 'standard',
    mineruOcrMode: body.mineruOcrMode ?? 'auto',
    useLocalVectorStore: body.useLocalVectorStore !== false,
    useFallbackParser: body.useFallbackParser !== false,
    useMockEmbedding: body.useMockEmbedding !== false,
    useMockRerank: body.useMockRerank !== false,
  }
  const row = await db.qdrantSetting.upsert({
    where: { id: 'default' },
    update: data,
    create: { id: 'default', ...data },
  })
  let testResult: { ok: boolean; message: string; version?: string } | undefined
  if (body.test) {
    testResult = await testConnection(row.url, row.apiKey)
  }
  return NextResponse.json({
    ok: true,
    settings: serializeSettings(row),
    test: testResult,
  })
}
