import { NextRequest, NextResponse } from 'next/server'
import { getDashboardTrends } from '@/lib/rag/trends'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** GET /api/dashboard/trends?days=14&kbId= —— 检索质量趋势聚合（契约 §14；kbId 可选 KB 维度过滤） */
export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get('days')
    const parsed = raw === null ? 14 : Number(raw)
    const kbId = req.nextUrl.searchParams.get('kbId') || undefined
    const trends = await getDashboardTrends(parsed, kbId ? { kbId } : {})
    return NextResponse.json({ trends })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
