/**
 * 文件入库共享层（Task 17-2/17-3）
 *
 * 从 POST /api/kb/[id]/documents 抽取的单一实现，供三条链路复用：
 *   - POST /api/kb/[id]/documents（平台 UI 上传）
 *   - POST /api/input/knowledge-bases/[id]/documents（入库 API，Agent 调用）
 *   - POST /v1/datasets/{id}/document/create-by-file|create-by-text（Dify 兼容层）
 *
 * 语义与原 UI 上传路由完全一致（v1.6 + Task 15-b + 14-e）：
 *   - 流式 sha256 + 临时文件落盘 → 秒传（同 kb + contentHash + parseConfigV）→ 建行 → 入流水线
 *   - 单文件 200MB / 体积校验（413）；扩展名白名单（400）
 *   - engine 选择（'mineru' | 'node'）优先于全局路由；chunkConfig 一次性覆盖（KB 默认之上）
 *
 * IngestError.status 由路由层映射为 HTTP 状态码。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { once } from 'node:events'
import path from 'node:path'
import { db } from '@/lib/db'
import { ensureDocDir, sourcePath, ARTIFACTS_ROOT } from './artifacts'
import { enqueueDocument } from './pipeline'
import { parseChunkConfig } from './serialize'
import { ALL_ACCEPTED_EXTS, extToMime } from './parsers/formats'
import type { Document, KnowledgeBase } from '@prisma/client'
import { recordOp } from './oplog'

export const INGEST_MAX_FILE_BYTES = 200 * 1024 * 1024 // 单文件 200MB（与 MinerU 云服务一致）

export class IngestError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface IngestOptions {
  /** 一次性切分配置（仅本次入库生效；缺省用 KB 默认） */
  chunkConfig?: Record<string, unknown>
  /** 解析引擎选择：'mineru' | 'node'（缺省跟随全局智能路由） */
  engine?: 'mineru' | 'node'
}

export interface IngestResult {
  doc: Document
  deduplicated: boolean
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 校验扩展名 + 体积（抛 IngestError） */
function checkFile(filename: string, declaredSize: number | undefined): string {
  const ext = path.extname(filename).toLowerCase().replace('.', '')
  if (!ALL_ACCEPTED_EXTS.includes(ext)) {
    throw new IngestError(400, `不支持的文件类型 .${ext || '(无扩展名)'}（支持：${ALL_ACCEPTED_EXTS.join(' / ')}）`)
  }
  if (declaredSize != null && declaredSize > INGEST_MAX_FILE_BYTES) {
    throw new IngestError(413, `文件「${filename}」体积 ${fmtMB(declaredSize)} 超过单文件上限 ${fmtMB(INGEST_MAX_FILE_BYTES)}（200MB，与 MinerU 云服务一致）`)
  }
  return ext
}

/** 流式读 File → sha256 + 临时文件；返回 { tmpPath, sizeBytes, contentHash }（调用方负责清理 tmpPath） */
async function streamToTemp(file: File, filename: string): Promise<{ tmpPath: string; sizeBytes: number; contentHash: string }> {
  const tmpPath = path.join(ARTIFACTS_ROOT, '.upload-' + randomUUID() + '.part')
  await fs.mkdir(ARTIFACTS_ROOT, { recursive: true })
  const hash = createHash('sha256')
  const ws = createWriteStream(tmpPath)
  const reader = (file.stream() as unknown as ReadableStream<Uint8Array>).getReader()
  let sizeBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        sizeBytes += value.byteLength
        // 流式限额兜底（防御伪造 Content-Length / size 声明的请求）
        if (sizeBytes > INGEST_MAX_FILE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new IngestError(413, `文件「${filename}」实际体积超过单文件上限 ${fmtMB(INGEST_MAX_FILE_BYTES)}（200MB），已中断上传`)
        }
        hash.update(value)
        if (!ws.write(value)) await once(ws, 'drain')
      }
    }
  } catch (e) {
    // F-E2E-05：413 中断/读取异常时清理半写临时文件（此前 .upload-*.part 残留磁盘）
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw e
  } finally {
    ws.end()
    await once(ws, 'finish')
  }
  if (sizeBytes === 0) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw new IngestError(400, '上传文件为空')
  }
  return { tmpPath, sizeBytes, contentHash: hash.digest('hex') }
}

/** 组装 chunkConfigSnap：一次性覆盖（opts）优先，其次 KB 默认 */
function resolveChunkSnap(kb: KnowledgeBase, opts?: IngestOptions): string {
  if (opts?.chunkConfig) {
    try {
      return JSON.stringify(parseChunkConfig(JSON.stringify(opts.chunkConfig)))
    } catch (e: any) {
      throw new IngestError(400, `chunkConfig 不合法：${e?.message ?? String(e)}`)
    }
  }
  return kb.chunkConfig
}

/** 组装 metaJson（engineChoice 优先级高于全局路由，14-e 语义） */
function resolveMetaJson(opts?: IngestOptions): string | undefined {
  return opts?.engine ? JSON.stringify({ engineChoice: opts.engine }) : undefined
}

/** 秒传判定（同 kb + contentHash + parseConfigV） */
async function findDuplicated(kbId: string, contentHash: string): Promise<Document | null> {
  return db.document.findFirst({ where: { kbId, contentHash, parseConfigV: 1 } })
}

/** 建行 + 移入产物目录。P2002 竞争（并发同文件）→ raced=true 返回既有文档（秒传语义，不入队） */
async function persistDocumentRow(
  kb: KnowledgeBase,
  tmpPath: string,
  filename: string,
  ext: string,
  mimeType: string,
  sizeBytes: number,
  contentHash: string,
  chunkConfigSnap: string,
  metaJson: string | undefined,
): Promise<{ doc: Document; raced: boolean }> {
  const docId = randomUUID()
  await ensureDocDir(kb.id, docId)
  await fs.rename(tmpPath, sourcePath(kb.id, docId, ext))
  try {
    const doc = await db.document.create({
      data: {
        id: docId,
        kbId: kb.id,
        filename,
        mimeType,
        sizeBytes,
        contentHash,
        status: 'queued',
        stageProgress: 0,
        parseConfigV: 1,
        chunkConfigSnap,
        storageKey: `${kb.id}/${docId}/`,
        ...(metaJson ? { metaJson } : {}),
      },
    })
    return { doc, raced: false }
  } catch (e: any) {
    // 并发同文件竞争唯一索引 → 返回既有行（秒传语义；产物目录回滚清理）
    if (String(e?.code) === 'P2002') {
      const existing = await db.document.findFirst({ where: { kbId: kb.id, contentHash, parseConfigV: 1 } })
      if (existing) {
        await fs.rm(path.dirname(sourcePath(kb.id, docId, ext)), { recursive: true, force: true })
        return { doc: existing, raced: true }
      }
    }
    throw e
  }
}

/**
 * 上传文件入库（核心入口）：校验 → 流式落盘 → 秒传判定 → 建行 → 入流水线。
 * 失败抛 IngestError（status 400/404/413/500）；成功返回 { doc, deduplicated }。
 * deduplicated=true 时 tmpPath 已清理、不产生新流水线任务。
 */
async function ingestUploadFileImpl(kb: KnowledgeBase, file: File, opts?: IngestOptions): Promise<IngestResult> {
  const filename = file.name || 'untitled'
  const ext = checkFile(filename, file.size)
  const { tmpPath, sizeBytes, contentHash } = await streamToTemp(file, filename)
  try {
    const dup = await findDuplicated(kb.id, contentHash)
    if (dup) {
      await fs.rm(tmpPath, { force: true })
      return { doc: dup, deduplicated: true }
    }
    const { doc, raced } = await persistDocumentRow(
      kb,
      tmpPath,
      filename,
      ext,
      file.type || extToMime(ext),
      sizeBytes,
      contentHash,
      resolveChunkSnap(kb, opts),
      resolveMetaJson(opts),
    )
    if (raced) return { doc, deduplicated: true }
    await enqueueDocument(doc.id, 'parse')
    return { doc, deduplicated: false }
  } catch (e: any) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    if (e instanceof IngestError) throw e
    throw new IngestError(500, e?.message ?? String(e))
  }
}

/**
 * 文本直接入库：内容写入 .md 产物文件后走同一流水线。
 * name 缺扩展名时自动补 .md；内容以 UTF-8 落盘，sha256 参与秒传语义。
 */
async function ingestTextContentImpl(
  kb: KnowledgeBase,
  name: string,
  text: string,
  opts?: IngestOptions,
): Promise<IngestResult> {
  const rawName = String(name ?? '').trim() || 'untitled.md'
  let filename = rawName
  let ext = path.extname(rawName).toLowerCase().replace('.', '')
  if (!ALL_ACCEPTED_EXTS.includes(ext)) {
    // 无（或不支持的）扩展名 → 默认按 Markdown 入库
    filename = `${rawName}.md`
    ext = 'md'
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new IngestError(400, 'text 不能为空')
  }
  const buf = Buffer.from(text, 'utf-8')
  if (buf.byteLength > INGEST_MAX_FILE_BYTES) {
    throw new IngestError(413, `文本体积 ${fmtMB(buf.byteLength)} 超过单文件上限 ${fmtMB(INGEST_MAX_FILE_BYTES)}`)
  }
  const contentHash = createHash('sha256').update(buf).digest('hex')

  const dup = await findDuplicated(kb.id, contentHash)
  if (dup) return { doc: dup, deduplicated: true }

  const docId = randomUUID()
  await ensureDocDir(kb.id, docId)
  await fs.writeFile(sourcePath(kb.id, docId, ext), buf)
  const doc = await db.document.create({
    data: {
      id: docId,
      kbId: kb.id,
      filename,
      mimeType: ext === 'md' ? 'text/markdown' : extToMime(ext),
      sizeBytes: buf.byteLength,
      contentHash,
      status: 'queued',
      stageProgress: 0,
      parseConfigV: 1,
      chunkConfigSnap: resolveChunkSnap(kb, opts),
      storageKey: `${kb.id}/${docId}/`,
      ...(resolveMetaJson(opts) ? { metaJson: resolveMetaJson(opts) } : {}),
    },
  })
  await enqueueDocument(doc.id, 'parse')
  return { doc, deduplicated: false }
}


/**
 * 对外入口（带程序日志，Task 17-5）：三条链路（/api/kb/[id]/documents、/api/input、/v1/datasets）共用。
 */
export async function ingestUploadFile(kb: KnowledgeBase, file: File, opts?: IngestOptions): Promise<IngestResult> {
  const t0 = Date.now()
  try {
    const r = await ingestUploadFileImpl(kb, file, opts)
    recordOp({
      level: 'info',
      category: 'document',
      action: r.deduplicated ? 'doc.upload_dedup' : 'doc.upload',
      message: r.deduplicated
        ? `秒传命中：${file.name || 'untitled'}（已存在同内容文档，未新建流水线任务）`
        : `上传入库：${file.name || 'untitled'}（${(file.size / 1024).toFixed(1)}KB，引擎 ${opts?.engine ?? 'auto'}）`,
      durationMs: Date.now() - t0,
      kbId: kb.id,
      docId: r.doc.id,
    })
    return r
  } catch (e: any) {
    recordOp({
      level: e instanceof IngestError && e.status < 500 ? 'warn' : 'error',
      category: 'document',
      action: 'doc.upload_failed',
      message: `上传入库失败：${file.name || 'untitled'}——${e?.message ?? String(e)}`,
      detail: e instanceof IngestError ? { status: e.status } : e,
      statusCode: e instanceof IngestError ? e.status : 500,
      kbId: kb.id,
    })
    throw e
  }
}

export async function ingestTextContent(
  kb: KnowledgeBase,
  name: string,
  text: string,
  opts?: IngestOptions,
): Promise<IngestResult> {
  const t0 = Date.now()
  try {
    const r = await ingestTextContentImpl(kb, name, text, opts)
    recordOp({
      level: 'info',
      category: 'document',
      action: r.deduplicated ? 'doc.ingest_text_dedup' : 'doc.ingest_text',
      message: r.deduplicated ? `文本秒传命中：${name}` : `文本入库：${name}（${text.length} 字符）`,
      durationMs: Date.now() - t0,
      kbId: kb.id,
      docId: r.doc.id,
    })
    return r
  } catch (e: any) {
    recordOp({
      level: e instanceof IngestError && e.status < 500 ? 'warn' : 'error',
      category: 'document',
      action: 'doc.ingest_text_failed',
      message: `文本入库失败：${name}——${e?.message ?? String(e)}`,
      detail: e instanceof IngestError ? { status: e.status } : e,
      statusCode: e instanceof IngestError ? e.status : 500,
      kbId: kb.id,
    })
    throw e
  }
}
