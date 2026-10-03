import { NextRequest, NextResponse } from 'next/server'
import { restoreBackup } from '@/lib/rag/backup'
import { recordOp } from '@/lib/rag/oplog'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/system/backups/[id]/restore body { includeQdrant? = true }
 * → { result: RestoreResult }（破坏性：覆盖当前全部数据）
 *
 * §29：备份含 qdrant-snapshots 且 includeQdrant≠false 时，面板数据恢复后逐个上传恢复
 * Qdrant 集合；单集合失败记 result.warnings（面板数据不回滚）。
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    let body: { includeQdrant?: boolean } = {}
    try {
      body = await req.json()
    } catch {
      // 空 body 走默认值（includeQdrant=true）
    }
    const includeQdrant = body?.includeQdrant !== false
    // location 回退基址：取请求 origin（网关转发时为公网 Host），默认本机
    const origin = new URL(req.url).origin
    const t0 = Date.now()
    const result = await restoreBackup(id, { includeQdrant, origin })
    recordOp({
      level: 'warn',
      category: 'backup',
      action: 'backup.restore',
      message: `恢复备份 ${id}（${result.restored.kbs} 库 / ${result.restored.docs} 文档 / ${result.restored.chunks} chunk${result.warnings?.length ? `，警告 ${result.warnings.length} 条` : ''}）——覆盖性操作`,
      detail: { restored: result.restored, warnings: result.warnings },
      durationMs: Date.now() - t0,
    })
    return NextResponse.json({ result })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
