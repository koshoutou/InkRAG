'use client'

// 系统运维：健康矩阵（10s 自动刷新）+ 平台指标 + 备份与恢复 + 流水线任务表 + 实时活动流（socket）+ 清理工具

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  DatabaseBackup,
  Download,
  Eraser,
  Gauge,
  ListChecks,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Timer,
  Trash2,
  XCircle,
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
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { useQuickAction } from '../useQuickAction'
import type { BackupItem, BackupSchedule, QdrantSnapshotItem } from '../types'
import { useRealtime } from '../useRealtime'
import { EmptyHint, ErrorCard, JOB_TYPE_META, StatCard, formatBytes, formatDateTime, formatDuration, formatNumber, formatUptime, ragScrollbar, timeAgo } from '../ui'

interface ActivityEntry {
  id: number
  at: string
  level: string
  message: string
}

/** 备份行（契约 §15：后端 manifest.auto 自动备份标记，本地扩展契约类型） */
type BackupRow = BackupItem & { auto?: boolean }

/** 定时备份参数边界（后端同款 clamp：间隔 2-168 小时 / 保留 2-50 份） */
const SCHED_INTERVAL_MIN = 2
const SCHED_INTERVAL_MAX = 168
const SCHED_INTERVAL_DEFAULT = 24
const SCHED_KEEP_MIN = 2
const SCHED_KEEP_MAX = 50
const SCHED_KEEP_DEFAULT = 5

const HEALTH_ROWS = [
  { key: 'qdrant', label: 'Qdrant', icon: Server },
  { key: 'vectorStore', label: '向量存储引擎', icon: Server },
  { key: 'embedding', label: 'Embedding', icon: Activity },
  { key: 'mineru', label: 'MinerU 解析', icon: Activity },
  { key: 'rerank', label: 'Rerank', icon: Activity },
  { key: 'pipeline', label: '流水线引擎', icon: ListChecks },
] as const

export function OpsView() {
  const queryClient = useQueryClient()
  const { subscribeRooms, on, connected } = useRealtime()

  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [activities, setActivities] = useState<ActivityEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [pausedCount, setPausedCount] = useState(0)
  const [cleanHours, setCleanHours] = useState('24')
  const idRef = useRef(0)

  // ---- 备份与恢复 ----
  const [includeArtifacts, setIncludeArtifacts] = useState(true)
  const [restoreTarget, setRestoreTarget] = useState<BackupItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BackupItem | null>(null)

  // ---- Qdrant 快照（契约 §23，备份卡内 Divider 区块）----
  const [snapRestoreTarget, setSnapRestoreTarget] = useState<QdrantSnapshotItem | null>(null)
  const [snapDeleteTarget, setSnapDeleteTarget] = useState<QdrantSnapshotItem | null>(null)

  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: () => ragApi.getHealth(),
    refetchInterval: 10_000,
  })

  // Prometheus 指标摘要（进程内计数 + DB 聚合）
  const metricsQuery = useQuery({
    queryKey: ['metrics-summary'],
    queryFn: () => ragApi.getMetricsSummary(),
    refetchInterval: 15_000,
  })
  const [promOpen, setPromOpen] = useState(false)
  // 原始文本懒加载：仅在展开时请求（enabled 模式，避免 setState-in-effect）
  const promQuery = useQuery({
    queryKey: ['prometheus-text'],
    queryFn: () => ragApi.getPrometheusText(),
    enabled: promOpen,
    staleTime: 5_000,
  })

  const jobsQuery = useQuery({
    queryKey: ['jobs', statusFilter, typeFilter],
    queryFn: () =>
      ragApi.listJobs({
        status: statusFilter !== 'all' ? statusFilter : undefined,
        type: typeFilter !== 'all' ? typeFilter : undefined,
        limit: 50,
      }),
    refetchInterval: 15_000,
  })

  const backupsQuery = useQuery({
    queryKey: ['backups'],
    queryFn: () => ragApi.listBackups(),
    staleTime: 10_000,
  })

  // ---- 定时自动备份（契约 §15）----
  const scheduleQuery = useQuery({
    queryKey: ['backup-schedule'],
    queryFn: () => ragApi.getBackupSchedule(),
    staleTime: 10_000,
    refetchInterval: 15_000,
  })
  const schedule = scheduleQuery.data?.schedule

  const [schedEnabled, setSchedEnabled] = useState(false)
  const [schedInterval, setSchedInterval] = useState('24')
  const [schedKeep, setSchedKeep] = useState('5')
  /** 已同步的服务端配置签名：仅配置真正变化时重置表单（React 官方「渲染期条件调整 state」模式，
   *  防止轮询刷新覆盖正在编辑的输入） */
  const [syncedSchedSig, setSyncedSchedSig] = useState<string | null>(null)
  const schedSig = schedule ? `${schedule.enabled}|${schedule.intervalHours}|${schedule.keep}` : null
  if (schedSig !== null && schedSig !== syncedSchedSig) {
    setSyncedSchedSig(schedSig)
    setSchedEnabled(schedule!.enabled)
    setSchedInterval(String(schedule!.intervalHours))
    setSchedKeep(String(schedule!.keep))
  }

  // socket：实时活动流 + 任务表刷新
  useEffect(() => {
    subscribeRooms(['global'])
    const push = (entry: Omit<ActivityEntry, 'id'>) => {
      setActivities((prev) => {
        if (paused) return prev
        return [{ id: ++idRef.current, ...entry }, ...prev].slice(0, 50)
      })
      if (paused) setPausedCount((c) => c + 1)
    }
    const un1 = on('pipeline:activity', (e: { at?: string; level?: string; message?: string }) => {
      push({ at: e.at ?? new Date().toISOString(), level: e.level ?? 'info', message: e.message ?? '' })
    })
    const un2 = on('job:update', (e: { jobId: string; type: string; status: string; error?: string; durationMs?: number }) => {
      push({
        at: new Date().toISOString(),
        level: e.status === 'failed' ? 'error' : 'info',
        message: `[job] ${e.type} → ${e.status}${e.durationMs ? ` (${formatDuration(e.durationMs)})` : ''}${e.error ? ` · ${e.error}` : ''}`,
      })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    })
    return () => {
      un1()
      un2()
    }
  }, [subscribeRooms, on, paused, queryClient])

  const retryMutation = useMutation({
    mutationFn: (id: string) => ragApi.retryJob(id),
    onSuccess: () => {
      toast.success('任务已重新排队')
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (e: Error) => toast.error('重试失败：' + e.message),
  })

  const cleanMutation = useMutation({
    mutationFn: () => ragApi.cleanJobs({ status: 'completed', olderThanHours: Number(cleanHours) || 24 }),
    onSuccess: (r) => {
      toast.success(`已清理 ${r.cleaned} 个已完成任务`)
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (e: Error) => toast.error('清理失败：' + e.message),
  })

  const createBackupMutation = useMutation({
    mutationFn: () => ragApi.createBackup({ includeArtifacts }),
    onSuccess: (r) => {
      toast.success(
        `备份已创建：${r.backup.counts.kbs} 库 · ${r.backup.counts.docs} 文档 · ${r.backup.counts.points} 点 · ${formatBytes(r.backup.sizes.total)}`,
      )
      queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (e: Error) => toast.error('创建备份失败：' + e.message),
  })

  // 命令面板快捷动作（契约 §19）：rag:quick-backup → 复用创建按钮 handler 自动触发备份
  // （创建中则忽略；跨视图派发时由 useQuickAction 桥回放）
  useQuickAction('rag:quick-backup', () => {
    if (createBackupMutation.isPending) return
    toast.info('已通过命令面板触发备份')
    createBackupMutation.mutate()
  })

  const saveScheduleMutation = useMutation({
    mutationFn: () =>
      ragApi.saveBackupSchedule({
        enabled: schedEnabled,
        intervalHours: Number(schedInterval),
        keep: Number(schedKeep),
      }),
    onSuccess: (r) => {
      toast.success(
        r.schedule.enabled
          ? `定时备份已启用：每 ${r.schedule.intervalHours} 小时一次，保留最近 ${r.schedule.keep} 份自动备份`
          : '定时备份已停用',
      )
      queryClient.invalidateQueries({ queryKey: ['backup-schedule'] })
    },
    onError: (e: Error) => toast.error('保存配置失败：' + e.message),
  })

  const deleteBackupMutation = useMutation({
    mutationFn: (id: string) => ragApi.deleteBackup(id),
    onSuccess: () => {
      toast.success('备份已删除')
      setDeleteTarget(null)
      queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (e: Error) => toast.error('删除备份失败：' + e.message),
  })

  const restoreBackupMutation = useMutation({
    mutationFn: (id: string) => ragApi.restoreBackup(id),
    onSuccess: (r) => {
      const { restored } = r.result
      toast.success(
        `恢复完成：${restored.kbs} 库 / ${restored.docs} 文档 / ${restored.chunks} chunk / ${restored.points} 点 · ${formatDuration(r.result.tookMs)}，3 秒后自动刷新页面`,
      )
      setRestoreTarget(null)
      // 恢复覆盖全局数据：失效全部相关缓存，并延时整页刷新让全局状态重初始化
      //（含备份调度配置：QdrantSetting 已被备份行覆盖，GET 惰性同步会让调度器停下/重启）
      for (const key of ['dashboard', 'kbs', 'health', 'jobs', 'keys', 'metrics', 'metrics-summary', 'backups', 'backup-schedule']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      setTimeout(() => window.location.reload(), 3000)
    },
    onError: (e: Error) => toast.error('恢复失败：' + e.message),
  })

  // ---- Qdrant 快照：查询 + 变更（契约 §23）----
  const snapCreateMutation = useMutation({
    mutationFn: (collection: string) => ragApi.createQdrantSnapshot(collection),
    onSuccess: (r) => {
      toast.success(`快照已创建：${r.snapshot.name}`, {
        description: `${formatBytes(r.snapshot.sizeBytes)} · 集合 ${r.snapshot.collection}`,
      })
      queryClient.invalidateQueries({ queryKey: ['qdrant-snapshots'] })
    },
    onError: (e: Error) => toast.error('创建快照失败：' + e.message),
  })

  const snapDeleteMutation = useMutation({
    mutationFn: (s: QdrantSnapshotItem) => ragApi.deleteQdrantSnapshot(s.collection, s.name),
    onSuccess: (_r, s) => {
      toast.success('快照已删除', { description: s.name })
      setSnapDeleteTarget(null)
      queryClient.invalidateQueries({ queryKey: ['qdrant-snapshots'] })
    },
    onError: (e: Error) => toast.error('删除快照失败：' + e.message),
  })

  const snapRestoreMutation = useMutation({
    mutationFn: (s: QdrantSnapshotItem) => ragApi.restoreQdrantSnapshot(s.collection, s.name),
    onSuccess: (r, s) => {
      toast.success(r.message || `快照已恢复：${s.name}`, {
        description: '集合数据已从快照恢复，检索可能需要重新验证',
      })
      setSnapRestoreTarget(null)
      // 恢复覆盖集合向量数据：快照列表 / 集合清单 / 健康矩阵（点数）级联刷新
      queryClient.invalidateQueries({ queryKey: ['qdrant-snapshots'] })
      queryClient.invalidateQueries({ queryKey: ['qdrant-collections'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
    onError: (e: Error) => toast.error('恢复快照失败：' + e.message),
  })

  const snapBusy = snapCreateMutation.isPending || snapRestoreMutation.isPending || snapDeleteMutation.isPending

  const snapshotsQuery = useQuery({
    queryKey: ['qdrant-snapshots'],
    queryFn: () => ragApi.listQdrantSnapshots(),
    // local 模式 400 是预期态（引导空态），不做退避重试；轮询保持配置变更后的自动感知
    retry: false,
    refetchInterval: snapBusy ? 4_000 : 15_000,
  })

  /** local 模式判定：契约 §23 固定消息（后端 400），据此渲染引导空态而非错误卡 */
  const snapshotsLocalMode =
    snapshotsQuery.error instanceof Error && snapshotsQuery.error.message.includes('local 模式')
  const snapshotsData = snapshotsQuery.data

  /** qdrant 模式下的真实集合清单（基座 /api/qdrant/collections）：零快照集合的分组补全 + 空态快捷创建 */
  const qdrantCollectionsQuery = useQuery({
    queryKey: ['qdrant-collections'],
    enabled: !snapshotsLocalMode && snapshotsQuery.isSuccess,
    queryFn: async () => {
      const res = await fetch('/api/qdrant/collections', { cache: 'no-store' })
      const json = (await res.json().catch(() => ({}))) as { collections?: { name: string }[]; error?: string }
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      return json as { collections: { name: string }[] }
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
  })

  /** 分组视图：集合名字母序；组内快照 createdAt 倒序；零快照集合在有集合清单时也展示（带创建入口） */
  const snapshotGroups = useMemo(() => {
    if (!snapshotsData) return []
    const byCollection = new Map(
      snapshotsData.collections.map((g) => [
        g.collection,
        [...g.snapshots].sort((a, b) => b.createdAt - a.createdAt),
      ]),
    )
    const auxNames = (qdrantCollectionsQuery.data?.collections ?? [])
      .map((c) => c.name)
      .filter(Boolean)
    const names = auxNames.length > 0 ? auxNames : snapshotsData.collections.map((g) => g.collection)
    return Array.from(new Set(names))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ collection: name, snapshots: byCollection.get(name) ?? [] }))
      .filter((g) => (auxNames.length > 0 ? true : g.snapshots.length > 0))
  }, [snapshotsData, qdrantCollectionsQuery.data])

  /** 空快照态的每集合快捷创建清单 */
  const quickCreateCollections = useMemo(
    () =>
      (qdrantCollectionsQuery.data?.collections ?? [])
        .map((c) => c.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [qdrantCollectionsQuery.data],
  )

  const health = healthQuery.data?.health
  const jobs = jobsQuery.data?.jobs ?? []
  const stats = jobsQuery.data?.stats

  const byTypeBars = useMemo(() => {
    if (!stats) return []
    const total = Object.values(stats.byType).reduce((a, b) => a + b, 0) || 1
    return Object.entries(stats.byType).map(([type, count]) => ({ type, count, pct: (count / total) * 100 }))
  }, [stats])

  const backups = (backupsQuery.data?.backups ?? []) as BackupRow[]
  const backupsTotalBytes = useMemo(() => backups.reduce((a, b) => a + (b.sizes.total ?? 0), 0), [backups])
  const hasQdrantBackup = useMemo(() => backups.some((b) => b.vectorMode === 'qdrant'), [backups])
  const autoBackupCount = useMemo(() => backups.filter((b) => b.auto === true).length, [backups])

  // ---- 定时备份表单校验 / clamp（与后端同边界：间隔 2-168、保留 2-50） ----
  const schedIntervalNum = Number(schedInterval)
  const schedKeepNum = Number(schedKeep)
  const schedInputsValid =
    Number.isFinite(schedIntervalNum) &&
    schedIntervalNum >= SCHED_INTERVAL_MIN &&
    schedIntervalNum <= SCHED_INTERVAL_MAX &&
    Number.isFinite(schedKeepNum) &&
    schedKeepNum >= SCHED_KEEP_MIN &&
    schedKeepNum <= SCHED_KEEP_MAX
  const scheduleDirty =
    !!schedule &&
    schedInputsValid &&
    (schedEnabled !== schedule.enabled ||
      schedIntervalNum !== schedule.intervalHours ||
      schedKeepNum !== schedule.keep)

  /** 失焦校验：越界/非法 → clamp 到边界并提示 */
  const clampSchedInterval = () => {
    const n = Number(schedInterval)
    const clamped = Number.isFinite(n)
      ? Math.min(SCHED_INTERVAL_MAX, Math.max(SCHED_INTERVAL_MIN, Math.round(n)))
      : SCHED_INTERVAL_DEFAULT
    if (clamped !== Number(schedInterval)) {
      setSchedInterval(String(clamped))
      toast.info(`间隔已调整为 ${clamped} 小时（允许范围 ${SCHED_INTERVAL_MIN}-${SCHED_INTERVAL_MAX}）`)
    }
  }
  const clampSchedKeep = () => {
    const n = Number(schedKeep)
    const clamped = Number.isFinite(n)
      ? Math.min(SCHED_KEEP_MAX, Math.max(SCHED_KEEP_MIN, Math.round(n)))
      : SCHED_KEEP_DEFAULT
    if (clamped !== Number(schedKeep)) {
      setSchedKeep(String(clamped))
      toast.info(`保留份数已调整为 ${clamped}（允许范围 ${SCHED_KEEP_MIN}-${SCHED_KEEP_MAX}）`)
    }
  }

  const levelColor = (level: string) =>
    level === 'error'
      ? 'text-rose-600 dark:text-rose-400'
      : level === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground'

  return (
    <div className={cn('h-full overflow-y-auto', ragScrollbar)}>
      <div className="mx-auto w-full max-w-[1600px] space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">系统运维</h2>
            <p className="text-xs text-muted-foreground">服务健康矩阵 · 流水线任务 · 实时活动流（10s 自动刷新）</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-emerald-500 animate-pulse' : 'bg-stone-400')} />
              实时通道{connected ? '已连接' : '未连接'}
            </span>
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => { healthQuery.refetch(); jobsQuery.refetch() }} disabled={healthQuery.isRefetching}>
              <RefreshCw className={cn('h-3 w-3', healthQuery.isRefetching && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </div>

        {/* 健康矩阵 */}
        {healthQuery.isLoading ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : healthQuery.error ? (
          <ErrorCard
            title="健康状态加载失败"
            message={healthQuery.error instanceof Error ? healthQuery.error.message : String(healthQuery.error)}
            onRetry={() => healthQuery.refetch()}
          />
        ) : health ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Server className="h-4 w-4 text-primary" />
                服务健康矩阵
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 xl:grid-cols-3">
                {HEALTH_ROWS.map(({ key, label, icon: Icon }) => {
                  const row = (health as Record<string, any>)[key] ?? {}
                  // 防御：pipeline 等无 ok 字段时按对象存在视为正常
                  const ok = row.ok !== undefined ? !!row.ok : Object.keys(row).length > 0
                  // 完整拼接文案（与下方渲染内容一致）：截断时 title 可悬停查看全文，不撑破卡片
                  const rowDetail = [
                    row.message ?? row.model ?? (ok ? '正常' : '不可用'),
                    row.version ? `v${row.version}` : '',
                    row.dim ? `${row.dim}d` : '',
                    key === 'vectorStore' ? `${formatNumber(row.collections)} 集合 / ${formatNumber(row.points)} 点` : '',
                    key === 'pipeline' ? `运行 ${formatUptime(row.uptimeSec)}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <div key={key} className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/20 p-3">
                      <span className={cn('mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ring-2', ok ? 'bg-emerald-500 ring-emerald-500/20' : 'bg-rose-500 ring-rose-500/20')} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs font-medium">{label}</span>
                          <Badge
                            variant="outline"
                            className={cn(
                              'ml-auto text-[10px]',
                              row.mode === 'qdrant' || row.mode === 'real' || row.mode === 'mineru'
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                                : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
                            )}
                          >
                            {row.mode ?? '—'}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-[11px] text-muted-foreground" title={rowDetail}>
                          {rowDetail}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* Prometheus 指标卡 */}
        {metricsQuery.data?.summary && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <Gauge className="h-4 w-4 text-primary" />
                平台指标
                <Badge variant="outline" className="text-[10px] font-mono">GET /api/metrics</Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 gap-1 px-2 text-[10px]"
                  onClick={() => setPromOpen((v) => !v)}
                >
                  {promOpen ? '收起' : '查看'} Prometheus 原始文本
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {(() => {
                const m = metricsQuery.data!.summary
                const modeRows = Object.entries(m.modes).filter(([, v]) => v)
                return (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                        <p className="flex items-center justify-center gap-1 text-[9px] text-muted-foreground"><Timer className="h-2.5 w-2.5" />进程运行</p>
                        <p className="font-mono text-sm font-semibold tabular-nums">{formatUptime(m.process.uptimeSec)}</p>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                        <p className="text-[9px] text-muted-foreground">检索次数</p>
                        <p className="font-mono text-sm font-semibold tabular-nums">{formatNumber(m.search.total)}</p>
                        <p className="text-[8px] text-muted-foreground">avg {m.search.avgMs ?? '—'}ms · max {m.search.maxMs}ms</p>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                        <p className="text-[9px] text-muted-foreground">检索错误</p>
                        <p className={cn('font-mono text-sm font-semibold tabular-nums', m.search.errors > 0 && 'text-rose-600 dark:text-rose-400')}>{m.search.errors}</p>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                        <p className="text-[9px] text-muted-foreground">API 调用（累计）</p>
                        <p className="font-mono text-sm font-semibold tabular-nums">{formatNumber(m.api.calls)}</p>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                        <p className="text-[9px] text-muted-foreground">启用 chunk / 总数</p>
                        <p className="font-mono text-sm font-semibold tabular-nums">{formatNumber(m.store.enabledChunks)}/{formatNumber(m.store.chunks)}</p>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                        <p className="text-[9px] text-muted-foreground">向量点</p>
                        <p className="font-mono text-sm font-semibold tabular-nums">{formatNumber(m.store.points)}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {Object.entries(m.search.byMode).length > 0 ? (
                        Object.entries(m.search.byMode).map(([mode, n]) => (
                          <Badge key={mode} variant="secondary" className="font-mono text-[10px]">{mode}×{n}</Badge>
                        ))
                      ) : (
                        <span className="text-[10px] text-muted-foreground">暂无检索记录</span>
                      )}
                      <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
                        {modeRows.map(([k, v]) => (
                          <Badge key={k} variant="outline" className="text-[9px] font-mono">{k}={v}</Badge>
                        ))}
                      </span>
                    </div>
                  </>
                )
              })()}
              {promOpen && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">curl $HOST/api/metrics</code>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 gap-1 px-2 text-[10px]"
                      onClick={() => {
                        void navigator.clipboard?.writeText('curl -s http://<host>:3000/api/metrics').then(() => toast.success('已复制 scrape 命令'))
                      }}
                    >
                      复制
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={() => void promQuery.refetch()}>
                      <RefreshCw className={cn('h-3 w-3', promQuery.isFetching && 'animate-spin')} />刷新
                    </Button>
                  </div>
                  <pre className={cn('max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-[10px] leading-relaxed', ragScrollbar)}>
                    {promQuery.isFetching && !promQuery.data ? '加载中…' : promQuery.data ?? '加载中…'}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 备份与恢复 */}
        <Card>
          <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <DatabaseBackup className="h-4 w-4 text-primary" />
              备份与恢复
            </CardTitle>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <label
                className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground"
                title="备份时包含 artifacts 产物目录（原始文件 / full.md / middle.json / chunk 全文），恢复时一并还原"
              >
                <Checkbox
                  checked={includeArtifacts}
                  onCheckedChange={(v) => setIncludeArtifacts(v === true)}
                  className="h-3.5 w-3.5"
                  aria-label="包含产物文件"
                />
                包含产物文件
              </label>
              <Button
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={createBackupMutation.isPending}
                onClick={() => createBackupMutation.mutate()}
              >
                {createBackupMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                {createBackupMutation.isPending ? '创建中…' : '创建备份'}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* 定时自动备份配置（契约 §15：进程内调度器 + 保留轮转） */}
            <div className="space-y-2.5 rounded-lg bg-muted/30 p-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {/* 左：启用开关 + 说明 */}
                <div className="flex min-w-[240px] flex-1 items-center gap-2.5">
                  <Switch
                    checked={schedEnabled}
                    onCheckedChange={(v) => setSchedEnabled(v === true)}
                    disabled={scheduleQuery.isLoading || saveScheduleMutation.isPending}
                    className="data-[state=checked]:bg-amber-500"
                    aria-label="启用定时自动备份"
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium">定时自动备份</p>
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      每 {schedInterval || '—'} 小时自动创建完整备份，保留最近 {schedKeep || '—'} 份自动备份（手动备份不受影响）
                    </p>
                  </div>
                </div>
                {/* 中：间隔 / 保留份数（失焦 clamp 校验） */}
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    间隔（小时）
                    <Input
                      type="number"
                      min={SCHED_INTERVAL_MIN}
                      max={SCHED_INTERVAL_MAX}
                      value={schedInterval}
                      onChange={(e) => setSchedInterval(e.target.value)}
                      onBlur={clampSchedInterval}
                      disabled={scheduleQuery.isLoading || saveScheduleMutation.isPending}
                      className="h-8 w-20 text-xs"
                      aria-label="自动备份间隔小时数（2-168）"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    保留份数
                    <Input
                      type="number"
                      min={SCHED_KEEP_MIN}
                      max={SCHED_KEEP_MAX}
                      value={schedKeep}
                      onChange={(e) => setSchedKeep(e.target.value)}
                      onBlur={clampSchedKeep}
                      disabled={scheduleQuery.isLoading || saveScheduleMutation.isPending}
                      className="h-8 w-20 text-xs"
                      aria-label="自动备份保留份数（2-50）"
                    />
                  </label>
                </div>
                {/* 右：保存配置（有变更才可点） */}
                <Button
                  size="sm"
                  className="h-8 gap-1 text-xs"
                  disabled={!scheduleDirty || saveScheduleMutation.isPending}
                  onClick={() => saveScheduleMutation.mutate()}
                >
                  {saveScheduleMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  {saveScheduleMutation.isPending ? '保存中…' : '保存配置'}
                </Button>
              </div>
              {/* 状态徽标行：调度器运行态 + 累计统计（服务端真相） */}
              {scheduleQuery.isLoading ? (
                <Skeleton className="h-4 w-72 rounded" />
              ) : schedule ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2">
                  {schedule.schedulerRunning ? (
                    <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                      运行中 · 下次 {formatDateTime(schedule.nextRunAt)}
                    </span>
                  ) : schedule.enabled ? (
                    <span className="flex items-center gap-1.5 text-[11px] font-medium text-rose-600 dark:text-rose-400">
                      <span className="h-2 w-2 rounded-full bg-rose-500" />
                      调度器异常（已启用但未运行）
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">未启用</span>
                  )}
                  <span className="text-[11px] text-muted-foreground">累计 {schedule.runCount} 次</span>
                  {schedule.failCount > 0 && (
                    <span className="text-[11px] font-medium text-rose-600 dark:text-rose-400">失败 {schedule.failCount} 次</span>
                  )}
                  {schedule.lastRunAt && (
                    <span className="text-[11px] text-muted-foreground" title={schedule.lastBackupId ?? undefined}>
                      上次自动备份 {timeAgo(schedule.lastRunAt)}
                    </span>
                  )}
                </div>
              ) : scheduleQuery.error ? (
                <p className="border-t border-border/60 pt-2 text-[11px] text-rose-600 dark:text-rose-400">
                  调度状态加载失败：{scheduleQuery.error instanceof Error ? scheduleQuery.error.message : String(scheduleQuery.error)}
                </p>
              ) : null}
            </div>
            {/* 顶部小统计行 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="text-[10px]">共 {backups.length} 个备份</Badge>
              {autoBackupCount > 0 && (
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-300" title="定时任务自动创建（受保留轮转管理）">
                  自动 {autoBackupCount} 个
                </Badge>
              )}
              <Badge variant="secondary" className="text-[10px]">磁盘占用 {backupsTotalBytes > 0 ? formatBytes(backupsTotalBytes) : '—'}</Badge>
              <span className="text-[10px] text-muted-foreground">SQLite 一致性快照（VACUUM INTO）+ 可选 artifacts 产物</span>
            </div>
            {hasQdrantBackup && (
              <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                Qdrant 模式下向量数据需单独执行 Qdrant snapshot，此处仅备份元数据与 DB
              </p>
            )}
            {restoreBackupMutation.isPending && (
              <p className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                <Loader2 className="h-3 w-3 animate-spin" />
                正在恢复备份（覆盖全部数据），完成后页面将自动刷新…
              </p>
            )}
            {backupsQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 rounded-lg" />
                ))}
              </div>
            ) : backupsQuery.error ? (
              <ErrorCard
                title="备份列表加载失败"
                message={backupsQuery.error instanceof Error ? backupsQuery.error.message : String(backupsQuery.error)}
                onRetry={() => backupsQuery.refetch()}
              />
            ) : backups.length === 0 ? (
              <EmptyHint
                icon={<DatabaseBackup className="h-6 w-6" />}
                title="暂无备份"
                description="点击右上角「创建备份」生成第一份完整快照：SQLite 一致性在线备份 + artifacts 产物目录，可随时恢复到备份时点。"
              />
            ) : (
              <div className={cn('max-h-96 overflow-y-auto', ragScrollbar)}>
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead className="h-8 text-[11px]">备份时间</TableHead>
                      <TableHead className="h-8 text-[11px]">内容</TableHead>
                      <TableHead className="h-8 text-[11px]">体积</TableHead>
                      <TableHead className="h-8 text-[11px]">模式</TableHead>
                      <TableHead className="h-8 text-[11px] text-center">产物</TableHead>
                      <TableHead className="h-8 text-[11px] text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {backups.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="py-2">
                          <p className="whitespace-nowrap text-xs">{formatDateTime(b.createdAt)}</p>
                          <p className="font-mono text-[10px] text-muted-foreground" title={b.id}>
                            v{b.version} · {b.id}
                          </p>
                        </TableCell>
                        <TableCell className="whitespace-nowrap py-2 text-[11px] text-muted-foreground">
                          {b.counts.kbs} 库 · {b.counts.docs} 文档 · {b.counts.chunks} chunk · {b.counts.points} 点
                        </TableCell>
                        <TableCell className="whitespace-nowrap py-2 text-[11px]">
                          <span className="font-semibold tabular-nums">{formatBytes(b.sizes.total)}</span>
                          <span className="text-muted-foreground">
                            {' '}· db {formatBytes(b.sizes.db)} · 产物 {b.sizes.artifacts > 0 ? formatBytes(b.sizes.artifacts) : '—'}
                          </span>
                        </TableCell>
                        <TableCell className="py-2">
                          <div className="flex items-center gap-1">
                            {b.vectorMode === 'qdrant' ? (
                              <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-300" title="Qdrant 模式：向量需单独 snapshot">qdrant</Badge>
                            ) : (
                              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-300" title="本地向量引擎：向量数据随 DB 备份">local</Badge>
                            )}
                            {b.auto === true && (
                              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-300" title="定时任务自动创建（受保留轮转管理，手动备份不受影响）">
                                自动
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="py-2 text-center">
                          {b.includesArtifacts ? (
                            <Check className="mx-auto h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-label="包含产物文件" />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="py-2 text-right">
                          <div className="flex items-center justify-end gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              title="下载 tar.gz 归档"
                              onClick={() => window.open(ragApi.backupDownloadUrl(b.id), '_blank')}
                            >
                              <Download className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              title="恢复此备份（覆盖当前全部数据）"
                              disabled={restoreBackupMutation.isPending || deleteBackupMutation.isPending}
                              onClick={() => setRestoreTarget(b)}
                            >
                              {restoreBackupMutation.isPending && restoreTarget?.id === b.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-rose-600 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
                              title="删除此备份"
                              disabled={restoreBackupMutation.isPending || deleteBackupMutation.isPending}
                              onClick={() => setDeleteTarget(b)}
                            >
                              {deleteBackupMutation.isPending && deleteTarget?.id === b.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Qdrant 快照（契约 §23）：qdrant 模式向量数据的独立备份通道（local 模式引导空态） */}
            <div className="space-y-2.5 border-t border-border/60 pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold">
                  <Camera className="h-3.5 w-3.5 text-primary" />
                  Qdrant 快照
                </h3>
                {snapshotsData && (
                  <Badge variant="secondary" className="text-[10px]">
                    {snapshotsData.totalSnapshots} 个快照 / {snapshotGroups.length || snapshotsData.collections.length} 集合
                  </Badge>
                )}
                <span className="hidden text-[10px] text-muted-foreground sm:inline">
                  向量数据的独立备份通道（SQLite / 产物备份见上方）
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 gap-1 px-2 text-[10px]"
                  onClick={() => void snapshotsQuery.refetch()}
                  disabled={snapshotsQuery.isFetching}
                >
                  <RefreshCw className={cn('h-3 w-3', snapshotsQuery.isFetching && 'animate-spin')} />
                  刷新
                </Button>
              </div>

              {snapshotsQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 rounded-lg" />
                  ))}
                </div>
              ) : snapshotsLocalMode ? (
                <EmptyHint
                  icon={<Camera className="h-6 w-6" />}
                  title="local 模式无 Qdrant 快照"
                  description="qdrant 模式下此处可直接创建 / 恢复 / 下载向量数据快照（当前 local 模式向量数据随上方备份一起保存）"
                />
              ) : snapshotsQuery.error ? (
                <ErrorCard
                  title="Qdrant 快照加载失败"
                  message={snapshotsQuery.error instanceof Error ? snapshotsQuery.error.message : String(snapshotsQuery.error)}
                  onRetry={() => snapshotsQuery.refetch()}
                />
              ) : snapshotsData && snapshotsData.totalSnapshots === 0 ? (
                /* qdrant 模式但无任何快照：空态 + 每集合快捷创建 */
                <div className="space-y-2">
                  <EmptyHint
                    icon={<Camera className="h-6 w-6" />}
                    title="暂无 Qdrant 快照"
                    description="为各集合创建第一份向量数据快照（创建 / 恢复 / 下载均在此处完成）："
                  />
                  {qdrantCollectionsQuery.isLoading ? (
                    <Skeleton className="h-7 w-56 rounded-lg" />
                  ) : quickCreateCollections.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {quickCreateCollections.map((c) => (
                        <Button
                          key={c}
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1 font-mono text-[10px]"
                          disabled={snapCreateMutation.isPending}
                          onClick={() => snapCreateMutation.mutate(c)}
                          title={`为集合 ${c} 创建快照`}
                        >
                          {snapCreateMutation.isPending && snapCreateMutation.variables === c ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Plus className="h-3 w-3" />
                          )}
                          {c}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      qdrant 中暂无集合（切换模式后需重新解析 / 重切分文档生成向量数据）
                    </p>
                  )}
                </div>
              ) : (
                /* 按集合分组快照列表：集合名 Badge + 组顶创建 + 行内 恢复/下载/删除 */
                <div className="space-y-2">
                  {snapshotGroups.map(({ collection, snapshots }) => (
                    <div key={collection} className="overflow-hidden rounded-lg border border-border/60">
                      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/30 px-2.5 py-1.5">
                        <Badge variant="outline" className="max-w-full truncate font-mono text-[10px]" title={collection}>
                          {collection}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">{snapshots.length} 个快照</span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="ml-auto h-7 gap-1 px-2 text-[10px]"
                          disabled={snapCreateMutation.isPending}
                          onClick={() => snapCreateMutation.mutate(collection)}
                          title={`为集合 ${collection} 创建新快照`}
                        >
                          {snapCreateMutation.isPending && snapCreateMutation.variables === collection ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Plus className="h-3 w-3" />
                          )}
                          创建快照
                        </Button>
                      </div>
                      {snapshots.length === 0 ? (
                        <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
                          暂无快照，点击右上角「创建快照」生成第一份。
                        </p>
                      ) : (
                        <div className="divide-y divide-border/60">
                          {snapshots.map((s) => {
                            const createdIso = new Date(s.createdAt).toISOString()
                            return (
                              <div key={s.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5">
                                <p className="min-w-0 flex-1 basis-40 truncate font-mono text-[11px]" title={s.name}>
                                  {s.name}
                                </p>
                                <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground">
                                  {formatBytes(s.sizeBytes)}
                                </span>
                                <span className="whitespace-nowrap text-[10px] text-muted-foreground" title={formatDateTime(createdIso)}>
                                  {timeAgo(createdIso)}
                                </span>
                                <div className="flex items-center gap-0.5">
                                  <Button variant="outline" size="icon" className="h-7 w-7" asChild title="下载快照文件">
                                    <a href={s.downloadUrl} download aria-label={`下载快照 ${s.name}`}>
                                      <Download className="h-3.5 w-3.5" />
                                    </a>
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-7 w-7 text-rose-600 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
                                    title="从快照恢复（覆盖该集合现有向量数据，破坏性操作）"
                                    aria-label={`从快照恢复 ${s.name}`}
                                    disabled={snapRestoreMutation.isPending || snapDeleteMutation.isPending}
                                    onClick={() => setSnapRestoreTarget(s)}
                                  >
                                    {snapRestoreMutation.isPending && snapRestoreTarget?.name === s.name ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <RotateCcw className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-7 w-7 text-rose-600 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
                                    title="删除此快照"
                                    aria-label={`删除快照 ${s.name}`}
                                    disabled={snapRestoreMutation.isPending || snapDeleteMutation.isPending}
                                    onClick={() => setSnapDeleteTarget(s)}
                                  >
                                    {snapDeleteMutation.isPending && snapDeleteTarget?.name === s.name ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Trash2 className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 恢复二次确认（破坏性） */}
        <AlertDialog open={!!restoreTarget} onOpenChange={(o) => !o && setRestoreTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                恢复此备份？
              </AlertDialogTitle>
              <AlertDialogDescription>
                将覆盖当前全部数据（知识库 / 文档 / chunk / 向量 / API Key / 设置），此操作不可撤销。恢复完成后建议刷新页面。
                {restoreTarget && (
                  <span className="mt-2 block font-mono text-[11px] text-muted-foreground">
                    {restoreTarget.id} · {restoreTarget.counts.kbs} 库 / {restoreTarget.counts.docs} 文档 / {restoreTarget.counts.points} 点 · {formatBytes(restoreTarget.sizes.total)}
                  </span>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={restoreBackupMutation.isPending}>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
                disabled={restoreBackupMutation.isPending}
                onClick={(e) => {
                  e.preventDefault() // 恢复期间保持弹窗展示进度，由 onSuccess 关闭
                  if (restoreTarget) restoreBackupMutation.mutate(restoreTarget.id)
                }}
              >
                {restoreBackupMutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    恢复中…
                  </>
                ) : (
                  '确认恢复'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 删除备份二次确认 */}
        <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <Trash2 className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                删除此备份？
              </AlertDialogTitle>
              <AlertDialogDescription>
                删除后无法找回该备份文件（{deleteTarget?.id}，{deleteTarget ? formatBytes(deleteTarget.sizes.total) : ''}）。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteBackupMutation.isPending}>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
                disabled={deleteBackupMutation.isPending}
                onClick={(e) => {
                  e.preventDefault()
                  if (deleteTarget) deleteBackupMutation.mutate(deleteTarget.id)
                }}
              >
                {deleteBackupMutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    删除中…
                  </>
                ) : (
                  '确认删除'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Qdrant 快照恢复二次确认（破坏性：覆盖集合向量数据） */}
        <AlertDialog open={!!snapRestoreTarget} onOpenChange={(o) => !o && setSnapRestoreTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                从快照恢复此集合？
              </AlertDialogTitle>
              <AlertDialogDescription>
                集合 <span className="font-mono text-[11px]">{snapRestoreTarget?.collection}</span> 的现有向量数据将被快照内容覆盖（集合不存在时重建），此操作不可撤销，恢复完成后建议重新验证检索效果。
                {snapRestoreTarget && (
                  <span className="mt-2 block font-mono text-[11px] text-muted-foreground">
                    {snapRestoreTarget.name} · {formatBytes(snapRestoreTarget.sizeBytes)}
                  </span>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={snapRestoreMutation.isPending}>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
                disabled={snapRestoreMutation.isPending}
                onClick={(e) => {
                  e.preventDefault() // 恢复期间保持弹窗展示进度，由 onSuccess 关闭
                  if (snapRestoreTarget) snapRestoreMutation.mutate(snapRestoreTarget)
                }}
              >
                {snapRestoreMutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    恢复中…
                  </>
                ) : (
                  '确认恢复'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Qdrant 快照删除二次确认 */}
        <AlertDialog open={!!snapDeleteTarget} onOpenChange={(o) => !o && setSnapDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <Trash2 className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                删除此快照？
              </AlertDialogTitle>
              <AlertDialogDescription>
                删除后无法找回该快照文件（{snapDeleteTarget?.name}，{snapDeleteTarget ? formatBytes(snapDeleteTarget.sizeBytes) : ''}）。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={snapDeleteMutation.isPending}>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
                disabled={snapDeleteMutation.isPending}
                onClick={(e) => {
                  e.preventDefault()
                  if (snapDeleteTarget) snapDeleteMutation.mutate(snapDeleteTarget)
                }}
              >
                {snapDeleteMutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    删除中…
                  </>
                ) : (
                  '确认删除'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 任务统计卡 */}
        {stats && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={<ListChecks className="h-4 w-4" />} label="待处理 (pending)" value={stats.pending} accent="stone" />
            <StatCard icon={<Play className="h-4 w-4" />} label="执行中 (active)" value={stats.active} accent="amber" />
            <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="已完成 (completed)" value={stats.completed} accent="emerald" />
            <StatCard icon={<XCircle className="h-4 w-4" />} label="失败 (failed)" value={stats.failed} accent="rose" />
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_360px]">
          {/* 任务表 */}
          <Card>
            <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0 pb-3">
              <CardTitle className="text-sm">流水线任务</CardTitle>
              <div className="ml-auto flex items-center gap-2">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-7 w-28 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-xs">全部状态</SelectItem>
                    <SelectItem value="pending" className="text-xs">pending</SelectItem>
                    <SelectItem value="active" className="text-xs">active</SelectItem>
                    <SelectItem value="completed" className="text-xs">completed</SelectItem>
                    <SelectItem value="failed" className="text-xs">failed</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="h-7 w-28 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-xs">全部类型</SelectItem>
                    <SelectItem value="parse" className="text-xs">parse</SelectItem>
                    <SelectItem value="chunk" className="text-xs">chunk</SelectItem>
                    <SelectItem value="embed" className="text-xs">embed</SelectItem>
                    <SelectItem value="upsert" className="text-xs">upsert</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {/* byType 分布 */}
              {byTypeBars.length > 0 && (
                <div className="mb-3 flex h-2 w-full overflow-hidden rounded-full bg-muted">
                  {byTypeBars.map((b) => (
                    <div key={b.type} className={JOB_TYPE_META[b.type]?.bar ?? 'bg-stone-400'} style={{ width: `${b.pct}%` }} title={`${b.type}: ${b.count}`} />
                  ))}
                </div>
              )}
              {jobsQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 rounded-lg" />
                  ))}
                </div>
              ) : jobsQuery.error ? (
                <ErrorCard
                  title="任务列表加载失败"
                  message={jobsQuery.error instanceof Error ? jobsQuery.error.message : String(jobsQuery.error)}
                  onRetry={() => jobsQuery.refetch()}
                />
              ) : jobs.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">没有匹配的任务</p>
              ) : (
                <div className="max-h-96 overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-card">
                      <TableRow>
                        <TableHead className="h-8 text-[11px]">类型</TableHead>
                        <TableHead className="h-8 text-[11px]">文档</TableHead>
                        <TableHead className="h-8 text-[11px]">状态</TableHead>
                        <TableHead className="h-8 text-[11px] text-right">尝试</TableHead>
                        <TableHead className="h-8 text-[11px] text-right">耗时</TableHead>
                        <TableHead className="h-8 text-[11px]">时间</TableHead>
                        <TableHead className="h-8 text-[11px] text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jobs.map((job) => (
                        <TableRow key={job.id}>
                          <TableCell className="py-2">
                            <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium', JOB_TYPE_META[job.type]?.badge ?? 'border-stone-400/40 bg-stone-500/10 text-stone-600 dark:text-stone-300')}>
                              {JOB_TYPE_META[job.type]?.label ?? job.type}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-[180px] truncate py-2 text-xs" title={job.docName ?? job.documentId}>
                            {job.docName ?? job.documentId.slice(0, 12) + '…'}
                          </TableCell>
                          <TableCell className="py-2">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 text-[11px] font-medium',
                                job.status === 'failed' ? 'text-rose-600 dark:text-rose-400' : job.status === 'active' ? 'text-amber-600 dark:text-amber-400' : job.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
                              )}
                            >
                              {job.status === 'failed' && job.error ? (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="flex items-center gap-1">
                                        <AlertTriangle className="h-3 w-3" />
                                        {job.status}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-xs text-xs">
                                      {job.error}
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              ) : (
                                job.status
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="py-2 text-right font-mono text-[11px] text-muted-foreground">
                            {job.attempts}/{job.maxAttempts}
                          </TableCell>
                          <TableCell className="py-2 text-right font-mono text-[11px] text-muted-foreground">
                            {formatDuration(job.durationMs)}
                          </TableCell>
                          <TableCell className="py-2 text-[11px] text-muted-foreground">{timeAgo(job.createdAt)}</TableCell>
                          <TableCell className="py-2 text-right">
                            {job.status === 'failed' && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 gap-1 px-2 text-[10px]"
                                disabled={retryMutation.isPending}
                                onClick={() => retryMutation.mutate(job.id)}
                              >
                                重试
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* 清理工具 */}
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                <span className="text-[11px] text-muted-foreground">清理已完成任务（早于）</span>
                <Input
                  type="number"
                  min={1}
                  value={cleanHours}
                  onChange={(e) => setCleanHours(e.target.value)}
                  className="h-7 w-20 text-xs"
                  aria-label="小时数"
                />
                <span className="text-[11px] text-muted-foreground">小时</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto h-7 gap-1 text-xs"
                  disabled={cleanMutation.isPending}
                  onClick={() => cleanMutation.mutate()}
                >
                  <Eraser className="h-3 w-3" />
                  {cleanMutation.isPending ? '清理中…' : '执行清理'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* 实时活动流 */}
          <Card className="flex flex-col">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Activity className="h-4 w-4 text-primary" />
                实时活动流
              </CardTitle>
              <div className="flex items-center gap-1">
                {pausedCount > 0 && paused && <Badge variant="secondary" className="text-[10px]">+{pausedCount} 新事件</Badge>}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => {
                    setPaused((p) => !p)
                    setPausedCount(0)
                  }}
                  title={paused ? '恢复' : '暂停'}
                >
                  {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setActivities([])} title="清空">
                  <Eraser className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex-1">
              <div className={cn('max-h-[480px] space-y-1 overflow-y-auto font-mono', ragScrollbar)} role="log" aria-label="流水线活动日志">
                {activities.length === 0 ? (
                  <p className="py-10 text-center text-[11px] text-muted-foreground">
                    等待流水线事件…
                    <br />
                    （上传文档 / 检索 / 重切分会在此实时滚动）
                  </p>
                ) : (
                  activities.map((a) => (
                    <div key={a.id} className="flex gap-2 rounded px-1.5 py-1 text-[11px] leading-relaxed hover:bg-muted/40">
                      <span className="shrink-0 text-muted-foreground">{formatDateTime(a.at).slice(11)}</span>
                      <span className={cn('shrink-0 font-semibold uppercase', levelColor(a.level))}>[{a.level}]</span>
                      <span className="break-all text-muted-foreground">{a.message}</span>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
