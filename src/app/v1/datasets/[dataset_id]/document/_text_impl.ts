/**
 * create-by-text / create_by_text 共享实现（Dify 兼容）
 * Dify 同时暴露连字符与下划线两个路径（后者为废弃别名）；两路由共用本实现。
 */
import { NextRequest, NextResponse } from 'next/server'
import type { KnowledgeBase } from '@prisma/client'
import { difyError } from '../../../_guard'
import { toDifyDocument, docSegments, applyDifyProcessRule, recordDifyParams } from '../../../_map'
import { ingestTextContent, IngestError } from '@/lib/rag/ingest'

export async function handleCreateByText(req: NextRequest, kb: KnowledgeBase): Promise<NextResponse> {
  try {
    const body = await req.json().catch(() => ({}))
    const name = String(body.name ?? '').trim()
    if (!name) return difyError(400, 'invalid_param', 'name is required')
    if (name.length > 200) return difyError(400, 'invalid_param', 'name must be at most 200 characters')
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return difyError(400, 'invalid_param', 'text is required')
    }

    const { chunkConfig, ruleInfo } = applyDifyProcessRule(body as Record<string, unknown>)
    const r = await ingestTextContent(kb, name, body.text, chunkConfig ? { chunkConfig } : undefined)
    void recordDifyParams(r.doc.id, {
      source: 'dify-compat',
      process_rule: ruleInfo,
      ...(typeof body.doc_form === 'string' ? { doc_form: body.doc_form } : {}),
      ...(typeof body.doc_language === 'string' ? { doc_language: body.doc_language } : {}),
      ...(typeof body.indexing_technique === 'string' ? { indexing_technique: body.indexing_technique } : {}),
    })

    return NextResponse.json({
      document: toDifyDocument(r.doc, { position: 1, segments: r.deduplicated ? await docSegments(r.doc.id) : { total: 0, enabled: 0 } }),
      batch: r.doc.id,
    })
  } catch (e: any) {
    if (e instanceof IngestError) {
      const code = e.status === 413 ? 'file_too_large' : e.status === 400 ? 'invalid_param' : 'internal_error'
      return difyError(e.status, code, e.message)
    }
    return difyError(500, 'internal_error', e?.message ?? String(e))
  }
}
