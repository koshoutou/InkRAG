/**
 * Dify 兼容层鉴权（Task 17-3）
 *
 * 错误体采用 Dify Service API 格式：{ code, message, status }
 * 鉴权复用平台 API Key（rag- 前缀，lib/rag/apikey.ts 恒定时间比对）——
 * 在 MinerU 面板「导出到 Dify」中填本平台地址 + 平台 API Key 即可。
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyApiKey } from '@/lib/rag/apikey'
import type { ApiKey } from '@prisma/client'

export type GuardOk = { ok: true; apiKey: ApiKey }
export type GuardFail = { ok: false; response: NextResponse }

export function difyError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ code, message, status }, { status })
}

/** Bearer 鉴权；write=true 时校验角色（readonly 拒绝写入）。命中后计数审计。 */
export async function requireDatasetKey(req: NextRequest, opts: { write?: boolean } = {}): Promise<GuardOk | GuardFail> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) {
    return { ok: false, response: difyError(401, 'unauthorized', "Authorization header must be provided and start with 'Bearer token'") }
  }
  const apiKey = await verifyApiKey(token)
  if (!apiKey) return { ok: false, response: difyError(401, 'unauthorized', 'Invalid API token.') }
  if (!apiKey.enabled) return { ok: false, response: difyError(403, 'forbidden', 'API Key 已被禁用') }
  if (opts.write && apiKey.role === 'readonly') {
    return { ok: false, response: difyError(403, 'forbidden', 'readonly 角色不允许写入操作（请使用 operator/admin 角色）') }
  }
  void db.apiKey
    .update({ where: { id: apiKey.id }, data: { callCount: { increment: 1 }, lastUsedAt: new Date() } })
    .catch(() => {})
  return { ok: true, apiKey }
}

/** Dify 风格的库不存在错误 */
export function notFoundDataset(): NextResponse {
  return difyError(404, 'not_found', 'Dataset not found.')
}

export function notFoundDocument(): NextResponse {
  return difyError(404, 'not_found', 'Documents not found.')
}
