import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { testConnection } from '@/lib/qdrant'
import { MINERU_PROVIDERS, normalizeMinerUProvider } from '@/lib/rag/settings'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** 密钥掩码（Task 15-b / 审计 #4）：非空返回 `***尾4位`，空值保持空串 */
function maskKey(v: string): string {
  return v ? `***${v.slice(-4)}` : ''
}

/** 掩码值约定：空串或 `***` 开头 = 客户端原样回传 GET 结果，不覆盖已存密钥 */
function isMaskedOrEmpty(v: string | undefined): boolean {
  return v === undefined || v === '' || v.startsWith('***')
}

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
  useFallbackParser: boolean
  useMockEmbedding: boolean
  useMockRerank: boolean
  updatedAt: Date
}) {
  return {
    id: row.id,
    url: row.url,
    apiKey: maskKey(row.apiKey),
    hasApiKey: row.apiKey.length > 0,
    defaultCollection: row.defaultCollection,
    embedApiBase: row.embedApiBase,
    embedApiKey: maskKey(row.embedApiKey),
    hasEmbedApiKey: row.embedApiKey.length > 0,
    embedModel: row.embedModel,
    rerankApiBase: row.rerankApiBase,
    rerankApiKey: maskKey(row.rerankApiKey),
    hasRerankApiKey: row.rerankApiKey.length > 0,
    rerankModel: row.rerankModel,
    mineruProvider: normalizeMinerUProvider(row.mineruProvider),
    mineruApiUrl: row.mineruApiUrl,
    mineruApiKey: maskKey(row.mineruApiKey),
    hasMineruApiKey: row.mineruApiKey.length > 0,
    mineruTier: row.mineruTier,
    mineruOcrMode: row.mineruOcrMode,
    useFallbackParser: row.useFallbackParser,
    useMockEmbedding: row.useMockEmbedding,
    useMockRerank: row.useMockRerank,
    updatedAt: row.updatedAt,
  }
}

/** GET /api/qdrant/settings — 完整设置（含 MinerU 与双模式开关；密钥掩码返回） */
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
  useFallbackParser?: boolean
  useMockEmbedding?: boolean
  useMockRerank?: boolean
  /** if true, ping the Qdrant URL after saving and return the result */
  test?: boolean
}

/** PUT /api/qdrant/settings — upsert 完整配置（密钥字段收到空串/掩码值时保持现值不覆盖） */
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

  // 密钥字段：掩码约定（Task 15-b）——值为空串 / *** 开头 / 未携带 → 保持数据库现值
  const secretOrDefault = (v: string | undefined, current: string): string =>
    isMaskedOrEmpty(v) ? (current ?? '') : v

  const data = {
    url: (body.url ?? '').trim(),
    apiKey: secretOrDefault(body.apiKey, existing?.apiKey ?? ''),
    defaultCollection: body.defaultCollection ?? '',
    embedApiBase: (body.embedApiBase ?? '').trim(),
    embedApiKey: secretOrDefault(body.embedApiKey, existing?.embedApiKey ?? ''),
    embedModel: (body.embedModel ?? '').trim(),
    rerankApiBase: (body.rerankApiBase ?? '').trim(),
    rerankApiKey: secretOrDefault(body.rerankApiKey, existing?.rerankApiKey ?? ''),
    rerankModel: (body.rerankModel ?? '').trim(),
    mineruProvider:
      body.mineruProvider !== undefined
        ? normalizeMinerUProvider(body.mineruProvider)
        : normalizeMinerUProvider(existing?.mineruProvider ?? 'selfhost'),
    mineruApiUrl: (body.mineruApiUrl ?? '').trim(),
    mineruApiKey: secretOrDefault(body.mineruApiKey, existing?.mineruApiKey ?? ''),
    mineruTier: body.mineruTier ?? 'standard',
    mineruOcrMode: body.mineruOcrMode ?? 'auto',
    useFallbackParser: body.useFallbackParser !== false,
    // useMockEmbedding 缺省为 false（与 schema 默认一致；避免旧客户端不携带该字段时静默开启 mock 嵌入）
    useMockEmbedding: body.useMockEmbedding === true,
    useMockRerank: body.useMockRerank !== false,
  }
  const row = await db.qdrantSetting.upsert({
    where: { id: 'default' },
    update: data,
    create: { id: 'default', ...data },
  })
  let testResult: { ok: boolean; message: string; version?: string } | undefined
  if (body.test) {
    // 用落库后的真实值测试（掩码值从不落库，row.apiKey 一定是真实密钥或空串）
    testResult = await testConnection(row.url, row.apiKey)
  }
  return NextResponse.json({
    ok: true,
    settings: serializeSettings(row),
    test: testResult,
  })
}
