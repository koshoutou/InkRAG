import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recordOp } from '@/lib/rag/oplog'
import { testConnection } from '@/lib/qdrant'
import { MINERU_PROVIDERS, invalidateRagSettingsCache, normalizeMinerUProvider } from '@/lib/rag/settings'

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
  mineruPdfAutoSplit: boolean
  mineruPdfPartPages: number
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
    mineruPdfAutoSplit: row.mineruPdfAutoSplit,
    mineruPdfPartPages: row.mineruPdfPartPages,
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
  /** 16-b：超大 PDF 自动拆分（缺省保留现值） */
  mineruPdfAutoSplit?: boolean
  /** 16-b：每段页数上限，0=Provider 默认（缺省保留现值；非负整数） */
  mineruPdfPartPages?: number
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
  if (body.mineruPdfPartPages !== undefined) {
    const p = Number(body.mineruPdfPartPages)
    if (!Number.isInteger(p) || p < 0 || p > 10000) {
      return NextResponse.json(
        { error: '无效 mineruPdfPartPages（需 0-10000 的整数，0 = 按服务商默认）' },
        { status: 400 },
      )
    }
  }
  // mineruProvider 缺省时保留现值（旧客户端/基座 SettingsDialog 不携带该字段，避免意外重置回 selfhost）
  const existing = await db.qdrantSetting.findUnique({ where: { id: 'default' } })

  // 密钥字段：掩码约定（Task 15-b）——值为空串 / *** 开头 / 未携带 → 保持数据库现值
  const secretOrDefault = (v: string | undefined, current: string): string =>
    isMaskedOrEmpty(v) ? (current ?? '') : v

  // 16-b：非密钥字段缺省保留现值（部分 PUT 不再清空未携带字段；显式传空串仍可清空）
  const keep = <T>(v: T | undefined, current: T | undefined, fallback: T): T =>
    v !== undefined ? v : (current ?? fallback)

  const data = {
    url: keep(body.url, existing?.url, '').trim(),
    apiKey: secretOrDefault(body.apiKey, existing?.apiKey ?? ''),
    defaultCollection: keep(body.defaultCollection, existing?.defaultCollection, ''),
    embedApiBase: keep(body.embedApiBase, existing?.embedApiBase, '').trim(),
    embedApiKey: secretOrDefault(body.embedApiKey, existing?.embedApiKey ?? ''),
    embedModel: keep(body.embedModel, existing?.embedModel, '').trim(),
    rerankApiBase: keep(body.rerankApiBase, existing?.rerankApiBase, '').trim(),
    rerankApiKey: secretOrDefault(body.rerankApiKey, existing?.rerankApiKey ?? ''),
    rerankModel: keep(body.rerankModel, existing?.rerankModel, '').trim(),
    mineruProvider:
      body.mineruProvider !== undefined
        ? normalizeMinerUProvider(body.mineruProvider)
        : normalizeMinerUProvider(existing?.mineruProvider ?? 'selfhost'),
    mineruApiUrl: keep(body.mineruApiUrl, existing?.mineruApiUrl, '').trim(),
    mineruApiKey: secretOrDefault(body.mineruApiKey, existing?.mineruApiKey ?? ''),
    mineruTier: keep(body.mineruTier, existing?.mineruTier, 'standard'),
    mineruOcrMode: keep(body.mineruOcrMode, existing?.mineruOcrMode, 'auto'),
    // 16-b：PDF 拆分配置缺省保留现值（旧客户端不携带时不重置）
    mineruPdfAutoSplit: body.mineruPdfAutoSplit ?? existing?.mineruPdfAutoSplit ?? true,
    mineruPdfPartPages: body.mineruPdfPartPages ?? existing?.mineruPdfPartPages ?? 0,
    useFallbackParser: keep(body.useFallbackParser, existing?.useFallbackParser, true),
    // useMockEmbedding 缺省保留现值（与 schema 默认 false 对齐；避免旧客户端不携带该字段时静默开启 mock 嵌入）
    useMockEmbedding: body.useMockEmbedding ?? existing?.useMockEmbedding ?? false,
    useMockRerank: keep(body.useMockRerank, existing?.useMockRerank, true),
  }
  const row = await db.qdrantSetting.upsert({
    where: { id: 'default' },
    update: data,
    create: { id: 'default', ...data },
  })
  // F-LOC-08：写后主动失效设置缓存（getRagSettings 3s TTL 缓存立即见到新值）
  invalidateRagSettingsCache()
  let testResult: { ok: boolean; message: string; version?: string } | undefined
  if (body.test) {
    // 用落库后的真实值测试（掩码值从不落库，row.apiKey 一定是真实密钥或空串）
    testResult = await testConnection(row.url, row.apiKey)
  }
  // F-LOC-13：MinerU 接入方式切换时，在途 waiting_mineru 任务会用新 provider 探测旧
  // jobId → 判 gone → 自动重新上传提交（自愈但重传耗配额）——返回明确警示 + 审计记录
  let providerSwitchWarning: string | undefined
  if (data.mineruProvider !== undefined && existing && data.mineruProvider !== existing.mineruProvider) {
    try {
      const inFlight = await db.pipelineJob.count({ where: { status: 'waiting_mineru' } })
      if (inFlight > 0) {
        providerSwitchWarning = `MinerU 接入方式已从 ${existing.mineruProvider} 切换为 ${data.mineruProvider}：${inFlight} 个在途解析任务将自动重新提交（远端任务 ID 不跨 provider 迁移，重传会消耗新 provider 配额）`
        recordOp({
          level: 'warn',
          category: 'system',
          action: 'settings.mineru_provider_switched',
          message: providerSwitchWarning,
          detail: { from: existing.mineruProvider, to: data.mineruProvider, inFlight },
        })
      }
    } catch {
      /* 统计失败不阻断保存 */
    }
  }
  recordOp({
    level: 'info',
    category: 'system',
    action: 'settings.update',
    message: `更新平台设置（${Object.keys(body as object)
      .filter((k) => !['apiKey', 'embedApiKey', 'rerankApiKey', 'mineruApiKey'].includes(k))
      .join('、') || '（未携带字段）'}${body.test ? '；保存后附带连接测试' : ''}；密钥类字段仅记字段名不记值）`,
    detail: { test: testResult ? { ok: testResult.ok } : null },
  })
  return NextResponse.json({
    ok: true,
    ...(providerSwitchWarning ? { warning: providerSwitchWarning } : {}),
    settings: serializeSettings(row),
    test: testResult,
  })
}
