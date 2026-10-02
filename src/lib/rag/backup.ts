/**
 * 备份与恢复（契约 §11 / M8 运维增强）
 *
 * 备份内容：SQLite 快照（VACUUM INTO 一致性在线备份）+ artifacts 产物目录（可选）+ manifest.json。
 * 备份存储：{DB_DIR}/backups/{backupId}/（db.sqlite / artifacts/ / manifest.json）。
 *
 * - local 向量引擎的向量数据在 VectorPoint 表中随库备份；
 * - qdrant 模式需另行 Qdrant snapshot（UI 提示），此处仅备份元数据与 DB；
 * - 恢复语义：独立 PrismaClient 读备份库 → 主库事务内全表 deleteMany + createMany
 *   （先删子表后删父表，插入反序）→ artifacts 目录整体替换；
 * - 定时任务（契约 §15）：进程内调度器 globalThis 单例，复用 createBackup，
 *   自动备份 manifest.auto=true，轮转清理只删自动备份（手动不受影响）。
 */
import { execFile } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { PrismaClient } from '@prisma/client'
import { db } from '@/lib/db'
import { ARTIFACTS_ROOT } from './artifacts'
import { pipelineActivity } from './events'
import { getRagSettings } from './settings'

const execFileAsync = promisify(execFile)

/** 备份根目录（与主库 custom.db 同级：{cwd}/db/backups） */
export const BACKUPS_ROOT = path.resolve(process.cwd(), 'db', 'backups')

/** 备份 id 格式：yyyyMMdd-HHmmss-xxxx（4 位随机后缀防同秒冲突） */
const BACKUP_ID_RE = /^[0-9a-zA-Z-]+$/

export interface BackupItem {
  id: string
  createdAt: string
  /** 平台版本标识（schema 兼容性提示用） */
  version: string
  counts: { kbs: number; docs: number; chunks: number; points: number; keys: number; jobs: number }
  sizes: { db: number; artifacts: number; total: number }
  /** local 向量引擎数据随库走；qdrant 模式需单独 snapshot */
  vectorMode: string
  settingsSummary: Record<string, unknown>
  includesArtifacts: boolean
  /** 是否定时任务自动创建（手动备份缺省/false；轮转清理只删 auto===true，契约 §15） */
  auto?: boolean
}

export interface RestoreResult {
  ok: true
  restored: {
    kbs: number
    docs: number
    chunks: number
    points: number
    keys: number
    jobs: number
    settings: boolean
    artifactsFiles: number
  }
  backupId: string
  tookMs: number
}

/** manifest.json 结构（磁盘持久化格式，与 BackupItem 同构） */
type BackupManifest = BackupItem

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function newBackupId(): string {
  const d = new Date()
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${date}-${time}-${suffix}`
}

/** SQL 字符串字面量安全校验（VACUUM INTO 路径拼接前防注入） */
function assertNoQuote(p: string): void {
  if (p.includes("'")) throw new Error(`备份路径含非法字符（单引号）: ${p}`)
}

/** 递归统计目录字节数（目录不存在返回 0） */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
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

/** 递归统计文件数 */
async function countFiles(dir: string): Promise<number> {
  let total = 0
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += await countFiles(p)
    else if (e.isFile()) total++
  }
  return total
}

/** 校验备份 id 并返回目录（防路径穿越：只允许 [0-9a-zA-Z-]，必须存在） */
export function getBackupDir(id: string): string | null {
  if (!id || typeof id !== 'string' || !BACKUP_ID_RE.test(id)) return null
  const dir = path.join(BACKUPS_ROOT, id)
  // 二次防御：解析结果必须仍在备份根目录内
  if (!dir.startsWith(BACKUPS_ROOT + path.sep)) return null
  return existsSync(dir) ? dir : null
}

// ---------------------------------------------------------------------------
// 创建备份
// ---------------------------------------------------------------------------

export async function createBackup(
  opts: { includeArtifacts?: boolean; auto?: boolean } = {}
): Promise<BackupItem> {
  const includeArtifacts = opts.includeArtifacts !== false
  const auto = opts.auto === true

  await fs.mkdir(BACKUPS_ROOT, { recursive: true })

  // id 唯一性：4 位随机后缀防同秒冲突；极端碰撞用 Date.now 兜底
  let id = newBackupId()
  for (let i = 0; i < 5 && existsSync(path.join(BACKUPS_ROOT, id)); i++) {
    id = newBackupId()
  }
  if (existsSync(path.join(BACKUPS_ROOT, id))) id = `${newBackupId()}-${Date.now()}`

  const dir = path.join(BACKUPS_ROOT, id)
  const dbPath = path.join(dir, 'db.sqlite')

  try {
    await fs.mkdir(dir, { recursive: true })

    // 1) SQLite 一致性在线备份（目标文件已存在会报错 —— 新建目录保证唯一）
    assertNoQuote(dbPath)
    await db.$queryRawUnsafe(`VACUUM INTO '${dbPath}'`)

    // 2) artifacts 产物目录复制（可选）
    let artifactsCopied = false
    if (includeArtifacts && existsSync(ARTIFACTS_ROOT)) {
      await fs.cp(ARTIFACTS_ROOT, path.join(dir, 'artifacts'), { recursive: true })
      artifactsCopied = true
    }

    // 3) manifest：DB 计数 + 文件体积 + 模式 + 设置摘要（非敏感字段）
    const [kbs, docs, chunks, points, keys, jobs, settings] = await Promise.all([
      db.knowledgeBase.count(),
      db.document.count(),
      db.chunk.count(),
      db.vectorPoint.count(),
      db.apiKey.count(),
      db.pipelineJob.count(),
      getRagSettings(),
    ])
    const dbSize = (await fs.stat(dbPath)).size
    const artifactsSize = artifactsCopied ? await dirSize(path.join(dir, 'artifacts')) : 0

    const manifest: BackupManifest = {
      id,
      createdAt: new Date().toISOString(),
      version: '1.0',
      counts: { kbs, docs, chunks, points, keys, jobs },
      sizes: { db: dbSize, artifacts: artifactsSize, total: dbSize + artifactsSize },
      vectorMode: settings.vectorMode,
      settingsSummary: {
        url: settings.row.url,
        defaultCollection: settings.row.defaultCollection,
        embedApiBase: settings.row.embedApiBase,
        embedModel: settings.row.embedModel,
        rerankApiBase: settings.row.rerankApiBase,
        rerankModel: settings.row.rerankModel,
        mineruApiUrl: settings.row.mineruApiUrl,
        mineruTier: settings.row.mineruTier,
        mineruOcrMode: settings.row.mineruOcrMode,
        useLocalVectorStore: settings.row.useLocalVectorStore,
        useFallbackParser: settings.row.useFallbackParser,
        useMockEmbedding: settings.row.useMockEmbedding,
        useMockRerank: settings.row.useMockRerank,
        updatedAt: settings.row.updatedAt.toISOString(),
      },
      includesArtifacts: artifactsCopied,
      auto,
    }
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

    return manifest
  } catch (e) {
    // 失败清理半成品目录再抛错
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

// ---------------------------------------------------------------------------
// 列表 / 删除
// ---------------------------------------------------------------------------

export async function listBackups(): Promise<BackupItem[]> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(BACKUPS_ROOT, { withFileTypes: true })
  } catch {
    return [] // 备份目录尚不存在
  }

  const items: BackupItem[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !BACKUP_ID_RE.test(e.name)) continue
    try {
      const raw = await fs.readFile(path.join(BACKUPS_ROOT, e.name, 'manifest.json'), 'utf-8')
      const m = JSON.parse(raw) as Partial<BackupManifest>
      // 必要字段缺失 / 损坏的目录直接跳过
      if (!m?.id || !m.counts || !m.sizes) continue
      items.push({
        id: m.id,
        createdAt: m.createdAt ?? new Date(0).toISOString(),
        version: m.version ?? '—',
        counts: {
          kbs: m.counts.kbs ?? 0,
          docs: m.counts.docs ?? 0,
          chunks: m.counts.chunks ?? 0,
          points: m.counts.points ?? 0,
          keys: m.counts.keys ?? 0,
          jobs: m.counts.jobs ?? 0,
        },
        sizes: {
          db: m.sizes.db ?? 0,
          artifacts: m.sizes.artifacts ?? 0,
          total: m.sizes.total ?? 0,
        },
        vectorMode: m.vectorMode ?? 'local',
        settingsSummary: m.settingsSummary ?? {},
        includesArtifacts: !!m.includesArtifacts,
        // 旧版 manifest 无 auto 字段 → 视为手动备份（false）
        auto: m.auto === true,
      })
    } catch {
      // 损坏 / 缺失 manifest 的目录跳过
      continue
    }
  }

  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return items
}

export async function deleteBackup(id: string): Promise<void> {
  const dir = getBackupDir(id)
  if (!dir) throw new Error(`备份不存在: ${id}`)
  await fs.rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 恢复（破坏性：覆盖主库全部表 + artifacts 目录整体替换）
// ---------------------------------------------------------------------------

export async function restoreBackup(id: string): Promise<RestoreResult> {
  const started = Date.now()
  const dir = getBackupDir(id)
  if (!dir) throw new Error(`备份不存在: ${id}`)
  const backupDbPath = path.join(dir, 'db.sqlite')
  if (!existsSync(backupDbPath)) throw new Error('备份缺少 db.sqlite 快照（目录不完整）')

  // 独立 PrismaClient 指向备份库（只读用途，用完即断开，不干扰主库连接）
  const backupClient = new PrismaClient({
    datasources: { db: { url: 'file:' + backupDbPath } },
    log: ['error', 'warn'],
  })

  let counts: RestoreResult['restored'] = {
    kbs: 0,
    docs: 0,
    chunks: 0,
    points: 0,
    keys: 0,
    jobs: 0,
    settings: false,
    artifactsFiles: 0,
  }

  try {
    // 备份库读出全部表数据（DateTime 字段保持 Date 对象，直接传给 createMany，不做 JSON 化）
    const [callLogs, testCases, chunks, jobs, docs, kbs, keys, points, settingsRows] = await Promise.all([
      backupClient.qdrantCallLog.findMany(),
      backupClient.retrievalTestCase.findMany(),
      backupClient.chunk.findMany(),
      backupClient.pipelineJob.findMany(),
      backupClient.document.findMany(),
      backupClient.knowledgeBase.findMany(),
      backupClient.apiKey.findMany(),
      backupClient.vectorPoint.findMany(),
      backupClient.qdrantSetting.findMany(),
    ])

    // 主库事务内全量替换：先删子表后删父表，插入反序（父表先插，满足 FK 约束）
    await db.$transaction(
      async (tx) => {
        await tx.qdrantCallLog.deleteMany({})
        await tx.retrievalTestCase.deleteMany({})
        await tx.chunk.deleteMany({})
        await tx.pipelineJob.deleteMany({})
        await tx.document.deleteMany({})
        await tx.knowledgeBase.deleteMany({})
        await tx.apiKey.deleteMany({})
        await tx.vectorPoint.deleteMany({})
        await tx.qdrantSetting.deleteMany({})

        // 插入反序：QdrantSetting → VectorPoint → ApiKey → KnowledgeBase →
        // Document → PipelineJob → Chunk → RetrievalTestCase → QdrantCallLog
        if (settingsRows.length) await tx.qdrantSetting.createMany({ data: settingsRows })
        if (points.length) await tx.vectorPoint.createMany({ data: points })
        if (keys.length) await tx.apiKey.createMany({ data: keys })
        if (kbs.length) await tx.knowledgeBase.createMany({ data: kbs })
        if (docs.length) await tx.document.createMany({ data: docs })
        if (jobs.length) await tx.pipelineJob.createMany({ data: jobs })
        if (chunks.length) await tx.chunk.createMany({ data: chunks })
        if (testCases.length) await tx.retrievalTestCase.createMany({ data: testCases })
        if (callLogs.length) await tx.qdrantCallLog.createMany({ data: callLogs })
      },
      // 全表重建可能较大：放宽交互事务默认 5s 超时
      { timeout: 120_000, maxWait: 10_000 },
    )

    counts = {
      kbs: kbs.length,
      docs: docs.length,
      chunks: chunks.length,
      points: points.length,
      keys: keys.length,
      jobs: jobs.length,
      settings: settingsRows.length > 0,
      artifactsFiles: 0,
    }
  } finally {
    await backupClient.$disconnect().catch(() => {})
  }

  // local 向量引擎内存缓存失效（数据面 VectorPoint 已整体替换）
  const g = globalThis as unknown as { __ragLocalVectorCache?: Map<string, unknown[]> }
  g.__ragLocalVectorCache?.clear()

  // artifacts 恢复：备份含产物目录时整体替换
  const backupArtifacts = path.join(dir, 'artifacts')
  if (existsSync(backupArtifacts)) {
    await fs.rm(ARTIFACTS_ROOT, { recursive: true, force: true })
    await fs.cp(backupArtifacts, ARTIFACTS_ROOT, { recursive: true })
    counts.artifactsFiles = await countFiles(ARTIFACTS_ROOT)
  }

  const tookMs = Date.now() - started
  await pipelineActivity({
    at: Date.now(),
    level: 'info',
    message: `备份恢复完成 ${id} · ${counts.kbs} 库 / ${counts.docs} 文档 / ${counts.chunks} chunk / ${counts.points} 点 / ${counts.keys} Key${counts.artifactsFiles ? ` / ${counts.artifactsFiles} 产物文件` : ''}（${tookMs}ms）`,
  })

  return { ok: true, restored: counts, backupId: id, tookMs }
}

// ---------------------------------------------------------------------------
// tar 打包下载
// ---------------------------------------------------------------------------

/** 将备份目录打包为 tar.gz（tarPath 建议放 os.tmpdir，调用方负责清理） */
export async function tarBackup(id: string, tarPath: string): Promise<string> {
  const dir = getBackupDir(id)
  if (!dir) throw new Error(`备份不存在: ${id}`)
  assertNoQuote(tarPath)
  // 目标已存在时 tar 会报错 / 追加，先清理
  await fs.rm(tarPath, { force: true })
  // cwd=备份根目录、打包整个 {id}/ 目录 → 归档内路径为 {id}/...
  await execFileAsync('tar', ['-czf', tarPath, id], {
    cwd: BACKUPS_ROOT,
    timeout: 120_000,
  })
  return tarPath
}

/** 生成临时 tar 路径（os.tmpdir，唯一化） */
export function tempTarPath(id: string): string {
  return path.join(os.tmpdir(), `rag-backup-${id}-${Date.now()}.tar.gz`)
}

// ---------------------------------------------------------------------------
// 定时任务调度器（契约 §15：进程内 globalThis 单例 + 保留轮转）
// ---------------------------------------------------------------------------
// 设计要点（对齐 pipeline.ts 引擎模式）：
// - globalThis 单例状态：Next dev 下各 route 模块独立实例，必须跨模块共享；
// - moduleVersion：dev 热重载后新模块实例检测版本更新即安全接管旧定时器；
// - tick 每 60s 检查一次到点情况（未到点静默返回，开销可忽略）；
// - 失败同样推进 nextRunAt（等满一个周期再试，避免每分钟重锤磁盘）；
// - 模块加载时不自动启动：由 GET /api/system/backups/schedule 惰性触发（未用不占资源）；
// - 路由冲突说明：/api/system/backups/schedule 是静态段，优先于 [id] 动态路由匹配；
//   即使误入 [id]，getBackupDir 的 existsSync 校验也会因无同名目录而拒绝。

/** 调度配置（持久化在 QdrantSetting 三个 autoBackup* 字段） */
export interface ScheduleConfig {
  enabled: boolean
  intervalHours: number
  keep: number
}

/** 对外契约类型（契约 §15，与前端 types.ts BackupSchedule 同构） */
export interface BackupSchedule {
  enabled: boolean
  intervalHours: number
  keep: number
  /** 下次自动备份时间（null = 未启用或调度器异常） */
  nextRunAt: string | null
  /** 上次自动备份时间（进程内，重启清零） */
  lastRunAt: string | null
  /** 上次自动备份产物 ID */
  lastBackupId: string | null
  /** 调度器进程状态（timer 是否在跑） */
  schedulerRunning: boolean
  /** 自动备份累计成功/失败计数（进程内，重启清零） */
  runCount: number
  failCount: number
}

interface BackupSchedulerState {
  timer: NodeJS.Timeout | null
  nextRunAt: Date | null
  lastRunAt: Date | null
  lastBackupId: string | null
  runCount: number
  failCount: number
  running: boolean
  /** 模块版本（dev 热重载接管判据；实现细节，非契约字段） */
  moduleVersion: number
}

const SCHEDULER_TICK_MS = 60_000
const MIN_INTERVAL_HOURS = 2
const MAX_INTERVAL_HOURS = 168
const MIN_KEEP = 2
const MAX_KEEP = 50

/** 默认配置（QdrantSetting 行不存在时的返回值；schema 默认值一致） */
export const DEFAULT_SCHEDULE: ScheduleConfig = { enabled: false, intervalHours: 24, keep: 5 }

const schedG = globalThis as unknown as { __ragBackupScheduler?: BackupSchedulerState }

/** 每次模块求值取新值——dev 下模块重编译后可检测并接管旧调度器 */
const BACKUP_SCHEDULER_MODULE_VERSION = Date.now()

function clampInterval(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_SCHEDULE.intervalHours
  return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(hours)))
}

function clampKeep(keep: number): number {
  if (!Number.isFinite(keep)) return DEFAULT_SCHEDULE.keep
  return Math.min(MAX_KEEP, Math.max(MIN_KEEP, Math.round(keep)))
}

/** 读调度配置（QdrantSetting 单行；不存在返回默认值，不播种） */
export async function readScheduleConfig(): Promise<ScheduleConfig> {
  const row = await db.qdrantSetting.findUnique({ where: { id: 'default' } })
  if (!row) return { ...DEFAULT_SCHEDULE }
  return {
    enabled: row.autoBackupEnabled,
    intervalHours: clampInterval(row.autoBackupIntervalHours),
    keep: clampKeep(row.autoBackupKeep),
  }
}

/** nextRunAt = max(lastRunAt ?? now, 调度器启动/本次计算时刻) + intervalHours（契约 §15） */
function computeNextRunAt(state: BackupSchedulerState, intervalHours: number): Date {
  const now = Date.now()
  const last = state.lastRunAt?.getTime() ?? now
  return new Date(Math.max(last, now) + intervalHours * 3_600_000)
}

/** 取（或建）调度器状态对象（纯内存操作；含 dev 热重载接管） */
function schedulerState(): BackupSchedulerState {
  let state = schedG.__ragBackupScheduler
  if (state && state.moduleVersion !== BACKUP_SCHEDULER_MODULE_VERSION) {
    // dev 热重载：旧模块实例的定时器（闭包引用旧代码）→ 清旧接管
    if (state.timer) clearInterval(state.timer)
    console.log('[backup-scheduler] 检测到模块更新，接管调度器（保留运行统计）')
    state = undefined
  }
  if (!state) {
    state = {
      timer: null,
      nextRunAt: null,
      lastRunAt: null,
      lastBackupId: null,
      runCount: 0,
      failCount: 0,
      running: false,
      moduleVersion: BACKUP_SCHEDULER_MODULE_VERSION,
    }
    schedG.__ragBackupScheduler = state
  }
  return state
}

/** 启动定时器（60s tick；闭包捕获 interval/keep，改配置走 updateSchedule 热重载重建） */
function startSchedulerTimer(state: BackupSchedulerState, cfg: ScheduleConfig): void {
  state.nextRunAt = computeNextRunAt(state, cfg.intervalHours)
  const { intervalHours, keep } = cfg
  state.timer = setInterval(() => {
    void schedulerTick(state, intervalHours, keep)
  }, SCHEDULER_TICK_MS)
  console.log(
    `[backup-scheduler] 已启动 interval=${cfg.intervalHours}h keep=${cfg.keep}（下次 ${state.nextRunAt.toISOString()}）`,
  )
  // 活动流广播（尽力而为，不阻塞启动）
  void pipelineActivity({
    at: Date.now(),
    level: 'info',
    message: `备份调度器已启动：每 ${cfg.intervalHours} 小时自动备份，保留最近 ${cfg.keep} 份（下次 ${state.nextRunAt.toISOString()}）`,
  })
}

/** 停止定时器并清 nextRunAt（运行统计保留） */
function stopSchedulerTimer(state: BackupSchedulerState): void {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  state.nextRunAt = null
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)}${units[i]}`
}

/** 单次 tick：到点且空闲 → 执行自动备份 → 成功后轮转清理；任何异常都吞掉绝不炸 setInterval */
async function schedulerTick(
  state: BackupSchedulerState,
  intervalHours: number,
  keep: number
): Promise<void> {
  try {
    if (state.running) return // 上一轮尚未结束（createBackup 可能含大量文件复制）
    const now = Date.now()
    if (!state.nextRunAt || now < state.nextRunAt.getTime()) {
      // 未到点：静默（debug 级心跳，证明 tick 存活且无异常）
      console.debug(
        `[backup-scheduler] tick 未到点（next=${state.nextRunAt?.toISOString() ?? '—'}）`,
      )
      return
    }

    state.running = true
    let succeeded = false
    try {
      const backup = await createBackup({ includeArtifacts: true, auto: true })
      state.lastRunAt = new Date()
      state.lastBackupId = backup.id
      state.runCount++
      succeeded = true
      await pipelineActivity({
        at: Date.now(),
        level: 'info',
        message: `自动备份完成 ${backup.id} · ${backup.counts.kbs} 库 / ${backup.counts.docs} 文档 / ${backup.counts.chunks} chunk / ${backup.counts.points} 点 · ${fmtBytes(backup.sizes.total)}`,
      })
    } catch (e) {
      state.failCount++
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 200)
      console.error('[backup-scheduler] 自动备份失败:', message)
      await pipelineActivity({
        at: Date.now(),
        level: 'error',
        message: `自动备份失败：${message}`,
      })
    } finally {
      state.running = false
      // 成功与失败都推进 nextRunAt：lastRunAt 为空/过旧时等价于 now+interval，
      // 失败也等满一个周期再试（避免磁盘满等持续故障时每分钟重锤）
      state.nextRunAt = computeNextRunAt(state, intervalHours)
    }

    // 轮转清理仅在成功产出新备份后执行（失败不清理，防止异常时误删仅存的好备份）
    if (succeeded) {
      const pruned = await pruneAutoBackups(keep)
      if (pruned > 0) {
        console.log(`[backup-scheduler] 轮转清理 ${pruned} 份过期自动备份（保留 ${keep} 份）`)
        await pipelineActivity({
          at: Date.now(),
          level: 'info',
          message: `自动备份轮转：清理 ${pruned} 份过期自动备份（保留最近 ${keep} 份，手动备份不受影响）`,
        })
      }
    }
  } catch (e) {
    // tick 兜底：绝不让 setInterval 回调抛未捕获异常
    console.error('[backup-scheduler] tick 异常:', e)
  }
}

/**
 * 幂等惰性同步调度器（契约 §15「GET 每次调用确保调度器与 DB 配置一致」）：
 * - DB enabled=false → 停掉内存定时器（防备份恢复/外部改库后调度器带旧配置空转）；
 * - DB enabled=true 且未运行 → 启动（防进程重启后未恢复）；
 * - 已在运行 → 幂等返回（interval/keep 变更走 PUT updateSchedule 热重载重建）。
 */
export async function ensureScheduler(): Promise<BackupSchedulerState> {
  const state = schedulerState()
  const cfg = await readScheduleConfig()
  if (!cfg.enabled) {
    if (state.timer) {
      stopSchedulerTimer(state)
      console.log('[backup-scheduler] 惰性同步：配置已停用，停止调度器')
    }
    return state
  }
  if (state.timer) return state
  startSchedulerTimer(state, cfg)
  return state
}

/** 合并 DB 配置 + 调度器内存状态 → 契约 §15 BackupSchedule（每次先惰性同步） */
export async function getSchedule(): Promise<BackupSchedule> {
  await ensureScheduler()
  const state = schedulerState()
  const cfg = await readScheduleConfig()
  const running = !!state.timer
  return {
    enabled: cfg.enabled,
    intervalHours: cfg.intervalHours,
    keep: cfg.keep,
    nextRunAt: running && cfg.enabled ? (state.nextRunAt?.toISOString() ?? null) : null,
    lastRunAt: state.lastRunAt?.toISOString() ?? null,
    lastBackupId: state.lastBackupId,
    schedulerRunning: running,
    runCount: state.runCount,
    failCount: state.failCount,
  }
}

/**
 * 更新调度配置（PUT）：
 * clamp intervalHours 2-168 / keep 2-50 → upsert QdrantSetting（只动三个 autoBackup* 字段，
 * 基座 upsert 语义：行存在走 update、不存在 create 其余字段取 schema 默认）→ 热重载
 * （清旧 interval timer → 按新配置重建；enabled=false 时停机、nextRunAt=null）→ 返回 getSchedule()
 */
export async function updateSchedule(patch: {
  enabled?: boolean
  intervalHours?: number
  keep?: number
}): Promise<BackupSchedule> {
  const current = await readScheduleConfig()
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled
  const intervalHours =
    patch.intervalHours !== undefined ? clampInterval(patch.intervalHours) : current.intervalHours
  const keep = patch.keep !== undefined ? clampKeep(patch.keep) : current.keep

  await db.qdrantSetting.upsert({
    where: { id: 'default' },
    update: {
      autoBackupEnabled: enabled,
      autoBackupIntervalHours: intervalHours,
      autoBackupKeep: keep,
    },
    create: {
      id: 'default',
      autoBackupEnabled: enabled,
      autoBackupIntervalHours: intervalHours,
      autoBackupKeep: keep,
    },
  })

  // 热重载：停旧 timer → enabled 时按新配置立即重建（nextRunAt 重算）
  const state = schedulerState()
  stopSchedulerTimer(state)
  if (enabled) {
    startSchedulerTimer(state, { enabled, intervalHours, keep })
  } else {
    console.log('[backup-scheduler] 已停止（enabled=false）')
    void pipelineActivity({
      at: Date.now(),
      level: 'info',
      message: '备份调度器已停止（定时自动备份关闭）',
    })
  }
  return getSchedule()
}

/**
 * 轮转清理：只删 manifest.auto===true 的自动备份。
 * listBackups 已按 createdAt 倒序 → 保留最近 keep 份，其余 fs.rm 整目录；手动备份不受影响。
 * （keep 由调用方传入调度配置，2-50 clamp 兜底）
 */
export async function pruneAutoBackups(keep: number): Promise<number> {
  const k = clampKeep(keep)
  const all = await listBackups()
  const autoBackups = all.filter((b) => b.auto === true)
  const victims = autoBackups.slice(k)
  for (const v of victims) {
    await fs.rm(path.join(BACKUPS_ROOT, v.id), { recursive: true, force: true })
  }
  return victims.length
}

// 注意：本模块加载时不自动启动调度器（防止未使用时占资源）；
// 由 API 调用（GET /api/system/backups/schedule → ensureScheduler）惰性启动。
