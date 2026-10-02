import { NextResponse } from 'next/server'
import { metricsSummary } from '@/lib/rag/metrics'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** GET /api/system/metrics-summary —— OpsView 指标卡（JSON 摘要） */
export async function GET() {
  try {
    return NextResponse.json({ summary: await metricsSummary() })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
