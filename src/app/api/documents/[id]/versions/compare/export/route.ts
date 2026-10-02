import { NextRequest, NextResponse } from 'next/server'
import {
  compareVersions,
  compareResultToJson,
  compareResultToMarkdown,
  exportFileName,
} from '@/lib/rag/versions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/documents/[id]/versions/compare/export?v1=&v2=&format=json|md
 * 文档版本管理报告下载（json=完整结构；md=人读报告，same 折叠计数）
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const v1 = req.nextUrl.searchParams.get('v1') ?? ''
    const v2 = req.nextUrl.searchParams.get('v2') ?? 'current'
    const format = (req.nextUrl.searchParams.get('format') ?? 'json').toLowerCase()
    if (!v1) return NextResponse.json({ error: '缺少 v1 参数' }, { status: 400 })
    if (!['json', 'md'].includes(format)) {
      return NextResponse.json({ error: `无效 format: ${format}（可选 json / md）` }, { status: 400 })
    }
    if (v1 === v2) return NextResponse.json({ error: '两个版本相同，无对比意义' }, { status: 400 })

    const compare = await compareVersions(id, v1, v2)
    const base = exportFileName(compare.doc.filename, v1, v2)
    if (format === 'md') {
      return new NextResponse(compareResultToMarkdown(compare), {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(base)}.md"`,
        },
      })
    }
    return new NextResponse(compareResultToJson(compare), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(base)}.json"`,
      },
    })
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    const status = msg.includes('不存在') || msg.includes('无对比') ? 404 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
