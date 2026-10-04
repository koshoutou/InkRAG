'use client'

// 仪表盘：统计卡 / 状态机分布 / 最近文档 / 队列概况
// 数据：GET /api/dashboard；socket global 房间事件触发自动刷新
// §32（Task 17-1）：检索质量趋势卡与最近检索日志已随对外检索 API 一并移除（平台定位收敛为知识库管理）

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  Boxes,
  Database,
  FileText,
  Layers,
  Library,
  ListChecks,
  PauseCircle,
  Power,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ragApi } from '../api'
import { usePlatformStore } from '../store'
import { ensureQuickActionBridge } from '../useQuickAction'
import { useRealtime } from '../useRealtime'
import {
  DOC_STATUSES,
  STATUS_META,
  ErrorCard,
  ParseEngineBadge,
  StatCard,
  StatusBadge,
  ViewPage,
  formatNumber,
  timeAgo,
} from '../ui'

// 常驻事件桥锚点：默认视图（dashboard）随应用启动加载，保证契约 §19 的快捷动作
// window 监听先于任何命令面板派发就绪（跨视图回放依赖它）
ensureQuickActionBridge()

// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  return (
    <ViewPage>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </ViewPage>
  )
}

export function DashboardView() {
  const queryClient = useQueryClient()
  const setView = usePlatformStore((s) => s.setView)
  const { subscribeRooms, on } = useRealtime()

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => ragApi.getDashboard(),
    refetchInterval: 30_000,
  })

  // global 房间实时事件 → 自动刷新
  useEffect(() => {
    subscribeRooms(['global'])
    const un1 = on('document:status', () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }))
    const un2 = on('document:done', () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }))
    const un3 = on('kb:stats', () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }))
    const un4 = on('pipeline:activity', () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }))
    return () => {
      un1()
      un2()
      un3()
      un4()
    }
  }, [subscribeRooms, on, queryClient])

  if (isLoading) return <DashboardSkeleton />

  if (error) {
    return (
      <ViewPage>
        <ErrorCard
          title="仪表盘数据加载失败"
          message={error instanceof Error ? error.message : String(error)}
          onRetry={() => refetch()}
        />
      </ViewPage>
    )
  }

  const d = data?.dashboard
  if (!d) return null

  const statusFlow = DOC_STATUSES.map((s) => ({ status: s, count: d.statusFlow?.[s] ?? 0 }))
  const flowTotal = statusFlow.reduce((acc, x) => acc + x.count, 0)

  return (
    <ViewPage wide>
      {/* FE-005：流水线引擎状态横幅（paused=备份/恢复期间暂停认领；draining=优雅关闭进行中） */}
      {d.pipeline?.draining && (
        <div className="mb-3 flex items-center gap-2.5 rounded-lg border border-rose-300/60 bg-rose-50 px-4 py-2.5 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-300">
          <Power className="h-4 w-4 shrink-0 animate-pulse" />
          <span className="font-medium">服务正在关闭</span>
          <span className="text-rose-600/80 dark:text-rose-400/80">
            · 正在排空活跃任务（优雅关闭），不再接收新任务。{d.pipeline.active > 0 ? `当前 ${d.pipeline.active} 个活跃任务收尾中。` : ''}
          </span>
        </div>
      )}
      {d.pipeline?.paused && !d.pipeline?.draining && (
        <div className="mb-3 flex items-center gap-2.5 rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-2.5 text-sm text-amber-700 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-300">
          <PauseCircle className="h-4 w-4 shrink-0" />
          <span className="font-medium">流水线已暂停</span>
          <span className="text-amber-600/80 dark:text-amber-400/80">
            · {d.pipeline.pausedReason || '备份/恢复进行中'}：活跃任务继续运行，新任务暂停认领。
          </span>
        </div>
      )}

      {/* 统计卡 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard icon={<Library className="h-4 w-4" />} label="知识库" value={d.totals.kbs} accent="primary" hint={`启用 chunk ${formatNumber(d.totals.enabledChunks)}`} />
        <StatCard icon={<FileText className="h-4 w-4" />} label="文档总数" value={d.totals.docs} accent="teal" hint={`就绪 ${d.totals.docsReady} · 失败 ${d.totals.docsFailed}`} />
        <StatCard icon={<Layers className="h-4 w-4" />} label="Chunk 总数" value={d.totals.chunks} accent="violet" />
        <StatCard icon={<Database className="h-4 w-4" />} label="向量点数" value={d.totals.points} accent="emerald" />
        <StatCard icon={<Sparkles className="h-4 w-4" />} label="处理中" value={d.totals.docsProcessing} accent="amber" hint="解析/切分/向量化/写入" />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="失败文档" value={d.totals.docsFailed} accent="rose" />
      </div>

      {/* 状态机分布条（统计卡与最近文档之间） */}
      <div className="rounded-xl border border-border/60 bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium">文档状态机分布</span>
          {isRefetching && <span className="text-[10px] text-muted-foreground">刷新中…</span>}
        </div>
        {flowTotal === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">暂无文档 —— 上传第一个文档后这里会显示各状态分布</p>
        ) : (
          <>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`状态分布，共 ${flowTotal} 个文档`}>
              {statusFlow
                .filter((x) => x.count > 0)
                .map((x) => (
                  <TooltipProvider key={x.status}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div
                          className={STATUS_META[x.status].bar}
                          style={{ width: `${(x.count / flowTotal) * 100}%` }}
                        />
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">
                        {STATUS_META[x.status].label}：{x.count} 个（{((x.count / flowTotal) * 100).toFixed(1)}%）
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ))}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {statusFlow.map((x) => (
                <span key={x.status} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className={`h-2 w-2 rounded-full ${STATUS_META[x.status].dot}`} />
                  {STATUS_META[x.status].label}
                  <span className="font-medium tabular-nums text-foreground">{x.count}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* FE-006：流水线引擎状态卡（uptime/吞吐/成功率/并发槽） */}
      {d.pipeline && (
        <div className="rounded-xl border border-border/60 bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
              流水线引擎
            </span>
            <div className="flex items-center gap-2 text-[11px]">
              {d.pipeline.draining ? (
                <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500" />
                  关闭中
                </span>
              ) : d.pipeline.paused ? (
                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  已暂停
                </span>
              ) : (
                <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                  运行中
                </span>
              )}
              {isRefetching && <span className="text-muted-foreground">刷新中…</span>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {/* 队列：pending + waiting */}
            <div className="rounded-lg bg-muted/40 px-3 py-2">
              <div className="text-[10px] text-muted-foreground">队列</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">
                {d.pipeline.pending + d.pipeline.waiting}
              </div>
              <div className="text-[10px] text-muted-foreground">
                pending {d.pipeline.pending} · waiting {d.pipeline.waiting}
              </div>
            </div>
            {/* 活跃 */}
            <div className="rounded-lg bg-muted/40 px-3 py-2">
              <div className="text-[10px] text-muted-foreground">活跃</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums text-sky-600 dark:text-sky-400">
                {d.pipeline.active}
                <span className="text-xs text-muted-foreground"> / {d.pipeline.concurrency || 2}</span>
              </div>
              <div className="text-[10px] text-muted-foreground">并发槽</div>
            </div>
            {/* 完成 */}
            <div className="rounded-lg bg-muted/40 px-3 py-2">
              <div className="text-[10px] text-muted-foreground">已完成</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {d.pipeline.completed}
              </div>
              <div className="text-[10px] text-muted-foreground">累计</div>
            </div>
            {/* 失败 */}
            <div className="rounded-lg bg-muted/40 px-3 py-2">
              <div className="text-[10px] text-muted-foreground">失败</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                {d.pipeline.failed}
              </div>
              <div className="text-[10px] text-muted-foreground">累计</div>
            </div>
            {/* 成功率 */}
            <div className="rounded-lg bg-muted/40 px-3 py-2">
              <div className="text-[10px] text-muted-foreground">成功率</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">
                {d.pipeline.completed + d.pipeline.failed > 0
                  ? ((d.pipeline.completed / (d.pipeline.completed + d.pipeline.failed)) * 100).toFixed(1) + '%'
                  : '—'}
              </div>
              <div className="text-[10px] text-muted-foreground">完成/总</div>
            </div>
            {/* 引擎运行时长 */}
            <div className="rounded-lg bg-muted/40 px-3 py-2">
              <div className="text-[10px] text-muted-foreground">运行时长</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">
                {d.pipeline.uptimeSec >= 3600
                  ? `${Math.floor(d.pipeline.uptimeSec / 3600)}h${Math.floor((d.pipeline.uptimeSec % 3600) / 60)}m`
                  : d.pipeline.uptimeSec >= 60
                    ? `${Math.floor(d.pipeline.uptimeSec / 60)}m${d.pipeline.uptimeSec % 60}s`
                    : `${d.pipeline.uptimeSec}s`}
              </div>
              <div className="text-[10px] text-muted-foreground">进程内</div>
            </div>
          </div>
        </div>
      )}

      {/* FE-013: 流水线吞吐趋势图（近 24h 按小时桶完成/失败数） */}
      {d.throughputTrend && d.throughputTrend.length > 0 && (() => {
        const trend = d.throughputTrend
        const totalCompleted = trend.reduce((a, b) => a + b.completed, 0)
        const totalFailed = trend.reduce((a, b) => a + b.failed, 0)
        const hasData = totalCompleted > 0 || totalFailed > 0
        return (
          <div className="rounded-xl border border-border/60 bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                流水线吞吐趋势
              </span>
              <div className="flex items-center gap-3 text-[11px]">
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  完成 {totalCompleted}
                </span>
                <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                  失败 {totalFailed}
                </span>
                <span className="text-muted-foreground">近 24h</span>
              </div>
            </div>
            {hasData ? (
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={trend} margin={{ top: 5, right: 8, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradCompleted" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradFailed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
                  <XAxis
                    dataKey="hour"
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    interval={3}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    allowDecimals={false}
                    axisLine={false}
                    tickLine={false}
                    width={28}
                  />
                  <RTooltip
                    contentStyle={{
                      fontSize: 11,
                      borderRadius: 8,
                      border: '1px solid hsl(var(--border))',
                      background: 'hsl(var(--card))',
                      color: 'hsl(var(--card-foreground))',
                    }}
                    labelStyle={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="completed"
                    name="完成"
                    stroke="#10b981"
                    strokeWidth={1.5}
                    fill="url(#gradCompleted)"
                  />
                  <Area
                    type="monotone"
                    dataKey="failed"
                    name="失败"
                    stroke="#f43f5e"
                    strokeWidth={1.5}
                    fill="url(#gradFailed)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-40 items-center justify-center text-[11px] text-muted-foreground">
                近 24h 无完成/失败任务
              </div>
            )}
          </div>
        )
      })()}

      {/* FE-011: 按解析引擎分布统计卡（MinerU / 本地引擎 / 未解析 占比） */}
      {d.engineDistribution && (() => {
        const dist = d.engineDistribution
        const mineru = dist.mineru ?? 0
        const fallback = dist.fallback ?? 0
        const pending = dist.pending ?? 0
        const total = mineru + fallback + pending
        if (total === 0) return null
        const pct = (n: number) => ((n / total) * 100).toFixed(1)
        return (
          <div className="rounded-xl border border-border/60 bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                解析引擎分布
              </span>
              <span className="text-[11px] text-muted-foreground">共 {total} 个文档</span>
            </div>
            {/* 堆叠条 */}
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`引擎分布，共 ${total} 个文档`}>
              {mineru > 0 && (
                <div className="bg-sky-500" style={{ width: `${(mineru / total) * 100}%` }} title={`MinerU: ${mineru}`} />
              )}
              {fallback > 0 && (
                <div className="bg-amber-500" style={{ width: `${(fallback / total) * 100}%` }} title={`本地引擎: ${fallback}`} />
              )}
              {pending > 0 && (
                <div className="bg-stone-400" style={{ width: `${(pending / total) * 100}%` }} title={`未解析: ${pending}`} />
              )}
            </div>
            {/* 图例 */}
            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {[
                { label: 'MinerU', count: mineru, color: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400' },
                { label: '本地引擎', count: fallback, color: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
                { label: '未解析', count: pending, color: 'bg-stone-400', text: 'text-stone-500 dark:text-stone-400' },
              ].map((item) => (
                <span key={item.label} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className={`h-2 w-2 rounded-full ${item.color}`} />
                  {item.label}
                  <span className={`font-medium tabular-nums ${item.text}`}>{item.count}</span>
                  <span className="text-muted-foreground/70">({pct(item.count)}%)</span>
                </span>
              ))}
            </div>
          </div>
        )
      })()}

      {/* 最近文档（全宽；原第二列「最近检索日志」已随 §32 移除） */}
      <div className="rounded-xl border border-border/60 bg-card">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <span className="text-sm font-medium">最近文档</span>
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setView('docs')}>
            <FileText className="h-3 w-3" />
            文档中心
          </Button>
        </div>
        {d.recentDocs.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">暂无文档</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="h-8 text-[11px]">文件名</TableHead>
                  <TableHead className="h-8 text-[11px]">知识库</TableHead>
                  <TableHead className="h-8 text-[11px]">引擎</TableHead>
                  <TableHead className="h-8 text-[11px]">状态</TableHead>
                  <TableHead className="h-8 text-[11px] text-right">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.recentDocs.map((doc) => (
                  <TableRow key={doc.id} className="cursor-pointer" onClick={() => {
                    usePlatformStore.getState().setKb(doc.kbId)
                    usePlatformStore.getState().setDoc(doc.id)
                    setView('viewer')
                  }}>
                    <TableCell className="max-w-[320px] truncate py-2 text-xs font-medium">{doc.filename}</TableCell>
                    <TableCell className="max-w-[160px] truncate py-2 text-xs text-muted-foreground">{doc.kbName}</TableCell>
                    <TableCell className="py-2"><ParseEngineBadge engine={doc.parseEngine} /></TableCell>
                    <TableCell className="py-2"><StatusBadge status={doc.status} /></TableCell>
                    <TableCell className="py-2 text-right text-[11px] text-muted-foreground">{timeAgo(doc.updatedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* 队列概况 */}
      <div className="rounded-xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">流水线队列概况</span>
          </div>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setView('ops')}>
            <Activity className="h-3 w-3" />
            前往系统运维
          </Button>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Boxes className="h-3 w-3" /> 待处理 (pending)
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{d.jobs.pending}</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Sparkles className="h-3 w-3" /> 执行中 (active)
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{d.jobs.active}</div>
          </div>
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <AlertTriangle className="h-3 w-3 text-rose-500" /> 失败 (failed)
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-rose-600 dark:text-rose-400">{d.jobs.failed}</div>
          </div>
        </div>
      </div>
    </ViewPage>
  )
}
