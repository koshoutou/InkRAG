'use client'

// 仪表盘：统计卡 / 状态机分布 / 检索质量趋势 / 最近文档 / 最近检索日志 / 队列概况
// 数据：GET /api/dashboard + GET /api/dashboard/trends；socket global 房间事件触发自动刷新
// 检索质量趋势卡已提取为独立组件 ./TrendsCard（Task 11-b：KB 维度过滤 + 下钻扩展）

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
  Search,
  Sparkles,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ragApi } from '../api'
import { usePlatformStore } from '../store'
import { ensureQuickActionBridge } from '../useQuickAction'
import { useRealtime } from '../useRealtime'
import { TrendsCard } from './TrendsCard'
import {
  DOC_STATUSES,
  STATUS_META,
  ErrorCard,
  StatCard,
  StatusBadge,
  ViewPage,
  formatDateTime,
  formatNumber,
  shortCode,
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
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
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
      {/* 统计卡 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard icon={<Library className="h-4 w-4" />} label="知识库" value={d.totals.kbs} accent="primary" hint={`启用 chunk ${formatNumber(d.totals.enabledChunks)}`} />
        <StatCard icon={<FileText className="h-4 w-4" />} label="文档总数" value={d.totals.docs} accent="teal" hint={`就绪 ${d.totals.docsReady} · 失败 ${d.totals.docsFailed}`} />
        <StatCard icon={<Layers className="h-4 w-4" />} label="Chunk 总数" value={d.totals.chunks} accent="violet" />
        <StatCard icon={<Database className="h-4 w-4" />} label="向量点数" value={d.totals.points} accent="emerald" />
        <StatCard icon={<Sparkles className="h-4 w-4" />} label="处理中" value={d.totals.docsProcessing} accent="amber" hint="解析/切分/向量化/写入" />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="失败文档" value={d.totals.docsFailed} accent="rose" />
      </div>

      {/* 检索质量趋势（统计卡与最近文档表之间） */}
      <TrendsCard />

      {/* 状态机分布条 */}
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

      {/* grid-cols-1 = minmax(0,1fr)：防 auto 轨道被表格/长文本 max-content 撑爆 375px（与 TrendsCard 同类修复） */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 最近文档 */}
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
                      <TableCell className="max-w-[220px] truncate py-2 text-xs font-medium">{doc.filename}</TableCell>
                      <TableCell className="max-w-[120px] truncate py-2 text-xs text-muted-foreground">{doc.kbName}</TableCell>
                      <TableCell className="py-2"><StatusBadge status={doc.status} /></TableCell>
                      <TableCell className="py-2 text-right text-[11px] text-muted-foreground">{timeAgo(doc.updatedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* 最近检索日志 */}
        <div className="rounded-xl border border-border/60 bg-card">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <span className="text-sm font-medium">最近检索日志</span>
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setView('retrieval')}>
              <Search className="h-3 w-3" />
              检索调试台
            </Button>
          </div>
          {d.recentLogs.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">暂无检索记录</p>
          ) : (
            <div className="max-h-96 overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead className="h-8 text-[11px]">Query</TableHead>
                    <TableHead className="h-8 text-[11px]">模式</TableHead>
                    <TableHead className="h-8 text-[11px] text-right">耗时</TableHead>
                    <TableHead className="h-8 text-[11px] text-right">来源</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.recentLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="max-w-[260px] truncate py-2 text-xs">{log.query}</TableCell>
                      <TableCell className="py-2">
                        <Badge variant="secondary" className="text-[10px] font-mono">{log.mode}</Badge>
                      </TableCell>
                      <TableCell className="py-2 text-right text-[11px] tabular-nums text-muted-foreground">
                        {log.tookMs}ms · {log.resultCount} 条
                      </TableCell>
                      <TableCell className="py-2 text-right">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="text-[10px]">{log.source === 'external' ? 'API' : '调试台'}</Badge>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                              <div className="font-mono">{shortCode(log.collection, 12)}</div>
                              <div className="text-muted-foreground">{formatDateTime(log.createdAt)}</div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
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
