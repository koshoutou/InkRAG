import { promises as fs, type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ARTIFACTS_ROOT } from '@/lib/rag/artifacts'
import { BACKUPS_ROOT } from '@/lib/rag/backup'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * 平台资源占用（契约 §29-A，OpsView「平台资源占用」卡数据源）
 *
 * - process.cpuPercent：两次 process.cpuUsage() 差分 ÷ 墙钟时间（globalThis 缓存上次采样，
 *   首次请求无采样点返回 0，第二次起为真实值；多核可 >100%，按核数上限 clamp）
 * - disk 三项目录字节数：globalThis 缓存 30s，防止每次请求全盘 walk
 *   （dbBytes = {cwd}/db 目录且不含 backups 子目录，backups 单独统计）
 * - oplog：程序日志行数与估算占用（SQLite 无逐表体积，按字段字节数求和 + 每行固定开销近似；
 *   与 disk 同缓存 30s）
 */

/** globalThis 采样缓存（dev 热重载后跨模块实例保留） */
interface ResourceSample {
  cpu: { usage: NodeJS.CpuUsage; hrtime: bigint }
}
interface DiskCache {
  at: number
  dbBytes: number
  artifactsBytes: number
  backupsBytes: number
  oplogCount: number
  oplogEstBytes: number
}
const sampleG = globalThis as unknown as { __ragResourceSample?: ResourceSample }
const diskG = globalThis as unknown as { __ragResourceDiskCache?: DiskCache }

const DISK_CACHE_TTL_MS = 30_000
/** {cwd}/db 目录（backups 子目录单独统计，不计入 dbBytes） */
const DB_DIR = path.resolve(process.cwd(), 'db')

/** 递归统计目录字节数（可跳过顶层指定子目录名；目录不存在返回 0） */
async function dirSize(dir: string, skipTopLevel?: string): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const e of entries) {
    if (skipTopLevel && e.name === skipTopLevel) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(p)
    else if (e.isFile()) {
      try {
        total += (await fs.stat(p)).size
      } catch {
        // 文件被并发删除等场景忽略
      }
    }
  }
  return total
}

/** 进程 CPU%：cpuUsage 差分 ÷ 墙钟（μs/μs），首次采样返回 0 */
function sampleProcessCpuPercent(): number {
  const usage = process.cpuUsage()
  const hrtime = process.hrtime.bigint()
  const prev = sampleG.__ragResourceSample
  sampleG.__ragResourceSample = { cpu: { usage, hrtime } }
  if (!prev) return 0
  const cpuMicros =
    usage.user + usage.system - (prev.cpu.usage.user + prev.cpu.usage.system)
  const wallMicros = Number(hrtime - prev.cpu.hrtime) / 1000 // ns → μs
  if (wallMicros <= 0 || cpuMicros <= 0) return 0
  return Math.min(100 * os.cpus().length, (cpuMicros / wallMicros) * 100)
}

async function diskSizes(): Promise<DiskCache> {
  const cached = diskG.__ragResourceDiskCache
  if (cached && Date.now() - cached.at < DISK_CACHE_TTL_MS) return cached
  // 程序日志体积估算：字段字节数求和 + 每行 ~120B 固定开销（id/时间戳/索引分摊）
  let oplogCount = 0
  let oplogEstBytes = 0
  try {
    const rows = (await db.$queryRaw`SELECT COUNT(*) AS cnt,
      COALESCE(SUM(LENGTH(message)), 0) + COALESCE(SUM(LENGTH(COALESCE(detailJson, ''))), 0)
      + COALESCE(SUM(LENGTH(action)), 0) AS payload
      FROM ProgramLog`) as Array<{ cnt: number | bigint; payload: number | bigint }>
    const r = rows[0]
    oplogCount = Number(r?.cnt ?? 0)
    oplogEstBytes = Number(r?.payload ?? 0) + oplogCount * 120
  } catch {
    // 表不存在（首次未 db push）等场景忽略
  }
  const fresh: DiskCache = {
    at: Date.now(),
    dbBytes: await dirSize(DB_DIR, 'backups'),
    artifactsBytes: await dirSize(ARTIFACTS_ROOT),
    backupsBytes: await dirSize(BACKUPS_ROOT),
    oplogCount,
    oplogEstBytes,
  }
  diskG.__ragResourceDiskCache = fresh
  return fresh
}

/** GET /api/system/resources → { process, system, disk }（字节原始值，前端格式化） */
export async function GET() {
  try {
    const mem = process.memoryUsage()
    const load = os.loadavg()
    const [cpuPercent, disk] = await Promise.all([sampleProcessCpuPercent(), diskSizes()])
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    return NextResponse.json({
      process: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
      },
      system: {
        totalMemBytes: totalMem,
        freeMemBytes: freeMem,
        usedMemPercent: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : 0,
        loadavg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0] as [number, number, number],
        cpuCount: os.cpus().length,
        platform: os.platform(),
        nodeVersion: process.version,
        hostname: os.hostname(),
      },
      disk: {
        dbBytes: disk.dbBytes,
        artifactsBytes: disk.artifactsBytes,
        backupsBytes: disk.backupsBytes,
        oplog: {
          count: disk.oplogCount,
          estBytes: disk.oplogEstBytes,
        },
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
