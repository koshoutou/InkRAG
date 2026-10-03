/**
 * GET /api/input/docs —— 入库 API 完整文档（公开端点，无需鉴权）
 * 返回 docs/input-api.md 原文（text/markdown），供 Agent / DocsViewerDialog 渲染。
 *
 * Task 17-3 扩展：?file=dify-compat → 返回 docs/dify-compat.md
 * （Dify 兼容数据集 API 文档——MinerU 面板「导出到 Dify」对接说明）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const DOC_FILES: Record<string, string> = {
  'input-api': 'input-api.md',
  'dify-compat': 'dify-compat.md',
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const key = url.searchParams.get('file') ?? 'input-api'
    const filename = DOC_FILES[key]
    if (!filename) {
      return NextResponse.json(
        { error: `未知文档 ${key}（可选：${Object.keys(DOC_FILES).join(' / ')}）` },
        { status: 404 },
      )
    }
    const file = path.join(process.cwd(), 'docs', filename)
    let md: string
    try {
      md = readFileSync(file, 'utf-8')
    } catch {
      return NextResponse.json(
        { error: `API 文档尚未部署（docs/${filename} 不存在）—— 请联系平台管理员` },
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
