import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/qdrant/test —— 连接测试（契约 §6：settings/collections/points/search/call-logs/test）
 * Body: { kind: 'qdrant' | 'embed' | 'rerank' | 'mineru', url, apiKey?, model?, provider?, tier?, ocrMode? }
 * → 200 { ok, message, provider?, detail?, dim?, version? }（测试失败也返回 200 + ok:false，便于前端徽标展示）
 *
 * 说明：qdrant 用 GET /readyz 探活（api-key 头）+ GET / 取版本；
 * embed/rerank 走 OpenAI 兼容协议（Bearer），各带超时防止外网 DNS 挂死拖垮请求；
 * mineru 按 provider 探测（Task 14-e，指南《MinerU_API_完整指南》）：
 *   - selfhost：GET {url}/v1/health（带可选 Bearer）—— V1 Unified API 握手端点
 *   - cloud：GET https://mineru.net/api/v4/extract-results/batch/nonexistent（Bearer Token）
 *     401/A0202 → Token 无效；404/400 → 服务可达且 Token 有效（探测性 404 属预期）
 *   - cloud-agent：POST https://mineru.net/api/v1/agent/parse/url 空 body 期待 400（证明可达，免 Token）
 */

const TEST_TIMEOUT_MS = 10_000
const MINERU_CLOUD_BASE = 'https://mineru.net'
const MINERU_PROVIDERS = ['selfhost', 'cloud', 'cloud-agent'] as const
type MineruProvider = (typeof MINERU_PROVIDERS)[number]

interface TestResult {
  ok: boolean
  message: string
  provider?: string
  detail?: string
  dim?: number
  version?: string
}

function trimBase(url: unknown): string {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

async function testQdrant(url: string, apiKey: string): Promise<TestResult> {
  const headers: Record<string, string> = {}
  if (apiKey) headers['api-key'] = apiKey
  try {
    const res = await fetch(url + '/readyz', {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, message: `连接失败：HTTP ${res.status}` }
    let version: string | undefined
    try {
      const vRes = await fetch(url + '/', {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      })
      if (vRes.ok) version = (await vRes.json())?.version
    } catch {}
    return {
      ok: true,
      ...(version ? { version } : {}),
      message: `连接成功${version ? ` · ${version}` : ''}`,
    }
  } catch (e) {
    return { ok: false, message: `连接失败：${(e as Error).message}` }
  }
}

async function testEmbed(url: string, apiKey: string, model: string): Promise<TestResult> {
  if (!model) return { ok: false, message: '模型 ID 为空' }
  try {
    const res = await fetch(url + '/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: '连接测试' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    const text = await res.text()
    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      return { ok: false, message: `返回非 JSON（${res.status}）：${text.slice(0, 160)}` }
    }
    if (!res.ok) {
      const msg = json?.error?.message || json?.error || json?.message || `HTTP ${res.status}`
      return { ok: false, message: `Embedding 测试失败：${String(msg).slice(0, 200)}` }
    }
    const dim = Number(json?.data?.[0]?.embedding?.length) || undefined
    if (!dim) return { ok: false, message: '响应缺少 data[0].embedding，非 OpenAI 兼容格式' }
    return { ok: true, dim, message: `连接成功 · 返回 ${dim}d 向量` }
  } catch (e) {
    return { ok: false, message: `Embedding 测试失败：${(e as Error).message}` }
  }
}

async function testRerank(url: string, apiKey: string, model: string): Promise<TestResult> {
  if (!model) return { ok: false, message: '模型 ID 为空' }
  try {
    const res = await fetch(url + '/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        query: '检索增强',
        documents: ['检索增强实验文档', '完全无关的文本'],
        top_n: 2,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) {
      let msg = text.slice(0, 200)
      try {
        msg = JSON.parse(text)?.error?.message || msg
      } catch {}
      return { ok: false, message: `Rerank 测试失败（${res.status}）：${msg}` }
    }
    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      return { ok: false, message: `返回非 JSON：${text.slice(0, 160)}` }
    }
    const results = Array.isArray(json?.results) ? json.results : null
    if (!results) {
      return { ok: false, message: '响应缺少 results 数组，非 OpenAI 兼容 rerank 格式' }
    }
    const top = results[0]
    const score =
      top && typeof (top.relevance_score ?? top.score) === 'number'
        ? ` · top1 score ${Number(top.relevance_score ?? top.score).toFixed(4)}`
        : ''
    return { ok: true, message: `Rerank API 可用 · 返回 ${results.length} 条${score}` }
  } catch (e) {
    return { ok: false, message: `Rerank 测试失败：${(e as Error).message}` }
  }
}

/** 自部署 V1：GET {url}/v1/health（握手端点；带可选 Bearer） */
async function testMineruSelfhost(url: string, apiKey: string): Promise<TestResult> {
  try {
    const res = await fetch(url + '/v1/health', {
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      return {
        ok: false,
        provider: 'selfhost',
        message: `连接失败：HTTP ${res.status}`,
        detail: `探测端点：${url}/v1/health（V1 Unified API 握手）。若 404 请确认填的是 api-server 端口（如 8000），不是 WebUI 面板端口（如 7860）`,
      }
    }
    let version: string | undefined
    let capability = ''
    try {
      const json = await res.json()
      version = typeof json?.version === 'string' ? json.version : undefined
      const sources = Array.isArray(json?.sources) ? json.sources.join('/') : ''
      capability = sources ? ` · 支持源：${sources}` : ''
    } catch {}
    return {
      ok: true,
      provider: 'selfhost',
      ...(version ? { version } : {}),
      message: `连接成功 · /v1/health 可达${capability}`,
      detail: `探测端点：${url}/v1/health`,
    }
  } catch (e) {
    return {
      ok: false,
      provider: 'selfhost',
      message: `连接失败：${(e as Error).message}`,
      detail: `探测端点：${url}/v1/health（10s 超时保护）`,
    }
  }
}

/** 官方云·精准 v4：用 Token 查询不存在的 batch —— 401/A0202 = Token 无效；404/400 = 服务可达且 Token 有效 */
async function testMineruCloud(apiKey: string): Promise<TestResult> {
  if (!apiKey) {
    return {
      ok: false,
      provider: 'cloud',
      message: '请先填写 MinerU API Token（官方云·精准需要 Bearer Token，在 mineru.net API 管理页面创建）',
    }
  }
  try {
    const res = await fetch(`${MINERU_CLOUD_BASE}/api/v4/extract-results/batch/nonexistent`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    const text = await res.text()
    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = {}
    }
    if (res.status === 401 || String(json?.code) === 'A0202' || String(json?.code) === 'A0211') {
      return {
        ok: false,
        provider: 'cloud',
        message: 'Token 无效或已过期（A0202/A0211）——请在 mineru.net API 管理页面重新创建',
        detail: `服务可达（HTTP ${res.status}），但鉴权被拒绝：${String(json?.msg ?? text).slice(0, 160)}`,
      }
    }
    // 404/400：batch 不存在属预期 —— 服务可达且 Token 通过了鉴权
    if (res.status === 404 || res.status === 400) {
      return {
        ok: true,
        provider: 'cloud',
        message: '连接成功 · 官方云·精准 API 可达，Token 有效',
        detail: `探测方式：查询不存在的 batch（HTTP ${res.status} 属预期，鉴权已通过）`,
      }
    }
    if (res.status === 429 || res.status >= 500) {
      return {
        ok: false,
        provider: 'cloud',
        message: `服务暂不可用（HTTP ${res.status}），稍后重试`,
        detail: `探测响应：${text.slice(0, 160)}`,
      }
    }
    return {
      ok: true,
      provider: 'cloud',
      message: `服务可达（HTTP ${res.status}）`,
      detail: `探测响应：${text.slice(0, 160)}`,
    }
  } catch (e) {
    return {
      ok: false,
      provider: 'cloud',
      message: `连接失败：${(e as Error).message}`,
      detail: `探测端点：${MINERU_CLOUD_BASE}/api/v4/extract-results/batch/*（10s 超时保护）`,
    }
  }
}

/** 官方云·Agent 轻量：POST /api/v1/agent/parse/url 空 body —— 期待 400 参数校验拒绝（证明可达，免 Token） */
async function testMineruCloudAgent(): Promise<TestResult> {
  try {
    const res = await fetch(`${MINERU_CLOUD_BASE}/api/v1/agent/parse/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      cache: 'no-store',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    const text = await res.text()
    if (res.ok) {
      // 空 body 竟然被接受（不太可能）——服务显然可达
      return {
        ok: true,
        provider: 'cloud-agent',
        message: '连接成功 · Agent 轻量接口可达（免 Token）',
        detail: '探测方式：提交空请求（预期 400 参数校验）',
      }
    }
    if (res.status === 429) {
      return {
        ok: false,
        provider: 'cloud-agent',
        message: 'IP 限频生效中（HTTP 429）——服务可达，但每分钟提交数已达上限，请稍后再试',
        detail: '轻量接口免 Token、按 IP 限频；解析请求请错峰使用',
      }
    }
    if (res.status >= 500) {
      return {
        ok: false,
        provider: 'cloud-agent',
        message: `服务异常（HTTP ${res.status}），稍后重试`,
        detail: `探测响应：${text.slice(0, 160)}`,
      }
    }
    // 400/404/422 等参数校验拒绝 → 可达性证明
    return {
      ok: true,
      provider: 'cloud-agent',
      message: `连接成功 · Agent 轻量接口可达（免 Token，HTTP ${res.status} 参数校验属预期）`,
      detail: '探测方式：提交空请求，接口返回参数校验错误即证明服务可达',
    }
  } catch (e) {
    return {
      ok: false,
      provider: 'cloud-agent',
      message: `连接失败：${(e as Error).message}`,
      detail: `探测端点：${MINERU_CLOUD_BASE}/api/v1/agent/parse/url（10s 超时保护）`,
    }
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    kind?: string
    url?: string
    apiKey?: string
    model?: string
    provider?: string
    tier?: string
    ocrMode?: string
  }
  const kind = String(body.kind ?? '').trim()
  const url = trimBase(body.url)
  const apiKey = String(body.apiKey ?? '')
  const model = String(body.model ?? '').trim()
  void body.tier
  void body.ocrMode

  const mineruProvider: MineruProvider = MINERU_PROVIDERS.includes(body.provider as MineruProvider)
    ? (body.provider as MineruProvider)
    : 'selfhost'

  // url 必要性按 kind/provider 区分：cloud / cloud-agent 固定 mineru.net，无需本地 url
  const needsUrl =
    kind === 'qdrant' || kind === 'embed' || kind === 'rerank' || (kind === 'mineru' && mineruProvider === 'selfhost')
  if (needsUrl && !url) {
    return NextResponse.json({ ok: false, message: '缺少 url（服务地址）' }, { status: 400 })
  }
  if (url && !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ ok: false, message: 'url 必须以 http:// 或 https:// 开头' }, { status: 400 })
  }

  let result: TestResult
  switch (kind) {
    case 'qdrant':
      result = await testQdrant(url, apiKey)
      break
    case 'embed':
      result = await testEmbed(url, apiKey, model)
      break
    case 'rerank':
      result = await testRerank(url, apiKey, model)
      break
    case 'mineru':
      if (mineruProvider === 'cloud') {
        result = await testMineruCloud(apiKey)
      } else if (mineruProvider === 'cloud-agent') {
        result = await testMineruCloudAgent()
      } else {
        result = await testMineruSelfhost(url, apiKey)
      }
      break
    default:
      return NextResponse.json(
        { ok: false, message: `无效 kind: ${kind || '(空)'}（可选 qdrant / embed / rerank / mineru）` },
        { status: 400 },
      )
  }
  console.log(
    `[qdrant/test] kind=${kind}${kind === 'mineru' ? ` provider=${mineruProvider}` : ''} ok=${result.ok} ${result.message}`
  )
  return NextResponse.json(result)
}
