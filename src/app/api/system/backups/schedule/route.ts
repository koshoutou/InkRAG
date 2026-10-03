import { NextRequest, NextResponse } from 'next/server'
import { ensureScheduler, getSchedule, updateSchedule } from '@/lib/rag/backup'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// 静态段 schedule 优先于同级 [id] 动态路由匹配（Next.js App Router 路由优先级），
// /api/system/backups/schedule 永远进入本文件，不会误入 [id] 的备份详情。

/** GET /api/system/backups/schedule → { schedule }（惰性恢复调度：进程重启后首次 GET 即拉起） */
export async function GET() {
  try {
    await ensureScheduler()
    const schedule = await getSchedule()
    return NextResponse.json({ schedule })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/** PUT /api/system/backups/schedule body { enabled?; intervalHours?; keep? } → { schedule }
 *  intervalHours 2-168 / keep 2-50 越界 clamp；保存后热重载调度器（清旧 timer 按新配置重建） */
export async function PUT(req: NextRequest) {
  try {
    let body: { enabled?: boolean; intervalHours?: number; keep?: number } = {}
    try {
      body = await req.json()
    } catch {
      // 空 body：视为不改任何字段（走现值）
    }
    const schedule = await updateSchedule(body ?? {})
    return NextResponse.json({ schedule })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
