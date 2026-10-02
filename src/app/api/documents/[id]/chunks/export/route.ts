import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { chunksDir } from '@/lib/rag/artifacts'
import { toChunkItem } from '@/lib/rag/serialize'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** docType 徽标文本（与前端 DOC_TYPE_META.label 对齐） */
const DOC_TYPE_LABEL: Record<string, string> = {
  text: '文本',
  table: '表格',
  code: '代码',
  image: '图片',
}

/** CSV 字段转义：双引号包裹、内部引号翻倍、换行保留 */
function csvEscape(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

/** Content-Disposition：ASCII fallback + RFC 5987 UTF-8（兼容中文文件名） */
function disposition(name: string): string {
  const encoded = encodeURIComponent(name)
  return `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`
}

/**
 * GET /api/documents/[id]/chunks/export?format=json|csv|md&includeParents=0|1  （契约 §13）
 * - json：{ doc, exportedAt, chunks: [...toChunkItem, text] }
 * - csv：UTF-8 BOM + 表头 seq,isParent,docType,tokenCount,pageFrom,pageTo,enabled,editedAt,text
 * - md：按 seq 重组，每 chunk 一节 `## [chunk {seq}] {docType 徽标文本}`（父块标注）
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const doc = await db.document.findUnique({ where: { id } })
    if (!doc) return NextResponse.json({ error: '文档不存在' }, { status: 404 })

    const url = new URL(req.url)
    const format = url.searchParams.get('format') ?? 'json'
    if (!['json', 'csv', 'md'].includes(format)) {
      return NextResponse.json({ error: 'format 必须为 json | csv | md' }, { status: 400 })
    }
    const includeParents = url.searchParams.get('includeParents') === '1'

    // 全量 chunk（isParent 过滤按 includeParents；按 seq 升序）+ 逐条读全文
    const where: { documentId: string; isParent?: boolean } = { documentId: id }
    if (!includeParents) where.isParent = false
    const rows = await db.chunk.findMany({ where, orderBy: { seq: 'asc' } })

    const dir = chunksDir(doc.kbId, doc.id)
    const loaded = await Promise.all(
      rows.map(async (row) => {
        let text = ''
        try {
          text = await fs.readFile(path.join(dir, `${row.id}.txt`), 'utf-8')
        } catch {
          text = row.textPreview // 产物缺失时回退 preview
        }
        return { row, text }
      }),
    )

    const childCount = includeParents
      ? await db.chunk.count({ where: { documentId: id, isParent: false } })
      : loaded.length
    const baseName =
      doc.filename
        .replace(/\.[^.]+$/, '')
        .replace(/[\r\n"\\]/g, '')
        .trim() || 'chunks'

    // ---- JSON ----
    if (format === 'json') {
      const payload = {
        doc: {
          id: doc.id,
          filename: doc.filename,
          kbId: doc.kbId,
          chunkCount: childCount,
        },
        exportedAt: new Date().toISOString(),
        chunks: loaded.map(({ row, text }) => ({ ...toChunkItem(row), text })),
      }
      return new NextResponse(JSON.stringify(payload, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': disposition(`${baseName}-chunks.json`),
        },
      })
    }

    // ---- CSV ----
    if (format === 'csv') {
      const header = 'seq,isParent,docType,tokenCount,pageFrom,pageTo,enabled,editedAt,text'
      const lines = loaded.map(({ row, text }) =>
        [
          String(row.seq),
          String(row.isParent),
          row.docType,
          String(row.tokenCount),
          String(row.pageFrom),
          String(row.pageTo),
          String(row.enabled),
          row.editedAt ? row.editedAt.toISOString() : '',
          csvEscape(text),
        ].join(','),
      )
      // UTF-8 BOM 开头，Excel 打开中文不乱码
      const csv = '\uFEFF' + [header, ...lines].join('\n') + '\n'
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': disposition(`${baseName}-chunks.csv`),
        },
      })
    }

    // ---- Markdown ----
    const sections = loaded.map(({ row, text }) => {
      const label = DOC_TYPE_LABEL[row.docType] ?? row.docType
      const parentTag = row.isParent ? '父块 · ' : ''
      const meta: string[] = [`${row.tokenCount} tok`]
      meta.push(row.pageTo > row.pageFrom ? `P${row.pageFrom}-${row.pageTo}` : `P${row.pageFrom}`)
      if (row.editedAt) meta.push('已人工编辑')
      return `## [chunk ${row.seq}] ${parentTag}${label}\n\n${text}\n`
    })
    const md =
      [
        `# ${doc.filename} · chunk 导出`,
        '',
        `> 共 ${loaded.length} 个 chunk（${includeParents ? '含父块' : '仅子块'}）· 导出于 ${new Date().toLocaleString('zh-CN')}`,
        '',
        ...sections,
      ].join('\n')
    return new NextResponse(md, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': disposition(`${baseName}-chunks.md`),
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
