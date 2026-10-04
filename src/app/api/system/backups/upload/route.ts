import { NextRequest, NextResponse } from 'next/server'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import {
  BACKUPS_ROOT,
  deleteUploadedQdrantSnapshot,
  importBackupArchive,
  listUploadedQdrantSnapshots,
} from '@/lib/rag/backup'
import { recordOp } from '@/lib/rag/oplog'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * /api/system/backups/upload（契约 §29.4 上传导入）
 *
 * - GET    列出已上传 .snapshot 文件（BACKUPS_ROOT 顶层 uploaded-*.snapshot）
 * - POST   接收 multipart/form-data：
 *            · 字段 file = .snapshot  → 保存为 uploaded-{ts}-{原文件名}.snapshot
 *            · 字段 file = .tar.gz    → 走 importBackupArchive 解包入库
 *          单文件大小上限 2GB，防 OOM；超限 413。
 * - DELETE ?file={fileName} 删除指定已上传快照（仅允许 uploaded-*.snapshot 顶层文件，
 *           防路径穿越）
 *
 * 安全：写入前强制校验文件名（白名单 + 长度）、目标路径必须落在 BACKUPS_ROOT 内；
 *       multipart 解析走 Web 标准 formData()，文件落盘流式写入临时路径后原子 rename。
 */

/** 单文件上限 2GB（Qdrant 快照 / 备份归档均足够；防 OOM） */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

/** 上传文件名安全模式（.snapshot / .tar.gz / .tgz 后缀，禁止路径分隔符与 ..） */
const UPLOAD_NAME_RE = /^[0-9a-zA-Z._-]+$/

/** 时间戳前缀生成（uploaded-yyyyMMddHHmmss-原文件名） */
function tsPrefix(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `uploaded-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 校验上传文件名：非空、白名单字符、无路径分隔符、合法后缀 */
function validateUploadName(name: string): string | null {
  const base = String(name ?? '').trim()
  if (!base || base.length > 200) return null
  if (base.includes('/') || base.includes('\\') || base.includes('..')) return null
  if (!UPLOAD_NAME_RE.test(base)) return null
  if (!/\.(snapshot|tar\.gz|tgz)$/i.test(base)) return null
  return base
}

/** GET /api/system/backups/upload → { snapshots: UploadedQdrantSnapshot[] } */
export async function GET() {
  try {
    const snapshots = await listUploadedQdrantSnapshots()
    return NextResponse.json({ snapshots })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/**
 * POST /api/system/backups/upload (multipart/form-data, field: file)
 * → 201 { kind: 'snapshot'|'archive', ... }
 *
 * .snapshot：保存到 BACKUPS_ROOT/uploaded-{ts}-{原文件名}.snapshot
 * .tar.gz：写入临时文件后调用 importBackupArchive，返回导入后的 BackupItem
 */
export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return NextResponse.json(
        { error: '仅支持 multipart/form-data 上传' },
        { status: 415 }
      )
    }

    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return NextResponse.json({ error: 'multipart 解析失败' }, { status: 400 })
    }

    const entry = form.get('file')
    if (!(entry instanceof File)) {
      return NextResponse.json({ error: '缺少 file 字段' }, { status: 400 })
    }

    const originalName = validateUploadName(entry.name)
    if (!originalName) {
      return NextResponse.json(
        { error: '文件名不合法（仅允许 [0-9a-zA-Z._-]，后缀 .snapshot/.tar.gz/.tgz）' },
        { status: 400 }
      )
    }

    if (entry.size <= 0) {
      return NextResponse.json({ error: '文件为空' }, { status: 400 })
    }
    if (entry.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `文件超过上限 ${MAX_UPLOAD_BYTES} 字节` },
        { status: 413 }
      )
    }

    // 确保备份根目录存在
    await fs.mkdir(BACKUPS_ROOT, { recursive: true })

    const isArchive = /\.(tar\.gz|tgz)$/i.test(originalName)
    const isSnapshot = /\.snapshot$/i.test(originalName)

    if (!isArchive && !isSnapshot) {
      return NextResponse.json(
        { error: '仅支持 .snapshot / .tar.gz / .tgz 文件' },
        { status: 400 }
      )
    }

    // 流式读取文件内容到 Buffer（Web File 的 stream() 兼容 Web ReadableStream）
    const buf = Buffer.from(await entry.arrayBuffer())

    if (isSnapshot) {
      // 直接保存为 uploaded-{ts}-{原文件名}.snapshot
      const targetName = `${tsPrefix()}-${originalName}`
      const targetPath = path.join(BACKUPS_ROOT, targetName)
      // 二次防路径穿越：最终路径必须严格落在 BACKUPS_ROOT 内
      if (!targetPath.startsWith(BACKUPS_ROOT + path.sep)) {
        return NextResponse.json({ error: '目标路径越界' }, { status: 400 })
      }
      // 同名文件兜底冲突处理：若极少概率已存在则追加后缀
      let finalPath = targetPath
      let finalName = targetName
      if (existsSync(targetPath)) {
        finalName = `${tsPrefix()}-${originalName.replace(/\.snapshot$/i, '')}-${Date.now()}.snapshot`
        finalPath = path.join(BACKUPS_ROOT, finalName)
      }
      // 原子写入：先写临时文件再 rename，避免半文件被读取
      const tmpPath = `${finalPath}.${process.pid}.tmp`
      await fs.writeFile(tmpPath, buf)
      await fs.rename(tmpPath, finalPath)

      const t0 = Date.now()
      recordOp({
        level: 'info',
        category: 'backup',
        action: 'backup.upload.snapshot',
        message: `上传快照 ${finalName}（${(buf.length / 1024 / 1024).toFixed(1)}MB）`,
        durationMs: Date.now() - t0,
        detail: { fileName: finalName, sizeBytes: buf.length },
      })
      return NextResponse.json(
        { kind: 'snapshot', fileName: finalName, sizeBytes: buf.length },
        { status: 201 }
      )
    }

    // 备份归档：写临时文件 → importBackupArchive 解包入库 → 清理临时文件
    const tmpPath = path.join(
      BACKUPS_ROOT,
      `.upload-${process.pid}-${Date.now()}.tar.gz`
    )
    await fs.writeFile(tmpPath, buf)
    try {
      const t0 = Date.now()
      const backup = await importBackupArchive(tmpPath)
      recordOp({
        level: 'info',
        category: 'backup',
        action: 'backup.upload.archive',
        message: `导入备份归档 ${originalName} → ${backup.id}`,
        durationMs: Date.now() - t0,
        detail: { originalName, backupId: backup.id },
      })
      return NextResponse.json({ kind: 'archive', backup }, { status: 201 })
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => {})
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/**
 * DELETE /api/system/backups/upload?file={fileName}
 * → { ok: true }（仅允许删除 BACKUPS_ROOT 顶层 uploaded-*.snapshot）
 */
export async function DELETE(req: NextRequest) {
  try {
    const fileName = new URL(req.url).searchParams.get('file') ?? ''
    await deleteUploadedQdrantSnapshot(fileName)
    recordOp({
      level: 'info',
      category: 'backup',
      action: 'backup.upload.delete',
      message: `删除已上传快照 ${fileName}`,
      detail: { fileName },
    })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    const status = /不存在|仅允许|不合法/.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
