'use client'

// 文档文档版本管理 · 单条 diff 渲染（契约 §17 / Task 9-c）
// same = 折叠行（点击展开） / added = emerald 左边框 / removed = rose 左边框
// changed = amber 左边框 + md 双栏对照 + 相似度徽标（进度色）
// 颜色体系：same teal · added emerald · removed rose · changed amber（禁 indigo/blue）

import { useState } from 'react'
import { CheckCircle2, ChevronRight, FileMinus2, FilePenLine, FilePlus2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { VersionDiffChunk, VersionDiffItem, VersionDiffType } from '../../types'
import { formatNumber, ragScrollbar } from '../../ui'

export const DIFF_TYPE_META: Record<
  VersionDiffType,
  { label: string; dot: string; badge: string; leftBorder: string; activeChip: string }
> = {
  same: {
    label: '未变化',
    dot: 'bg-teal-500',
    badge: 'border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300',
    leftBorder: 'border-l-teal-500/60',
    activeChip: 'border-teal-500/50 bg-teal-500/15 text-teal-700 dark:text-teal-300',
  },
  added: {
    label: '新增',
    dot: 'bg-emerald-500',
    badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    leftBorder: 'border-l-emerald-500',
    activeChip: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  },
  removed: {
    label: '已移除',
    dot: 'bg-rose-500',
    badge: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300',
    leftBorder: 'border-l-rose-500',
    activeChip: 'border-rose-500/50 bg-rose-500/15 text-rose-700 dark:text-rose-300',
  },
  changed: {
    label: '已修改',
    dot: 'bg-amber-500',
    badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
    leftBorder: 'border-l-amber-500',
    activeChip: 'border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300',
  },
}

/** 相似度进度色：<40% rose / 40–70% amber / >70% emerald */
function similarityMeta(sim: number) {
  const pct = Math.max(0, Math.min(100, Math.round(sim * 100)))
  if (pct < 40) {
    return { pct, bar: 'bg-rose-500', chip: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400' }
  }
  if (pct <= 70) {
    return { pct, bar: 'bg-amber-500', chip: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400' }
  }
  return { pct, bar: 'bg-emerald-500', chip: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' }
}

/** 文本预览：等宽 + pre-wrap + 限高滚动（项目自定义滚动条） */
function PreviewText({ text, className }: { text: string | undefined; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2.5 font-mono text-xs leading-relaxed text-foreground/90',
        ragScrollbar,
        className,
      )}
    >
      {text && text.trim().length > 0 ? text : '（空内容）'}
    </pre>
  )
}

/** meta 行：seq · tokens · 字符范围 */
function ChunkMeta({ chunk, className }: { chunk: VersionDiffChunk; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground',
        className,
      )}
    >
      <span>seq {chunk.seq}</span>
      <span aria-hidden>·</span>
      <span>{formatNumber(chunk.tokenCount)} tokens</span>
      <span aria-hidden>·</span>
      <span>
        {formatNumber(chunk.charStart)}–{formatNumber(chunk.charEnd)} 字符
      </span>
    </span>
  )
}

function TypeBadge({ type }: { type: Exclude<VersionDiffType, 'same'> }) {
  const meta = DIFF_TYPE_META[type]
  const Icon = type === 'added' ? FilePlus2 : type === 'removed' ? FileMinus2 : FilePenLine
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none',
        meta.badge,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// same：折叠单行，点击展开文本预览
// ---------------------------------------------------------------------------

function SameRow({ item }: { item: VersionDiffItem }) {
  const [open, setOpen] = useState(false)
  const chunk = item.v1 ?? item.v2
  if (!chunk) return null
  return (
    <div className="rounded-lg border border-border/50 bg-muted/25 transition-colors hover:border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        <span className="font-medium tabular-nums">seq {chunk.seq}</span>
        <span className="text-muted-foreground">· 未变化</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 rounded-full', DIFF_TYPE_META.same.dot)} aria-hidden />
          same
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatNumber(chunk.tokenCount)} tokens
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <PreviewText text={chunk.textPreview} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// added / removed：单边卡片（emerald / rose 左边框）
// ---------------------------------------------------------------------------

function SingleSideCard({ item, vLabel }: { item: VersionDiffItem; vLabel: string }) {
  const isAdd = item.type === 'added'
  const chunk = isAdd ? item.v2 : item.v1
  if (!chunk) return null
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 border-l-[3px] bg-card p-3 shadow-xs transition-colors hover:border-border',
        DIFF_TYPE_META[isAdd ? 'added' : 'removed'].leftBorder,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <TypeBadge type={isAdd ? 'added' : 'removed'} />
        <ChunkMeta chunk={chunk} />
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {isAdd ? 'v2' : 'v1'} · {vLabel}
        </span>
      </div>
      <div className="mt-2">
        <PreviewText text={chunk.textPreview} className={isAdd ? 'bg-emerald-500/5' : 'bg-rose-500/5'} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// changed：amber 左边框 + md 以上双栏对照 + 相似度徽标（进度色 + 迷你进度条）
// ---------------------------------------------------------------------------

function ChangedCard({ item, v1Label, v2Label }: { item: VersionDiffItem; v1Label: string; v2Label: string }) {
  const sim = typeof item.similarity === 'number' ? item.similarity : null
  const sm = sim !== null ? similarityMeta(sim) : null
  return (
    <div className="rounded-lg border border-border/60 border-l-[3px] border-l-amber-500 bg-card p-3 shadow-xs transition-colors hover:border-border">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <TypeBadge type="changed" />
        {sm && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums',
              sm.chip,
            )}
          >
            相似度 {sm.pct}%
          </span>
        )}
        {sm && (
          <span
            className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted sm:inline-flex"
            role="img"
            aria-label={`相似度 ${sm.pct}%`}
          >
            <span className={cn('h-full rounded-full transition-all', sm.bar)} style={{ width: `${sm.pct}%` }} />
          </span>
        )}
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div
          className="rounded-md border border-rose-500/20 bg-rose-500/5 p-2"
          title={item.v1 ? `v1 字符范围 ${formatNumber(item.v1.charStart)} – ${formatNumber(item.v1.charEnd)}` : undefined}
        >
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
            <span className="font-medium text-rose-600 dark:text-rose-400">v1 · {v1Label}</span>
            {item.v1 && (
              <span>
                seq {item.v1.seq} · {formatNumber(item.v1.tokenCount)} tokens
              </span>
            )}
          </div>
          <PreviewText text={item.v1?.textPreview} className="bg-transparent" />
        </div>
        <div
          className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2"
          title={item.v2 ? `v2 字符范围 ${formatNumber(item.v2.charStart)} – ${formatNumber(item.v2.charEnd)}` : undefined}
        >
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
            <span className="font-medium text-emerald-600 dark:text-emerald-400">v2 · {v2Label}</span>
            {item.v2 && (
              <span>
                seq {item.v2.seq} · {formatNumber(item.v2.tokenCount)} tokens
              </span>
            )}
          </div>
          <PreviewText text={item.v2?.textPreview} className="bg-transparent" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 对外导出：按 type 分发渲染
// ---------------------------------------------------------------------------

export function DiffItemCard({
  item,
  v1Label,
  v2Label,
}: {
  item: VersionDiffItem
  v1Label: string
  v2Label: string
}) {
  if (item.type === 'same') {
    return <SameRow item={item} />
  }
  if (item.type === 'changed') {
    return <ChangedCard item={item} v1Label={v1Label} v2Label={v2Label} />
  }
  return <SingleSideCard item={item} vLabel={item.type === 'added' ? v2Label : v1Label} />
}

/** 「两版本切分结果一致」空态（全 same 时 diff 列表内提示） */
export function SameOnlyHint() {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <CheckCircle2 className="h-8 w-8 text-teal-500" aria-hidden />
      <p className="text-sm font-medium">两版本切分结果一致</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        所有 chunk 内容与数量完全相同，无新增 / 移除 / 修改（切分参数差异仍可在上方查看）
      </p>
    </div>
  )
}
