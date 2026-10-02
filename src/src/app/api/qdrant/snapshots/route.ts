import { NextRequest, NextResponse } from 'next/server'
import { createQdrantSnapshot, listQdrantSnapshots, toSnapshotErrorPayload } from '@/lib/rag/qdrant-snapshots'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function fail(e: unknown) {
  const { status, message } = toSnapshotErrorPayload(e)
  return NextResponse.json({ error: message }, { status })
}

/**
 * GET /api/qdrant/snapshots（契约 §23）
 * → { vectorMode, collections: [{ collection, snapshots }], totalSnapshots }（仅有快照的集合）
 * local 模式 → 400 { error: 'local 模式无 Qdrant 快照…' }；qdrant 不可达 → 502
 */
export async function GET() {
  try {
    return NextResponse.json(await listQdrantSnapshots())
  } catch (e) {
    return fail(e)
  }
}

/** POST /api/qdrant/snapshots body { collection } → 201 { snapshot }（同步创建，wait=true） */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { collection?: string }
    const collection = (body?.collection ?? '').trim()
    if (!collection) {
      return NextResponse.json({ error: 'collection 参数必填' }, { status: 400 })
    }
    const snapshot = await createQdrantSnapshot(collection)
    return NextResponse.json({ snapshot }, { status: 201 })
  } catch (e) {
    return fail(e)
  }
}
