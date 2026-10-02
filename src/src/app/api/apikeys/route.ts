import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function keyPreview(key: string): string {
  if (key.length <= 12) return key
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

/** GET /api/apikeys → { keys }（不返回完整 key） */
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
        keyPreview: keyPreview(k.key),
      })),
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/** POST /api/apikeys Body: { name, role? } → 201 { key }（完整 key 仅此一次返回） */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: '名称不能为空' }, { status: 400 })
    const role = ['admin', 'operator', 'readonly'].includes(body.role) ? body.role : 'readonly'

    const key = `rag-${randomBytes(16).toString('hex')}`
    const created = await db.apiKey.create({ data: { name, role, key } })
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
          keyPreview: keyPreview(created.key),
          key, // 完整 key 仅此一次返回
        },
      },
      { status: 201 }
    )
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
