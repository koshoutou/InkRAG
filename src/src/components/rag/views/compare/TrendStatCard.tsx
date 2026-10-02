'use client'

// 文档文档版本管理 · 趋势统计卡（v1 → v2 数值变化 + 趋势箭头，Task 9-c）

import type { ReactNode } from 'react'
import { ArrowRight, Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatNumber } from '../../ui'

export function TrendStatCard({
  icon,
  label,
  from,
  to,
  unit,
}: {
  icon?: ReactNode
  label: string
  from: number
  to: number
  unit?: string
}) {
  const delta = to - from
  const flat = delta === 0
  const up = delta > 0
  const pct = from > 0 ? (delta / from) * 100 : null
  const deltaClass = flat
    ? 'text-muted-foreground'
    : up
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-rose-600 dark:text-rose-400'
  const TrendIcon = flat ? Minus : up ? TrendingUp : TrendingDown
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4 shadow-xs transition-colors hover:border-border">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {icon && (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
            {icon}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xl font-semibold tabular-nums tracking-tight">
        <span className="text-muted-foreground/70">{formatNumber(from)}</span>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
        <span>{formatNumber(to)}</span>
        <TrendIcon className={cn('h-4 w-4 shrink-0', deltaClass)} aria-hidden />
      </div>
      <div className={cn('mt-1 text-[11px] tabular-nums', deltaClass)}>
        {flat
          ? '无变化'
          : `${up ? '+' : '-'}${formatNumber(Math.abs(delta))}${unit ? ` ${unit}` : ''}${
              pct !== null ? `（${up ? '+' : '-'}${Math.abs(pct).toFixed(1)}%）` : ''
            }`}
      </div>
    </div>
  )
}
