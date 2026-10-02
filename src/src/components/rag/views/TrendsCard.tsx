'use client'

// 检索质量趋势卡（契约 §14，/api/dashboard/trends，数据源 QdrantCallLog）
// —— 从 DashboardView 提取为独立卡组件（Task 11-b），新增：
//    1) KB 维度过滤 chips（全部 + 各知识库，数据源 ragApi.listKbs()）
//    2) 下钻扩展：模式分布条 / 热门查询可点击 → 跳转检索调试台（CustomEvent 携带上下文）
//
// 【跨视图下钻契约（§19 扩展）——本卡为派发端】
//    - 点击图表某天   → store.retrievalDateFilter = 'YYYY-MM-DD'（zustand，检索台已有消费端）
//    - 点击模式分布条 → window CustomEvent 'rag:goto-retrieval'  detail { mode: 'hybrid'|'dense'|'sparse' }
//    - 点击热门查询   → window CustomEvent 'rag:prefill-query'   detail { query: string }
//    【消费端待接入（后续轮次，不归本文件）】检索调试台 RetrievalDebugView 挂载时监听：
//      window.addEventListener('rag:goto-retrieval', (e) => {
//        const mode = (e as CustomEvent<{ mode: string }>).detail?.mode  // 预选检索模式
//        ...
//      })
//      window.addEventListener('rag:prefill-query', (e) => {
//        const query = (e as CustomEvent<{ query: string }>).detail?.query  // 预填查询输入框
//        ...
//      })
//    时序兜底：检索台视图为 dynamic() 懒加载，setView 后立即 dispatch 会因无监听者丢事件，
//    故先 setView 触发加载，再 setTimeout(250ms) 派发（简单兜底，等目标视图挂载完成）。

import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis, type TooltipProps } from 'recharts'
import { Loader2, MousePointerClick, RefreshCw, SearchX, TrendingUp } from 'lucide-react'
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import { ragApi } from '../api'
import { usePlatformStore } from '../store'
import type { ModeBreakdownItem, TrendDay } from '../types'

// ---------------------------------------------------------------------------
// 常量与辅助
// ---------------------------------------------------------------------------

const TRENDS_RANGES = [7, 14, 30]

/** 懒加载兜底延迟：setView → 检索台 dynamic() 挂载 → 再派发 CustomEvent（见文件头注释） */
const DRILLDOWN_EVENT_DELAY_MS = 250
/** 下钻事件缓冲（契约 §19 双通道）：派发前先写 window 缓冲，再延迟 dispatch 实时事件；
 *  消费端挂载时读缓冲（TTL 8s 内有效，常量在 RetrievalDebugView）先到先消费 */
interface DrillPending {
  ts: number
  kind: 'goto-retrieval' | 'prefill-query'
  detail: { mode?: string; query?: string; kbId?: string }
}

function stashDrillPending(kind: DrillPending['kind'], detail: DrillPending['detail']): void {
  ;(window as unknown as { __ragDrillPending?: DrillPending }).__ragDrillPending = {
    ts: Date.now(),
    kind,
    detail,
  }
}

/** 模式分布颜色（仅 emerald/amber/teal/stone，禁止蓝紫） */
const MODE_META: Record<string, { bar: string; badge: string }> = {
  hybrid: {
    bar: 'bg-emerald-500',
    badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  },
  dense: {
    bar: 'bg-amber-500',
    badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  },
  sparse: {
    bar: 'bg-teal-500',
    badge: 'border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300',
  },
}
const MODE_FALLBACK = { bar: 'bg-stone-400', badge: 'border-stone-400/40 bg-stone-500/10 text-stone-600 dark:text-stone-300' }

const trendsChartConfig = {
  searches: { label: '检索次数', color: '#10b981' },
  p95: { label: 'P95 耗时', color: '#f59e0b' },
} satisfies ChartConfig

function sourceLabel(source: string): string {
  if (source === 'external') return 'API'
  if (source === 'debug-console') return '调试台'
  if (source === 'web-ui') return 'Web'
  return source
}

function TrendsTooltipRow({ dotClass, children }: { dotClass: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <span className={cn('h-2 w-2 shrink-0 rounded-[2px]', dotClass)} />
      <span className="tabular-nums">{children}</span>
    </div>
  )
}

/** 自定义图表 tooltip：日期 / 检索次数 / P95 / 平均耗时 / 空结果 */
function TrendsTooltipContent({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  const point = payload[0]?.payload as TrendDay | undefined
  if (!point) return null
  return (
    <div className="grid min-w-[9.5rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{label}</div>
      <div className="grid grid-cols-1 gap-1">
        <TrendsTooltipRow dotClass="bg-emerald-500">检索次数：{point.searches}</TrendsTooltipRow>
        <TrendsTooltipRow dotClass="bg-amber-500">P95 耗时：{point.p95Ms}ms</TrendsTooltipRow>
        <TrendsTooltipRow dotClass="bg-teal-500">平均耗时：{point.avgMs}ms</TrendsTooltipRow>
        <TrendsTooltipRow dotClass="bg-stone-400">空结果：{point.zeroResults} 次</TrendsTooltipRow>
      </div>
    </div>
  )
}

/** 空数据占位：居中 muted 图标 + 文案（区分全平台空态 / 单 KB 空态） */
function TrendsEmptyState({ kbSelected }: { kbSelected: boolean }) {
  return (
    <div className="mt-3 flex h-[180px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/20 text-muted-foreground">
      <SearchX className="h-6 w-6 opacity-60" aria-hidden />
      <span className="text-xs">{kbSelected ? '该知识库暂无检索记录' : '暂无检索记录'}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function TrendsCard() {
  const setView = usePlatformStore((s) => s.setView)
  const [days, setDays] = useState(14)
  /** KB 维度过滤：null = 全部知识库（全平台） */
  const [kbId, setKbId] = useState<string | null>(null)

  // KB 列表（chips 数据源，与 KnowledgeBasesView 共用 queryKey 缓存）
  const kbsQuery = useQuery({
    queryKey: ['kbs'],
    queryFn: () => ragApi.listKbs(),
    staleTime: 60_000,
    retry: 1,
  })
  const kbs = kbsQuery.data?.kbs ?? []
  // 守卫：选中的 KB 已被删除 → 回退「全部」
  const effectiveKbId = kbId && kbs.some((k) => k.id === kbId) ? kbId : null
  const selectedKbName = effectiveKbId ? kbs.find((k) => k.id === effectiveKbId)?.name : undefined

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['dashboard-trends', days, effectiveKbId ?? 'all'],
    queryFn: () => ragApi.getDashboardTrends(days, effectiveKbId ?? undefined),
    staleTime: 30_000,
    retry: 2,
  })

  // 趋势下钻（契约 §19，已有行为）：点击某天 → 写入下钻日期 + 跳转检索调试台
  // （目标视图挂载时消费 retrievalDateFilter 并打开历史侧栏按日过滤，消费后清除）
  // 注：recharts 2.15 axis-tooltip 模式下 Area 的 item 级 onClick 不会透传，
  // 需挂 ComposedChart 级 onClick（nextState.activePayload 含点击命中的数据点）
  const handleDayClick = (nextState: unknown) => {
    const date = (nextState as { activePayload?: { payload?: { date?: string } }[] } | null | undefined)
      ?.activePayload?.[0]?.payload?.date
    if (!date) return
    usePlatformStore.getState().setRetrievalDateFilter(date)
    setView('retrieval')
  }

  // 下钻扩展①：点击模式分布条 → 检索调试台并携带该模式（+ 当前 KB 过滤上下文）
  // 双通道：先写 __ragDrillPending 缓冲（懒加载挂载慢时兑底），再延迟 dispatch 实时事件
  const handleModeClick = (mode: string) => {
    stashDrillPending('goto-retrieval', { mode, ...(effectiveKbId ? { kbId: effectiveKbId } : {}) })
    setView('retrieval')
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('rag:goto-retrieval', {
          detail: { mode, ...(effectiveKbId ? { kbId: effectiveKbId } : {}) },
        }),
      )
    }, DRILLDOWN_EVENT_DELAY_MS)
    toast.success('已跳转检索调试台', { description: `模式：${mode}${selectedKbName ? ` · ${selectedKbName}` : ''}` })
  }

  // 下钻扩展②：点击热门查询 → 检索调试台并预填该查询（+ 当前 KB 过滤上下文）
  const handleQueryClick = (query: string) => {
    stashDrillPending('prefill-query', { query, ...(effectiveKbId ? { kbId: effectiveKbId } : {}) })
    setView('retrieval')
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('rag:prefill-query', {
          detail: { query, ...(effectiveKbId ? { kbId: effectiveKbId } : {}) },
        }),
      )
    }, DRILLDOWN_EVENT_DELAY_MS)
    toast.success('已跳转检索调试台', { description: `已预填查询：${query}` })
  }

  const t = data?.trends
  const hasData = (t?.totals.searches ?? 0) > 0

  // 模式分布行：固定 hybrid/dense/sparse 顺序（缺失补 0），附加未知模式
  const modeMap = new Map<string, ModeBreakdownItem>((t?.modeBreakdown ?? []).map((m) => [m.mode, m]))
  const fixedRows: ModeBreakdownItem[] = (['hybrid', 'dense', 'sparse'] as const).map((m) =>
    modeMap.get(m) ?? { mode: m, count: 0, avgMs: 0 },
  )
  const extraRows = (t?.modeBreakdown ?? []).filter((m) => !['hybrid', 'dense', 'sparse'].includes(m.mode))
  const allModeRows = [...fixedRows, ...extraRows]
  const modeTotal = allModeRows.reduce((acc, m) => acc + m.count, 0)

  const top5 = (t?.topQueries ?? []).slice(0, 5)

  const zeroRate = t?.totals.zeroRate ?? 0
  const zeroBadgeClass =
    zeroRate > 0.2
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400'
      : zeroRate > 0.05
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300'
        : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'

  // 选中 KB 时汇总行展示 KB 名（区分过滤上下文）
  const scopeLabel = selectedKbName ? (
    <>
      <Badge variant="outline" className="h-5 max-w-[12rem] truncate px-1.5 text-[10px] font-medium">
        {selectedKbName}
      </Badge>
      <span>近 {days} 天</span>
    </>
  ) : (
    <span>近 {days} 天</span>
  )

  // 选中 chip 的计数徽标：该过滤维度下的检索次数（trends.totals.searches，随当前查询加载）
  const chipCount = hasData ? t?.totals.searches : undefined

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="rounded-xl border border-border/60 bg-card p-4 sm:p-6"
    >
      {/* 卡头：标题 + （KB 过滤 chips + 范围切换）。md 以上同行右侧，窄屏换行 */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex h-7 items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
            <TrendingUp className="h-4 w-4" />
          </span>
          <span className="text-sm font-medium">检索质量趋势</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-start gap-x-3 gap-y-2 md:min-w-0 md:flex-none md:justify-end">
          {/* KB 维度过滤 chips（风格对齐文档版本管理视图过滤 chips） */}
          <div className="flex max-w-full flex-wrap items-center gap-1.5" role="group" aria-label="知识库维度过滤">
            <button
              type="button"
              onClick={() => setKbId(null)}
              aria-pressed={effectiveKbId === null}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                effectiveKbId === null
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border/60 bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              全部
              {effectiveKbId === null && chipCount !== undefined && (
                <span className="tabular-nums opacity-80">{chipCount}</span>
              )}
            </button>
            {kbsQuery.isLoading
              ? [0, 1].map((i) => <Skeleton key={i} className="h-7 w-20 rounded-full" aria-hidden />)
              : kbs.map((kb) => {
                  const active = effectiveKbId === kb.id
                  return (
                    <button
                      key={kb.id}
                      type="button"
                      onClick={() => setKbId(kb.id)}
                      aria-pressed={active}
                      title={kb.name}
                      className={cn(
                        'inline-flex h-7 max-w-[11rem] items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                        active
                          ? 'border-primary/50 bg-primary/10 text-primary'
                          : 'border-border/60 bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                      )}
                    >
                      <span className="min-w-0 truncate">{kb.name}</span>
                      {active && chipCount !== undefined && (
                        <span className="shrink-0 tabular-nums opacity-80">{chipCount}</span>
                      )}
                    </button>
                  )
                })}
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            value={String(days)}
            onValueChange={(v) => v && setDays(Number(v))}
            className="h-8"
          >
            {TRENDS_RANGES.map((d) => (
              <ToggleGroupItem key={d} value={String(d)} className="h-7 px-2.5 text-xs">
                {d}天
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {isLoading ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-[180px] w-full" />
        </div>
      ) : error || !t ? (
        <div className="mt-3 flex flex-col items-center gap-2 py-8 text-xs text-muted-foreground">
          <span>趋势数据加载失败</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            {isRefetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            重试
          </Button>
        </div>
      ) : (
        <>
          {/* 汇总徽标行（选中 KB 时带 KB 名徽标） */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
            {scopeLabel}
            <span>
              <span className="font-medium tabular-nums text-foreground">{t.totals.searches}</span> 次检索
            </span>
            <span>·</span>
            <span>
              平均 <span className="font-medium tabular-nums text-foreground">{t.totals.avgMs}ms</span>
            </span>
            <span>·</span>
            <span>
              P95 <span className="font-medium tabular-nums text-foreground">{t.totals.p95Ms}ms</span>
            </span>
            <Badge variant="outline" className={cn('text-[10px]', zeroBadgeClass)}>
              空结果率 {(zeroRate * 100).toFixed(0)}%
            </Badge>
          </div>

          {/* 主图：每日检索次数（左轴 Area）+ P95 耗时（右轴 Line）；点击 Area 下钻当日 */}
          {hasData ? (
            <>
              <ChartContainer config={trendsChartConfig} className="mt-3 h-[180px] w-full aspect-auto cursor-pointer">
                <ComposedChart data={t.days} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} onClick={handleDayClick}>
                  <defs>
                    <linearGradient id="trendsFillSearches" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-searches)" stopOpacity={0.65} />
                      <stop offset="95%" stopColor="var(--color-searches)" stopOpacity={0.08} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    minTickGap={24}
                    fontSize={10}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis yAxisId="left" allowDecimals={false} tickLine={false} axisLine={false} width={28} fontSize={10} />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickLine={false}
                    axisLine={false}
                    width={40}
                    fontSize={10}
                    tickFormatter={(v: number) => `${v}ms`}
                  />
                  <ChartTooltip cursor={false} content={<TrendsTooltipContent />} />
                  <Area
                    yAxisId="left"
                    dataKey="searches"
                    name="searches"
                    type="monotone"
                    stroke="var(--color-searches)"
                    strokeWidth={2}
                    fill="url(#trendsFillSearches)"
                  />
                  <Line
                    yAxisId="right"
                    dataKey="p95Ms"
                    name="p95"
                    type="monotone"
                    stroke="var(--color-p95)"
                    strokeWidth={1.5}
                    dot={{ r: 2, fill: 'var(--color-p95)', strokeWidth: 0 }}
                    activeDot={{ r: 3 }}
                  />
                </ComposedChart>
              </ChartContainer>
              {/* 图例（手动：标注双轴 + 点击下钻提示样式） */}
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-[2px] bg-emerald-500" />检索次数（左轴）
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-[2px] bg-amber-500" />P95 耗时（右轴）
                </span>
                <span className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground/90 transition-colors hover:bg-muted/80 hover:text-foreground">
                  <MousePointerClick className="h-3 w-3 shrink-0" />
                  点击图表 / 模式 / 查询跳转检索调试台
                </span>
              </div>
            </>
          ) : (
            <TrendsEmptyState kbSelected={effectiveKbId !== null} />
          )}

          {/* 下部两栏：模式分布 + 热门查询（窄屏堆叠；均可点击下钻）
              grid-cols-1 = minmax(0,1fr)：防 auto 轨道被长查询 max-content 撑爆 375px */}
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* 左：模式分布水平条（点击 → 检索调试台 + 模式，事件见文件头注释） */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="text-[11px] font-medium text-muted-foreground">检索模式分布</div>
              {modeTotal === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {effectiveKbId ? '该知识库暂无检索记录' : '暂无检索记录'}
                </p>
              ) : (
                <div className="mt-2.5 space-y-2.5">
                  {allModeRows.map((m) => {
                    const meta = MODE_META[m.mode] ?? MODE_FALLBACK
                    const pct = modeTotal > 0 ? (m.count / modeTotal) * 100 : 0
                    return (
                      <TooltipProvider key={m.mode}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              role="button"
                              tabIndex={0}
                              aria-label={`按 ${m.mode} 模式跳转检索调试台`}
                              onClick={() => handleModeClick(m.mode)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  handleModeClick(m.mode)
                                }
                              }}
                              className="-mx-1 flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span className="w-14 shrink-0 font-mono text-[11px]">{m.mode}</span>
                              <Badge variant="outline" className={cn('h-5 shrink-0 px-1.5 text-[10px] tabular-nums', meta.badge)}>
                                {m.count}
                              </Badge>
                              <div
                                className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
                                role="progressbar"
                                aria-label={`${m.mode} 占比 ${((m.count / modeTotal) * 100).toFixed(0)}%`}
                                aria-valuenow={Math.round(pct)}
                              >
                                <div className={cn('h-full rounded-full', meta.bar)} style={{ width: `${pct}%` }} />
                              </div>
                              <span className="w-24 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                                {pct.toFixed(0)}% · {m.avgMs}ms
                              </span>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">点击查看 → 检索调试台（{m.mode}）</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 右：热门查询 Top 5（点击 → 检索调试台 + 预填查询，事件见文件头注释） */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="text-[11px] font-medium text-muted-foreground">热门查询 Top 5</div>
              {top5.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {effectiveKbId ? '该知识库暂无检索记录' : '暂无'}
                </p>
              ) : (
                <ul className="mt-2.5 space-y-1.5">
                  {top5.map((q, i) => (
                    <TooltipProvider key={q.query}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <li
                            role="button"
                            tabIndex={0}
                            aria-label={`预填查询「${q.query}」并跳转检索调试台`}
                            onClick={() => handleQueryClick(q.query)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                handleQueryClick(q.query)
                              }
                            }}
                            className="-mx-1 flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
                            <span className="min-w-0 flex-1 truncate">{q.query}</span>
                            <Badge
                              variant="outline"
                              className="h-5 shrink-0 px-1.5 text-[10px] tabular-nums border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                            >
                              ×{q.count}
                            </Badge>
                            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{q.avgMs}ms</span>
                            <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] text-muted-foreground">
                              {sourceLabel(q.source)}
                            </Badge>
                          </li>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[280px] break-all text-xs">
                          <div>{q.query}</div>
                          <div className="text-[10px] text-muted-foreground">点击查看 → 检索调试台</div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </motion.div>
  )
}
