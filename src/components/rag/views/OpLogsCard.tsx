'use client'

// 程序日志卡（Task 17-5 + 定时清理扩展）
// 面板操作 / 运行信息 / 报错信息的统一运维视图：
//   数据源 GET /api/system/oplogs（level/category/keyword/hours 过滤 + 分页 + 全量 stats）
//   写入点：共享层（建库/上传/文本/删除/重试）+ 流水线永久失败 + 设置/APIKey/备份路由
//          + instrumentation onRequestError 全局兜底（未捕获请求错误）
//   管理：按时长清理（0=全部）+ 导出 JSON + 10s 自动刷新 + 行内详情展开
//          + 定时清理设置（默认关闭；保留时长 + 清理级别，调度器每小时执行）

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  Download,
  Eraser,
  FileTerminal,
  RefreshCw,
  Search,
  TimerClock,
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { ErrorCard, formatDateTime, ragScrollbar, useDebouncedValue } from '../ui'

export interface OpLogItem {
  id: string
  ts: string
  level: 'info' | 'warn' | 'error'
  category: string
  action: string
  message: string
  detail: unknown
  durationMs: number | null
  statusCode: number | null
  kbId: string | null
  docId: string | null
}

const LEVEL_META: Record<string, { label: string; badge: string; dot: string }> = {
  info: { label: 'info', badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300', dot: 'bg-emerald-500' },
  warn: { label: 'warn', badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300', dot: 'bg-amber-500' },
  error: { label: 'error', badge: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300', dot: 'bg-rose-500' },
}

const CATEGORY_LABEL: Record<string, string> = {
  api: 'API',
  kb: '知识库',
  document: '文档',
  chunk: 'chunk',
  pipeline: '流水线',
  auth: 'Key',
  backup: '备份',
  system: '系统',
}

const HOURS_OPTIONS = [
  { value: '1', label: '最近 1 小时' },
  { value: '6', label: '最近 6 小时' },
  { value: '24', label: '最近 24 小时' },
  { value: '168', label: '最近 7 天' },
  { value: '0', label: '全部时间' },
]

const PAGE_SIZE = 60

/** 字节格式化（日志大小展示） */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

const KEEP_OPTIONS = [
  { value: '24', label: '24 小时前' },
  { value: '72', label: '3 天前' },
  { value: '168', label: '7 天前' },
  { value: '720', label: '30 天前' },
  { value: '2160', label: '90 天前' },
  { value: '8760', label: '365 天前' },
]

const MAX_LEVEL_OPTIONS = [
  { value: 'info', label: '仅 info（保留警告和错误）' },
  { value: 'warn', label: 'info + warn（保留错误）' },
  { value: 'error', label: '全部级别（含错误）' },
]

export function OpLogsCard() {
  const queryClient = useQueryClient()
  const [level, setLevel] = useState('all')
  const [category, setCategory] = useState('all')
  const [hours, setHours] = useState('24')
  const [qInput, setQInput] = useState('')
  // FE-004 修复：原 useMemo 设 setTimeout 但 useMemo 不执行返回的 cleanup，
  // 每次输入都新增一个未被清除的定时器，导致防抖失效并触发多次查询。
  // 改用现有 useDebouncedValue hook（内部 useEffect + clearTimeout 正确清理）。
  const q = useDebouncedValue(qInput.trim(), 300)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [size, setSize] = useState(PAGE_SIZE)
  const [cleanOpen, setCleanOpen] = useState(false)
  const [cleanHours, setCleanHours] = useState('24')
  const [schedOpen, setSchedOpen] = useState(false)

  // 定时清理配置（GET 惰性拉起调度器；30s 轮询看下次运行时间）
  const schedQuery = useQuery({
    queryKey: ['oplog-clean-schedule'],
    queryFn: () => ragApi.getOplogCleanSchedule(),
    refetchInterval: 30_000,
  })
  const sched = schedQuery.data?.schedule

  const schedMutation = useMutation({
    mutationFn: (body: { enabled?: boolean; olderThanHours?: number; maxLevel?: string }) =>
      ragApi.updateOplogCleanSchedule(body),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['oplog-clean-schedule'] })
      toast.success(
        r.schedule.enabled
          ? `定时清理已开启：每小时清理 ${r.schedule.olderThanHours}h 前日志（级别 ≤ ${r.schedule.maxLevel}）`
          : '定时清理已关闭',
      )
    },
    onError: (e: Error) => toast.error('保存失败：' + e.message),
  })

  // 查询
  const logsQuery = useQuery({
    queryKey: ['oplogs', level, category, hours, q, size],
    queryFn: () => ragApi.listOpLogs({ level, category, hours, q, limit: size }),
    refetchInterval: 10_000,
  })

  const logs: OpLogItem[] = logsQuery.data?.logs ?? []
  const total = logsQuery.data?.total ?? 0
  const shown = logs.length
  // 全量统计（忽略过滤条件）：总条数 + 估算占用（后端 stats 字段）
  const stats = logsQuery.data?.stats

  // FE-004：关键词防抖已迁移到 useDebouncedValue（上方声明）。
  // 关键词变化时重置分页为首页大小：在输入 onChange 处直接重置，避免 effect 内 setState。
  const onSearchChange = (v: string) => {
    setQInput(v)
    setSize(PAGE_SIZE)
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `oplogs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`已导出 ${shown} 条程序日志`)
  }

  const doClean = async () => {
    try {
      const r = await ragApi.cleanOplogs(Number(cleanHours))
      toast.success(`已清理 ${r.deleted} 条程序日志`)
      setCleanOpen(false)
      queryClient.invalidateQueries({ queryKey: ['oplogs'] })
    } catch (e) {
      toast.error('清理失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const levelCounts = useMemo(() => {
    const c = { info: 0, warn: 0, error: 0 } as Record<string, number>
    for (const l of logs) c[l.level] = (c[l.level] ?? 0) + 1
    return c
  }, [logs])

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <FileTerminal className="h-4 w-4 text-primary" />
          程序日志
          <Badge variant="secondary" className="text-[10px]">面板操作 · 运行信息 · 报错</Badge>
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{levelCounts.info}</span>
            <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{levelCounts.warn}</span>
            <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-rose-500" />{levelCounts.error}</span>
            （当前页）
            {stats && (
              <Badge variant="outline" className="ml-1 border-border/60 font-mono text-[9.5px] font-normal text-muted-foreground">
                全量 {stats.totalAll} 条 · 约 {fmtBytes(stats.estBytes)}
              </Badge>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 过滤器 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={qInput}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="搜索消息 / 动作标识（doc.upload、pipeline.job_failed…）"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Select value={level} onValueChange={(v) => { setLevel(v); setSize(PAGE_SIZE) }}>
            <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">全部级别</SelectItem>
              <SelectItem value="info" className="text-xs">info</SelectItem>
              <SelectItem value="warn" className="text-xs">warn</SelectItem>
              <SelectItem value="error" className="text-xs">error</SelectItem>
            </SelectContent>
          </Select>
          <Select value={category} onValueChange={(v) => { setCategory(v); setSize(PAGE_SIZE) }}>
            <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">全部分类</SelectItem>
              {Object.entries(CATEGORY_LABEL).map(([k, label]) => (
                <SelectItem key={k} value={k} className="text-xs">{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={hours} onValueChange={(v) => { setHours(v); setSize(PAGE_SIZE) }}>
            <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {HOURS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={() => logsQuery.refetch()} disabled={logsQuery.isRefetching}>
            <RefreshCw className={cn('h-3 w-3', logsQuery.isRefetching && 'animate-spin')} />
            刷新
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={exportJson} disabled={shown === 0}>
            <Download className="h-3 w-3" />
            导出
          </Button>
          <Select value={cleanHours} onValueChange={setCleanHours}>
            <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1" className="text-xs">清理 1 小时前</SelectItem>
              <SelectItem value="24" className="text-xs">清理 24 小时前</SelectItem>
              <SelectItem value="168" className="text-xs">清理 7 天前</SelectItem>
              <SelectItem value="0" className="text-xs">清空全部</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8 gap-1 text-xs text-rose-600 hover:text-rose-700 dark:text-rose-400" onClick={() => setCleanOpen(true)}>
            <Eraser className="h-3 w-3" />
            清理
          </Button>
        </div>

        {/* 列表 */}
        {logsQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-lg" />
            ))}
          </div>
        ) : logsQuery.error ? (
          <ErrorCard
            title="程序日志加载失败"
            message={logsQuery.error instanceof Error ? logsQuery.error.message : String(logsQuery.error)}
            onRetry={() => logsQuery.refetch()}
          />
        ) : shown === 0 ? (
          <p className="py-10 text-center text-[11px] text-muted-foreground">
            暂无日志记录（当前过滤条件下）
            <br />
            写入点：建库 / 上传 / 文本入库 / 删除 / 重试 / 流水线失败 / 设置 / API Key / 备份 / 未捕获错误
          </p>
        ) : (
          <>
            <div className={cn('max-h-[520px] overflow-y-auto rounded-lg border border-border/60', ragScrollbar)} role="log" aria-label="程序日志列表">
              {logs.map((l) => {
                const lm = LEVEL_META[l.level] ?? LEVEL_META.info
                const isOpen = expanded === l.id
                return (
                  <div key={l.id} className="border-b border-border/40 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : l.id)}
                      className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-muted/40"
                      aria-expanded={isOpen}
                    >
                      <span className="shrink-0 pt-0.5 font-mono text-[10.5px] text-muted-foreground">{formatDateTime(l.ts).slice(11)}</span>
                      <span className={cn('shrink-0 pt-0.5 rounded border px-1 text-[9.5px] font-semibold uppercase', lm.badge)}>{l.level}</span>
                      <span className="shrink-0 pt-0.5 text-[10px] text-muted-foreground">{CATEGORY_LABEL[l.category] ?? l.category}</span>
                      <code className="shrink-0 pt-0.5 font-mono text-[10.5px] text-primary/80">{l.action}</code>
                      <span className="min-w-0 flex-1 break-all pt-0.5 text-[11px] leading-relaxed">{l.message}</span>
                      <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[10px] text-muted-foreground">
                        {l.statusCode != null && <span className="font-mono">{l.statusCode}</span>}
                        {l.durationMs != null && l.durationMs > 0 && <span className="font-mono">{l.durationMs}ms</span>}
                        <ChevronDown className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-180')} />
                      </span>
                    </button>
                    {isOpen && (
                      <div className="space-y-1.5 border-t border-border/40 bg-muted/20 px-3 py-2">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-muted-foreground">
                          <span>时间：<span className="font-mono">{formatDateTime(l.ts)}</span></span>
                          {l.kbId && <span className="font-mono">kb {l.kbId.slice(0, 8)}</span>}
                          {l.docId && <span className="font-mono">doc {l.docId.slice(0, 8)}</span>}
                        </div>
                        {l.detail != null && (
                          <pre className={cn('max-h-48 overflow-auto rounded border border-border/60 bg-stone-950 p-2 font-mono text-[10.5px] leading-relaxed text-stone-200', ragScrollbar)}>
                            {typeof l.detail === 'string' ? l.detail : JSON.stringify(l.detail, null, 2)}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
              <span>已显示 {shown} / 命中 {total} 条（新→旧，10s 自动刷新）</span>
              {shown < total && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setSize((s) => s + PAGE_SIZE)}>
                  加载更多
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={cleanOpen} onOpenChange={setOpen => { if (!setOpen) setCleanOpen(false); else setCleanOpen(true) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理程序日志？</AlertDialogTitle>
            <AlertDialogDescription>
              {cleanHours === '0'
                ? '将清空全部程序日志记录，此操作不可撤销。'
                : `将删除 ${cleanHours === '1' ? '1 小时' : cleanHours === '24' ? '24 小时' : '7 天'}之前的日志记录，此操作不可撤销。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={doClean} className="bg-rose-600 hover:bg-rose-700">确认清理</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
