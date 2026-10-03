import { NextRequest, NextResponse } from 'next/server'
import { createBackup, listBackups } from '@/lib/rag/backup'
import { recordOp } from '@/lib/rag/oplog'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** GET /api/system/backups → { backups: BackupItem[] }（按 createdAt 倒序） */
export async function GET() {
  try {
    const backups = await listBackups()
    return NextResponse.json({ backups })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/**
 * POST /api/system/backups body { includeArtifacts? = true, includeQdrantSnapshot? = true }
 * → 201 { backup }（§29 一体化：qdrant 模式默认连同 Qdrant 快照；local 模式向量数据随库走）
 */
export async function POST(req: NextRequest) {
  try {
    let body: { includeArtifacts?: boolean; includeQdrantSnapshot?: boolean } = {}
    try {
      body = await req.json()
    } catch {
      // 空 body 走默认值
    }
    const includeArtifacts = body?.includeArtifacts !== false
    const includeQdrantSnapshot = body?.includeQdrantSnapshot !== false
    const t0 = Date.now()
    const backup = await createBackup({ includeArtifacts, includeQdrantSnapshot })
    recordOp({
      level: 'info',
      category: 'backup',
      action: 'backup.create',
      message: `创建备份 ${backup.fileName}（${(backup.sizeBytes / 1024 / 1024).toFixed(1)}MB${backup.warnings?.length ? `，警告 ${backup.warnings.length} 条` : ''}）`,
      durationMs: Date.now() - t0,
    })
    return NextResponse.json({ backup }, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
