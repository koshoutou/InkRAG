import { NextRequest, NextResponse } from 'next/server'
import { importQdrantSnapshot, resolveSnapshotFileRef, inferCollectionFromFileName, knownCollections } from '@/lib/rag/backup'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/system/backups/qdrant-restore body { fileName, collection? }
 * → { ok, message, collection }（契约 §29.5）
 *
 * 将已上传的 .snapshot 文件（BACKUPS_ROOT 顶层 uploaded-*.snapshot）恢复到指定集合；
 * collection 缺省从文件名推断（剥离 uploaded-{ts}- 前缀 → 现有集合最长前缀匹配 → 首段）。
 * local 模式 400 / 文件不存在 404 / 集合名非法 400 / qdrant 不可达或恢复失败 502。
 */
export async function POST(req: NextRequest) {
  try {
    let body: { fileName?: string; collection?: string } = {}
    try {
      body = await req.json()
    } catch {
      // 空 body → 400
    }
    const fileName = String(body?.fileName ?? '').trim()
    if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
      return NextResponse.json({ error: 'fileName 参数必填（仅文件名，不含路径）' }, { status: 400 })
    }
    const filePath = resolveSnapshotFileRef(fileName)
    if (!filePath) {
      return NextResponse.json({ error: `快照文件不存在: ${fileName}` }, { status: 404 })
    }

    // 推断目标集合：显式指定 > 文件名推断（§29.4 同规则：现有集合最长前缀匹配 → 首段）
    let collection = String(body?.collection ?? '').trim()
    if (!collection) {
      collection = inferCollectionFromFileName(fileName, await knownCollections())
    }
    if (!collection) {
      return NextResponse.json({ error: '无法从文件名推断目标集合，请显式指定 collection' }, { status: 400 })
    }

    const origin = new URL(req.url).origin
    const result = await importQdrantSnapshot(filePath, collection, {
      locationUrl: `${origin}/api/system/backups/snapshot-file?file=${encodeURIComponent(fileName)}`,
    })
    return NextResponse.json(result)
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    // local 模式（qdrant-snapshots 语义 400）与其他参数错误 → 400；上游失败 → 502
    const status = msg.includes('local 模式') || msg.includes('不合法') || msg.includes('必填') ? 400 : 502
    return NextResponse.json({ error: msg }, { status })
  }
}
