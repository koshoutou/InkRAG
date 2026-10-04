/**
 * POST /api/input/knowledge-bases/[id]/documents（契约 §33）
 *
 * multipart/form-data：
 *   - file：单个文件；files：多个文件（form.getAll，两者可并存，至少一个）
 *   - chunkConfig（可选，JSON 字符串）：一次性覆盖 KB 默认切分配置（仅本次入库生效）
 *   - engine（可选）：'mineru' | 'node'，缺省跟随全局智能路由
 *
 * 多文件用 Promise.allSettled 并发，单文件失败不影响其余文件：
 *   → 201 { docs: DocSummary[], deduplicated: DocSummary[], failures: [{filename, error}] }
 * 单文件请求额外兼容顶层字段 { doc, deduplicated: boolean }。
 * 单请求总量上限 500MB（413）；单文件 200MB / 扩展名白名单由共享层校验（IngestError.status）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireApiKey } from '../../../_guard'
import { IngestError, ingestUploadFile, type IngestOptions } from '@/lib/rag/ingest'
import { toDocSummary } from '@/lib/rag/serialize'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** 单请求总上传量上限（与 /api/kb/[id]/documents 同口径，Task 15-b 审计 #2） */
const MAX_REQUEST_BYTES = 500 * 1024 * 1024

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 带上 chunk 计数的 DocSummary（秒传命中时已有 chunk，新入队文档为 0） */
async function toSummaryWithCounts(docId: string, deduplicated: boolean) {
  const d = await db.document.findUnique({ where: { id: docId } })
  if (!d) return null
  const [chunkCount, enabledChunkCount] = deduplicated
    ? await Promise.all([
        db.chunk.count({ where: { documentId: d.id, isParent: false } }),
        db.chunk.count({ where: { documentId: d.id, isParent: false, enabled: true } }),
      ])
    : [0, 0]
  return toDocSummary(d, { chunkCount, enabledChunkCount })
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiKey(req, { write: true })
  if ('response' in guard) return guard.response
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const form = await req.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: '请求必须是 multipart/form-data' }, { status: 400 })

    // ---- 收集文件：file（单个）+ files（多个，getAll） ----
    const single = form.get('file')
    const multi = form.getAll('files')
    const files: File[] = []
    if (single instanceof File && single.size > 0) files.push(single)
    for (const f of multi) {
      if (f instanceof File && f.size > 0) files.push(f)
    }
    if (files.length === 0) {
      return NextResponse.json({ error: '缺少 file / files 字段（至少上传一个文件）' }, { status: 400 })
    }

    // ---- 单请求总量上限（单文件 200MB 由共享层 checkFile 校验） ----
    const allFormFiles: File[] = []
    for (const [, value] of form.entries()) {
      if (value instanceof File && value.size > 0) allFormFiles.push(value)
    }
    const total = allFormFiles.reduce((acc, f) => acc + f.size, 0)
    if (total > MAX_REQUEST_BYTES) {
      return NextResponse.json(
        { error: `单次请求总上传量 ${fmtMB(total)} 超过上限 ${fmtMB(MAX_REQUEST_BYTES)}` },
        { status: 413 },
      )
    }

    // ---- 可选参数 ----
    let chunkConfig: Record<string, unknown> | undefined
    const cfgRaw = form.get('chunkConfig')
    if (typeof cfgRaw === 'string' && cfgRaw.trim()) {
      try {
        chunkConfig = JSON.parse(cfgRaw)
      } catch {
        return NextResponse.json({ error: 'chunkConfig 不是合法 JSON' }, { status: 400 })
      }
    }
    let engine: 'mineru' | 'node' | undefined
    const engineRaw = form.get('engine')
    if (typeof engineRaw === 'string' && engineRaw.trim()) {
      const v = engineRaw.trim()
      if (v !== 'mineru' && v !== 'node') {
        return NextResponse.json({ error: `无效 engine: ${v}（可选 mineru / node）` }, { status: 400 })
      }
      engine = v
    }
    const opts: IngestOptions | undefined = chunkConfig || engine ? { chunkConfig, engine } : undefined

    // ---- 并发入库（allSettled：单文件失败不影响其余） ----
    const settled = await Promise.allSettled(files.map((f) => ingestUploadFile(kb, f, opts)))

    // docs = 全部入库成功（含秒传命中）；deduplicated = 其中秒传命中的子集；failures = 逐文件失败明细
    const okDocIds: string[] = []
    const dedupDocIds: string[] = []
    const failures: { filename: string; error: string }[] = []

    settled.forEach((r, i) => {
      const filename = files[i].name || 'untitled'
      if (r.status === 'fulfilled') {
        okDocIds.push(r.value.doc.id)
        if (r.value.deduplicated) dedupDocIds.push(r.value.doc.id)
      } else {
        const reason = r.reason
        failures.push({
          filename,
          error: reason instanceof Error ? reason.message : String(reason),
        })
      }
    })

    const [docsOut, dedupOut] = await Promise.all([
      Promise.all(okDocIds.map((docId) => toSummaryWithCounts(docId, dedupDocIds.includes(docId)))),
      Promise.all(dedupDocIds.map((docId) => toSummaryWithCounts(docId, true))),
    ])

    const response: Record<string, unknown> = {
      docs: docsOut.filter(Boolean),
      deduplicated: dedupOut.filter(Boolean),
      failures,
    }
    // 单文件兼容：顶层 doc / deduplicated 布尔
    if (files.length === 1 && okDocIds.length === 1) {
      response.doc = docsOut[0]
      response.deduplicated = dedupDocIds.length === 1
    }

    return NextResponse.json(response, { status: 201 })
  } catch (e: any) {
    if (e instanceof IngestError) {
      // F-CONC-05：429 背压时附带 Retry-After（秒）
      const res = NextResponse.json({ error: e.message }, { status: e.status })
      if (e.status === 429 && e.retryAfterSec) res.headers.set('Retry-After', String(e.retryAfterSec))
      return res
    }
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
