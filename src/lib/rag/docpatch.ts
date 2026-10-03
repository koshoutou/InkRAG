/**
 * 文档产物同步修补（Task 16-d）
 *
 * 背景：chunk 编辑 / 还原 / 删除此前只改 chunk 行、chunk 文件与向量点，full.md 与
 * middle.json 保持原文 → 下次「重新入库 / 重新切分」按 full.md 重切时编辑全部丢失
 * （回到旧文本），与「所见即所得」预期不符。
 *
 * 方案：child chunk 的 charStart / charEnd 是 full.md 的 code-unit 偏移（chunking.ts
 * 契约，绝对偏移），对 full.md 做一次 splice 并保持全链一致：
 *   1) 替换 / 删除区间文本（删除时吞掉紧邻的分隔换行，避免残留连续空行）
 *   2) 平移 DB 中位于编辑点之后的 chunk 偏移（delta = 新文本长 - 旧区间长）
 *   3) 重新切片全部父 chunk（父覆盖编辑区间，文本随 full.md 变化；行/文件同步刷新）
 *   4) middle.json 块偏移重对齐（按块文本前缀顺序 indexOf，与 normalizeMiddleJson 同法）
 *
 * 防御：若 chunk 偏移与 full.md 当前内容不匹配（历史脏数据），退化为「按旧全文定位」，
 * 定位失败则跳过产物修补（chunk 编辑本身照常生效，标记 degraded）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { markdownPath, middleJsonPath, chunksDir } from './artifacts'
import { countTokens } from './chunking'
import type { MiddleJson } from './types'

export interface SpliceDocResult {
  /** 是否成功修补了 full.md（false = 偏移失配且定位失败，仅 chunk 层生效） */
  patched: boolean
  /** 修补导致的长度变化（patched=false 时为 0） */
  delta: number
  /** 修补细节（观测/日志） */
  note: string
}

/** middle.json 块偏移重对齐（顺序 indexOf；块顺序 = 文档顺序，与 normalizeMiddleJson 同法） */
export function realignMiddleBlocks(middle: MiddleJson, markdown: string): MiddleJson {
  if (!Array.isArray(middle?.blocks)) return middle
  let cursor = 0
  const blocks = middle.blocks.map((b) => {
    const prefix = (b.text ?? '').slice(0, 60)
    if (!prefix) return b
    const found = markdown.indexOf(prefix, cursor)
    if (found >= 0) {
      cursor = found + (b.text ?? '').length
      return { ...b, charStart: found, charEnd: found + (b.text ?? '').length }
    }
    return b
  })
  return { pages: middle.pages, blocks }
}

/** 读取文档 middle.json（缺失/损坏返回空结构） */
export async function readMiddleJson(kbId: string, docId: string): Promise<MiddleJson> {
  try {
    return JSON.parse(await fs.readFile(middleJsonPath(kbId, docId), 'utf-8')) as MiddleJson
  } catch {
    return { pages: [], blocks: [] }
  }
}

/**
 * 对 full.md 应用一次区间替换/删除，并同步：后续 chunk 偏移平移、父 chunk 重切片、
 * middle.json 重对齐。调用方负责：被编辑 chunk 自身的行更新与文件写入、向量更新。
 */
export async function spliceDocMarkdown(input: {
  kbId: string
  docId: string
  /** 被编辑 chunk 的当前全文（用于校验/定位区间；删除场景为被删 chunk 全文） */
  currentText: string
  charStart: number
  charEnd: number
  /** 替换文本；null = 删除区间 */
  replacement: string | null
}): Promise<SpliceDocResult> {
  const { kbId, docId, currentText, replacement } = input
  const mdPath = markdownPath(kbId, docId)
  let md: string
  try {
    md = await fs.readFile(mdPath, 'utf-8')
  } catch {
    return { patched: false, delta: 0, note: 'full.md 不存在（文档产物可能已被清理），跳过修补' }
  }

  // ---- 区间定位（偏移失配时按旧全文回退定位） ----
  let start = input.charStart
  let end = input.charEnd
  const valid = start >= 0 && end > start && end <= md.length && md.slice(start, end) === currentText
  if (!valid) {
    const found = md.indexOf(currentText)
    if (found < 0) {
      return {
        patched: false,
        delta: 0,
        note: `偏移失配且全文定位失败（offset ${start}-${end}，md ${md.length} 字符），仅 chunk 层生效`,
      }
    }
    start = found
    end = found + currentText.length
  }

  // ---- 删除场景：吞掉区间后紧邻的分隔换行（最多 2 个，避免残留连续空行） ----
  if (replacement === null) {
    let consumed = 0
    while (end < md.length && md[end] === '\n' && consumed < 2) {
      end++
      consumed++
    }
    // 区间在文档末尾且前面留了双换行 → 回吞前导换行
    if (end >= md.length) {
      while (start > 0 && md[start - 1] === '\n' && consumed < 2) {
        start--
        consumed++
      }
    }
  }

  const removal = end - start
  const delta = (replacement?.length ?? 0) - removal
  const patched = md.slice(0, start) + (replacement ?? '') + md.slice(end)
  await fs.writeFile(mdPath, patched, 'utf-8')

  // ---- 1) 后续 chunk 偏移平移（完全位于编辑点后：整体平移） ----
  if (delta !== 0) {
    await db.chunk.updateMany({
      where: { documentId: docId, charStart: { gte: end } },
      data: { charStart: { increment: delta }, charEnd: { increment: delta } },
    })
    // 跨越编辑区间的块（父 chunk 覆盖被编辑子块）：仅 charEnd 平移
    await db.chunk.updateMany({
      where: { documentId: docId, charStart: { lt: end }, charEnd: { gte: end } },
      data: { charEnd: { increment: delta } },
    })
  }

  // ---- 2) 父 chunk 重切片（文本随 patched full.md 变化；行 + 文件刷新） ----
  const parents = await db.chunk.findMany({ where: { documentId: docId, isParent: true }, orderBy: { seq: 'asc' } })
  const dir = chunksDir(kbId, docId)
  for (const p of parents) {
    const ps = Math.max(0, Math.min(p.charStart, patched.length))
    const pe = Math.max(ps, Math.min(p.charEnd, patched.length))
    const text = patched.slice(ps, pe)
    if (text.length === 0 && patched.length > 0) continue
    await fs.writeFile(path.join(dir, `${p.id}.txt`), text, 'utf-8').catch(() => {})
    await db.chunk
      .update({
        where: { id: p.id },
        data: {
          tokenCount: countTokens(text),
          textPreview: text.replace(/\s+/g, ' ').trim().slice(0, 500),
        },
      })
      .catch(() => {})
  }

  // ---- 3) middle.json 块偏移重对齐 ----
  const middle = await readMiddleJson(kbId, docId)
  if (middle.blocks.length > 0) {
    await fs.writeFile(middleJsonPath(kbId, docId), JSON.stringify(realignMiddleBlocks(middle, patched)), 'utf-8').catch(
      () => {}
    )
  }

  return {
    patched: true,
    delta,
    note: `full.md ${md.length} → ${patched.length} 字符（${replacement === null ? '删除' : '替换'} ${removal} 字符区间）`,
  }
}
