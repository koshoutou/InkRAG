/**
 * 知识库汇总助手（列表/详情共用：活统计 docCount/chunkCount + pointCount）
 */
import { db } from '@/lib/db'
import { getRagSettings } from './settings'
import { toKbSummary } from './serialize'
import type { KbSummary } from './types'
import type { KnowledgeBase } from '@prisma/client'

export async function kbSummaryWithCounts(kb: KnowledgeBase): Promise<KbSummary> {
  const settings = await getRagSettings()
  const [docCount, chunkCount] = await Promise.all([
    db.document.count({ where: { kbId: kb.id } }),
    db.chunk.count({ where: { kbId: kb.id, isParent: false } }),
  ])
  let pointCount = kb.pointCount
  if (settings.vectorMode === 'local') {
    try {
      pointCount = await db.vectorPoint.count({ where: { collection: kb.collection } })
    } catch {}
  }
  return toKbSummary(kb, { docCount, chunkCount, pointCount }, settings.vectorMode)
}

export async function kbSummaries(kbs: KnowledgeBase[]): Promise<KbSummary[]> {
  return Promise.all(kbs.map((kb) => kbSummaryWithCounts(kb)))
}
