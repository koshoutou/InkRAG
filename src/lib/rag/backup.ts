/**
 * 备份与恢复（契约 §11 / M8 运维增强）
 *
 * 备份内容：SQLite 快照（VACUUM INTO 一致性在线备份）+ artifacts 产物目录（可选）+ manifest.json。
 * 备份存储：{DB_DIR}/backups/{backupId}/（db.sqlite / artifacts/ / manifest.json）。
 *
 * - 向量数据存于 Qdrant（v1.6 起本地向量引擎已移除）：qdrant 模式需另行 Qdrant snapshot
 *   （§29 支持备份时内嵌快照文件），此处仅备份面板元数据与 DB；
 * - 恢复语义：独立 PrismaClient 读备份库 → 主库事务内全表 deleteMany + createMany
 *   （先删子表后删父表，插入反序）→ artifacts 目录整体替换；
 * - 定时任务（契约 §15）：进程内调度器 globalThis 单例，复用 createBackup，
 *   自动备份 manifest.auto=true，轮转清理只删自动备份（手动不受影响）。
 */
import { execFile } from 'node:child_process'
import { promises as fs, existsSync, type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { PrismaClient } from '@prisma/client'
import { db } from '@/lib/db'
import { ARTIFACTS_ROOT } from './artifacts'
import { pipelineActivity } from './events'
import {
  createQdrantSnapshot,
  downloadSnapshotStream,
  recoverQdrantWithSnapshotFile,
} from './qdrant-snapshots'
import { getRagSettings } from './settings'
import { pausePipelineEngine, resumePipelineEngine } from './pipeline'

const execFileAsync = promisify(execFile)

/**
 * BE-005/OPS-003：备份/恢复期间暂停流水线引擎，带超时保护与强制恢复。
 *
 * - 暂停期间 tick / mineruPollTick 不认领新任务（活跃任务继续跑完）
 * - 无论操作成功或抛错，finally 一定调用 resume（防泄漏暂停）
 * - 额外 watchdog：PAUSE_TIMEOUT_MS 后强制 resume（防进程崩溃后引擎永久暂停）
 */
const PAUSE_TIMEOUT_MS = 30 * 60 * 1000 // 30 分钟上限（备份/恢复远超此时长视为异常）

async function withPipelinePaused<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  pausePipelineEngine(reason)
  // 兜底 watchdog：即使 finally 因异常未执行，超时后也会自动恢复
  const watchdog = setTimeout(() => {
    try {
      resumePipelineEngine(`${reason} · 超时强制恢复`)
      console.error(`[backup] 引擎暂停超时 ${PAUSE_TIMEOUT_MS}ms，已强制恢复（reason=${reason}）`)
    } catch {
      /* 兜底失败忽略 */
    }
  }, PAUSE_TIMEOUT_MS)
  ;(watchdog as unknown as { unref?: () => void }).unref?.()
  try {
    return await fn()
  } finally {
    clearTimeout(watchdog)
    resumePipelineEngine(`${reason} · 完成`)
  }
}

/** 备份根目录（与主库 custom.db 同级：{cwd}/db/backups） */
export const BACKUPS_ROOT = path.resolve(process.cwd(), 'db', 'backups')

/** 备份 id 格式：yyyyMMdd-HHmmss-xxxx（4 位随机后缀防同秒冲突） */
const BACKUP_ID_RE = /^[0-9a-zA-Z-]+$/

/** 快照文件 / 集合名安全模式（防路径穿越与注入） */
const SAFE_FILE_SEG_RE = /^[0-9a-zA-Z._-]+$/
const COLLECTION_RE = /^[0-9a-zA-Z_-]+$/

export interface BackupQdrantSnapshot {
  /** 目标集合名 */
  collection: string
  /** 备份目录内相对路径（qdrant-snapshots/{name}.snapshot） */
  file: string
  /** 字节 */
  sizeBytes: number
}

export interface BackupItem {
  id: string
  createdAt: string
  /** 平台版本标识（schema 兼容性提示用） */
  version: string
  counts: { kbs: number; docs: number; chunks: number; points: number; keys: number; jobs: number }
  sizes: { db: number; artifacts: number; total: number }
  /** 备份时的向量存储模式（v1.6 起仅 qdrant；旧备份可能为 local，仅展示用） */
  vectorMode: string
  settingsSummary: Record<string, unknown>
  includesArtifacts: boolean
  /** 是否定时任务自动创建（手动备份缺省/false；轮转清理只删 auto===true，契约 §15） */
  auto?: boolean
  /** §29 是否内嵌 Qdrant 快照文件（qdrant 模式创建且未显式关闭时 true） */
  includesQdrantSnapshots: boolean
  /** §29 内嵌快照清单（备份目录 qdrant-snapshots/ 下） */
  qdrantSnapshots?: BackupQdrantSnapshot[]
  /** §29 创建/恢复过程中的非致命警告（单集合快照失败等；备份本身成功） */
  warnings?: string[]
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
    /** §29 成功恢复的 Qdrant 集合数（未恢复/不含快照时 0） */
    qdrantRestored: number
  }
  backupId: string
  tookMs: number
  /** §29 非致命警告（单集合恢复失败等；面板数据已恢复成功） */
  warnings?: string[]
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

/** qdrant 快照文件名净化（qdrant 名字形如 {collection}-{seq}-{ts}.snapshot，本身安全，防御性处理） */
function sanitizeSnapshotFileName(name: string): string {
  const cleaned = String(name ?? '')
    .split(/[/\\]/)
    .pop()!
    .replace(/[^0-9a-zA-Z._-]/g, '_')
  return cleaned.endsWith('.snapshot') ? cleaned : `${cleaned}.snapshot`
}

export async function createBackup(
  opts: { includeArtifacts?: boolean; auto?: boolean; includeQdrantSnapshot?: boolean } = {}
): Promise<BackupItem> {
  const includeArtifacts = opts.includeArtifacts !== false
  const auto = opts.auto === true
  // §29 一体化：默认连同 Qdrant 快照（local 模式自动跳过——VectorPoint 已随库备份）
  const includeQdrantSnapshot = opts.includeQdrantSnapshot !== false

  await fs.mkdir(BACKUPS_ROOT, { recursive: true })

  // id 唯一性：4 位随机后缀防同秒冲突；极端碰撞用 Date.now 兜底
  let id = newBackupId()
  for (let i = 0; i < 5 && existsSync(path.join(BACKUPS_ROOT, id)); i++) {
    id = newBackupId()
  }
  if (existsSync(path.join(BACKUPS_ROOT, id))) id = `${newBackupId()}-${Date.now()}`

  const dir = path.join(BACKUPS_ROOT, id)
  const dbPath = path.join(dir, 'db.sqlite')

  // BE-005/OPS-003：备份期间暂停流水线引擎（避免备份与流水线并发写库导致快照不一致）
  return withPipelinePaused(`backup:${id}`, async () => {
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

    // 2.5) §29 Qdrant 快照（qdrant 模式且未显式关闭时）：全部 KB collection
    //      （+ defaultCollection 若非空且不同）逐个串行创建 + 下载至备份目录；
    //      单集合失败仅记 warnings 不阻塞整体备份；local 模式跳过（VectorPoint 随库走）
    const settings = await getRagSettings()
    const warnings: string[] = []
    const qdrantSnapshots: BackupQdrantSnapshot[] = []
    let includesQdrantSnapshots = false
    if (includeQdrantSnapshot && settings.vectorMode === 'qdrant') {
      const kbRows = await db.knowledgeBase.findMany({ select: { collection: true } })
      const collections = Array.from(
        new Set(
          [...kbRows.map((k) => k.collection), settings.row.defaultCollection].map((c) =>
            String(c ?? '').trim(),
          ),
        ),
      ).filter(Boolean)
      if (collections.length > 0) {
        const snapDir = path.join(dir, 'qdrant-snapshots')
        await fs.mkdir(snapDir, { recursive: true })
        for (const collection of collections) {
          try {
            const snap = await createQdrantSnapshot(collection)
            const res = await downloadSnapshotStream(collection, snap.name)
            const buf = Buffer.from(await res.arrayBuffer())
            const fileName = sanitizeSnapshotFileName(snap.name || `${collection}-${Date.now()}.snapshot`)
            await fs.writeFile(path.join(snapDir, fileName), buf)
            qdrantSnapshots.push({ collection, file: `qdrant-snapshots/${fileName}`, sizeBytes: buf.length })
            includesQdrantSnapshots = true
          } catch (e) {
            const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200)
            warnings.push(`Qdrant 快照失败（${collection}）: ${msg}`)
          }
        }
      }
    }

    // 3) manifest：DB 计数 + 文件体积 + 模式 + 设置摘要（非敏感字段）
    // points 为库行快照 pointCount 之和（向量实体在 Qdrant，随快照文件另存）
    const [kbs, docs, chunks, pointAgg, keys, jobs] = await Promise.all([
      db.knowledgeBase.count(),
      db.document.count(),
      db.chunk.count(),
      db.knowledgeBase.aggregate({ _sum: { pointCount: true } }),
      db.apiKey.count(),
      db.pipelineJob.count(),
    ])
    const points = pointAgg._sum.pointCount ?? 0
    const dbSize = (await fs.stat(dbPath)).size
    const artifactsSize = artifactsCopied ? await dirSize(path.join(dir, 'artifacts')) : 0
    const qdrantBytes = qdrantSnapshots.reduce((a, s) => a + (s.sizeBytes || 0), 0)

    const manifest: BackupManifest = {
      id,
      createdAt: new Date().toISOString(),
      version: '1.0',
      counts: { kbs, docs, chunks, points, keys, jobs },
      sizes: { db: dbSize, artifacts: artifactsSize, total: dbSize + artifactsSize + qdrantBytes },
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
        useFallbackParser: settings.row.useFallbackParser,
        useMockEmbedding: settings.row.useMockEmbedding,
        useMockRerank: settings.row.useMockRerank,
        updatedAt: settings.row.updatedAt.toISOString(),
      },
      includesArtifacts: artifactsCopied,
      auto,
      includesQdrantSnapshots,
      ...(qdrantSnapshots.length > 0 ? { qdrantSnapshots } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

    return manifest
  } catch (e) {
    // 失败清理半成品目录再抛错
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
  }) // /withPipelinePaused
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
        vectorMode: m.vectorMode ?? 'qdrant',
        settingsSummary: m.settingsSummary ?? {},
        includesArtifacts: !!m.includesArtifacts,
        // 旧版 manifest 无 auto 字段 → 视为手动备份（false）
        auto: m.auto === true,
        // §29：旧 manifest 无快照字段 → false / undefined（兼容读取）
        includesQdrantSnapshots: Array.isArray(m.qdrantSnapshots) && m.qdrantSnapshots.length > 0,
        ...(Array.isArray(m.qdrantSnapshots) && m.qdrantSnapshots.length > 0
          ? {
              qdrantSnapshots: (m.qdrantSnapshots as BackupQdrantSnapshot[])
                .filter((s) => s && typeof s.collection === 'string' && typeof s.file === 'string')
                .map((s) => ({
                  collection: s.collection,
                  file: s.file,
                  sizeBytes: Number(s.sizeBytes) || 0,
                })),
            }
          : {}),
        ...(Array.isArray(m.warnings) && m.warnings.length > 0 ? { warnings: m.warnings.map(String) } : {}),
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
// 恢复（破坏性：覆盖主库全部表 + artifacts 目录整体替换；
// §29 一体化：备份含 qdrant-snapshots 且 includeQdrant≠false 时逐个上传恢复到 qdrant）
// ---------------------------------------------------------------------------

/** 默认平台文件服务基址（location 回退时 qdrant 自行回拉；同机 qdrant 可达） */
function defaultOrigin(): string {
  // A05 修复：回退端口由 3000 改为 2607（v1.10 端口体系迁移后，3000 段已废弃）。
  // 优先级：PORT > PANEL_PORT > 2607。直接 bun .next/standalone/server.js 启动时
  // PORT 可能为空，此前会生成 http://127.0.0.1:3000 → qdrant 回拉失败、含快照备份静默损坏。
  const port = process.env.PORT ?? process.env.PANEL_PORT ?? '2607'
  return `http://127.0.0.1:${port}`
}

export async function restoreBackup(
  id: string,
  opts: { includeQdrant?: boolean; origin?: string } = {},
): Promise<RestoreResult> {
  const started = Date.now()
  const dir = getBackupDir(id)
  if (!dir) throw new Error(`备份不存在: ${id}`)
  const backupDbPath = path.join(dir, 'db.sqlite')
  if (!existsSync(backupDbPath)) throw new Error('备份缺少 db.sqlite 快照（目录不完整）')

  // BE-005/OPS-003：恢复期间暂停流水线引擎（恢复会全表替换主库，与流水线并发会数据错乱）
  return withPipelinePaused(`restore:${id}`, async () => {
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
    qdrantRestored: 0,
  }

  try {
    // 备份库读出全部表数据（DateTime 字段保持 Date 对象，直接传给 createMany，不做 JSON 化）
    // （v1.6：VectorPoint 表已随本地向量引擎移除；旧备份含该表时忽略，向量实体经 Qdrant 快照恢复）
    const [callLogs, testCases, chunks, jobs, docs, kbs, keys, settingsRows] = await Promise.all([
      backupClient.qdrantCallLog.findMany(),
      backupClient.retrievalTestCase.findMany(),
      backupClient.chunk.findMany(),
      backupClient.pipelineJob.findMany(),
      backupClient.document.findMany(),
      backupClient.knowledgeBase.findMany(),
      backupClient.apiKey.findMany(),
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
        await tx.qdrantSetting.deleteMany({})

        // 插入反序：QdrantSetting → ApiKey → KnowledgeBase →
        // Document → PipelineJob → Chunk → RetrievalTestCase → QdrantCallLog
        if (settingsRows.length) await tx.qdrantSetting.createMany({ data: settingsRows })
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
      points: kbs.reduce((a, k) => a + (k.pointCount ?? 0), 0),
      keys: keys.length,
      jobs: jobs.length,
      settings: settingsRows.length > 0,
      artifactsFiles: 0,
      qdrantRestored: 0,
    }
  } finally {
    await backupClient.$disconnect().catch(() => {})
  }

  // artifacts 恢复：备份含产物目录时整体替换
  const backupArtifacts = path.join(dir, 'artifacts')
  if (existsSync(backupArtifacts)) {
    await fs.rm(ARTIFACTS_ROOT, { recursive: true, force: true })
    await fs.cp(backupArtifacts, ARTIFACTS_ROOT, { recursive: true })
    counts.artifactsFiles = await countFiles(ARTIFACTS_ROOT)
  }

  // §29 Qdrant 快照恢复：备份含 qdrant-snapshots 且未显式关闭时，逐个上传恢复
  //（设置已随面板数据恢复为备份时配置，连接信息与备份一致；单集合失败记 warnings 不回滚）
  const warnings: string[] = []
  let snapList: { collection?: unknown; file?: unknown }[] = []
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'))
    if (Array.isArray(m?.qdrantSnapshots)) snapList = m.qdrantSnapshots
  } catch {
    // manifest 缺失/损坏时尝试直接扫描目录
  }
  if (snapList.length === 0 && existsSync(path.join(dir, 'qdrant-snapshots'))) {
    try {
      const files = await fs.readdir(path.join(dir, 'qdrant-snapshots'))
      snapList = files
        .filter((f) => f.endsWith('.snapshot'))
        .map((f) => ({ collection: f.replace(/\.snapshot$/, '').split('-')[0], file: `qdrant-snapshots/${f}` }))
    } catch {
      // 目录扫描失败忽略
    }
  }
  if (opts.includeQdrant !== false && snapList.length > 0) {
    const origin = opts.origin ?? defaultOrigin()
    for (const s of snapList) {
      const collection = String(s.collection ?? '').trim()
      const relFile = String(s.file ?? '').trim()
      if (!collection || !relFile) continue
      const filePath = path.join(dir, relFile)
      if (!existsSync(filePath)) {
        warnings.push(`Qdrant 快照文件缺失（${collection}）: ${relFile}`)
        continue
      }
      try {
        await recoverQdrantWithSnapshotFile(filePath, collection, {
          locationUrl: `${origin}/api/system/backups/snapshot-file?file=${encodeURIComponent(`${id}/${relFile}`)}`,
        })
        counts.qdrantRestored++
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200)
        warnings.push(`Qdrant 快照恢复失败（${collection}）: ${msg}`)
      }
    }
  }

  const tookMs = Date.now() - started
  await pipelineActivity({
    at: Date.now(),
    level: warnings.length > 0 ? 'warn' : 'info',
    message: `备份恢复完成 ${id} · ${counts.kbs} 库 / ${counts.docs} 文档 / ${counts.chunks} chunk / ${counts.points} 点 / ${counts.keys} Key${counts.artifactsFiles ? ` / ${counts.artifactsFiles} 产物文件` : ''}${counts.qdrantRestored > 0 ? ` / Qdrant 集合 ×${counts.qdrantRestored}` : ''}（${tookMs}ms）${warnings.length > 0 ? ` · 警告 ${warnings.length} 条` : ''}`,
  })

  return {
    ok: true,
    restored: counts,
    backupId: id,
    tookMs,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
  }) // /withPipelinePaused
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
// §29 上传导入（备份包 tar.gz / Qdrant 快照 .snapshot）
// ---------------------------------------------------------------------------

/**
 * 导入备份归档（契约 §29.4）：解包 tar.gz → 校验（顶层目录名 ^[0-9a-zA-Z-]+$、
 * manifest.json + db.sqlite 存在、无路径穿越）→ 移入 BACKUPS_ROOT/{原备份 id 或新 id}。
 */
export async function importBackupArchive(tarPath: string): Promise<BackupItem> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-import-'))
  try {
    // 1) 解包前预检清单：拒绝绝对路径与 .. 穿越
    const { stdout } = await execFileAsync('tar', ['-tzf', tarPath], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    for (const line of stdout.split('\n')) {
      const entry = line.trim()
      if (!entry) continue
      if (entry.startsWith('/') || entry.split('/').includes('..')) {
        throw new Error(`归档含不安全路径: ${entry}`)
      }
    }

    // 2) 解包到临时目录
    await execFileAsync('tar', ['-xzf', tarPath, '-C', tmpDir], { timeout: 120_000 })

    // 3) 顶层应为单一合法备份目录
    const top = await fs.readdir(tmpDir, { withFileTypes: true })
    const topDirs = top.filter((d) => d.isDirectory()).map((d) => d.name)
    if (topDirs.length !== 1) {
      throw new Error(`归档顶层应为单一备份目录（实际 ${topDirs.length} 个目录）`)
    }
    const srcName = topDirs[0]
    if (!BACKUP_ID_RE.test(srcName)) {
      throw new Error(`备份目录名不合法（须匹配 ^[0-9a-zA-Z-]+$）: ${srcName}`)
    }
    const srcDir = path.join(tmpDir, srcName)

    // 4) 结构校验：manifest.json + db.sqlite
    const manifestPath = path.join(srcDir, 'manifest.json')
    const dbFile = path.join(srcDir, 'db.sqlite')
    if (!existsSync(manifestPath) || !existsSync(dbFile)) {
      throw new Error('归档缺少 manifest.json 或 db.sqlite（非平台备份包）')
    }
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<string, unknown>
    if (!raw?.id || !raw.counts || !raw.sizes) {
      throw new Error('manifest.json 损坏（缺少 id / counts / sizes）')
    }

    // 5) 目标 id：优先原备份 id；冲突时生成新 id 并回写 manifest
    let targetId = typeof raw.id === 'string' && BACKUP_ID_RE.test(raw.id) ? raw.id : srcName
    await fs.mkdir(BACKUPS_ROOT, { recursive: true })
    if (existsSync(path.join(BACKUPS_ROOT, targetId))) {
      targetId = newBackupId()
    }
    await fs.cp(srcDir, path.join(BACKUPS_ROOT, targetId), { recursive: true })
    if (raw.id !== targetId) {
      raw.id = targetId
      await fs.writeFile(
        path.join(BACKUPS_ROOT, targetId, 'manifest.json'),
        JSON.stringify(raw, null, 2),
        'utf-8',
      )
    }

    const item = (await listBackups()).find((b) => b.id === targetId)
    if (!item) throw new Error('导入成功但读取备份列表失败（manifest 异常）')
    return item
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 已上传 Qdrant 快照行（GET /api/system/backups/upload 载荷） */
export interface UploadedQdrantSnapshot {
  fileName: string
  sizeBytes: number
  createdAt: string
  /** 从文件名推断的目标集合（现有集合最长前缀匹配，否则首段） */
  inferredCollection: string
}

/** 从文件名推断目标集合：剥离 uploaded-{ts}- 前缀 → 现有集合最长前缀匹配 → 首段（§29.4/§29.5 同规则，路由与清单共用） */
export function inferCollectionFromFileName(fileName: string, known: string[]): string {
  let base = fileName.replace(/\.snapshot$/i, '')
  base = base.replace(/^uploaded-\d{4,14}-/, '')
  const sorted = Array.from(new Set(known.filter(Boolean))).sort((a, b) => b.length - a.length)
  for (const c of sorted) {
    if (base === c || base.startsWith(`${c}-`)) return c
  }
  return base.split('-')[0] ?? ''
}

/** 读取已知集合清单（KB collection + defaultCollection；§29.5 路由推断共用） */
export async function knownCollections(): Promise<string[]> {
  const [kbRows, settings] = await Promise.all([
    db.knowledgeBase.findMany({ select: { collection: true } }),
    getRagSettings(),
  ])
  const names = [
    ...kbRows.map((k) => k.collection),
    settings.row.defaultCollection,
  ].map((c) => String(c ?? '').trim())
  return Array.from(new Set(names)).filter(Boolean)
}

/** 已上传 .snapshot 清单（BACKUPS_ROOT 顶层 uploaded-*.snapshot 文件，mtime 倒序） */
export async function listUploadedQdrantSnapshots(): Promise<UploadedQdrantSnapshot[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(BACKUPS_ROOT, { withFileTypes: true })
  } catch {
    return []
  }
  const known = await knownCollections()
  const out: UploadedQdrantSnapshot[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.startsWith('uploaded-') || !e.name.endsWith('.snapshot')) continue
    try {
      const st = await fs.stat(path.join(BACKUPS_ROOT, e.name))
      out.push({
        fileName: e.name,
        sizeBytes: st.size,
        createdAt: st.mtime.toISOString(),
        inferredCollection: inferCollectionFromFileName(e.name, known),
      })
    } catch {
      // 并发删除忽略
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return out
}

/** 删除已上传快照文件（仅允许 BACKUPS_ROOT 顶层 uploaded-*.snapshot，防路径穿越） */
export async function deleteUploadedQdrantSnapshot(fileName: string): Promise<void> {
  if (
    !fileName ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..') ||
    !fileName.startsWith('uploaded-') ||
    !fileName.endsWith('.snapshot')
  ) {
    throw new Error('仅允许删除 uploaded-*.snapshot 上传文件')
  }
  const p = path.join(BACKUPS_ROOT, fileName)
  if (!p.startsWith(BACKUPS_ROOT + path.sep) || !existsSync(p)) {
    throw new Error(`文件不存在: ${fileName}`)
  }
  await fs.rm(p, { force: true })
}

/** 校验快照文件引用（snapshot-file 文件服务 / qdrant-restore 共用）：返回绝对路径或 null
 *  合法形态：uploaded-xxx.snapshot（顶层）或 {backupId}/qdrant-snapshots/xxx.snapshot（≤3 段） */
export function resolveSnapshotFileRef(ref: string): string | null {
  if (!ref || typeof ref !== 'string') return null
  const segs = ref.split('/')
  if (segs.length < 1 || segs.length > 3) return null
  if (segs.some((s) => !s || !SAFE_FILE_SEG_RE.test(s))) return null
  if (!ref.endsWith('.snapshot')) return null
  const abs = path.resolve(BACKUPS_ROOT, ...segs)
  if (!abs.startsWith(BACKUPS_ROOT + path.sep)) return null
  return existsSync(abs) ? abs : null
}

/**
 * 上传的 .snapshot 文件 → 恢复到指定集合（契约 §29.5；恢复语义同 restoreBackup 的
 * qdrant 快照段：upload/recover 直传优先，location 回退）。
 */
export async function importQdrantSnapshot(
  filePath: string,
  targetCollection: string,
  opts: { locationUrl?: string } = {},
): Promise<{ ok: true; message: string; collection: string }> {
  const collection = String(targetCollection ?? '').trim()
  if (!collection || !COLLECTION_RE.test(collection)) {
    throw new Error(`目标集合名不合法（仅允许 [0-9a-zA-Z_-]）: ${targetCollection}`)
  }
  const r = await recoverQdrantWithSnapshotFile(filePath, collection, opts)
  return { ...r, collection }
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
  // F-CONC-17：unref 不阻止进程优雅退出
  ;(state.timer as unknown as { unref?: () => void }).unref?.()
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
      // §29 一体化：自动备份同时创建面板数据与 Qdrant 快照（qdrant 模式）
      const backup = await createBackup({ includeArtifacts: true, auto: true, includeQdrantSnapshot: true })
      state.lastRunAt = new Date()
      state.lastBackupId = backup.id
      state.runCount++
      succeeded = true
      await pipelineActivity({
        at: Date.now(),
        level: backup.warnings && backup.warnings.length > 0 ? 'warn' : 'info',
        message: `自动备份完成 ${backup.id} · ${backup.counts.kbs} 库 / ${backup.counts.docs} 文档 / ${backup.counts.chunks} chunk / ${backup.counts.points} 点${backup.includesQdrantSnapshots ? ` / Qdrant 快照 ×${backup.qdrantSnapshots?.length ?? 0}` : ''} · ${fmtBytes(backup.sizes.total)}${backup.warnings && backup.warnings.length > 0 ? ` · 警告 ${backup.warnings.length} 条` : ''}`,
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
