import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { markdownPath, middleJsonPath, sourcePath } from '@/lib/rag/artifacts'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/documents/[id]/file?kind=source|markdown|middle
 * → 原始字节流（source 按 mimeType；markdown → text/markdown；middle → application/json）
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })

    const url = new URL(req.url)
    const kind = url.searchParams.get('kind') ?? 'source'

    let filePath: string
    let contentType: string
    if (kind === 'markdown') {
      filePath = markdownPath(doc.kbId, doc.id)
      contentType = 'text/markdown; charset=utf-8'
    } else if (kind === 'middle') {
      filePath = middleJsonPath(doc.kbId, doc.id)
      contentType = 'application/json; charset=utf-8'
    } else if (kind === 'source') {
      const ext = path.extname(doc.filename).toLowerCase().replace('.', '') || 'bin'
      filePath = sourcePath(doc.kbId, doc.id, ext)
      contentType = doc.mimeType || 'application/octet-stream'
    } else {
      return NextResponse.json({ error: `无效 kind: ${kind}` }, { status: 400 })
    }

    let buf: Buffer
    try {
      buf = await fs.readFile(filePath)
    } catch {
      return NextResponse.json({ error: '产物不存在（文档可能尚未解析完成）' }, { status: 404 })
    }
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buf.length),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
