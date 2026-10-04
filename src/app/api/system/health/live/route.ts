import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/system/health/live —— 公开存活探针（SEC-002 拆分）
 *
 * 用途：Docker HEALTHCHECK / k8s liveness / 网关探活。
 * 仅返回 { ok: true }，不暴露任何内部状态（不读 DB、不探测 Qdrant、不返回版本号）。
 *
 * 与 /api/system/health 的区别：
 *   - /api/system/health/live  公开（middleware 豁免），无敏感信息，适合外部探活
 *   - /api/system/health       需面板会话鉴权，返回 Qdrant/向量/Embedding/MinerU/流水线等详细状态
 */
export async function GET() {
  return NextResponse.json({ ok: true })
}
