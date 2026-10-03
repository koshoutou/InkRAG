// 文档版本快照 / 对比 / 恢复 / 删除（契约 §17 / §27）
// 快照时机：reparse / rechunk / chunk 编辑 / 启停 / 删除 / 版本恢复 触发前（parseConfigV 递增前）归档当前 chunk 集
// 存储：{ARTIFACTS_ROOT}/{kbId}/{docId}/versions/v{n}.json（随备份 includeArtifacts 一并留存）
// 对比：任意两版本（文件快照 或 'current'=DB 当前）做 chunk 级 diff：
//   - 内容指纹（isParent + textPreview 的 sha1 前 16 位）序列上求 LCS 锚点
//   - 匹配 → same；v1 独有 → removed；v2 独有 → added
//   - 相邻 removed/added 段按序配对 → changed（bigram dice 相似度）
// 恢复（§27）：快照含 fullText → 归档当前 → parseConfigV+1 → 重建 chunks 行/磁盘 → 入队 embed 重写向量库
// 删除（§27）：fs.rm(v{n}.json)；'current' 无文件不可删

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { docDir, chunksDir, resolveStorageKey } from './artifacts'
import { getVectorStore } from './vectorstore'
import { enqueueDocument } from './pipeline'
import { assertEmbedScheme, embedTexts } from './embed'
import { emitToRoom } from './events'

export const CURRENT_VERSION = 'current'

// ---------------------------------------------------------------------------
// 类型（与 src/components/rag/types.ts §16 保持同步）
// ---------------------------------------------------------------------------

export interface VersionChunkSnapshot {
  id: string
  seq: number
  isParent: boolean
  textPreview: string
  tokenCount: number
  charStart: number
  charEnd: number
  enabled: boolean
  // ---- §27 恢复所需字段（旧快照缺失时降级：fullText→textPreview / 其余取默认值） ----
  parentId?: string | null
  docType?: string
  pageFrom?: number
  pageTo?: number
  bboxFrom?: string
  bboxTo?: string
  storageKey?: string
  fullText?: string
}

export interface VersionSnapshotFile {
  meta: {
    version: number
    createdAt: string
    docStatus: string
    parseEngine: string
    chunkConfigSnap: string
    chunkCount: number
    totalTokens: number
  }
  chunks: VersionChunkSnapshot[]
}

// ---------------------------------------------------------------------------
// 快照：归档当前版本
// ---------------------------------------------------------------------------

function versionsDir(kbId: string, docId: string): string {
  return path.join(docDir(kbId, docId), 'versions')
}

function snapshotPath(kbId: string, docId: string, version: number): string {
  return path.join(versionsDir(kbId, docId), `v${version}.json`)
}

/**
 * 归档文档当前 chunk 集为 v{n} 快照（n = doc.parseConfigV）。
 * 幂等：同版本文件已存在则跳过（防 retry 竞态重复写）。
 * 空文档（无 chunk）不快照（无可对比内容）。
 * 失败不抛错（best-effort：快照失败不应阻塞重解析动作），返回是否落盘。
 */
export async function snapshotDocVersion(docId: string): Promise<boolean> {
  try {
    const doc = await db.document.findUnique({ where: { id: docId } })
    if (!doc) return false
    const chunks = await db.chunk.findMany({
      where: { documentId: docId },
      orderBy: [{ seq: 'asc' }],
    })
    if (chunks.length === 0) return false

    const target = snapshotPath(doc.kbId, docId, doc.parseConfigV)
    try {
      await fs.access(target)
      return true // 已存在（幂等）
    } catch {
      /* 不存在则写 */
    }

    // §27：快照携带全文与溯源字段（恢复历史版本的完整依据）
    const snapshotChunks: VersionChunkSnapshot[] = []
    for (const c of chunks) {
      let fullText = ''
      try {
        fullText = await fs.readFile(resolveStorageKey(c.storageKey), 'utf-8')
      } catch {
        fullText = c.textPreview
      }
      snapshotChunks.push({
        id: c.id,
        seq: c.seq,
        isParent: c.isParent,
        textPreview: c.textPreview,
        tokenCount: c.tokenCount,
        charStart: c.charStart,
        charEnd: c.charEnd,
        enabled: c.enabled,
        parentId: c.parentId,
        docType: c.docType,
        pageFrom: c.pageFrom,
        pageTo: c.pageTo,
        bboxFrom: c.bboxFrom,
        bboxTo: c.bboxTo,
        storageKey: c.storageKey,
        fullText,
      })
    }

    const file: VersionSnapshotFile = {
      meta: {
        version: doc.parseConfigV,
        createdAt: new Date().toISOString(),
        docStatus: doc.status,
        parseEngine: String((JSON.parse(doc.metaJson || '{}') as Record<string, unknown>).parseEngine ?? doc.parseEngine ?? ''),
        chunkConfigSnap: doc.chunkConfigSnap || '{}',
        chunkCount: chunks.length,
        totalTokens: chunks.reduce((acc, c) => acc + c.tokenCount, 0),
      },
      chunks: snapshotChunks,
    }
    await fs.mkdir(versionsDir(doc.kbId, docId), { recursive: true })
    await fs.writeFile(target, JSON.stringify(file), 'utf-8')
    return true
  } catch (e) {
    console.warn('[versions] 快照失败（忽略）:', (e as Error).message)
    return false
  }
}

// ---------------------------------------------------------------------------
// §27 版本号递增（三屏联动 / 沙盒入库 / 恢复共用）
// ---------------------------------------------------------------------------

/** 流水线进行中的状态（这些状态下禁止编辑 / 恢复 / 删除 chunk） */
const RUNNING_STATUSES = new Set(['queued', 'parsing', 'chunking', 'embedding', 'upserting'])

export function isDocRunning(status: string): boolean {
  return RUNNING_STATUSES.has(status)
}

/**
 * 归档当前 chunk 集并递增文档版本号（parseConfigV+1）。
 * 三屏联动 enable / edit / delete 与沙盒入库统一调用：任何内容变更前先留快照，
 * 保证「文档版本管理」视图可随时回滚。返回递增后的新版本号。
 */
export async function bumpDocVersion(docId: string): Promise<number> {
  const doc = await db.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('文档不存在')
  if (isDocRunning(doc.status)) {
    throw new Error(`文档正在流水线中（${doc.status}），请等待完成后再操作`)
  }
  await snapshotDocVersion(docId)
  const nextV = doc.parseConfigV + 1
  await db.document.update({
    where: { id: docId },
    data: { parseConfigV: nextV, updatedAt: new Date() },
  })
  return nextV
}

// ---------------------------------------------------------------------------
// 版本列表
// ---------------------------------------------------------------------------

export interface DocVersionSummary {
  version: string // 'current' | '1' | '2' | ...
  source: 'snapshot' | 'current'
  createdAt: string
  chunkCount: number
  totalTokens: number
  chunkConfigSnap: string
  docStatus: string
  parseEngine: string
  /** §27 快照元信息（含 hasFullText 恢复能力判定；current 无） */
  meta?: {
    version: number
    createdAt: string
    docStatus: string
    parseEngine: string
    chunkConfigSnap: string
    chunkCount: number
    totalTokens: number
    hasFullText: boolean
  }
}

export async function listDocVersions(docId: string): Promise<DocVersionSummary[]> {
  const doc = await db.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('文档不存在')

  const out: DocVersionSummary[] = []

  // 当前版本（DB）
  const [chunkCount, totalTokens] = await Promise.all([
    db.chunk.count({ where: { documentId: docId } }),
    db.chunk.aggregate({ where: { documentId: docId }, _sum: { tokenCount: true } }),
  ])
  out.push({
    version: CURRENT_VERSION,
    source: 'current',
    createdAt: (doc.updatedAt ?? doc.createdAt).toISOString(),
    chunkCount,
    totalTokens: totalTokens._sum.tokenCount ?? 0,
    chunkConfigSnap: doc.chunkConfigSnap || '{}',
    docStatus: doc.status,
    parseEngine: doc.parseEngine ?? '',
  })

  // 文件快照（倒序：新在前）
  try {
    const dir = versionsDir(doc.kbId, docId)
    const files = (await fs.readdir(dir)).filter((f) => /^v\d+\.json$/.test(f))
    const parsed = await Promise.all(
      files.map(async (f) => {
        try {
          return JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')) as VersionSnapshotFile
        } catch {
          return null
        }
      }),
    )
    for (const p of parsed) {
      if (!p || typeof p.meta?.version !== 'number') continue
      const hasFullText = (p.chunks ?? []).some((c) => typeof c.fullText === 'string' && c.fullText.length > 0)
      out.push({
        version: String(p.meta.version),
        source: 'snapshot',
        createdAt: p.meta.createdAt,
        chunkCount: p.meta.chunkCount ?? p.chunks?.length ?? 0,
        totalTokens: p.meta.totalTokens ?? 0,
        chunkConfigSnap: p.meta.chunkConfigSnap ?? '{}',
        docStatus: p.meta.docStatus ?? '',
        parseEngine: p.meta.parseEngine ?? '',
        meta: {
          version: p.meta.version,
          createdAt: p.meta.createdAt ?? new Date(0).toISOString(),
          docStatus: p.meta.docStatus ?? '',
          parseEngine: p.meta.parseEngine ?? '',
          chunkConfigSnap: p.meta.chunkConfigSnap ?? '{}',
          chunkCount: p.meta.chunkCount ?? p.chunks?.length ?? 0,
          totalTokens: p.meta.totalTokens ?? 0,
          hasFullText,
        },
      })
    }
  } catch {
    /* 无 versions 目录 → 仅当前版本 */
  }

  // current 排最前，快照按版本号倒序
  out.sort((a, b) => {
    if (a.source === 'current') return -1
    if (b.source === 'current') return 1
    return Number(b.version) - Number(a.version)
  })
  return out
}

// ---------------------------------------------------------------------------
// 加载版本 chunk 集
// ---------------------------------------------------------------------------

async function loadVersionChunks(docId: string, version: string): Promise<VersionChunkSnapshot[]> {
  const doc = await db.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('文档不存在')

  if (version === CURRENT_VERSION) {
    const chunks = await db.chunk.findMany({
      where: { documentId: docId },
      orderBy: [{ seq: 'asc' }],
    })
    return chunks.map((c) => ({
      id: c.id,
      seq: c.seq,
      isParent: c.isParent,
      textPreview: c.textPreview,
      tokenCount: c.tokenCount,
      charStart: c.charStart,
      charEnd: c.charEnd,
      enabled: c.enabled,
    }))
  }

  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) throw new Error(`无效版本: ${version}`)
  const target = snapshotPath(doc.kbId, docId, vNum)
  let file: VersionSnapshotFile
  try {
    file = JSON.parse(await fs.readFile(target, 'utf-8')) as VersionSnapshotFile
  } catch {
    throw new Error(`版本 v${version} 不存在（重解析/重切分后才会产生快照）`)
  }
  return (file.chunks ?? []).slice().sort((a, b) => a.seq - b.seq)
}

// ---------------------------------------------------------------------------
// diff：指纹 LCS + bigram dice 相似度
// ---------------------------------------------------------------------------

function fingerprint(c: VersionChunkSnapshot): string {
  return crypto.createHash('sha1').update(`${c.isParent}|${c.textPreview}`).digest('hex').slice(0, 16)
}

/** 字符 bigram dice 相似度（0-1），changed 块展示用 */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const bigrams = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ma = bigrams(a)
  const mb = bigrams(b)
  let inter = 0
  for (const [g, n] of ma) {
    const other = mb.get(g)
    if (other) inter += Math.min(n, other)
  }
  return (2 * inter) / (a.length - 1 + b.length - 1)
}

export type VersionDiffType = 'same' | 'added' | 'removed' | 'changed'

export interface VersionDiffItem {
  type: VersionDiffType
  v1?: Pick<VersionChunkSnapshot, 'seq' | 'textPreview' | 'tokenCount' | 'charStart' | 'charEnd'>
  v2?: Pick<VersionChunkSnapshot, 'seq' | 'textPreview' | 'tokenCount' | 'charStart' | 'charEnd'>
  /** type=changed 时的文本相似度 0-1 */
  similarity?: number
}

/** LCS 匹配对（v1 索引 → v2 索引），滚动数组 DP + 反向回溯 */
function lcsMatch(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度（倒序 DP 便于回溯）
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return pairs
}

export interface VersionConfigDiffEntry {
  key: string
  v1: string
  v2: string
}

export interface VersionCompareResult {
  doc: { id: string; filename: string }
  v1: DocVersionSummary
  v2: DocVersionSummary
  summary: {
    same: number
    added: number
    removed: number
    changed: number
    v1Chunks: number
    v2Chunks: number
    v1Tokens: number
    v2Tokens: number
  }
  configDiff: VersionConfigDiffEntry[]
  items: VersionDiffItem[]
}

export async function compareVersions(
  docId: string,
  v1: string,
  v2: string,
): Promise<VersionCompareResult> {
  if (v1 === v2) throw new Error('两个版本相同，无对比意义')
  const versions = await listDocVersions(docId)
  const meta1 = versions.find((v) => v.version === v1)
  const meta2 = versions.find((v) => v.version === v2)
  if (!meta1) throw new Error(`版本 ${v1} 不存在`)
  if (!meta2) throw new Error(`版本 ${v2} 不存在`)

  const doc = await db.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('文档不存在')

  const [chunks1, chunks2] = await Promise.all([
    loadVersionChunks(docId, v1),
    loadVersionChunks(docId, v2),
  ])

  const items: VersionDiffItem[] = []
  let same = 0
  let added = 0
  let removed = 0
  let changed = 0

  const pairs = lcsMatch(chunks1.map(fingerprint), chunks2.map(fingerprint))
  const matched1 = new Set(pairs.map((p) => p[0]))
  const matched2 = new Set(pairs.map((p) => p[1]))

  // LCS 锚点把两侧切分为段；段内未匹配的 removed/added 按序两两配对为 changed
  const toSimple = (c: VersionChunkSnapshot) => ({
    seq: c.seq,
    textPreview: c.textPreview,
    tokenCount: c.tokenCount,
    charStart: c.charStart,
    charEnd: c.charEnd,
  })

  let cursor1 = 0
  let cursor2 = 0
  const flushGap = (end1: number, end2: number) => {
    const gap1: VersionChunkSnapshot[] = []
    const gap2: VersionChunkSnapshot[] = []
    while (cursor1 < end1) {
      if (!matched1.has(cursor1)) gap1.push(chunks1[cursor1])
      cursor1++
    }
    while (cursor2 < end2) {
      if (!matched2.has(cursor2)) gap2.push(chunks2[cursor2])
      cursor2++
    }
    // 段内按序配对：短的一侧配完，剩余归 removed / added
    const pairCount = Math.min(gap1.length, gap2.length)
    for (let k = 0; k < pairCount; k++) {
      items.push({
        type: 'changed',
        v1: toSimple(gap1[k]),
        v2: toSimple(gap2[k]),
        similarity: textSimilarity(gap1[k].textPreview, gap2[k].textPreview),
      })
      changed++
    }
    for (let k = pairCount; k < gap1.length; k++) {
      items.push({ type: 'removed', v1: toSimple(gap1[k]) })
      removed++
    }
    for (let k = pairCount; k < gap2.length; k++) {
      items.push({ type: 'added', v2: toSimple(gap2[k]) })
      added++
    }
  }

  for (const [i, j] of pairs) {
    flushGap(i, j) // 锚点前的未匹配段
    items.push({ type: 'same', v1: toSimple(chunks1[i]), v2: toSimple(chunks2[j]) })
    same++
    cursor1 = i + 1
    cursor2 = j + 1
  }
  flushGap(chunks1.length, chunks2.length)

  // 切分参数 diff（chunkConfigSnap）
  const configDiff: VersionConfigDiffEntry[] = []
  try {
    const c1 = JSON.parse(meta1.chunkConfigSnap || '{}') as Record<string, unknown>
    const c2 = JSON.parse(meta2.chunkConfigSnap || '{}') as Record<string, unknown>
    const keys = new Set([...Object.keys(c1), ...Object.keys(c2)])
    for (const key of keys) {
      const val1 = String(c1[key] ?? '-')
      const val2 = String(c2[key] ?? '-')
      if (val1 !== val2) configDiff.push({ key, v1: val1, v2: val2 })
    }
  } catch {
    /* 参数解析失败忽略 */
  }

  return {
    doc: { id: doc.id, filename: doc.filename },
    v1: meta1,
    v2: meta2,
    summary: {
      same,
      added,
      removed,
      changed,
      v1Chunks: chunks1.length,
      v2Chunks: chunks2.length,
      v1Tokens: chunks1.reduce((acc, c) => acc + c.tokenCount, 0),
      v2Tokens: chunks2.reduce((acc, c) => acc + c.tokenCount, 0),
    },
    configDiff,
    items,
  }
}

// ---------------------------------------------------------------------------
// §22 文档版本管理导出（json / markdown 报告）
// ---------------------------------------------------------------------------

/** 导出文件名（不含扩展名）：versions-{filename前缀}-v{v1}-vs-v{v2}-{yyyymmdd} */
export function exportFileName(docFilename: string, v1: string, v2: string): string {
  const stem = docFilename.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40)
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `versions-${stem}-v${v1}-vs-v${v2}-${ymd}`
}

/** JSON 报告（完整结构，含全部 diff items） */
export function compareResultToJson(r: VersionCompareResult): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      doc: r.doc,
      v1: r.v1,
      v2: r.v2,
      summary: r.summary,
      configDiff: r.configDiff,
      items: r.items,
    },
    null,
    2,
  )
}

const TYPE_LABEL: Record<VersionDiffType, string> = {
  same: '未变化',
  added: '新增',
  removed: '已移除',
  changed: '已修改',
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

/** Markdown 报告（人读向：头部汇总 + 参数差异表 + 变化明细；same 默认折叠成一行计数） */
export function compareResultToMarkdown(r: VersionCompareResult): string {
  const s = r.summary
  const lines: string[] = []
  lines.push(`# 文档版本管理报告：${r.doc.filename}`)
  lines.push('')
  lines.push(`> 导出时间：${fmtTime(new Date().toISOString())}`)
  lines.push('')
  lines.push(`## 版本`)
  lines.push(``)
  lines.push(`| | v1（基准） | v2（目标） |`)
  lines.push(`|---|---|---|`)
  lines.push(`| 版本 | ${r.v1.version}（${r.v1.source === 'current' ? '当前' : '快照'}） | ${r.v2.version}（${r.v2.source === 'current' ? '当前' : '快照'}） |`)
  lines.push(`| 时间 | ${fmtTime(r.v1.createdAt)} | ${fmtTime(r.v2.createdAt)} |`)
  lines.push(`| chunk 数 | ${s.v1Chunks} | ${s.v2Chunks} |`)
  lines.push(`| token 总量 | ${s.v1Tokens} | ${s.v2Tokens} |`)
  lines.push('')
  lines.push(`## 汇总`)
  lines.push('')
  lines.push(`- 未变化 **${s.same}** · 新增 **${s.added}** · 已移除 **${s.removed}** · 已修改 **${s.changed}**`)
  if (s.v1Chunks !== s.v2Chunks) {
    const diff = s.v2Chunks - s.v1Chunks
    lines.push(`- chunk 数变化：${s.v1Chunks} → ${s.v2Chunks}（${diff > 0 ? '+' : ''}${diff}，${((diff / Math.max(s.v1Chunks, 1)) * 100).toFixed(1)}%）`)
  }
  lines.push('')
  if (r.configDiff.length > 0) {
    lines.push(`## 切分参数差异`)
    lines.push('')
    lines.push(`| 参数 | v1 | v2 |`)
    lines.push(`|---|---|---|`)
    for (const c of r.configDiff) {
      lines.push(`| ${c.key} | ${c.v1} | ${c.v2} |`)
    }
    lines.push('')
  } else {
    lines.push(`## 切分参数差异`)
    lines.push('')
    lines.push(`两版本切分参数一致。`)
    lines.push('')
  }
  lines.push(`## 差异明细`)
  lines.push('')
  const changed = r.items.filter((i) => i.type !== 'same')
  if (changed.length === 0) {
    lines.push(`两版本切分结果一致（${s.same} 个 chunk 内容与数量完全相同）。`)
  } else {
    let idx = 0
    for (const i of changed) {
      idx++
      if (i.type === 'changed') {
        const sim = i.similarity !== undefined ? Math.round(i.similarity * 100) : -1
        lines.push(`### ${idx}. 已修改（相似度 ${sim}%）`)
        lines.push('')
        lines.push(`**v1 · seq ${i.v1?.seq} · ${i.v1?.tokenCount} tokens**`)
        lines.push('')
        lines.push('```')
        lines.push((i.v1?.textPreview ?? '').slice(0, 500))
        lines.push('```')
        lines.push('')
        lines.push(`**v2 · seq ${i.v2?.seq} · ${i.v2?.tokenCount} tokens**`)
        lines.push('')
        lines.push('```')
        lines.push((i.v2?.textPreview ?? '').slice(0, 500))
        lines.push('```')
      } else if (i.type === 'added') {
        lines.push(`### ${idx}. 新增（v2 · seq ${i.v2?.seq} · ${i.v2?.tokenCount} tokens）`)
        lines.push('')
        lines.push('```')
        lines.push((i.v2?.textPreview ?? '').slice(0, 500))
        lines.push('```')
      } else {
        lines.push(`### ${idx}. 已移除（v1 · seq ${i.v1?.seq} · ${i.v1?.tokenCount} tokens）`)
        lines.push('')
        lines.push('```')
        lines.push((i.v1?.textPreview ?? '').slice(0, 500))
        lines.push('```')
      }
      lines.push('')
    }
    lines.push(`---`)
    lines.push(`（另有 ${s.same} 个未变化 chunk，报告省略；完整结构见 JSON 导出）`)
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// §27 恢复历史版本 / 删除版本
// ---------------------------------------------------------------------------

export interface RestoreVersionResult {
  ok: true
  restoredVersion: number // 恢复产生的新版本号（= 恢复前 parseConfigV + 1）
  fromVersion: string
  chunkCount: number
  degradedChunks: number // 缺 fullText 降级用 textPreview 的 chunk 数
}

/**
 * 恢复文档到历史版本 v{n}（契约 §27）：
 * 1) 校验快照存在 + 文档不在流水线中
 * 2) 归档当前版本（bumpDocVersion：当前 chunk 集 → v{parseConfigV}.json，parseConfigV+1）
 * 3) 清空当前 chunks（行 + 磁盘 + 向量点）
 * 4) 按快照重建 chunks 行与磁盘全文（快照缺 fullText 的降级 textPreview）
 * 5) 入队 embed（重新嵌入 + 向量库重写——chunk ID 确定性，与快照一致）
 */
export async function restoreDocVersion(docId: string, version: string): Promise<RestoreVersionResult> {
  const doc = await db.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('文档不存在')
  if (version === CURRENT_VERSION) throw new Error('current 即当前版本，无需恢复')
  if (isDocRunning(doc.status)) {
    throw new Error(`文档正在流水线中（${doc.status}），请等待完成后再恢复`)
  }

  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) throw new Error(`无效版本: ${version}`)
  let file: VersionSnapshotFile
  try {
    file = JSON.parse(await fs.readFile(snapshotPath(doc.kbId, docId, vNum), 'utf-8')) as VersionSnapshotFile
  } catch {
    throw new Error(`版本 v${version} 不存在`)
  }
  const snapChunks = (file.chunks ?? []).slice().sort((a, b) => a.seq - b.seq)
  if (snapChunks.length === 0) throw new Error(`版本 v${version} 快照为空，无法恢复`)

  const kb = await db.knowledgeBase.findUnique({ where: { id: doc.kbId } })
  if (!kb) throw new Error('知识库不存在')

  // v1.6：恢复会重写向量库，先断言当前嵌入与建库时锁定的方案（dim / sparseScheme）一致，
  // 不一致给明确报错（防止恢复动作把异构向量写进库）
  try {
    const sample = snapChunks.find((c) => !c.isParent) ?? snapChunks[0]
    const sampleText =
      (typeof sample.fullText === 'string' && sample.fullText) || sample.textPreview || ''
    const probe = await embedTexts([sampleText || 'connectivity probe'], { dim: kb.dim || 1024 })
    assertEmbedScheme(kb, probe)
  } catch (e) {
    throw new Error(`恢复失败：${(e as Error).message}`)
  }

  // 1) 归档当前 + 版本号递增
  const restoredVersion = await bumpDocVersion(docId)

  // 2) 清旧 chunks：行 + 磁盘目录 + 向量
  await db.chunk.deleteMany({ where: { documentId: docId } })
  await fs.rm(chunksDir(doc.kbId, docId), { recursive: true, force: true })
  await fs.mkdir(chunksDir(doc.kbId, docId), { recursive: true })
  try {
    const store = await getVectorStore()
    await store.deleteByFilter(kb.collection, { must: [{ key: 'doc_id', match: { value: docId } }] })
  } catch (e) {
    console.warn('[versions] 恢复前清理旧向量跳过（可能无旧数据）:', (e as Error).message)
  }

  // 3) 重建 chunks 行 + 磁盘全文
  let degraded = 0
  const rows: Parameters<typeof db.chunk.create>[0]['data'][] = []
  for (const c of snapChunks) {
    const fullText = typeof c.fullText === 'string' && c.fullText.length > 0 ? c.fullText : c.textPreview
    if (typeof c.fullText !== 'string' || c.fullText.length === 0) degraded++
    const storageKey = c.storageKey ?? `${doc.kbId}/${docId}/chunks/${c.id}.txt`
    await fs.writeFile(resolveStorageKey(storageKey), fullText, 'utf-8')
    rows.push({
      id: c.id,
      documentId: docId,
      kbId: doc.kbId,
      isParent: c.isParent,
      parentId: c.parentId ?? null,
      seq: c.seq,
      docType: c.docType ?? 'text',
      tokenCount: c.tokenCount,
      charStart: c.charStart,
      charEnd: c.charEnd,
      pageFrom: c.pageFrom ?? 0,
      pageTo: c.pageTo ?? 0,
      bboxFrom: c.bboxFrom ?? '[]',
      bboxTo: c.bboxTo ?? '[]',
      textPreview: c.textPreview,
      storageKey,
      enabled: c.enabled,
    })
  }
  const TX = 100
  for (let i = 0; i < rows.length; i += TX) {
    await db.$transaction(rows.slice(i, i + TX).map((r) => db.chunk.create({ data: r })))
  }

  // 4) 状态回写 + 入队 embed（重嵌入 + 向量库重写）
  const meta = safeMeta(doc.metaJson)
  await db.document.update({
    where: { id: docId },
    data: {
      status: 'queued',
      stageProgress: 0,
      errorCode: null,
      errorMessage: null,
      metaJson: JSON.stringify({
        ...meta,
        restoredFrom: vNum,
        parentCount: snapChunks.filter((c) => c.isParent).length,
        childCount: snapChunks.filter((c) => !c.isParent).length,
      }),
    },
  })
  await enqueueDocument(docId, 'embed')
  await emitToRoom('global', 'pipeline:activity', {
    at: Date.now(),
    level: 'info',
    message: `版本恢复：${doc.filename} → v${version}（新版本 v${restoredVersion}，${snapChunks.length} chunks 重新向量化中）`,
  })

  return { ok: true, restoredVersion, fromVersion: version, chunkCount: snapChunks.length, degradedChunks: degraded }
}

/** 删除历史版本快照（§27）：'current' 无文件不可删 */
export async function deleteDocVersion(docId: string, version: string): Promise<void> {
  const doc = await db.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('文档不存在')
  if (version === CURRENT_VERSION) throw new Error('当前版本不可删除（删除文档请到文档中心）')
  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) throw new Error(`无效版本: ${version}`)
  const target = snapshotPath(doc.kbId, docId, vNum)
  try {
    await fs.access(target)
  } catch {
    throw new Error(`版本 v${version} 不存在`)
  }
  await fs.rm(target, { force: true })
}

function safeMeta(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}')
    return typeof v === 'object' && v !== null ? v : {}
  } catch {
    return {}
  }
}
