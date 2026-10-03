import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/dify/reachability —— 平台对外可达性探测（Dify 导出诊断）
 *
 * 背景（MinerU「导出到 Dify」链路分析结论，2026-10 实证）：
 *   - 「检查链接 / 选择导出位置」= 用户浏览器直连 GET {host}/v1/datasets（跨域 CORS）；
 *   - 「导出」= 浏览器 POST mineru.net 后端 /api/v4/tasks/{taskId}/dify，
 *     由 **mineru.net 服务器**向 {host}/v1/datasets/{id}/document/create-by-text 转发。
 *   ⇒ 检查链接通过 ≠ 导出可用：导出要求平台地址对 **mineru.net 服务器**（公网出站）可达。
 *
 * 本端点做两路探测帮助定位：
 *   - direct：本进程直接 fetch {url}/v1/datasets（预期 401 JSON = 端点活着；参考值）
 *   - external：通过 z-ai-web-dev-sdk page_reader 从**外部网络**抓取同一 URL
 *     （预期拿到 401 的 JSON 体 = 公网可达；DNS 失败/超时/5xx = 公网不可达）
 *
 * Body: { url }（平台根地址，自动剥掉尾部 /v1 与斜杠）
 * → { ok, url, direct{...}, external{...}, verdict: 'ok'|'external-unreachable'|'unreachable', advice }
 */

const PROBE_TIMEOUT_MS = 20_000

interface ProbeResult {
  reachable: boolean
  httpStatus: number | null
  ms: number
  /** 失败原因（网络层/解析层） */
  error?: string
}

function normalizeBase(raw: unknown): string {
  let u = String(raw ?? '').trim()
  if (!u) return ''
  // 允许用户粘贴带 /v1 的地址（与 MinerU 面板 Mn() 同款归一化）
  u = u.replace(/\/v1\/?$/i, '')
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  return u.replace(/\/+$/, '')
}

/** 直连探测（进程自身视角） */
async function probeDirect(base: string): Promise<ProbeResult> {
  const t0 = Date.now()
  try {
    const res = await fetch(base + '/v1/datasets?page=1&limit=1', {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Authorization: 'Bearer reachability-probe' },
    })
    return { reachable: true, httpStatus: res.status, ms: Date.now() - t0 }
  } catch (e) {
    return { reachable: false, httpStatus: null, ms: Date.now() - t0, error: (e as Error).message }
  }
}

/**
 * 外部网络探测（z-ai page_reader）：预期返回 401 JSON（未带合法 Bearer），
 * 拿到任何 HTTP 状态（含 401/403/404）都证明「公网 → 平台」链路通；
 * 仅 DNS/超时/连接失败才算不可达。
 */
async function probeExternal(base: string): Promise<ProbeResult> {
  const t0 = Date.now()
  try {
    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = await ZAI.create()
    const r: any = await Promise.race([
      zai.functions.invoke('page_reader', { url: base + '/v1/datasets?page=1&limit=1' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('外部探测超时（20s）')), PROBE_TIMEOUT_MS)),
    ])
    const status = Number(r?.data?.httpStatus ?? r?.httpStatus ?? 0)
    const ms = Date.now() - t0
    if (status > 0) return { reachable: true, httpStatus: status, ms }
    // page_reader 对完全无法访问的 URL 会抛错或返回空体
    const html = String(r?.data?.html ?? '')
    if (html.includes('unauthorized') || html.includes('Authorization')) {
      return { reachable: true, httpStatus: 401, ms }
    }
    return { reachable: false, httpStatus: null, ms, error: '外部网络未取到 HTTP 状态（可能 DNS/连接失败）' }
  } catch (e) {
    return { reachable: false, httpStatus: null, ms: Date.now() - t0, error: (e as Error).message }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { url?: string }
    const base = normalizeBase(body.url)
    if (!base) return NextResponse.json({ ok: false, error: 'url is required' }, { status: 400 })

    const [direct, external] = await Promise.all([probeDirect(base), probeExternal(base)])

    let verdict: 'ok' | 'external-unreachable' | 'unreachable'
    if (direct.reachable && external.reachable) verdict = 'ok'
    else if (direct.reachable && !external.reachable) verdict = 'external-unreachable'
    else verdict = 'unreachable'

    const advice =
      verdict === 'ok'
        ? '平台端点正常且公网可达。若 MinerU 仍导出失败：① 核对面板内地址与 Key；② 注意 mineru.net 服务器位于中国境内，若平台域名在境外/CDN 后面，其服务器出站访问可能受阻——建议换用国内可稳定访问的服务器与域名部署后复测。'
        : verdict === 'external-unreachable'
          ? '平台端点活着，但公网外部网络访问不到该地址——MinerU「导出」由 mineru.net 服务器转发调用（检查链接只是浏览器直连，能通过不代表导出可用）。请把平台部署/映射到公网稳定可达的域名（自有服务器 + 反代），再用本工具复测。'
          : '连本机直连都失败——地址填错或平台服务未启动。请先确认地址格式（https://域名，不带 /v1）与服务状态。'

    return NextResponse.json({ ok: true, url: base, direct, external, verdict, advice })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 })
  }
}
