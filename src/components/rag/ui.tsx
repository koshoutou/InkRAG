'use client'

// RAG 知识库平台 · 共享 UI 小组件与常量
// 设计基调：与基座（qdrant workbench）一致的紧凑专业风格

import { useEffect, useState, type ReactNode } from 'react'
import { motion, useSpring, useTransform } from 'framer-motion'
import { AlertCircle, Inbox, Loader2, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { DocStatus, DocType, VectorMode } from './types'
import { formatNumber } from '@/components/qdrant/format'

export { formatNumber, formatBytes, truncate, shortId } from '@/components/qdrant/format'
export { DOC_STATUSES, PROCESSING_STATUSES } from './types'

// ---------------------------------------------------------------------------
// 自定义滚动条（原生 overflow 容器统一使用）
// ---------------------------------------------------------------------------

export const ragScrollbar =
  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/45 [&::-webkit-scrollbar-track]:bg-transparent'

/** 普通视图页容器：自然流（滚动统一收敛到 PlatformShell 的 main）+ 居中内容列 */
export function ViewPage({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className={cn('mx-auto w-full space-y-4 p-4 sm:p-6', wide ? 'max-w-[1600px]' : 'max-w-6xl', className)}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 状态 / 类型徽标（颜色规范：禁止 blue/indigo）
// ---------------------------------------------------------------------------

export const STATUS_META: Record<DocStatus, { label: string; icon: string; badge: string; dot: string; bar: string }> = {
  queued: {
    label: '排队中',
    icon: 'Clock',
    badge: 'border-stone-400/40 bg-stone-500/10 text-stone-600 dark:text-stone-300',
    dot: 'bg-stone-400',
    bar: 'bg-stone-400',
  },
  parsing: {
    label: '解析中',
    icon: 'FileSearch',
    badge: 'border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300',
    dot: 'bg-teal-500',
    bar: 'bg-teal-500',
  },
  chunking: {
    label: '切分中',
    icon: 'Scissors',
    badge: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300',
    dot: 'bg-violet-500',
    bar: 'bg-violet-500',
  },
  embedding: {
    label: '向量化',
    icon: 'Sparkles',
    badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
    dot: 'bg-amber-500',
    bar: 'bg-amber-500',
  },
  upserting: {
    label: '写入向量库',
    icon: 'UploadCloud',
    badge: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300',
    dot: 'bg-orange-500',
    bar: 'bg-orange-500',
  },
  ready: {
    label: '就绪',
    icon: 'CheckCircle2',
    badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    dot: 'bg-emerald-500',
    bar: 'bg-emerald-500',
  },
  failed: {
    label: '失败',
    icon: 'XCircle',
    badge: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300',
    dot: 'bg-rose-500',
    bar: 'bg-rose-500',
  },
}

export const DOC_TYPE_META: Record<DocType, { label: string; badge: string; overlay: string; bar: string; ring: string }> = {
  text: {
    label: '文本',
    badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    overlay: 'border-emerald-500/70 bg-emerald-500/20',
    bar: 'bg-emerald-500',
    ring: 'ring-emerald-600',
  },
  table: {
    label: '表格',
    badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
    overlay: 'border-amber-500/70 bg-amber-500/20',
    bar: 'bg-amber-500',
    ring: 'ring-amber-600',
  },
  code: {
    label: '代码',
    badge: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300',
    overlay: 'border-violet-500/70 bg-violet-500/20',
    bar: 'bg-violet-500',
    ring: 'ring-violet-600',
  },
  image: {
    label: '图片',
    badge: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300',
    overlay: 'border-rose-500/70 bg-rose-500/20',
    bar: 'bg-rose-500',
    ring: 'ring-rose-600',
  },
}

export const JOB_TYPE_META: Record<string, { label: string; badge: string; bar: string }> = {
  parse: { label: '解析', badge: 'border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300', bar: 'bg-teal-500' },
  chunk: { label: '切分', badge: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300', bar: 'bg-violet-500' },
  embed: { label: '向量化', badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300', bar: 'bg-amber-500' },
  upsert: { label: '写入', badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300', bar: 'bg-emerald-500' },
}

export function StatusBadge({ status, className }: { status: DocStatus; className?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.queued
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none',
        meta.badge,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot, status !== 'ready' && status !== 'failed' && 'animate-pulse')} />
      {meta.label}
    </span>
  )
}

export function DocTypeBadge({ type, className }: { type: string; className?: string }) {
  const meta = DOC_TYPE_META[(type as DocType) in DOC_TYPE_META ? (type as DocType) : 'text']
  return (
    <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none', meta.badge, className)}>
      {meta.label}
    </span>
  )
}

/** 向量模式徽标（v1.6 两态：qdrant | unconfigured；本地引擎已移除） */
export function VectorModeBadge({ mode, className }: { mode: VectorMode | null | undefined; className?: string }) {
  if (!mode) return null
  return mode === 'qdrant' ? (
    <Badge variant="outline" className={cn('border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300', className)}>
      Qdrant
    </Badge>
  ) : (
    <Badge variant="outline" className={cn('border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300', className)}>
      未配置 Qdrant
    </Badge>
  )
}

// ---------------------------------------------------------------------------
// 数字动画（CountUp）
// ---------------------------------------------------------------------------

export function CountUp({ value, className }: { value: number; className?: string }) {
  const spring = useSpring(0, { stiffness: 90, damping: 22, mass: 0.6 })
  const display = useTransform(spring, (v) => Math.max(0, Math.round(v)).toLocaleString('en-US'))
  useEffect(() => {
    spring.set(value)
  }, [spring, value])
  return <motion.span className={className}>{display}</motion.span>
}

// ---------------------------------------------------------------------------
// 统计卡
// ---------------------------------------------------------------------------

const ACCENTS: Record<string, string> = {
  primary: 'bg-primary/10 text-primary ring-primary/20',
  emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/20',
  teal: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 ring-teal-500/20',
  amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/20',
  violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 ring-violet-500/20',
  rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 ring-rose-500/20',
  orange: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 ring-orange-500/20',
  stone: 'bg-stone-500/10 text-stone-600 dark:text-stone-400 ring-stone-500/20',
}

export function StatCard({
  icon,
  label,
  value,
  hint,
  accent = 'primary',
  animate = true,
}: {
  icon?: ReactNode
  label: string
  value: number | string
  hint?: string
  accent?: keyof typeof ACCENTS | string
  animate?: boolean
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4 shadow-xs transition-colors hover:border-border">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {icon && (
          <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg ring-1', ACCENTS[accent] ?? ACCENTS.primary)}>
            {icon}
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">
        {typeof value === 'number' && animate ? <CountUp value={value} /> : typeof value === 'number' ? formatNumber(value) : value}
      </div>
      {hint && <div className="mt-1 truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 空态 / 错误 / 加载
// ---------------------------------------------------------------------------

export function EmptyHint({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/70 bg-muted/20 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
        {icon ?? <Inbox className="h-6 w-6" />}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mx-auto max-w-md text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function ErrorCard({
  title = '加载失败',
  message,
  onRetry,
}: {
  title?: string
  message: string
  onRetry?: () => void
}) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[11px] leading-relaxed">{message}</span>
        {onRetry && (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onRetry}>
            <RefreshCw className="h-3 w-3" />
            重试
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function LoadingView({ rows = 4, text = '加载中…' }: { rows?: number; text?: string }) {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="text-xs">{text}</span>
      <span className="hidden">{rows}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 时间格式化
// ---------------------------------------------------------------------------

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = Date.now() - t
  if (diff < 0) return '刚刚'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function formatUptime(sec: number | undefined | null): string {
  if (!sec && sec !== 0) return '—'
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}时${m}分`
  if (m > 0) return `${m}分${s % 60}秒`
  return `${s}秒`
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 短码显示（chunkId / docId） */
export function shortCode(id: string | null | undefined, keep = 8): string {
  if (!id) return '—'
  if (id.length <= keep * 2) return id
  return `${id.slice(0, keep)}…${id.slice(-4)}`
}

/** 布尔开关徽标 */
export function BoolBadge({ value, trueLabel = '开启', falseLabel = '关闭' }: { value: boolean; trueLabel?: string; falseLabel?: string }) {
  return value ? (
    <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-300">
      {trueLabel}
    </Badge>
  ) : (
    <Badge variant="outline" className="border-stone-400/40 bg-stone-500/10 text-[10px] text-stone-500 dark:text-stone-400">
      {falseLabel}
    </Badge>
  )
}

/** 防抖 hook（沙盒参数预览等场景） */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
