import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { IngestError, ingestUploadFile } from '@/lib/rag/ingest'
import { toDocSummary } from '@/lib/rag/serialize'
import { ALL_ACCEPTED_EXTS } from '@/lib/rag/parsers/formats'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** 上传接受的全量类型（权威清单见 lib/rag/parsers/formats.ts） */
const SUPPORTED_EXTS: string[] = [...ALL_ACCEPTED_EXTS]

/** 单请求总上传量上限（Task 15-b / 审计 #2） */
const MAX_REQUEST_BYTES = 500 * 1024 * 1024

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 遍历 formData 全部文件做体积校验（单文件 200MB 在共享层校验；这里校验单请求总量），超限返 413 */
function checkRequestLimit(files: File[]): string | null {
  const total = files.reduce((acc, f) => acc + f.size, 0)
  if (total > MAX_REQUEST_BYTES) {
    return `单次请求总上传量 ${fmtMB(total)} 超过上限 ${fmtMB(MAX_REQUEST_BYTES)}`
  }
  return null
}

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

/**
 * POST /api/kb/[id]/documents（multipart：file + 可选 chunkConfig JSON 字符串 + engine）
 * 单文件语义；实现抽取至 lib/rag/ingest.ts（与 /api/input、/v1/datasets 三链路共用）。
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const form = await req.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: '请求必须是 multipart/form-data' }, { status: 400 })

    // ---- 单请求总量上限（单文件 200MB 由共享层 checkFile 校验） ----
    const allFiles: File[] = []
    for (const [, value] of form.entries()) {
      if (value instanceof File && value.size > 0) allFiles.push(value)
    }
    const limitError = checkRequestLimit(allFiles)
    if (limitError) {
      return NextResponse.json({ error: limitError }, { status: 413 })
    }

    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少 file 字段' }, { status: 400 })
    }

    // 一次性覆盖配置（仅本次，契约 §2）：优先 form chunkConfig，其次 KB 默认（共享层处理）
    let chunkConfig: Record<string, unknown> | undefined
    const cfgRaw = form.get('chunkConfig')
    if (typeof cfgRaw === 'string' && cfgRaw.trim()) {
      try {
        chunkConfig = JSON.parse(cfgRaw)
      } catch {
        return NextResponse.json({ error: 'chunkConfig 不是合法 JSON' }, { status: 400 })
      }
    }

    // 解析引擎选择（14-e）：'mineru' | 'node'，缺省跟随全局路由（共享层处理）
    const engineRaw = form.get('engine')
    let engine: 'mineru' | 'node' | undefined
    if (typeof engineRaw === 'string' && engineRaw.trim()) {
      const v = engineRaw.trim()
      if (v !== 'mineru' && v !== 'node') {
        return NextResponse.json({ error: `无效 engine: ${v}（可选 mineru / node）` }, { status: 400 })
      }
      engine = v
    }

    const r = await ingestUploadFile(kb, file, { chunkConfig, engine })
    const [chunkCount, enabledChunkCount] = r.deduplicated
      ? await Promise.all([
          db.chunk.count({ where: { documentId: r.doc.id, isParent: false } }),
          db.chunk.count({ where: { documentId: r.doc.id, isParent: false, enabled: true } }),
        ])
      : [0, 0]
    return NextResponse.json(
      { doc: toDocSummary(r.doc, { chunkCount, enabledChunkCount }), deduplicated: r.deduplicated },
      { status: 201 }
    )
  } catch (e: any) {
    if (e instanceof IngestError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
