import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { apiKeyColumns, apiKeyPreview } from '@/lib/rag/apikey'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** GET /api/apikeys → { keys }（不返回完整 key；掩码展示用 keyPrefix） */
export async function GET() {
  try {
    const keys = await db.apiKey.findMany({ orderBy: { createdAt: 'desc' } })
    return NextResponse.json({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        role: k.role,
        enabled: k.enabled,
        callCount: k.callCount,
        lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
        createdAt: k.createdAt.toISOString(),
        keyPrefix: k.keyPrefix,
        keyPreview: apiKeyPreview(k),
      })),
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/** POST /api/apikeys Body: { name, role? } → 201 { key }（完整 key 仅此一次返回，落库只存 sha256） */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: '名称不能为空' }, { status: 400 })
    const role = ['admin', 'operator', 'readonly'].includes(body.role) ? body.role : 'readonly'

    const key = `rag-${randomBytes(16).toString('hex')}`
    const created = await db.apiKey.create({ data: { name, role, ...apiKeyColumns(key) } })
    return NextResponse.json(
      {
        key: {
          id: created.id,
          name: created.name,
          role: created.role,
          enabled: created.enabled,
          callCount: created.callCount,
          lastUsedAt: null,
          createdAt: created.createdAt.toISOString(),
          keyPrefix: created.keyPrefix,
          keyPreview: apiKeyPreview(created),
          key, // 完整 key 仅此一次返回
        },
      },
      { status: 201 }
    )
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
