import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import { db } from '@/lib/db'
import { middleJsonPath } from '@/lib/rag/artifacts'
import type { MiddleJson } from '@/lib/rag/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/documents/[id]/layout → { layout, pageCount, pageSizes }（三屏高亮用） */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })

    let middle: MiddleJson
    try {
      middle = JSON.parse(await fs.readFile(middleJsonPath(doc.kbId, doc.id), 'utf-8'))
    } catch {
      return NextResponse.json({ error: 'middle.json 不存在（文档可能尚未解析完成）' }, { status: 404 })
    }
    const blocks = (middle.blocks ?? []).map((b) => ({
      ...b,
      text: (b.text ?? '').slice(0, 200),
    }))
    return NextResponse.json({
      layout: blocks,
      pageCount: middle.pages?.length ?? 0,
      pageSizes: middle.pages ?? [],
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
