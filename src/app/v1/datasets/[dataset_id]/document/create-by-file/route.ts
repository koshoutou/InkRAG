import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireDatasetKey, difyError, notFoundDataset } from '../../../../_guard'
import { toDifyDocument, docSegments, applyDifyProcessRule, recordDifyParams } from '../../../../_map'
import { ingestUploadFile, IngestError, INGEST_MAX_FILE_BYTES } from '@/lib/rag/ingest'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ dataset_id: string }> }

const MAX_REQUEST_BYTES = 500 * 1024 * 1024

/**
 * POST /v1/datasets/{dataset_id}/document/create-by-file（Dify 兼容 · Task 17-3）
 *
 * multipart：data（JSON：process_rule / indexing_technique / doc_form / doc_language）+ file。
 * MinerU 面板「导出到 Dify」即调本端点（高级配置 = process_rule：段落分隔符 + 每段最大 token 数）。
 *
 * 映射：process_rule.mode=custom + segmentation.max_tokens → chunkConfig.size（一次性切分覆盖，
 * clamp 64..8192）；separator/doc_form/doc_language/indexing_technique 记录到 metaJson.difyParams。
 * 入库走共享层 ingestUploadFile（流式 sha256 / 秒传 / P2002 竞争 / 入队）。
 * 响应：{ document, batch }（batch = 文档 id，供 indexing-status 轮询）。
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const g = await requireDatasetKey(req, { write: true })
  if (!g.ok) return g.response
  const { dataset_id } = await ctx.params
  const kb = await db.knowledgeBase.findUnique({ where: { id: dataset_id } })
  if (!kb) return notFoundDataset()
  try {
    const form = await req.formData().catch(() => null)
    if (!form) return difyError(400, 'no_file_uploaded', '请求必须是 multipart/form-data（含 data 与 file 字段）')

    // Dify：data 字段为 JSON 字符串（可选）
    let data: Record<string, unknown> = {}
    const dataRaw = form.get('data')
    if (typeof dataRaw === 'string' && dataRaw.trim()) {
      try {
        const v = JSON.parse(dataRaw)
        if (typeof v === 'object' && v) data = v as Record<string, unknown>
      } catch {
        return difyError(400, 'invalid_param', 'data 字段不是合法 JSON')
      }
    }

    // 文件字段（Dify 只允许单个 file）
    const files: File[] = []
    for (const [k, v] of form.entries()) {
      if ((k === 'file' || k === 'files') && v instanceof File && v.size > 0) files.push(v)
    }
    if (files.length === 0) return difyError(400, 'no_file_uploaded', 'Please upload a file.')
    if (files.length > 1) return difyError(400, 'too_many_files', 'Only one file can be uploaded.')
    const file = files[0]
    if (file.size > INGEST_MAX_FILE_BYTES) {
      return difyError(413, 'file_too_large', `文件体积超过上限 ${Math.round(INGEST_MAX_FILE_BYTES / 1024 / 1024)}MB`)
    }
    if (file.size > MAX_REQUEST_BYTES) {
      return difyError(413, 'file_too_large', '请求体积超过上限')
    }

    // process_rule → 一次性 chunkConfig（max_tokens→size clamp 64..8192）
    const { chunkConfig, ruleInfo } = applyDifyProcessRule(data)
    const docForm = typeof data.doc_form === 'string' ? data.doc_form : undefined
    const docLang = typeof data.doc_language === 'string' ? data.doc_language : undefined
    const idxTech = typeof data.indexing_technique === 'string' ? data.indexing_technique : undefined

    const r = await ingestUploadFile(kb, file, chunkConfig ? { chunkConfig } : undefined)
    void recordDifyParams(r.doc.id, {
      source: 'dify-compat',
      process_rule: ruleInfo,
      ...(docForm ? { doc_form: docForm } : {}),
      ...(docLang ? { doc_language: docLang } : {}),
      ...(idxTech ? { indexing_technique: idxTech } : {}),
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
