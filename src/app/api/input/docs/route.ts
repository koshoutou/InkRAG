/**
 * GET /api/input/docs —— 入库 API 完整文档（公开端点，无需鉴权）
 * 返回 docs/input-api.md 原文（text/markdown），供 Agent / DocsViewerDialog 渲染。
 */
import { NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const file = path.join(process.cwd(), 'docs', 'input-api.md')
    let md: string
    try {
      md = readFileSync(file, 'utf-8')
    } catch {
      return NextResponse.json(
        { error: 'API 文档尚未部署（docs/input-api.md 不存在）—— 请联系平台管理员' },
        { status: 404 },
      )
    }
    return new NextResponse(md, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
