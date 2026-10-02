import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sanitizeParams, toTestCaseItem } from '@/lib/rag/testset'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** PATCH /api/testcases/[id] body { name?; query?; expectDocIds?; expectChunkIds?; params?; enabled? } → { testCase } */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const existing = await db.retrievalTestCase.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: '测试用例不存在' }, { status: 404 })

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体必须是 JSON 对象' }, { status: 400 })
    }

    const data: Record<string, unknown> = {}

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return NextResponse.json({ error: '用例名称不能为空' }, { status: 400 })
      data.name = name
    }
    if (body.query !== undefined) {
      const query = typeof body.query === 'string' ? body.query.trim() : ''
      if (!query) return NextResponse.json({ error: '查询文本不能为空' }, { status: 400 })
      data.query = query
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return NextResponse.json({ error: 'enabled 必须是布尔值' }, { status: 400 })
      }
      data.enabled = body.enabled
    }
    if (body.expectDocIds !== undefined) {
      const rawDocIds: unknown[] = Array.isArray(body.expectDocIds) ? body.expectDocIds : []
      const expectDocIds: string[] = [
        ...new Set(rawDocIds.filter((x): x is string => typeof x === 'string' && x.length > 0)),
      ]
      if (expectDocIds.length === 0) {
        return NextResponse.json({ error: '期望命中文档不能为空（至少选择 1 个）' }, { status: 400 })
      }
      const owned = await db.document.findMany({
        where: { id: { in: expectDocIds }, kbId: existing.kbId },
        select: { id: true },
      })
      if (owned.length !== expectDocIds.length) {
        return NextResponse.json({ error: '期望文档中包含不属于该知识库的文档' }, { status: 400 })
      }
      data.expectDocIds = JSON.stringify(expectDocIds)
    }
    // chunk 级金标准（契约 §16）：可选更新；传 [] 清空（恢复文档级行为）
    if (body.expectChunkIds !== undefined) {
      if (!Array.isArray(body.expectChunkIds)) {
        return NextResponse.json({ error: 'expectChunkIds 必须是字符串数组' }, { status: 400 })
      }
      const rawChunkIds: unknown[] = Array.isArray(body.expectChunkIds) ? body.expectChunkIds : []
      const expectChunkIds: string[] = [
        ...new Set(rawChunkIds.filter((x): x is string => typeof x === 'string' && x.length > 0)),
      ]
      if (expectChunkIds.length > 0) {
        // 每项必须是该 KB 下存在的 chunk（跨库 / 已删除 → 400）
        const ownedChunks = await db.chunk.findMany({
          where: { id: { in: expectChunkIds }, kbId: existing.kbId },
          select: { id: true },
        })
        if (ownedChunks.length !== expectChunkIds.length) {
          return NextResponse.json({ error: '期望 chunk 中包含不存在或不属于该知识库的 chunk' }, { status: 400 })
        }
      }
      data.expectChunkIds = JSON.stringify(expectChunkIds)
    }
    if (body.params !== undefined) {
      data.paramsJson = JSON.stringify(sanitizeParams(body.params))
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: '没有需要更新的字段' }, { status: 400 })
    }

    const updated = await db.retrievalTestCase.update({ where: { id }, data })
    return NextResponse.json({ testCase: toTestCaseItem(updated) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

/** DELETE /api/testcases/[id] → { ok: true } */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params
    const existing = await db.retrievalTestCase.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: '测试用例不存在' }, { status: 404 })
    await db.retrievalTestCase.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
