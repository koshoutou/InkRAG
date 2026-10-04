/**
 * chunk 编辑后重新入库（M6 T6.6）
 *
 * 编辑链路（与流水线 execEmbed 同构，单 chunk 粒度）：
 *   备份原文 chunks/{id}.orig.txt（仅首次）→ 写入新全文 chunks/{id}.txt
 *   → 更新 DB（textPreview / tokenCount / editedAt）
 *   → 重新嵌入（embedTexts 单文本）
 *   → 以同一 chunk ID upsert 向量点（§6.4 payload 契约，向量原地更新）
 *   → 广播 chunk:update 事件（doc + kb 房间）+ pipeline:activity（global）
 *
 * 还原链路：从 .orig.txt 恢复 → 同上重嵌入（editedAt 置 null）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { chunksDir, resolveStorageKey } from './artifacts'
import { embedTexts } from './embed'
import { getRagSettings } from './settings'
import { getVectorStore, type PointInput } from './vectorstore'
import { countTokens } from './chunking'
import { emitToRoom } from './events'
import { spliceDocMarkdown } from './docpatch'

/** §6.4：parent_text ≤ 2000 token 才入 payload */
const PARENT_TEXT_MAX_TOKENS = 2000

/** 编辑全文上限（防御性，超大文本说明调用方搞错了对象） */
const EDIT_TEXT_MAX_CHARS = 200_000

type ChunkRow = Awaited<ReturnType<typeof db.chunk.findUnique>> & object
type KbRow = Awaited<ReturnType<typeof db.knowledgeBase.findUnique>> & object
type DocRow = Awaited<ReturnType<typeof db.document.findUnique>> & object

/** 读取 chunk 全文（优先磁盘，回退 textPreview） */
async function readFullText(storageKey: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(resolveStorageKey(storageKey), 'utf-8')
  } catch {
    return fallback
  }
}

/** §6.4 payload 构造（与 pipeline execEmbed 保持一致） */
async function buildChunkPoint(
  kb: KbRow,
  doc: DocRow,
  chunk: ChunkRow,
  newText: string,
  dense: number[],
  sparse: import('./vectorstore').SparseVector
): Promise<PointInput> {
  let parentText: string | undefined
  if (chunk.parentId) {
    const parent = await db.chunk.findUnique({ where: { id: chunk.parentId } })
    if (parent) {
      const full = await readFullText(parent.storageKey, parent.textPreview)
      if (full && countTokens(full) <= PARENT_TEXT_MAX_TOKENS) parentText = full
    }
  }
  const payload: Record<string, unknown> = {
    kb_id: kb.id,
    doc_id: doc.id,
    parent_id: chunk.parentId,
    page: chunk.pageFrom,
    page_from: chunk.pageFrom,
    page_to: chunk.pageTo,
    bbox_from: JSON.parse(chunk.bboxFrom || '[]') as number[],
    bbox_to: JSON.parse(chunk.bboxTo || '[]') as number[],
    seq: chunk.seq,
    token_count: countTokens(newText),
    text_preview: newText.slice(0, 200),
    doc_type: chunk.docType,
    enabled: chunk.enabled,
    created_at: Date.now(),
    ...(parentText ? { parent_text: parentText } : {}),
  }
  return { id: chunk.id, dense, sparse, payload }
}

export interface EditChunkResult {
  chunkId: string
  oldTokens: number
  newTokens: number
  embedMode: string
  tookMs: number
  /** 16-d：文档产物（full.md/middle.json）同步修补结果 */
  docPatch?: { patched: boolean; note: string }
}

/**
 * 编辑 chunk 全文并重新入库。
 * - 原文备份在 chunks/{id}.orig.txt（仅首次编辑时创建）
 * - 向量点以同 ID 原地更新（dense + sparse + payload）
 */
export async function editChunkText(
  kb: KbRow,
  doc: DocRow,
  chunk: ChunkRow,
  newText: string
): Promise<EditChunkResult> {
  const started = Date.now()
  const trimmed = newText.trim()
  if (trimmed.length === 0) throw new Error('编辑后文本不能为空')
  if (newText.length > EDIT_TEXT_MAX_CHARS) {
    throw new Error(`编辑文本超限（${newText.length} > ${EDIT_TEXT_MAX_CHARS} 字符）`)
  }

  const dir = chunksDir(doc.kbId, doc.id)
  const full = path.join(dir, `${chunk.id}.txt`)
  const orig = path.join(dir, `${chunk.id}.orig.txt`)

  // 1) 备份原文（仅首次编辑）
  try {
    await fs.access(orig)
  } catch {
    await fs.copyFile(full, orig).catch(() => {})
  }

  // 1.5)【16-d】同步修补文档产物：full.md 区间替换 + 后续 chunk 偏移平移 +
  //      父 chunk 重切片 + middle.json 重对齐 —— 下次重新入库/重切时不再回到旧文本。
  //      顺序：先修补产物（需要旧全文定位），再写 chunk 新文本。
  const oldText = await readFullText(chunk.storageKey, chunk.textPreview)
  const docPatch = await spliceDocMarkdown({
    kbId: doc.kbId,
    docId: doc.id,
    currentText: oldText,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    replacement: newText,
  })

  // 2) 写入新全文
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(full, newText, 'utf-8')

  // 3) 更新 DB 行（16-d：charEnd 随新文本长度同步，保持 full.md 偏移契约）
  const oldTokens = chunk.tokenCount
  const updated = await db.chunk.update({
    where: { id: chunk.id },
    data: {
      textPreview: newText.replace(/\s+/g, ' ').trim().slice(0, 500),
      tokenCount: countTokens(newText),
      charEnd: chunk.charStart + newText.length,
      editedAt: new Date(),
    },
  })

  // 4) 重嵌入 + 原地 upsert
  const dim = kb.dim || 1024
  const emb = await embedTexts([newText], { dim })
  const point = await buildChunkPoint(kb, doc, updated, newText, emb.vectors[0], emb.sparse[0])
  const store = await getVectorStore()
  const hnswM = (await getRagSettings()).row.qdrantHnswM ?? 0
  await store.ensureCollection(kb.collection, dim, { hnswM: hnswM })
  await store.upsertPoints(kb.collection, [point])

  const tookMs = Date.now() - started
  // 5) 事件：chunk:update（doc + kb 房间）+ pipeline:activity（global）
  void emitToRoom(`doc:${doc.id}`, 'chunk:update', {
    chunkId: chunk.id,
    docId: doc.id,
    kbId: kb.id,
    action: 'edit',
    tokenCount: updated.tokenCount,
  })
  void emitToRoom(`kb:${kb.id}`, 'chunk:update', {
    chunkId: chunk.id,
    docId: doc.id,
    kbId: kb.id,
    action: 'edit',
    tokenCount: updated.tokenCount,
  })
  void emitToRoom('global', 'pipeline:activity', {
    at: new Date().toISOString(),
    level: 'info',
    message: `chunk 编辑重入库 · ${doc.filename} · seq=${chunk.seq} · ${oldTokens}→${updated.tokenCount} tok · ${tookMs}ms${docPatch.patched ? ' · 文档产物已同步' : ' · ⚠ 产物同步失败：' + docPatch.note}`,
  })

  return {
    chunkId: chunk.id,
    oldTokens,
    newTokens: updated.tokenCount,
    embedMode: emb.provider,
    tookMs,
    docPatch: { patched: docPatch.patched, note: docPatch.note },
  }
}

/**
 * 还原 chunk 原文（从 .orig.txt）并重新入库。
 * 若无备份（从未编辑过）则报错。
 */
export async function revertChunkText(
  kb: KbRow,
  doc: DocRow,
  chunk: ChunkRow
): Promise<EditChunkResult> {
  const orig = path.join(chunksDir(doc.kbId, doc.id), `${chunk.id}.orig.txt`)
  let originalText: string
  try {
    originalText = await fs.readFile(orig, 'utf-8')
  } catch {
    throw new Error('原文备份不存在（该 chunk 从未编辑过）')
  }

  const started = Date.now()
  const full = path.join(chunksDir(doc.kbId, doc.id), `${chunk.id}.txt`)

  //【16-d】还原同样同步修补文档产物（当前编辑态全文 → 原文）
  const currentText = await readFullText(chunk.storageKey, chunk.textPreview)
  const docPatch = await spliceDocMarkdown({
    kbId: doc.kbId,
    docId: doc.id,
    currentText,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    replacement: originalText,
  })

  await fs.writeFile(full, originalText, 'utf-8')

  const oldTokens = chunk.tokenCount
  const updated = await db.chunk.update({
    where: { id: chunk.id },
    data: {
      textPreview: originalText.replace(/\s+/g, ' ').trim().slice(0, 500),
      tokenCount: countTokens(originalText),
      charEnd: chunk.charStart + originalText.length,
      editedAt: null,
    },
  })

  const dim = kb.dim || 1024
  const emb = await embedTexts([originalText], { dim })
  const point = await buildChunkPoint(kb, doc, updated, originalText, emb.vectors[0], emb.sparse[0])
  const store = await getVectorStore()
  const hnswM = (await getRagSettings()).row.qdrantHnswM ?? 0
  await store.ensureCollection(kb.collection, dim, { hnswM: hnswM })
  await store.upsertPoints(kb.collection, [point])

  const tookMs = Date.now() - started
  void emitToRoom(`doc:${doc.id}`, 'chunk:update', {
    chunkId: chunk.id,
    docId: doc.id,
    kbId: kb.id,
    action: 'revert',
    tokenCount: updated.tokenCount,
  })
  void emitToRoom(`kb:${kb.id}`, 'chunk:update', {
    chunkId: chunk.id,
    docId: doc.id,
    kbId: kb.id,
    action: 'revert',
    tokenCount: updated.tokenCount,
  })
  void emitToRoom('global', 'pipeline:activity', {
    at: new Date().toISOString(),
    level: 'info',
    message: `chunk 还原重入库 · ${doc.filename} · seq=${chunk.seq} · ${updated.tokenCount} tok · ${tookMs}ms${docPatch.patched ? ' · 文档产物已同步' : ' · ⚠ 产物同步失败：' + docPatch.note}`,
  })

  return {
    chunkId: chunk.id,
    oldTokens,
    newTokens: updated.tokenCount,
    embedMode: emb.provider,
    tookMs,
    docPatch: { patched: docPatch.patched, note: docPatch.note },
  }
}
