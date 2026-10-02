import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toDocSummary } from '@/lib/rag/serialize'
import { computeStale, getKbChunkMaxAt, sanitizeParams, toTestCaseItem } from '@/lib/rag/testset'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/kb/[id]/testcases → { cases, docs }（docs 供前端选择期望文档；cases 携带 §18 stale） */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    // KB 级 chunk 最新变更时间单次 aggregate（避免 N+1），逐用例与 lastRun.ranAt 比较出 stale
    const [cases, docs, chunkMaxAt] = await Promise.all([
      db.retrievalTestCase.findMany({ where: { kbId: id }, orderBy: { createdAt: 'asc' } }),
      db.document.findMany({ where: { kbId: id }, orderBy: { createdAt: 'desc' } }),
      getKbChunkMaxAt(id),
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

    return NextResponse.json({
      cases: cases.map((c) => toTestCaseItem(c, computeStale(chunkMaxAt, c.lastRunJson))),
      docs: docSummaries,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

/** POST /api/kb/[id]/testcases body { name, query, expectDocIds, expectChunkIds?, params? } → 201 { testCase } */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const kb = await db.knowledgeBase.findUnique({ where: { id } })
    if (!kb) return NextResponse.json({ error: '知识库不存在' }, { status: 404 })

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体必须是 JSON 对象' }, { status: 400 })
    }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!name) return NextResponse.json({ error: '用例名称不能为空' }, { status: 400 })
    if (!query) return NextResponse.json({ error: '查询文本不能为空' }, { status: 400 })

    const rawDocIds: unknown[] = Array.isArray(body.expectDocIds) ? body.expectDocIds : []
    const expectDocIds: string[] = [
      ...new Set(rawDocIds.filter((x): x is string => typeof x === 'string' && x.length > 0)),
    ]
    if (expectDocIds.length === 0) {
      return NextResponse.json({ error: '期望命中文档不能为空（至少选择 1 个）' }, { status: 400 })
    }

    // 期望文档必须属于该知识库
    const owned = await db.document.findMany({
      where: { id: { in: expectDocIds }, kbId: id },
      select: { id: true },
    })
    if (owned.length !== expectDocIds.length) {
      return NextResponse.json({ error: '期望文档中包含不属于该知识库的文档' }, { status: 400 })
    }

    // chunk 级金标准（契约 §16）：可选；每项必须是该 KB 下存在的 chunk
    const rawChunkIds: unknown[] = Array.isArray(body.expectChunkIds) ? body.expectChunkIds : []
    const expectChunkIds: string[] = [
      ...new Set(rawChunkIds.filter((x): x is string => typeof x === 'string' && x.length > 0)),
    ]
    if (expectChunkIds.length > 0) {
      const ownedChunks = await db.chunk.findMany({
        where: { id: { in: expectChunkIds }, kbId: id },
        select: { id: true },
      })
      if (ownedChunks.length !== expectChunkIds.length) {
        return NextResponse.json({ error: '期望 chunk 中包含不存在或不属于该知识库的 chunk' }, { status: 400 })
      }
    }

    const created = await db.retrievalTestCase.create({
      data: {
        kbId: id,
        name,
        query,
        expectDocIds: JSON.stringify(expectDocIds),
        expectChunkIds: JSON.stringify(expectChunkIds),
        paramsJson: JSON.stringify(sanitizeParams(body.params)),
        lastRunJson: '{}',
        enabled: true,
      },
    })

    return NextResponse.json({ testCase: toTestCaseItem(created) }, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
