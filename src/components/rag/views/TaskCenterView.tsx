'use client'

// 实时活动流 / 任务中心（契约 §28）
// 进行中文档：六阶段步进器 + 阶段内进度条 + 最新阶段消息（socket 实时 + 10s 轮询兜底）
// 失败文档：报错展开（errorCode / errorMessage / failedStage）+ 失败阶段重试 + 删除记录
// 完成的任务不显示（document:done → 移出运行列表 + toast）
//
// socket 房间说明：document:status / document:progress 仅广播到 doc:{id} / kb:{id} 房间
// （events.ts），document:done 才进 global —— 因此这里订阅全部 kb 房间 + global，
// 才能拿到每篇文档的阶段内进度。

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Radio,
  RefreshCw,
  RotateCcw,
  Timer,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { useRealtime } from '../useRealtime'
import type {
  ActivityDoc,
  ActivityResponse,
  DocStatus,
  DocumentDoneEvent,
  DocumentProgressEvent,
  DocumentStatusEvent,
} from '../types'
import {
  EmptyHint,
  ErrorCard,
  JOB_TYPE_META,
  formatBytes,
  formatDateTime,
  ragScrollbar,
  timeAgo,
} from '../ui'
import { FileTypeIcon, StageStepper, STAGE_LABEL, humanDuration } from './documents/shared'

/** 阶段内进度条填充色（早期 CPU 阶段 emerald，重 IO 阶段 amber） */
const RUNNING_BAR_CLS: Record<string, string> = {
  queued: 'bg-stone-400',
  parsing: 'bg-emerald-500',
  chunking: 'bg-emerald-500',
  embedding: 'bg-amber-500',
  upserting: 'bg-amber-500',
}

/** socket 实时叠加层：docId → 最新状态 / 阶段进度 / 阶段消息（优先于服务端轮询值） */
interface LiveDocState {
  status?: DocStatus
  stageProgress?: number
  message?: string
}

/** 失败阶段信息（metaJson.failedStage = job.type：parse/chunk/embed/upsert） */
function failedStageInfo(doc: ActivityDoc): { stage: string; label: string; badge: string } | null {
  const raw = doc.metaJson?.failedStage
  if (typeof raw !== 'string' || !raw) return null
  const meta = JOB_TYPE_META[raw]
  return { stage: raw, label: meta?.label ?? raw, badge: meta?.badge ?? '' }
}

/**
 * 每个 docId 首次进入运行列表的时间（模块级缓存：本视图单实例，切换视图后返回不重置）。
 * 老文档重试后 createdAt 远早于本次运行，用它作为本次运行起点。
 */
const firstSeenAt = new Map<string, number>()

/**
 * document:done 事件去重：后端同时广播到 doc:/kb:/global 三个房间，
 * 本视图订阅了 kb:* + global → 同一事件会收到两次（5s 窗口内按 docId 去重）。
 */
const recentDoneAt = new Map<string, number>()

export function TaskCenterView() {
  const queryClient = useQueryClient()
  const { connected, subscribeRooms, on } = useRealtime()

  const [live, setLive] = useState<Record<string, LiveDocState>>({})
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<ActivityDoc | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const kbsQuery = useQuery({ queryKey: ['kbs'], queryFn: () => ragApi.listKbs(), staleTime: 60_000 })
  const activityQuery = useQuery({
    queryKey: ['activity'],
    queryFn: () => ragApi.getActivity(),
    refetchInterval: 10_000,
  })

  const data = activityQuery.data
  const running = useMemo(() => data?.running ?? [], [data])
  const failed = useMemo(() => data?.failed ?? [], [data])
  const runningCount = data?.stats.runningCount ?? running.length
  const failedCount = data?.stats.failedCount ?? failed.length

  // 订阅全部 kb 房间（status/progress 只进 kb/doc 房间）+ global（done）
  useEffect(() => {
    const rooms = ['global', ...(kbsQuery.data?.kbs ?? []).map((k) => `kb:${k.id}`)]
    for (let i = 0; i < rooms.length; i += 30) {
      subscribeRooms(rooms.slice(i, i + 30))
    }
  }, [kbsQuery.data, subscribeRooms])

  // 运行中才有秒级 tick（已运行耗时实时跳动）
  useEffect(() => {
    if (running.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running.length])

  // socket 实时事件
  useEffect(() => {
    const isActive = (id: string) => {
      const cached = queryClient.getQueryData<ActivityResponse>(['activity'])
      return cached?.running.some((d) => d.id === id) ?? false
    }
    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['activity'] })

    const unStatus = on('document:status', (e: DocumentStatusEvent) => {
      if (e.status === 'ready' || e.status === 'failed') {
        setLive((prev) => {
          const next = { ...prev }
          delete next[e.docId]
          return next
        })
        firstSeenAt.delete(e.docId)
        if (e.status === 'failed') {
          // document:done 仅成功路径发出（后端语义），失败提示挂在 status(failed) 事件上
          const cached = queryClient.getQueryData<ActivityResponse>(['activity'])
          const doc = cached?.running.find((d) => d.id === e.docId)
          toast.error(
            `${doc?.filename ?? '文档'} 流水线失败${e.errorCode ? `（${e.errorCode}）` : ''}，可在失败任务列表重试或删除`,
          )
        }
        invalidate()
        return
      }
      setLive((prev) => ({
        ...prev,
        [e.docId]: { ...prev[e.docId], status: e.status, stageProgress: e.stageProgress, message: undefined },
      }))
      if (!isActive(e.docId)) invalidate()
    })

    const unProgress = on('document:progress', (e: DocumentProgressEvent) => {
      setLive((prev) => ({
        ...prev,
        [e.docId]: { ...prev[e.docId], stageProgress: e.progress, message: e.message },
      }))
      if (!isActive(e.docId)) invalidate()
    })

    const unDone = on('document:done', (e: DocumentDoneEvent) => {
      // 同一 done 事件经 kb 房间与 global 房间双路投递，5s 内同 docId 只处理一次
      const last = recentDoneAt.get(e.docId)
      const nowMs = Date.now()
      if (last !== undefined && nowMs - last < 5_000) return
      recentDoneAt.set(e.docId, nowMs)
      if (recentDoneAt.size > 64) {
        for (const [k, v] of recentDoneAt) {
          if (nowMs - v > 60_000) recentDoneAt.delete(k)
        }
      }
      const cached = queryClient.getQueryData<ActivityResponse>(['activity'])
      const doc = cached?.running.find((d) => d.id === e.docId)
      setLive((prev) => {
        const next = { ...prev }
        delete next[e.docId]
        return next
      })
      firstSeenAt.delete(e.docId)
      queryClient.setQueryData<ActivityResponse>(['activity'], (old) =>
        old
          ? {
              ...old,
              running: old.running.filter((d) => d.id !== e.docId),
              stats: { ...old.stats, runningCount: Math.max(0, old.stats.runningCount - 1) },
            }
          : old,
      )
      if (e.status === 'ready') {
        toast.success(`${doc?.filename ?? '文档'} 完成（${e.chunkCount} chunks，耗时 ${humanDuration(e.tookMs)}）`)
      } else if (e.status === 'failed') {
        toast.error(`${doc?.filename ?? '文档'} 流水线失败，详情见下方失败任务列表`)
        invalidate()
      }
      queryClient.invalidateQueries({ queryKey: ['docs'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    })

    return () => {
      unStatus()
      unProgress()
      unDone()
    }
  }, [on, queryClient])

  const retryMutation = useMutation({
    mutationFn: (doc: ActivityDoc) => ragApi.docAction(doc.id, 'retry'),
    onSuccess: (_r, doc) => {
      toast.success(`已重试「${doc.filename}」：从失败阶段重新入队`)
      queryClient.invalidateQueries({ queryKey: ['activity'] })
      queryClient.invalidateQueries({ queryKey: ['docs'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (e: Error) => toast.error('重试失败：' + e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (doc: ActivityDoc) => ragApi.deleteDoc(doc.id),
    onSuccess: (r, doc) => {
      toast.success(`已删除失败记录「${doc.filename}」（清理 ${r.deletedChunks} 个 chunk 与向量点）`)
      setPendingDelete(null)
      queryClient.invalidateQueries({ queryKey: ['activity'] })
      queryClient.invalidateQueries({ queryKey: ['docs'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (e: Error) => toast.error('删除失败：' + e.message),
  })

  /** 已运行耗时：1h 内创建的文档按 createdAt（页面刷新也不重置），老文档重试后按首次进入列表时间 */
  const elapsedOf = (doc: ActivityDoc): string => {
    const created = Date.parse(doc.createdAt)
    const useCreated = Number.isFinite(created) && now - created < 3_600_000
    let start: number
    if (useCreated) {
      start = created
    } else {
      let seen = firstSeenAt.get(doc.id)
      if (seen === undefined) {
        seen = Date.now()
        firstSeenAt.set(doc.id, seen)
      }
      start = seen
    }
    return humanDuration(Math.max(0, now - start))
  }

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (activityQuery.isLoading) {
    return (
      <div className="p-4 sm:p-6">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }
  if (activityQuery.error) {
    return (
      <div className="p-4">
        <ErrorCard
          title="活动流加载失败"
          message={activityQuery.error instanceof Error ? activityQuery.error.message : String(activityQuery.error)}
          onRetry={() => activityQuery.refetch()}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {/* 顶部工具栏 */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border/60 bg-background/95 px-4 py-2.5 backdrop-blur">
        <Radio className="h-4 w-4 shrink-0 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">实时活动 · 任务中心</h2>
        <span
          className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground"
          aria-live="polite"
        >
          <span className={cn('h-2 w-2 rounded-full', connected ? 'animate-pulse bg-emerald-500' : 'animate-pulse bg-amber-500')} />
          {connected ? '实时已连接' : '连接中…'}
        </span>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">socket 实时 + 10s 轮询兜底</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Badge variant="outline" className="border-teal-500/40 bg-teal-500/10 text-[11px] text-teal-600 dark:text-teal-300">
            进行中 {runningCount}
          </Badge>
          <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-[11px] text-rose-600 dark:text-rose-300">
            失败 {failedCount}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => activityQuery.refetch()}
            disabled={activityQuery.isRefetching}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', activityQuery.isRefetching && 'animate-spin')} />
            刷新
          </Button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
        {/* 进行中任务 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              <Activity className="h-4 w-4 text-teal-500" />
              进行中任务
              <Badge variant="outline" className="text-[10px] tabular-nums">
                {runningCount}
              </Badge>
              <span className="ml-auto text-[11px] font-normal text-muted-foreground">完成的任务不显示</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {running.length === 0 ? (
              <EmptyHint
                icon={<Activity className="h-6 w-6" />}
                title="没有进行中的任务"
                description="上传文档或触发重解析后，这里将实时展示每篇文档的解析、切分、向量化、写入向量库的全过程进度。"
              />
            ) : (
              <div className={cn('max-h-[32rem] space-y-2 overflow-y-auto pr-1', ragScrollbar)}>
                {running.map((doc) => {
                  const l = live[doc.id]
                  const status = l?.status ?? doc.status
                  const pct = Math.max(0, Math.min(100, Math.round(l?.stageProgress ?? doc.stageProgress)))
                  const stageLabel = STAGE_LABEL[status] ?? '处理中'
                  const message = l?.message ?? `${stageLabel}进行中`
                  return (
                    <div
                      key={doc.id}
                      className="rounded-xl border border-border/60 bg-card p-3 shadow-xs transition-colors hover:border-border sm:p-4"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <FileTypeIcon filename={doc.filename} isUrl={!!doc.sourceUrl} />
                        <span className="min-w-0 max-w-full truncate text-sm font-medium" title={doc.filename}>
                          {doc.filename}
                        </span>
                        <Badge variant="outline" className="max-w-36 truncate text-[10px]">
                          {doc.kbName}
                        </Badge>
                        <span className="rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          v{doc.parseConfigV}
                        </span>
                        <span className="text-[11px] tabular-nums text-muted-foreground">{formatBytes(doc.sizeBytes)}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
                          <Timer className="h-3 w-3" />
                          已运行 {elapsedOf(doc)}
                        </span>
                      </div>
                      <StageStepper className="mt-3" status={status} stageProgress={pct} />
                      <div className="mt-2.5 flex items-center gap-2">
                        <div
                          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={pct}
                          aria-label={`${doc.filename} · ${stageLabel} ${pct}%`}
                        >
                          <div
                            className={cn('h-full rounded-full transition-[width] duration-300', RUNNING_BAR_CLS[status] ?? 'bg-emerald-500')}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-9 shrink-0 text-right text-[11px] font-medium tabular-nums text-muted-foreground">{pct}%</span>
                      </div>
                      <p className="mt-1.5 truncate text-[11px] text-muted-foreground" title={message}>
                        {message}
                      </p>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 失败任务 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-rose-500" />
              失败任务
              <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-[10px] tabular-nums text-rose-600 dark:text-rose-300">
                {failedCount}
              </Badge>
              {failed.length > 0 && (
                <span className="ml-auto text-[11px] font-normal text-muted-foreground">重试从失败阶段续跑 · 可展开报错详情</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {failed.length === 0 ? (
              <EmptyHint
                icon={<CheckCircle2 className="h-6 w-6" />}
                title="没有失败的任务 🎉"
                description="解析、切分、向量化或写入向量库失败时，记录会出现在这里：可展开完整报错、从失败阶段重试，或删除失败记录。"
              />
            ) : (
              <div className={cn('max-h-96 space-y-2 overflow-y-auto pr-1', ragScrollbar)}>
                {failed.map((doc) => {
                  const fs = failedStageInfo(doc)
                  const expanded = expandedIds.has(doc.id)
                  return (
                    <div
                      key={doc.id}
                      className="rounded-xl border border-rose-500/30 bg-card p-3 shadow-xs transition-colors hover:border-rose-500/50 sm:p-4"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <FileTypeIcon filename={doc.filename} isUrl={!!doc.sourceUrl} />
                        <span className="min-w-0 max-w-full truncate text-sm font-medium" title={doc.filename}>
                          {doc.filename}
                        </span>
                        <Badge variant="outline" className="max-w-36 truncate text-[10px]">
                          {doc.kbName}
                        </Badge>
                        {fs && (
                          <Badge variant="outline" className={cn('text-[10px]', fs.badge)}>
                            {fs.label}失败
                          </Badge>
                        )}
                        {doc.errorCode && (
                          <Badge
                            variant="outline"
                            className="max-w-48 truncate border-rose-500/40 bg-rose-500/10 font-mono text-[10px] text-rose-600 dark:text-rose-300"
                            title={doc.errorCode}
                          >
                            {doc.errorCode}
                          </Badge>
                        )}
                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground" title={formatDateTime(doc.updatedAt)}>
                          {timeAgo(doc.updatedAt)}
                        </span>
                      </div>

                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggleExpand(doc.id)}
                          aria-expanded={expanded}
                          className="flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', expanded && 'rotate-180')} />
                          {expanded ? '收起报错' : '详细报错'}
                        </button>
                        <div className="ml-auto flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 border-emerald-500/40 text-xs text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-300"
                            disabled={retryMutation.isPending}
                            onClick={() => retryMutation.mutate(doc)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            重试
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 border-rose-500/40 text-xs text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-300"
                            onClick={() => setPendingDelete(doc)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            删除
                          </Button>
                        </div>
                      </div>

                      {expanded && (
                        <div className="mt-2 space-y-2 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3">
                          <pre className="whitespace-pre-wrap break-words rounded-md bg-rose-500/10 p-2.5 font-mono text-[11px] leading-relaxed text-rose-700 dark:text-rose-300">
                            {doc.errorMessage || '（无错误详情）'}
                          </pre>
                          <div className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-3">
                            <div className="min-w-0">
                              <span className="text-muted-foreground">错误代码：</span>
                              <span className="break-all font-mono">{doc.errorCode || '—'}</span>
                            </div>
                            <div className="min-w-0">
                              <span className="text-muted-foreground">失败阶段：</span>
                              {fs ? `${fs.label}（${fs.stage}）` : '—'}
                            </div>
                            <div className="min-w-0">
                              <span className="text-muted-foreground">发生时间：</span>
                              {formatDateTime(doc.updatedAt)}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 删除失败记录确认 */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除失败记录「{pendingDelete?.filename}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除失败记录将连同其 chunks、向量点与产物文件一并删除，不可恢复。如只想重新处理，请改用「重试」。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
              onClick={() => {
                if (pendingDelete) deleteMutation.mutate(pendingDelete)
              }}
            >
              {deleteMutation.isPending ? '删除中…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
