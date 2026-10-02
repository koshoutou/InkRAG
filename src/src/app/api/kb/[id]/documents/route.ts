import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { db } from '@/lib/db'
import { ensureDocDir, sourcePath, ARTIFACTS_ROOT } from '@/lib/rag/artifacts'
import { enqueueDocument } from '@/lib/rag/pipeline'
import { parseChunkConfig, toDocSummary } from '@/lib/rag/serialize'
import type { Document } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

const SUPPORTED_EXTS = ['pdf', 'docx', 'md', 'markdown', 'txt', 'html', 'htm']

/** GET /api/kb/[id]/documents?status=&q=&limit=&offset= → { docs, total } */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const url = new URL(req.url)
    const status = url.searchParams.get('status') || undefined
    const q = url.searchParams.get('q') || undefined
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50') || 50, 1), 200)
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0') || 0, 0)

    const where: Record<string, unknown> = { kbId: id }
    if (status) where.status = status
    if (q) where.filename = { contains: q }

    const [docs, total] = await Promise.all([
      db.document.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      db.document.count({ where }),
    ])

    const docSummaries = await Promise.all(
      docs.map(async (d) => {
        const [chunkCount, enabledChunkCount] = await Promise.all([
          db.chunk.count({ where: { documentId: d.id, isParent: false } }),
          db.chunk.count({ where: { documentId: d.id, isParent: false, enabled: true } }),
        ])
        return toDocSummary(d, { chunkCount, enabledChunkCount })
      })
    )
    return NextResponse.json({ docs: docSummaries, total })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

/** POST /api/kb/[id]/documents（multipart：file + 可选 chunkConfig JSON 字符串） */
export async function POST(req: NextRequest, ctx: Ctx) {
  const tmpPath = path.join(ARTIFACTS_ROOT, '.upload-' + randomUUID() + '.part')
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const form = await req.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: '请求必须是 multipart/form-data' }, { status: 400 })
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少 file 字段' }, { status: 400 })
    }
    const filename = file.name || 'untitled'
    const ext = path.extname(filename).toLowerCase().replace('.', '')
    if (!SUPPORTED_EXTS.includes(ext)) {
      return NextResponse.json(
        { error: `不支持的文件类型 .${ext}（支持：${SUPPORTED_EXTS.join(' / ')}）` },
        { status: 400 }
      )
    }

    // 一次性覆盖配置（仅本次，契约 §2）：优先 form chunkConfig，其次 KB 默认
    let chunkConfigSnap = kb.chunkConfig
    const cfgRaw = form.get('chunkConfig')
    if (typeof cfgRaw === 'string' && cfgRaw.trim()) {
      try {
        chunkConfigSnap = JSON.stringify(parseChunkConfig(cfgRaw))
      } catch {
        return NextResponse.json({ error: 'chunkConfig 不是合法 JSON' }, { status: 400 })
      }
    }

    // 流式 sha256 + 落盘临时文件
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
          hash.update(value)
          if (!ws.write(value)) await once(ws, 'drain')
        }
      }
    } finally {
      ws.end()
      await once(ws, 'finish')
    }
    if (sizeBytes === 0) {
      return NextResponse.json({ error: '上传文件为空' }, { status: 400 })
    }
    const contentHash = hash.digest('hex')

    // 秒传判定：同 kb + hash + parseConfigV 直接返回已有文档
    const parseConfigV = 1
    const dup = await db.document.findFirst({
      where: { kbId: id, contentHash, parseConfigV },
    })
    if (dup) {
      await fs.rm(tmpPath, { force: true })
      const [chunkCount, enabledChunkCount] = await Promise.all([
        db.chunk.count({ where: { documentId: dup.id, isParent: false } }),
        db.chunk.count({ where: { documentId: dup.id, isParent: false, enabled: true } }),
      ])
      return NextResponse.json(
        { doc: toDocSummary(dup, { chunkCount, enabledChunkCount }), deduplicated: true },
        { status: 201 }
      )
    }

    // 建文档 + 移入产物目录
    const docId = randomUUID()
    await ensureDocDir(id, docId)
    await fs.rename(tmpPath, sourcePath(id, docId, ext))

    let doc: Document
    try {
      doc = await db.document.create({
        data: {
          id: docId,
          kbId: id,
          filename,
          mimeType: file.type || guessMime(ext),
          sizeBytes,
          contentHash,
          status: 'queued',
          stageProgress: 0,
          parseConfigV,
          chunkConfigSnap,
          storageKey: `${id}/${docId}/`,
        },
      })
    } catch (e: any) {
      // 并发同文件竞争唯一索引 → 秒传返回
      if (String(e?.code) === 'P2002') {
        const existing = await db.document.findFirst({
          where: { kbId: id, contentHash, parseConfigV },
        })
        if (existing) {
          await fs.rm(path.dirname(sourcePath(id, docId, ext)), { recursive: true, force: true })
          return NextResponse.json({ doc: toDocSummary(existing), deduplicated: true }, { status: 201 })
        }
      }
      throw e
    }

    // 入流水线（parse 起步）
    await enqueueDocument(doc.id, 'parse')

    return NextResponse.json(
      { doc: toDocSummary(doc, { chunkCount: 0, enabledChunkCount: 0 }), deduplicated: false },
      { status: 201 }
    )
  } catch (e: any) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}

function guessMime(ext: string): string {
  switch (ext) {
    case 'pdf':
      return 'application/pdf'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'md':
    case 'markdown':
      return 'text/markdown'
    case 'html':
    case 'htm':
      return 'text/html'
    case 'txt':
      return 'text/plain'
    default:
      return 'application/octet-stream'
  }
}
