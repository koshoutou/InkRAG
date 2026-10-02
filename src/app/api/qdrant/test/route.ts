import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/qdrant/test —— 连接测试（契约 §6：settings/collections/points/search/call-logs/test）
 * Body: { kind: 'qdrant' | 'embed' | 'rerank' | 'mineru', url, apiKey?, model?, tier?, ocrMode? }
 * → 200 { ok, message, dim?, version? }（测试失败也返回 200 + ok:false，便于前端徽标展示）
 *
 * 说明：qdrant 用 GET /readyz 探活（api-key 头）+ GET / 取版本；
 * embed/rerank 走 OpenAI 兼容协议（Bearer），各带超时防止外网 DNS 挂死拖垮请求。
 */

const TEST_TIMEOUT_MS = 10_000

interface TestResult {
  ok: boolean
  message: string
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

async function testMineru(url: string, apiKey: string): Promise<TestResult> {
  try {
    const res = await fetch(url + '/health', {
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      return { ok: false, message: `连接失败：HTTP ${res.status}` }
    }
    return { ok: true, message: '连接成功 · /health 可达' }
  } catch (e) {
    return { ok: false, message: `连接失败：${(e as Error).message}` }
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    kind?: string
    url?: string
    apiKey?: string
    model?: string
    tier?: string
    ocrMode?: string
  }
  const kind = String(body.kind ?? '').trim()
  const url = trimBase(body.url)
  const apiKey = String(body.apiKey ?? '')
  const model = String(body.model ?? '').trim()
  void body.tier
  void body.ocrMode

  if (!url) return NextResponse.json({ ok: false, message: '缺少 url（服务地址）' }, { status: 400 })
  if (!/^https?:\/\//i.test(url)) {
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
      result = await testMineru(url, apiKey)
      break
    default:
      return NextResponse.json(
        { ok: false, message: `无效 kind: ${kind || '(空)'}（可选 qdrant / embed / rerank / mineru）` },
        { status: 400 },
      )
  }
  console.log(`[qdrant/test] kind=${kind} ok=${result.ok} ${result.message}`)
  return NextResponse.json(result)
}
