import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { markdownPath, middleJsonPath, sourcePath } from '@/lib/rag/artifacts'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Content-Type 白名单（Task 15-b / 审计 #3，存储型 XSS 修复）：
 * 服务端产物只有 pdf 与图片允许携带真实媒体类型（均为安全格式），
 * 其余一律 application/octet-stream —— 不信任 DB 里的 mimeType（来自上传时的客户端声明）。
 * 叠加 Content-Disposition: attachment + X-Content-Type-Options: nosniff，浏览器不会把产物当 HTML 渲染。
 */
const SAFE_SOURCE_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

function safeSourceContentType(ext: string): string {
  return SAFE_SOURCE_CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/** RFC 5987 编码（中文文件名安全下载） */
function contentDispositionAttachment(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * GET /api/documents/[id]/file?kind=source|markdown|middle
 * → 原始字节流（一律 attachment 下载 + nosniff；source 按扩展名白名单定 Content-Type）
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
      contentType = safeSourceContentType(ext)
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
        'Content-Disposition': contentDispositionAttachment(path.basename(filePath)),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
