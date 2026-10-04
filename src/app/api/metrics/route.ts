import { NextResponse } from 'next/server'
import { renderPrometheus } from '@/lib/rag/metrics'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/metrics —— Prometheus 文本格式（text/plain; version=0.0.4）
 * scrape 配置示例：- job_name: rag, static_configs: [{ targets: ["host:2607"] }], metrics_path: /api/metrics
 */
export async function GET() {
  try {
    const text = await renderPrometheus()
    return new NextResponse(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return new NextResponse(`# 渲染失败: ${e?.message ?? String(e)}\n`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}
