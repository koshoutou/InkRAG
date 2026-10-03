import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recordOp } from '@/lib/rag/oplog'
import { apiKeyPreview } from '@/lib/rag/apikey'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** PATCH /api/apikeys/[id] Body: { enabled, name?, role? } */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const key = await db.apiKey.findUnique({ where: { id } })
    if (!key) return NextResponse.json({ error: 'API Key 不存在' }, { status: 404 })
    const body = await req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}
    if (body.enabled !== undefined) data.enabled = body.enabled === true
    if (body.name !== undefined) data.name = String(body.name).trim() || key.name
    if (body.role !== undefined && ['admin', 'operator', 'readonly'].includes(body.role)) {
      data.role = body.role
    }
    const updated = await db.apiKey.update({ where: { id }, data })
    recordOp({
      level: 'info',
      category: 'auth',
      action: 'auth.key_update',
      message: `更新 API Key「${updated.name}」（${
        data.enabled !== undefined ? (updated.enabled ? '启用' : '停用') : '改名/改角色'
      }）`,
    })
    return NextResponse.json({
      key: {
        id: updated.id,
        name: updated.name,
        role: updated.role,
        enabled: updated.enabled,
        callCount: updated.callCount,
        lastUsedAt: updated.lastUsedAt ? updated.lastUsedAt.toISOString() : null,
        createdAt: updated.createdAt.toISOString(),
        keyPrefix: updated.keyPrefix,
        keyPreview: apiKeyPreview(updated),
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/** DELETE /api/apikeys/[id] */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const key = await db.apiKey.findUnique({ where: { id } })
    if (!key) return NextResponse.json({ error: 'API Key 不存在' }, { status: 404 })
    await db.apiKey.delete({ where: { id } })
    recordOp({
      level: 'info',
      category: 'auth',
      action: 'auth.key_delete',
      message: `删除 API Key「${key.name}」（角色 ${key.role}）`,
    })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
