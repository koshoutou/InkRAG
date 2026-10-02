/**
 * Markdown 感知切分引擎（计划书 §11.2 Phase 1-4，纯函数，零 I/O）
 *
 * Phase 1 结构解析：标题 / fenced code / markdown+HTML 表格 / 图片 / 段落 → Block[]
 * Phase 2 父 chunk 构建：strategy=title/hybrid 按标题分组节；token 顺序切；超长按段落二分
 * Phase 3 子 chunk 切分：code/table 原子保护 > 段落贪心合并 > 句子切分 > 硬切+overlap（UTF-8 安全）
 * Phase 4 坐标回填：layout blocks 与 chunk charRange 求交集 → page/bbox
 *
 * preview 与正式切分共用此纯函数（沙盒 500ms 预览要求天然满足）。
 * token 计数口径：CJK≈1/字，拉丁按词（与 embed/rerank 的 tokenize 一致）。
 */

export interface ChunkConfig {
  size: number
  overlap: number
  parentSize: number
  strategy: 'token' | 'title' | 'hybrid'
  protects: string[]
}

/** 默认切分配置（契约 §1） */
export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  size: 512,
  overlap: 0,
  parentSize: 2000,
  strategy: 'hybrid',
  protects: ['code', 'table'],
}

export interface LayoutBlock {
  idx: number
  type: 'text' | 'title' | 'table' | 'code' | 'image'
  page: number
  bbox: [number, number, number, number]
  charStart: number
  charEnd: number
  text: string
}

export interface SplitParent {
  seq: number
  text: string
  charStart: number
  charEnd: number
  tokenCount: number
}

export interface SplitChild {
  seq: number
  parentSeq: number
  text: string
  docType: 'text' | 'table' | 'code' | 'image'
  tokenCount: number
  charStart: number
  charEnd: number
  pageFrom: number
  pageTo: number
  bboxFrom: number[]
  bboxTo: number[]
}

export interface SplitStats {
  total: number
  parentCount: number
  tokenMin: number
  tokenMax: number
  tokenAvg: number
  tokenP95: number
  docTypeCounts: Record<string, number>
}

export interface SplitResult {
  parents: SplitParent[]
  children: SplitChild[]
  stats: SplitStats
}

// ---------------------------------------------------------------------------
// token 计数（CJK≈1/字，拉丁按词）
// ---------------------------------------------------------------------------

const TOKEN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]|[\p{L}\p{N}][\p{L}\p{N}_'’-]*/gu

/** 分词（保持原文形式；嵌入/重排侧需自行 lowercase） */
export function tokenizeText(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(TOKEN_RE)) out.push(m[0])
  return out
}

export function countTokens(text: string): number {
  let n = 0
  for (const _ of text.matchAll(TOKEN_RE)) n++
  return n
}

// ---------------------------------------------------------------------------
// Phase 1 · 结构解析
// ---------------------------------------------------------------------------

export interface MdBlock {
  type: 'heading' | 'paragraph' | 'code' | 'table' | 'image'
  /** heading 级别 1-6，其余 0 */
  level: number
  text: string
  charStart: number
  charEnd: number
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const FENCE_OPEN_RE = /^\s{0,3}`{3,}/
const FENCE_CLOSE_RE = /^\s{0,3}`{3,}\s*$/
const MD_TABLE_SEP_RE = /^\s*\|?[ :|-]*-[ :|-]*\|?\s*$/
const IMAGE_ONLY_RE = /^!\[[^\]]*\]\([^)]*\)\s*$/
const HAS_PIPE_RE = /|/

/** markdown 表格分隔行判定（|---|---| 形态） */
function isTableDelimiter(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false
  return MD_TABLE_SEP_RE.test(line)
}

/**
 * 逐行扫描 full.md，产出结构块（charStart/charEnd 为源文本 code-unit 偏移，不含尾换行）。
 */
export function parseMarkdownBlocks(md: string): MdBlock[] {
  const lines = md.split('\n')
  // 每行起始偏移
  const lineStarts: number[] = []
  let acc = 0
  for (const line of lines) {
    lineStarts.push(acc)
    acc += line.length + 1 // +\n
  }
  const lineEnd = (i: number) => lineStarts[i] + lines[i].length

  const blocks: MdBlock[] = []
  let i = 0
  let paraStart = -1

  const flushParagraph = (endLineExclusive: number) => {
    if (paraStart >= 0 && endLineExclusive > paraStart) {
      blocks.push({
        type: 'paragraph',
        level: 0,
        text: md.slice(lineStarts[paraStart], lineEnd(endLineExclusive - 1)),
        charStart: lineStarts[paraStart],
        charEnd: lineEnd(endLineExclusive - 1),
      })
    }
    paraStart = -1
  }

  while (i < lines.length) {
    const line = lines[i]

    // --- fenced code ---
    if (FENCE_OPEN_RE.test(line)) {
      flushParagraph(i)
      const start = i
      i++
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) i++
      if (i < lines.length) i++ // 含闭围栏
      blocks.push({
        type: 'code',
        level: 0,
        text: md.slice(lineStarts[start], lineEnd(Math.min(i - 1, lines.length - 1))),
        charStart: lineStarts[start],
        charEnd: lineEnd(Math.min(i - 1, lines.length - 1)),
      })
      continue
    }

    // --- HTML table ---
    if (/<table[\s>]/i.test(line)) {
      flushParagraph(i)
      const start = i
      while (i < lines.length && !/<\/table>/i.test(lines[i])) i++
      if (i < lines.length) i++
      blocks.push({
        type: 'table',
        level: 0,
        text: md.slice(lineStarts[start], lineEnd(Math.min(i - 1, lines.length - 1))),
        charStart: lineStarts[start],
        charEnd: lineEnd(Math.min(i - 1, lines.length - 1)),
      })
      continue
    }

    // --- markdown table（当前行含 | 且下一行是分隔行） ---
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isTableDelimiter(lines[i + 1]) &&
      lines[i + 1].includes('|')
    ) {
      flushParagraph(i)
      const start = i
      i += 2
      while (i < lines.length && lines[i].includes('|')) i++
      blocks.push({
        type: 'table',
        level: 0,
        text: md.slice(lineStarts[start], lineEnd(i - 1)),
        charStart: lineStarts[start],
        charEnd: lineEnd(i - 1),
      })
      continue
    }

    // --- heading ---
    const hm = line.match(HEADING_RE)
    if (hm) {
      flushParagraph(i)
      blocks.push({
        type: 'heading',
        level: hm[1].length,
        text: md.slice(lineStarts[i], lineEnd(i)),
        charStart: lineStarts[i],
        charEnd: lineEnd(i),
      })
      i++
      continue
    }

    // --- 独立图片行 ---
    if (IMAGE_ONLY_RE.test(line.trim())) {
      flushParagraph(i)
      blocks.push({
        type: 'image',
        level: 0,
        text: md.slice(lineStarts[i], lineEnd(i)),
        charStart: lineStarts[i],
        charEnd: lineEnd(i),
      })
      i++
      continue
    }

    // --- 段落累积（空行终止） ---
    if (line.trim() === '') {
      flushParagraph(i)
      i++
      continue
    }
    if (paraStart < 0) paraStart = i
    i++
  }
  flushParagraph(lines.length)
  return blocks
}

// ---------------------------------------------------------------------------
// Phase 2 · 父 chunk 构建
// ---------------------------------------------------------------------------

interface ParentDraft {
  blocks: MdBlock[]
  charStart: number
  charEnd: number
}

function draftText(md: string, d: ParentDraft): string {
  return md.slice(d.charStart, d.charEnd)
}

/** 章节切分：每个标题开一个 section（内容直到下一个任意级别标题） */
function buildSections(md: string, blocks: MdBlock[]): ParentDraft[] {
  const sections: ParentDraft[] = []
  let current: ParentDraft | null = null
  for (const b of blocks) {
    if (b.type === 'heading') {
      current = { blocks: [b], charStart: b.charStart, charEnd: b.charEnd }
      sections.push(current)
    } else {
      if (!current) {
        current = { blocks: [], charStart: b.charStart, charEnd: b.charStart }
        sections.push(current)
      }
      current.blocks.push(b)
      current.charEnd = b.charEnd
    }
  }
  return sections.filter((s) => s.blocks.length > 0)
}

/** 超长父按段落二分（保标题边界：标题跟随第一段） */
function bisectSection(md: string, section: ParentDraft, parentSize: number): ParentDraft[] {
  const total = countTokens(draftText(md, section))
  if (total <= parentSize) return [section]
  const parts: ParentDraft[] = []
  let part: MdBlock[] = []
  let partTokens = 0
  let start = section.charStart
  let end = section.charStart
  for (const b of section.blocks) {
    const bt = countTokens(b.text)
    const headingFirst = b.type === 'heading' && part.length === 0
    if (partTokens + bt > parentSize && part.length > 0 && !headingFirst) {
      parts.push({ blocks: part, charStart: start, charEnd: end })
      part = []
      partTokens = 0
      start = b.charStart
    }
    part.push(b)
    partTokens += bt
    end = b.charEnd
  }
  if (part.length) parts.push({ blocks: part, charStart: start, charEnd: end })
  return parts
}

/** strategy=token：忽略标题，顺序贪心打包（code/table 原子） */
function buildTokenParents(md: string, blocks: MdBlock[], parentSize: number): ParentDraft[] {
  const parents: ParentDraft[] = []
  let part: MdBlock[] = []
  let partTokens = 0
  let start = -1
  let end = -1
  const flush = () => {
    if (part.length) {
      parents.push({ blocks: part, charStart: start, charEnd: end })
      part = []
      partTokens = 0
      start = -1
    }
  }
  for (const b of blocks) {
    const bt = countTokens(b.text)
    if (partTokens + bt > parentSize && part.length > 0) flush()
    if (start < 0) start = b.charStart
    part.push(b)
    partTokens += bt
    end = b.charEnd
  }
  flush()
  return parents
}

// ---------------------------------------------------------------------------
// Phase 3 · 子 chunk 切分（父内）
// ---------------------------------------------------------------------------

interface Segment {
  text: string
  charStart: number
  charEnd: number
  docType: 'text' | 'table' | 'code' | 'image'
}

const SENTENCE_DELIMITERS = new Set(['。', '！', '？', '!', '?', '.', ';', '；', '\n'])

/** 句子切分（保留分隔符；返回相对偏移段） */
function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_DELIMITERS.has(text[i])) {
      // 连续分隔符合并
      let j = i + 1
      while (j < text.length && SENTENCE_DELIMITERS.has(text[j])) j++
      out.push({ text: text.slice(start, j), start, end: j })
      start = j
      i = j - 1
    }
  }
  if (start < text.length) out.push({ text: text.slice(start), start, end: text.length })
  return out.filter((s) => s.text.trim().length > 0)
}

/** 硬切 + overlap（UTF-8 安全：按 rune 组切，但偏移按 code-unit 记录） */
function hardCut(
  text: string,
  absStart: number,
  targetTokens: number,
  overlapTokens: number,
  docType: Segment['docType']
): Segment[] {
  const totalTokens = countTokens(text)
  if (totalTokens === 0) return []
  const avgCharsPerToken = text.length / totalTokens
  const segChars = Math.max(8, Math.round(targetTokens * avgCharsPerToken))
  const overlapChars = Math.max(0, Math.round(overlapTokens * avgCharsPerToken))
  const out: Segment[] = []
  // 按 rune 迭代并记录 code-unit 边界
  const boundaries: number[] = [0]
  for (const ch of text) {
    boundaries.push(boundaries[boundaries.length - 1] + ch.length)
  }
  let idx = 0
  while (idx < boundaries.length - 1) {
    let endPos = boundaries[boundaries.length - 1]
    // 找到 >= idx + segChars 的 rune 边界
    for (let bi = idx; bi < boundaries.length; bi++) {
      if (boundaries[bi] - boundaries[idx] >= segChars) {
        endPos = boundaries[bi]
        break
      }
    }
    const segText = text.slice(boundaries[idx], endPos)
    if (segText.trim().length > 0) {
      out.push({
        text: segText,
        charStart: absStart + boundaries[idx],
        charEnd: absStart + endPos,
        docType,
      })
    }
    if (endPos >= text.length) break
    // overlap 回退（rune 安全）
    let nextIdx = boundaries.length - 1
    for (let bi = boundaries.length - 1; bi >= idx; bi--) {
      if (endPos - boundaries[bi] >= overlapChars) {
        nextIdx = bi
        break
      }
    }
    if (nextIdx <= idx) nextIdx = boundaries.findIndex((b) => b >= endPos)
    if (nextIdx < 0 || nextIdx <= idx) break
    idx = nextIdx
  }
  return out
}

/** 单个块 → 切分段列表 */
function splitBlock(
  block: MdBlock,
  config: ChunkConfig
): Segment[] {
  const tokens = countTokens(block.text)
  const isProtected =
    (block.type === 'code' || block.type === 'table' || block.type === 'image') &&
    config.protects.includes(block.type)

  const docType: Segment['docType'] =
    block.type === 'code' ? 'code' : block.type === 'table' ? 'table' : block.type === 'image' ? 'image' : 'text'

  // 原子保护（≤ size）：整块一个子 chunk
  if (isProtected && tokens <= config.size) {
    return [
      { text: block.text, charStart: block.charStart, charEnd: block.charEnd, docType },
    ]
  }
  // 原子保护但超长：按行二分（不截断行）
  if (isProtected && tokens > config.size) {
    const lines = block.text.split('\n')
    // 计算每行相对偏移
    const lineOffsets: number[] = []
    let off = 0
    for (const ln of lines) {
      lineOffsets.push(off)
      off += ln.length + 1
    }
    const segs: Segment[] = []
    let group: string[] = []
    let groupStart = 0
    let groupTokens = 0
    const flushGroup = (endRel: number) => {
      if (group.length) {
        const text = group.join('\n')
        segs.push({
          text,
          charStart: block.charStart + groupStart,
          charEnd: block.charStart + endRel,
          docType,
        })
        group = []
        groupTokens = 0
      }
    }
    for (let li = 0; li < lines.length; li++) {
      const lt = countTokens(lines[li])
      if (groupTokens + lt > config.size && group.length > 0) {
        flushGroup(lineOffsets[li])
        groupStart = lineOffsets[li]
      }
      group.push(lines[li])
      groupTokens += lt
    }
    if (group.length) flushGroup(block.text.length)
    // 仍有单行超长 → 硬切该行
    const expanded: Segment[] = []
    for (const seg of segs) {
      if (countTokens(seg.text) > config.size && !seg.text.includes('\n')) {
        expanded.push(...hardCut(seg.text, seg.charStart, config.size, 0, docType))
      } else {
        expanded.push(seg)
      }
    }
    return expanded.filter((s) => s.text.trim().length > 0)
  }

  // 普通文本：≤ size 整块返回
  if (tokens <= config.size) {
    return [{ text: block.text, charStart: block.charStart, charEnd: block.charEnd, docType: 'text' }]
  }
  // 超长段落：句子切分贪心合并
  const sentences = splitSentences(block.text)
  const segs: Segment[] = []
  let cur: { text: string; start: number; end: number } | null = null
  for (const s of sentences) {
    const st = countTokens(s.text)
    if (cur && countTokens(cur.text) + st > config.size) {
      segs.push({
        text: cur.text,
        charStart: block.charStart + cur.start,
        charEnd: block.charStart + cur.end,
        docType: 'text',
      })
      cur = null
    }
    if (st > config.size) {
      // 单句超长 → 硬切（带 overlap）
      if (cur) {
        segs.push({
          text: cur.text,
          charStart: block.charStart + cur.start,
          charEnd: block.charStart + cur.end,
          docType: 'text',
        })
        cur = null
      }
      for (const piece of hardCut(s.text, block.charStart + s.start, config.size, config.overlap, 'text')) {
        segs.push(piece)
      }
      continue
    }
    cur = cur
      ? { text: cur.text + s.text, start: cur.start, end: s.end }
      : { text: s.text, start: s.start, end: s.end }
  }
  if (cur) {
    segs.push({
      text: cur.text,
      charStart: block.charStart + cur.start,
      charEnd: block.charStart + cur.end,
      docType: 'text',
    })
  }
  return segs.filter((s) => s.text.trim().length > 0)
}

/** 父内子 chunk 组装：块级贪心合并 → 块内切分 */
function splitParentChildren(
  parent: ParentDraft,
  config: ChunkConfig
): { segments: Segment[]; parentTextRange: [number, number] } {
  const segments: Segment[] = []
  let buffer: Segment | null = null
  const flushBuffer = () => {
    if (buffer && buffer.text.trim()) segments.push(buffer)
    buffer = null
  }
  for (const block of parent.blocks) {
    const blockSegs = splitBlock(block, config)
    for (const seg of blockSegs) {
      const segTokens = countTokens(seg.text)
      if (segTokens > config.size) {
        // 块内切分产物仍超长（不应发生，兜底直接放入）
        flushBuffer()
        segments.push(seg)
        continue
      }
      if (seg.docType !== 'text') {
        // code/table/image 独立成 chunk，不与文本合并
        flushBuffer()
        segments.push(seg)
        continue
      }
      if (buffer) {
        const mergedTokens = countTokens(buffer.text) + segTokens
        if (mergedTokens <= config.size) {
          buffer = {
            text: buffer.text + '\n\n' + seg.text,
            charStart: buffer.charStart,
            charEnd: seg.charEnd,
            docType: 'text',
          }
        } else {
          flushBuffer()
          buffer = seg
        }
      } else {
        buffer = seg
      }
    }
  }
  flushBuffer()
  return {
    segments,
    parentTextRange: [parent.charStart, parent.charEnd],
  }
}

// ---------------------------------------------------------------------------
// Phase 4 · 坐标回填
// ---------------------------------------------------------------------------

function backfill(
  charStart: number,
  charEnd: number,
  layout: LayoutBlock[]
): { pageFrom: number; pageTo: number; bboxFrom: number[]; bboxTo: number[] } {
  const sorted = [...layout].sort((a, b) => a.charStart - b.charStart)
  let first: LayoutBlock | null = null
  let last: LayoutBlock | null = null
  for (const lb of sorted) {
    if (lb.charStart < charEnd && lb.charEnd > charStart) {
      if (!first) first = lb
      last = lb
    }
  }
  if (!first || !last) return { pageFrom: 0, pageTo: 0, bboxFrom: [], bboxTo: [] }
  return {
    pageFrom: first.page,
    pageTo: last.page,
    bboxFrom: [...first.bbox],
    bboxTo: [...last.bbox],
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function percentile95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))
  return sorted[idx]
}

export function splitMarkdown(
  md: string,
  config: ChunkConfig,
  layout: LayoutBlock[] = []
): SplitResult {
  const safeConfig: ChunkConfig = {
    size: Math.max(16, config.size || 512),
    overlap: Math.max(0, Math.min(config.overlap || 0, Math.floor((config.size || 512) / 4))),
    parentSize: Math.max(config.size || 512, config.parentSize || 2000),
    strategy: config.strategy || 'hybrid',
    protects: Array.isArray(config.protects) ? config.protects : ['code', 'table'],
  }

  const blocks = parseMarkdownBlocks(md)
  const hasHeadings = blocks.some((b) => b.type === 'heading')

  // ---- Phase 2：父构建 ----
  let parentDrafts: ParentDraft[]
  if (safeConfig.strategy === 'token' || !hasHeadings) {
    parentDrafts = buildTokenParents(md, blocks, safeConfig.parentSize)
  } else {
    let sections = buildSections(md, blocks)
    if (safeConfig.strategy === 'hybrid') {
      // hybrid：相邻小节合并（合并后不超过 parentSize 且被合并节本身较小）
      const merged: ParentDraft[] = []
      for (const sec of sections) {
        const prev = merged[merged.length - 1]
        if (prev) {
          const prevTokens = countTokens(draftText(md, prev))
          const secTokens = countTokens(draftText(md, sec))
          const gapOk = sec.charStart - prev.charEnd <= 3 // 紧邻（仅隔空行）
          const prevIsRoot = prev.blocks[0]?.type !== 'heading'
          const secIsSmall = secTokens <= Math.max(1, Math.floor(safeConfig.size / 2))
          if (gapOk && secIsSmall && prevTokens + secTokens <= safeConfig.parentSize && !prevIsRoot) {
            prev.blocks.push(...sec.blocks)
            prev.charEnd = sec.charEnd
            continue
          }
          if (gapOk && prevIsRoot && secIsSmall) {
            // 根片段（首个标题前的孤立内容）并入首节
            prev.blocks.push(...sec.blocks)
            prev.charEnd = sec.charEnd
            continue
          }
        }
        merged.push(sec)
      }
      sections = merged
    }
    parentDrafts = []
    for (const sec of sections) {
      parentDrafts.push(...bisectSection(md, sec, safeConfig.parentSize))
    }
  }

  // ---- Phase 3 + 4：子切分 + 坐标回填 + 全局 seq ----
  const parents: SplitParent[] = []
  const children: SplitChild[] = []
  let seq = 0
  const parentSeqByIndex = new Map<number, number>()

  parentDrafts.forEach((draft, pi) => {
    const parentSeq = seq++
    parentSeqByIndex.set(pi, parentSeq)
    const text = draftText(md, draft)
    parents.push({
      seq: parentSeq,
      text,
      charStart: draft.charStart,
      charEnd: draft.charEnd,
      tokenCount: countTokens(text),
    })
    const { segments } = splitParentChildren(draft, safeConfig)
    for (const seg of segments) {
      const coords = backfill(seg.charStart, seg.charEnd, layout)
      children.push({
        seq: seq++,
        parentSeq,
        text: seg.text,
        docType: seg.docType,
        tokenCount: countTokens(seg.text),
        charStart: seg.charStart,
        charEnd: seg.charEnd,
        ...coords,
      })
    }
  })

  const tokenCounts = children.map((c) => c.tokenCount)
  const docTypeCounts: Record<string, number> = {}
  for (const c of children) docTypeCounts[c.docType] = (docTypeCounts[c.docType] ?? 0) + 1

  return {
    parents,
    children,
    stats: {
      total: children.length,
      parentCount: parents.length,
      tokenMin: tokenCounts.length ? Math.min(...tokenCounts) : 0,
      tokenMax: tokenCounts.length ? Math.max(...tokenCounts) : 0,
      tokenAvg: tokenCounts.length
        ? Math.round((tokenCounts.reduce((s, v) => s + v, 0) / tokenCounts.length) * 10) / 10
        : 0,
      tokenP95: percentile95(tokenCounts),
      docTypeCounts,
    },
  }
}

