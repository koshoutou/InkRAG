import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
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
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
