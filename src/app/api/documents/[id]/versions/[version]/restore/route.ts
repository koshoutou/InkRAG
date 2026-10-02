import { NextRequest, NextResponse } from 'next/server'
import { restoreDocVersion } from '@/lib/rag/versions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string; version: string }> }

/**
 * POST /api/documents/[id]/versions/[version]/restore（契约 §27）
 * 恢复文档到历史版本：
 * 归档当前 → parseConfigV+1 → 按快照重建 chunks（行+磁盘全文）→ 清旧向量 → 入队 embed 重写向量库
 * → { ok, restoredVersion, fromVersion, chunkCount, degradedChunks }
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, version } = await ctx.params
    const result = await restoreDocVersion(id, version)
    return NextResponse.json(result)
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    const status = /不存在|无需恢复|流水线中|快照为空|无效版本/.test(msg) ? 409 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
