import { promises as fs } from 'node:fs'
import { NextRequest, NextResponse } from 'next/server'
import { tarBackup, tempTarPath } from '@/lib/rag/backup'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/system/backups/[id]/download
 * → tar.gz 字节流（整个备份目录打包；Content-Disposition attachment）
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  const tarPath = tempTarPath(id)
  try {
    await tarBackup(id, tarPath)
    const buf = await fs.readFile(tarPath)
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/x-tar',
        'Content-Disposition': `attachment; filename="rag-backup-${id}.tar.gz"`,
        'Content-Length': String(buf.length),
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  } finally {
    // 及时清理临时文件
    fs.rm(tarPath, { force: true }).catch(() => {})
  }
}
