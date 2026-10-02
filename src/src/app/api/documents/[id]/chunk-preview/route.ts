import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import { db } from '@/lib/db'
import { markdownPath, middleJsonPath } from '@/lib/rag/artifacts'
import { DEFAULT_CHUNK_CONFIG, splitMarkdown, type ChunkConfig } from '@/lib/rag/chunking'
import { deterministicChunkId, textHash16 } from '@/lib/rag/ids'
import { parseChunkConfig } from '@/lib/rag/serialize'
import type { ChunkItem, MiddleJson } from '@/lib/rag/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/documents/[id]/chunk-preview
 * Body: { chunkConfig } —— 只读缓存产物（full.md + middle.json）重切预览，
 * 零外部调用、零落库（沙盒 500ms 要求：纯函数 + 缓存产物天然满足）。
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const config: ChunkConfig = body.chunkConfig
      ? parseChunkConfig(JSON.stringify(body.chunkConfig))
      : { ...DEFAULT_CHUNK_CONFIG }

    const started = Date.now()
    let md: string
    let middle: MiddleJson
    try {
      md = await fs.readFile(markdownPath(doc.kbId, doc.id), 'utf-8')
      middle = JSON.parse(await fs.readFile(middleJsonPath(doc.kbId, doc.id), 'utf-8'))
    } catch {
      return NextResponse.json(
        { error: '解析产物不存在，请先完成文档解析' },
        { status: 409 }
      )
    }

    const result = splitMarkdown(md, config, middle.blocks ?? [])

    const toPreviewItem = (
      seq: number,
      text: string,
      isParent: boolean,
      parentSeq: number | null,
      extra: Partial<ChunkItem>
    ): ChunkItem => ({
      id: deterministicChunkId(doc.kbId, doc.id, seq, textHash16(text)),
      documentId: doc.id,
      isParent,
      parentId:
        !isParent && parentSeq !== null
          ? deterministicChunkId(
              doc.kbId,
              doc.id,
              parentSeq,
              textHash16(result.parents.find((p) => p.seq === parentSeq)?.text ?? '')
            )
          : null,
      seq,
      docType: 'text',
      tokenCount: 0,
      charStart: 0,
      charEnd: 0,
      pageFrom: 0,
      pageTo: 0,
      bboxFrom: [],
      bboxTo: [],
      textPreview: text.slice(0, 500),
      enabled: true,
      ...extra,
    })

    const parents: ChunkItem[] = result.parents.map((p) =>
      toPreviewItem(p.seq, p.text, true, null, {
        tokenCount: p.tokenCount,
        charStart: p.charStart,
        charEnd: p.charEnd,
        textPreview: p.text.slice(0, 500),
      })
    )
    const chunks: ChunkItem[] = result.children.map((c) =>
      toPreviewItem(c.seq, c.text, false, c.parentSeq, {
        docType: c.docType,
        tokenCount: c.tokenCount,
        charStart: c.charStart,
        charEnd: c.charEnd,
        pageFrom: c.pageFrom,
        pageTo: c.pageTo,
        bboxFrom: c.bboxFrom ?? [],
        bboxTo: c.bboxTo ?? [],
        textPreview: c.text.slice(0, 500),
      })
    )

    return NextResponse.json({
      preview: {
        chunks,
        parents,
        stats: {
          ...result.stats,
          tookMs: Date.now() - started,
        },
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
