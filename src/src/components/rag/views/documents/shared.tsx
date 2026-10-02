'use client'

// 批量上传 / URL 导入（契约 §26）· 共享 UI 原子件
// StageStepper：六状态机阶段步进器（queued→parsing→chunking→embedding→upserting→ready|failed）

import {
  CheckCircle2,
  Clock,
  FileCode2,
  FileSearch,
  FileText,
  FileType2,
  Globe,
  Scissors,
  Sparkles,
  UploadCloud,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DocStatus } from '../../types'

/** 流水线五个过程阶段（终态另算） */
export const PROCESS_STAGE_ORDER: DocStatus[] = ['queued', 'parsing', 'chunking', 'embedding', 'upserting']

export const STAGE_ICON: Record<string, LucideIcon> = {
  queued: Clock,
  parsing: FileSearch,
  chunking: Scissors,
  embedding: Sparkles,
  upserting: UploadCloud,
  ready: CheckCircle2,
  failed: XCircle,
}

export const STAGE_LABEL: Record<string, string> = {
  queued: '排队',
  parsing: '解析',
  chunking: '切分',
  embedding: '向量化',
  upserting: '入库',
  ready: '就绪',
  failed: '失败',
}

/**
 * 六阶段步进器：完成阶段 emerald、当前阶段 teal 高亮 + 阶段内进度%、未到 muted。
 * 375px 下五段横排（图标 + 9px 标签），无横向溢出。
 */
export function StageStepper({
  status,
  stageProgress,
  className,
}: {
  status: DocStatus | undefined
  stageProgress: number
  className?: string
}) {
  const terminalReady = status === 'ready'
  const terminalFailed = status === 'failed'
  const currentIdx = PROCESS_STAGE_ORDER.indexOf(status as DocStatus)
  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)} role="status" aria-label={`流水线阶段：${STAGE_LABEL[status ?? 'queued']}`}>
      {PROCESS_STAGE_ORDER.map((stage, i) => {
        const Icon = STAGE_ICON[stage]
        const done = terminalReady || (currentIdx >= 0 && i < currentIdx)
        const active = !terminalReady && !terminalFailed && currentIdx === i
        const failedHere = terminalFailed && currentIdx === i
        return (
          <div key={stage} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border',
                done && 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
                active && 'border-teal-500/60 bg-teal-500/15 text-teal-600 animate-pulse dark:text-teal-300',
                failedHere && 'border-rose-500/60 bg-rose-500/10 text-rose-600 dark:text-rose-300',
                !done && !active && !failedHere && 'border-border text-muted-foreground/40',
              )}
              title={STAGE_LABEL[stage]}
            >
              <Icon className="h-3 w-3" />
            </span>
            <span
              className={cn(
                'max-w-full truncate text-[9px] leading-none',
                done && 'text-emerald-600 dark:text-emerald-300',
                active && 'font-medium text-teal-600 dark:text-teal-300',
                failedHere && 'text-rose-600 dark:text-rose-300',
                !done && !active && !failedHere && 'text-muted-foreground/50',
              )}
            >
              {STAGE_LABEL[stage]}
            </span>
          </div>
        )
      })}
      {!terminalReady && !terminalFailed && (
        <span className="w-8 shrink-0 text-right text-[10px] font-medium tabular-nums text-teal-600 dark:text-teal-300">
          {Math.max(0, Math.min(100, Math.round(stageProgress)))}%
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 文件类型徽标
// ---------------------------------------------------------------------------

const TYPE_STYLE: { match: RegExp; icon: LucideIcon; cls: string }[] = [
  { match: /\.pdf$/i, icon: FileText, cls: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300' },
  { match: /\.docx$/i, icon: FileText, cls: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300' },
  { match: /\.(md|markdown)$/i, icon: FileCode2, cls: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300' },
  { match: /\.(html|htm)$/i, icon: FileType2, cls: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300' },
  { match: /\.txt$/i, icon: FileText, cls: 'border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300' },
]

/** URL 导入徽标（emerald Globe） */
const URL_STYLE = { icon: Globe, cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' }

export function FileTypeIcon({
  filename,
  isUrl = false,
  className,
}: {
  filename: string
  isUrl?: boolean
  className?: string
}) {
  if (isUrl) {
    const Icon = URL_STYLE.icon
    return (
      <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md border', URL_STYLE.cls, className)}>
        <Icon className="h-3 w-3" />
      </span>
    )
  }
  const hit = TYPE_STYLE.find((t) => t.match.test(filename)) ?? TYPE_STYLE[4]
  const Icon = hit.icon
  return (
    <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md border', hit.cls, className)}>
      <Icon className="h-3 w-3" />
    </span>
  )
}

/** 文件扩展名（小写，无点） */
export function fileExt(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim())
  return m ? m[1].toLowerCase() : '?'
}

/** 支持的本地文件类型（契约 §26：pdf/docx/md/markdown/txt/html/htm） */
export const ACCEPT_EXTS = ['.pdf', '.docx', '.md', '.markdown', '.txt', '.html', '.htm']
export const ACCEPT_ATTR = ACCEPT_EXTS.join(',')

export function isSupportedFile(name: string): boolean {
  return ACCEPT_EXTS.some((e) => name.toLowerCase().endsWith(e))
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`
}

// ---------------------------------------------------------------------------
// 任务模型（BatchUploadDialog 容器持有，Tabs 子组件纯展示）
// ---------------------------------------------------------------------------

export type FilePhase = 'waiting' | 'uploading' | 'pipeline' | 'ready' | 'failed' | 'dedup'

export interface FileTask {
  id: string
  file: File
  uploadPct: number
  phase: FilePhase
  status?: DocStatus
  stageProgress: number
  errorCode?: string
  errorMessage?: string
  docId?: string
  chunkCount?: number
  tookMs?: number
  startedAt?: number
  endedAt?: number
}

export type UrlPhase = 'waiting' | 'fetching' | 'pipeline' | 'ready' | 'failed' | 'dedup' | 'sitemap'

export interface UrlTask {
  id: string
  url: string
  phase: UrlPhase
  note?: string
  expandedCount?: number
  filename?: string
  docId?: string
  status?: DocStatus
  stageProgress: number
  error?: string
  chunkCount?: number
  tookMs?: number
  startedAt: number
  endedAt?: number
}

export function isFileTerminal(t: FileTask): boolean {
  return t.phase === 'ready' || t.phase === 'failed' || t.phase === 'dedup'
}

export function isUrlTerminal(t: UrlTask): boolean {
  return t.phase === 'ready' || t.phase === 'failed' || t.phase === 'dedup' || t.phase === 'sitemap'
}
