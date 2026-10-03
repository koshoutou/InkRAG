/**
 * /api/input/** 鉴权守卫（Task 17-2 入库 API，契约 §33）
 *
 * 与旧 v1 search 路由同一套语义（lib/rag/apikey.ts verifyApiKey）：
 *   - 401：缺少 / 无效 Authorization: Bearer <ApiKey>
 *   - 403：Key 已禁用（enabled=false）
 *   - 403：readonly 角色执行写入操作（write=true 时）
 *   - 鉴权通过后 fire-and-forget 更新 callCount+1 / lastUsedAt（尽力而为，不阻塞请求）
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyApiKey } from '@/lib/rag/apikey'
import type { ApiKey } from '@prisma/client'

export interface GuardOptions {
  /** 写入操作（POST/DELETE 等）：readonly 角色将被拒绝（403）。缺省 false = 只读查询 */
  write?: boolean
}

export type GuardResult = { apiKey: ApiKey } | { response: NextResponse }

/**
 * 校验请求鉴权。命中返回 { apiKey }；未命中返回 { response }（调用方直接 return）。
 * 注意：GET /api/input/docs 为公开端点，不走本守卫。
 */
export async function requireApiKey(req: NextRequest, opts?: GuardOptions): Promise<GuardResult> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) {
    return {
      response: NextResponse.json(
        { error: '缺少 Authorization: Bearer <ApiKey> 请求头（先在「Agent API」视图创建 API Key）' },
        { status: 401 },
      ),
    }
  }

  // keyHash 恒定时间比对 + 存量明文惰性迁移（lib/rag/apikey.ts）
  const apiKey = await verifyApiKey(token)
  if (!apiKey) {
    return { response: NextResponse.json({ error: '无效的 API Key' }, { status: 401 }) }
  }
  if (!apiKey.enabled) {
    return { response: NextResponse.json({ error: 'API Key 已被禁用' }, { status: 403 }) }
  }
  if (opts?.write && apiKey.role === 'readonly') {
    return {
      response: NextResponse.json(
        { error: 'readonly 角色的 API Key 不允许执行写入操作（请使用 operator / admin 角色）' },
        { status: 403 },
      ),
    }
  }

  // 计费/审计（尽力而为，参照旧 v1 search 的 fire-and-forget 做法）
  void db.apiKey
    .update({
      where: { id: apiKey.id },
      data: { callCount: { increment: 1 }, lastUsedAt: new Date() },
    })
    .catch(() => {})

  return { apiKey }
}
