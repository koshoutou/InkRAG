import { promises as fs } from 'node:fs'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { resolveSnapshotFileRef } from '@/lib/rag/backup'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/system/backups/snapshot-file?file={ref} → .snapshot 文件字节流（契约 §29.5）
 *
 * 用途：qdrant recover(location) 回退路径的文件服务端点——qdrant 自行回拉该 URL 获取快照。
 * 合法 ref：uploaded-xxx.snapshot（顶层上传文件）或 {backupId}/qdrant-snapshots/xxx.snapshot
 * （备份内嵌快照）；仅允许 .snapshot 后缀与安全路径段，防路径穿越。
 */
export async function GET(req: NextRequest) {
  try {
    const ref = new URL(req.url).searchParams.get('file') ?? ''
    const filePath = resolveSnapshotFileRef(ref)
    if (!filePath) {
      return NextResponse.json({ error: `快照文件不存在或路径不合法: ${ref}` }, { status: 404 })
    }
    const buf = await fs.readFile(filePath)
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
        'Content-Length': String(buf.length),
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
