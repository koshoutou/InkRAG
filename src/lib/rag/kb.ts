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
  // pointCount 用库行快照（pipeline 每次 ready 后回写）；
  // 不在此处实时探测 Qdrant（列表页逐库 count 会放大远程延迟，且不可达时列表不应失败）
  return toKbSummary(kb, { docCount, chunkCount, pointCount: kb.pointCount }, settings.vectorMode)
}

export async function kbSummaries(kbs: KnowledgeBase[]): Promise<KbSummary[]> {
  return Promise.all(kbs.map((kb) => kbSummaryWithCounts(kb)))
}
