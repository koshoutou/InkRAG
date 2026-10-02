'use client'

// RAG 知识库平台 · 测试集回归视图（契约 §12 金标准用例 + §16 chunk 级金标准 + §18 结果过期 + §19 quick-run-tests 事件）
// 用例 = 查询 + 期望命中文档（金标准）+ 可选 chunk 级金标准（严格断言）+ 参数快照
// 布局：KB 选择器 + 新建/一键回归 → 过期提示条（§18）→ 汇总统计卡 → 通过率分段条 → 用例表（可展开失败详情）

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Boxes,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  History,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Target,
  Timer,
  Trash2,
  TrendingUp,
  TriangleAlert,
  X,
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { usePlatformStore } from '../store'
import type {
  ChunkItem,
  SearchMode,
  TestCaseItem,
  TestCaseParams,
  TestRunHistoryItem,
  TestRunReport,
  TestRunState,
  TestRunStatus,
} from '../types'
import {
  DOC_TYPE_META,
  EmptyHint,
  ErrorCard,
  formatDuration,
  ragScrollbar,
  shortCode,
  StatCard,
  StatusBadge,
  timeAgo,
  ViewPage,
} from '../ui'
import { useRealtime } from '../useRealtime'

/** lastRun 中可能存在的错误文本（后端写入，前端类型未声明） */
type LastRun = TestCaseItem['lastRun'] & { error?: string }

interface CaseForm {
  name: string
  query: string
  docIds: string[]
  /** chunk 级金标准（严格模式）：要求这些 chunk 全部出现在 Top-K 结果 */
  chunkIds: string[]
  mode: SearchMode
  topK: number
  rerank: boolean
  prefetchLimit: number
}

const EMPTY_FORM: CaseForm = {
  name: '',
  query: '',
  docIds: [],
  chunkIds: [],
  mode: 'hybrid',
  topK: 5,
  rerank: false,
  prefetchLimit: 50,
}

/** chunk 选择列表文本预览（压缩空白 + 截断） */
function previewText(t: string, keep = 60): string {
  const flat = t.replace(/\s+/g, ' ').trim()
  return flat.length > keep ? `${flat.slice(0, keep)}…` : flat
}

// ---------------------------------------------------------------------------
// 契约 §19 quick-run-tests：命令面板「一键回归」快捷动作事件
// ---------------------------------------------------------------------------
// 命令面板派发顺序是 setView('testsets') → dispatchEvent（同步块）→ 关闭面板；
// 本视图是动态 chunk + 条件渲染，首次跳转时组件尚未挂载、监听器未注册会丢事件。
// 取舍（简单方案，不为此引入跨模块 pending store）：
//   ① 模块级监听器常驻（chunk 首次加载时注册一次），只记录 pending 时间戳；
//     组件挂载时若 pending 落在 2s 窗口内 → 补触发，覆盖「曾访问过测试集 → 离开 →
//     命令面板再触发」的主路径（此时模块已加载、事件可被记录）；
//   ② 从未访问过测试集时模块本身未加载，事件确实丢失——用户再按一次即可
//     （组件已挂载、useEffect 监听生效）。
const QUICK_RUN_EVENT = 'rag:quick-run-tests'
/** pending 补触发窗口：事件派发 → 动态 chunk 加载 → 组件挂载的常规时延余量 */
const QUICK_RUN_PENDING_WINDOW_MS = 2000
let pendingQuickRunAt = 0
if (typeof window !== 'undefined') {
  window.addEventListener(QUICK_RUN_EVENT, () => {
    pendingQuickRunAt = Date.now()
  })
}

// ---------------------------------------------------------------------------
// 契约 §21 异步测试集运行（>8 例或 async:true → 后台 job + testrun:progress 推送）
// ---------------------------------------------------------------------------

/** §21 testrun:progress 事件载荷（部分状态：无 startedAt/report，终态需再拉全量） */
interface TestRunProgressEvent {
  runId: string
  kbId: string
  status: TestRunStatus
  total: number
  done: number
  current?: string
  error?: string
}

/** §21 状态轮询间隔（仅 running 时；socket 事件通道的兜底） */
const RUN_POLL_INTERVAL_MS = 1500
/** 连续轮询失败阈值（≈4.5s：404=run 被清理/服务重启 → 合成 error 态解除按钮阻塞） */
const RUN_POLL_FAIL_LIMIT = 3

/**
 * §21 运行请求（原生 fetch）：需读取全部三态响应体——
 * 200 { report }（≤8 例同步）| 200 { run }（异步 job）| 409 { run, note }（接管进行中运行）。
 * 不复用 ragApi.runTestCases：其 asJson 对 409 直接抛错丢弃 { run, note } 载荷，
 * 而 409 恰恰需要其中的 runId 才能接管轮询（契约 §21「不视为错误」）。
 */
async function postTestRun(
  kbId: string,
  body: { caseIds?: string[]; onlyEnabled?: boolean },
): Promise<{ status: number; report?: TestRunReport; run?: TestRunState; note?: string; error?: string }> {
  const res = await fetch(`/api/kb/${encodeURIComponent(kbId)}/testcases/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as {
    report?: TestRunReport
    run?: TestRunState
    note?: string
    error?: string
  }
  return { status: res.status, ...json }
}

/** §21 预计剩余展示：秒级一位小数 / 分钟级取整 */
function formatEta(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return r > 0 ? `${m}m${r}s` : `${m}m`
}

/** 线性外推：已用时间 / 完成数 × 剩余数（done=0 或数据不足 → '—'；随轮询/事件重渲刷新） */
function etaOf(run: TestRunState): string {
  if (run.status !== 'running' || run.done <= 0 || run.total <= run.done) return '—'
  const elapsed = Date.now() - Date.parse(run.startedAt)
  if (!Number.isFinite(elapsed) || elapsed <= 0) return '—'
  return `≈ ${formatEta(Math.round((elapsed / run.done) * (run.total - run.done)))}`
}

export function TestSetsView() {
  const activeKbId = usePlatformStore((s) => s.activeKbId)
  const setKb = usePlatformStore((s) => s.setKb)
  const qc = useQueryClient()

  const [kbId, setKbId] = useState(activeKbId ?? '')
  const [runningAll, setRunningAll] = useState(false)
  // 运行中同步守卫：命令面板事件等非 UI 入口在 React 状态闭包同步前的重复触发也忽略
  const runningRef = useRef(false)
  const [runningCaseId, setRunningCaseId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // §24 历史区展开的运行（done 行点击展开 summary 详情）
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  // 新建 / 编辑 Dialog
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<TestCaseItem | null>(null)
  const [initialForm, setInitialForm] = useState<CaseForm>(EMPTY_FORM)
  const [form, setForm] = useState<CaseForm>(EMPTY_FORM)
  const [advOpen, setAdvOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  // chunk 级金标准（§16）：Dialog 内已加载的各文档 chunk 列表
  const [chunkSecOpen, setChunkSecOpen] = useState(false)
  const [chunksByDoc, setChunksByDoc] = useState<Record<string, ChunkItem[]>>({})
  const [loadingDocId, setLoadingDocId] = useState<string | null>(null)

  // 删除确认
  const [deleting, setDeleting] = useState<TestCaseItem | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  // ---- §21 异步测试集运行状态 -------------------------------------------------
  // 后端三态：200 { report }（≤8 例同步，旧路径）| 200 { run }（后台 job）| 409 { run, note }（接管）。
  //
  // 页面挂载恢复取舍（简单方案）：后端无「按 KB 查询进行中 run」的全局端点，挂载时无法主动探测。
  //   ① 异步运行期间「一键回归 / 仅重跑过期用例」禁用（runningAll 阻塞至终态解除）；
  //   ② 刷新/重进页面后不做挂载查询，但保留两条被动恢复路径：
  //      a. 实时事件收养——订阅 kb:{kbId} 房间，收到未追踪的 running 事件即拉全量收养显示
  //         （依赖下一次推送，约 1 例耗时后出现；非挂载主动查询，后端零改动）；
  //      b. 用户再点「一键回归」→ 后端 409 返回现有 run → 前端接管进度（契约 §21）。
  const [asyncRun, setAsyncRun] = useState<TestRunState | null>(null)
  /** 事件回调读取最新追踪状态（避免 handler 闭包过期 → 不放入 effect 依赖以免频繁重订阅） */
  const asyncRunRef = useRef<TestRunState | null>(null)
  /** 收养时校验 KB 归属（effect 同步最新 kbId） */
  const kbIdRef = useRef('')
  /** 轮询连续失败计数（run 被清理/服务重启 → 合成 error 态解除阻塞） */
  const pollFailRef = useRef(0)
  /** 终态/进度副作用的上一次快照（null = 无追踪；结构含 runId 防串合） */
  const runWatchRef = useRef<{ runId: string; status: TestRunStatus; done: number } | null>(null)

  useEffect(() => {
    asyncRunRef.current = asyncRun
  }, [asyncRun])
  useEffect(() => {
    kbIdRef.current = kbId
  }, [kbId])

  /**
   * §21 状态合并：runId 校验 + 终态不回退 + done 单调；
   * 未追踪或已终态（旧完成/失败卡不阻塞新运行）时进入「被动收养」分支（仅收当前 KB 的 running 态）。
   */
  const applyRunState = useCallback((next: TestRunState) => {
    setAsyncRun((prev) => {
      if (!prev || prev.status !== 'running') {
        return next.status === 'running' && next.kbId === kbIdRef.current ? next : prev
      }
      if (prev.runId !== next.runId) return prev
      if (next.status === 'running' && next.done < prev.done) return prev
      return next
    })
  }, [])

  // §21 实时事件通道：testrun:progress（比轮询更快；双通道并行，状态以先到者为准）
  const { subscribeRooms, on } = useRealtime()
  useEffect(() => {
    if (!kbId) return
    subscribeRooms([`kb:${kbId}`])
  }, [kbId, subscribeRooms])
  useEffect(() => {
    const un = on('testrun:progress', (e: TestRunProgressEvent) => {
      if (!e || typeof e.runId !== 'string') return
      const tracked = asyncRunRef.current
      const forTracked = !!tracked && tracked.runId === e.runId
      if (!forTracked && e.kbId !== kbId) return
      // 用例表实时刷新：后端每例完成即写 lastRunJson（对未收养的运行也生效）
      void qc.invalidateQueries({ queryKey: ['testcases', e.kbId] })
      // §24 历史区实时刷新：running 行进度推进 / 终态行出汇总（每例一次，代价可忽）
      void qc.invalidateQueries({ queryKey: ['test-runs', e.kbId] })
      if (e.status === 'done' || e.status === 'error') {
        // 终态事件是部分载荷（无 report/startedAt）→ 仅追踪中拉全量补齐，避免「完成但无汇总」中间态
        if (!forTracked) return
        void ragApi
          .getTestRun(e.kbId, e.runId)
          .then(({ run }) => applyRunState(run))
          .catch(() => {})
        return
      }
      if (forTracked) {
        // 运行进度合并（runId 已校验；done 取最大防回退）
        setAsyncRun((prev) => {
          if (!prev || prev.runId !== e.runId || prev.status !== 'running') return prev
          return {
            ...prev,
            total: e.total ?? prev.total,
            done: Math.max(prev.done, e.done ?? prev.done),
            current: e.current ?? prev.current,
          }
        })
      } else if (!runningRef.current) {
        // 未追踪（或已终态的旧卡）+ 当前 KB + 本视图空闲：被动收养（刷新/重进页面后恢复进度显示，见组件头取舍注释）
        void ragApi
          .getTestRun(e.kbId, e.runId)
          .then(({ run }) => {
            const cur = asyncRunRef.current
            if (runningRef.current) return
            // 已在追踪另一场运行中的 job → 不收养；旧终态卡 / 未追踪 / 同 runId 竞态重拉 → 收养或合并
            if (cur && cur.status === 'running' && cur.runId !== run.runId) return
            applyRunState(run)
          })
          .catch(() => {})
      }
    })
    return un
  }, [on, kbId, qc, applyRunState])

  // §21 轮询通道：仅 running 时每 1.5s 拉全量（done/error 停止；事件通道断连时的兑底）
  const pollingRunId = asyncRun?.status === 'running' ? asyncRun.runId : null
  useEffect(() => {
    if (!pollingRunId || !kbId) return
    pollFailRef.current = 0
    let alive = true
    const timer = window.setInterval(async () => {
      try {
        const { run } = await ragApi.getTestRun(kbId, pollingRunId)
        if (!alive) return
        pollFailRef.current = 0
        applyRunState(run)
      } catch {
        if (!alive) return
        // 404（run 已被清理/服务重启）或网络异常：连续失败达到阈值 → 合成 error 态解除阻塞
        if (++pollFailRef.current >= RUN_POLL_FAIL_LIMIT) {
          setAsyncRun((prev) =>
            prev && prev.runId === pollingRunId && prev.status === 'running'
              ? {
                  ...prev,
                  status: 'error',
                  error: '运行状态查询失败（运行记录已丢失，服务可能已重启）',
                  finishedAt: new Date().toISOString(),
                }
              : prev,
          )
        }
      }
    }, RUN_POLL_INTERVAL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [pollingRunId, kbId, applyRunState])

  // §21 追踪副作用（单一 effect 集中处理，避免多 effect 竞态）：
  // 新 run 追踪 → 阻塞运行按钮（POST 路径已设置，重复无害；收养路径由此接管）；
  // done 推进 → 用例表实时刷新；running → 终态 → 汇总 toast + 解除阻塞 + 最终刷新。
  useEffect(() => {
    if (!asyncRun) {
      runWatchRef.current = null
      return
    }
    const prev = runWatchRef.current
    runWatchRef.current = { runId: asyncRun.runId, status: asyncRun.status, done: asyncRun.done }
    if (prev && prev.runId === asyncRun.runId) {
      if (asyncRun.status === 'running' && asyncRun.done > prev.done) {
        void qc.invalidateQueries({ queryKey: ['testcases', asyncRun.kbId] })
      }
      if (prev.status === 'running' && asyncRun.status !== 'running') {
        runningRef.current = false
        setRunningAll(false)
        if (asyncRun.status === 'done') {
          const rp = asyncRun.report
          toast.success(
            rp
              ? `回归完成：${rp.passed}/${rp.total} 用例通过 · 平均命中率 ${(rp.hitRateAvg * 100).toFixed(0)}% · MRR ${rp.mrrAvg.toFixed(2)}`
              : '回归完成',
          )
        } else {
          toast.error(`回归失败：${asyncRun.error ?? '未知错误'}`)
        }
        void qc.invalidateQueries({ queryKey: ['testcases', asyncRun.kbId] })
        // §24 终态：历史区该行由 running 转 done/error 汇总
        void qc.invalidateQueries({ queryKey: ['test-runs', asyncRun.kbId] })
      }
    } else if (asyncRun.status === 'running') {
      runningRef.current = true
      setRunningAll(true)
    }
  }, [asyncRun, qc])

  // KB 列表（默认 store.activeKbId 或第一个）
  const kbsQuery = useQuery({ queryKey: ['kbs'], queryFn: () => ragApi.listKbs() })
  const kbs = kbsQuery.data?.kbs ?? []
  useEffect(() => {
    if (kbs.length > 0 && (!kbId || !kbs.some((k) => k.id === kbId))) {
      setKbId(activeKbId && kbs.some((k) => k.id === activeKbId) ? activeKbId : kbs[0].id)
    }
  }, [kbId, kbs, activeKbId])

  // 用例 + 文档列表
  const tcQuery = useQuery({
    queryKey: ['testcases', kbId],
    queryFn: () => ragApi.listTestCases(kbId),
    enabled: !!kbId,
  })
  const cases = tcQuery.data?.cases ?? []
  const docs = tcQuery.data?.docs ?? []
  const docNameMap = useMemo(() => new Map(docs.map((d) => [d.id, d.filename])), [docs])

  // 严格用例（§16）期望 chunk 元信息（seq / docType / 归属文档），徽标 tooltip 展示用
  const strictDocIds = useMemo(
    () => [...new Set(cases.filter((c) => c.expectChunkIds.length > 0).flatMap((c) => c.expectDocIds))],
    [cases],
  )
  const chunkMetaQuery = useQuery({
    queryKey: ['testcases-chunk-meta', kbId, strictDocIds],
    queryFn: async () => {
      const lists = await Promise.all(
        strictDocIds.map((d) => ragApi.listChunks(d, { limit: 200 }).catch(() => ({ chunks: [], total: 0 }))),
      )
      const m = new Map<string, { seq: number; docType: string; documentId: string; textPreview: string }>()
      for (const { chunks } of lists) {
        for (const ch of chunks) {
          m.set(ch.id, { seq: ch.seq, docType: ch.docType, documentId: ch.documentId, textPreview: ch.textPreview })
        }
      }
      return m
    },
    enabled: !!kbId && strictDocIds.length > 0,
    staleTime: 60_000,
  })
  const chunkMetaMap = chunkMetaQuery.data

  // ---- §24 运行历史（最近运行；数据源 = §21 globalThis 注册表，重启清零） ----------
  // 同步直跑（≤8 例）不写注册表 → 历史区只有异步运行（>8 例或 async:true 强制）的记录；
  // 轮询策略：有 running 时 5s 推进度，无 running 15s 低频兑底（完成态数据基本不变）。
  const runsQuery = useQuery({
    queryKey: ['test-runs', kbId],
    queryFn: () => ragApi.listTestRuns(kbId),
    enabled: !!kbId,
    staleTime: 5_000,
    refetchInterval: (query) =>
      ((query.state.data as { runs?: TestRunHistoryItem[] } | undefined)?.runs ?? []).some(
        (r) => r.status === 'running',
      )
        ? 5_000
        : 15_000,
  })
  const runs = runsQuery.data?.runs ?? []

  useEffect(() => {
    setExpandedId(null)
    setExpandedRunId(null)
  }, [kbId])

  // 汇总统计（以各用例最近一次运行结果为准，跨刷新保留）
  const stats = useMemo(() => {
    const ran = cases.filter((c) => typeof c.lastRun.pass === 'boolean')
    const passed = ran.filter((c) => c.lastRun.pass === true).length
    const n = ran.length || 1
    const strictCases = cases.filter((c) => c.expectChunkIds.length > 0)
    return {
      ranCount: ran.length,
      passed,
      failed: ran.length - passed,
      notRun: cases.length - ran.length,
      enabled: cases.filter((c) => c.enabled).length,
      hitAvg: ran.reduce((a, c) => a + (c.lastRun.hitRate ?? 0), 0) / n,
      mrrAvg: ran.reduce((a, c) => a + (c.lastRun.mrr ?? 0), 0) / n,
      tookAvg: Math.round(ran.reduce((a, c) => a + (c.lastRun.tookMs ?? 0), 0) / n),
      strictCount: strictCases.length,
      strictPassed: strictCases.filter((c) => c.lastRun.pass === true).length,
      // §18 结果过期统计（后端按 KB chunk 最新变更时间判定）
      stale: cases.filter((c) => c.stale === true).length,
      staleEnabled: cases.filter((c) => c.stale === true && c.enabled).length,
    }
  }, [cases])

  const hasRun = stats.ranCount > 0
  const hitAccent = stats.hitAvg >= 0.8 ? 'emerald' : stats.hitAvg >= 0.5 ? 'amber' : 'rose'
  const formValid =
    form.name.trim().length > 0 && form.query.trim().length > 0 && form.docIds.length > 0
  const formDirty = editing !== null && JSON.stringify(form) !== JSON.stringify(initialForm)
  const canSave = !saving && formValid && (editing === null || formDirty)

  // 已加载 chunk → 归属文档映射（Dialog 内选 chunk 自动勾选文档 / 取消文档守卫用）
  const chunkDocMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const [docId, chunks] of Object.entries(chunksByDoc)) {
      for (const ch of chunks) m.set(ch.id, docId)
    }
    return m
  }, [chunksByDoc])
  // 已选但无法定位归属文档的 chunk（如 API 直改过 expectChunkIds）
  const orphanChunkCount = useMemo(
    () => form.chunkIds.filter((id) => !chunkDocMap.has(id)).length,
    [form.chunkIds, chunkDocMap],
  )

  // ---- 动作 -----------------------------------------------------------------

  const openCreate = () => {
    setEditing(null)
    setInitialForm(EMPTY_FORM)
    setForm(EMPTY_FORM)
    setAdvOpen(false)
    setChunkSecOpen(false)
    setChunksByDoc({})
    setLoadingDocId(null)
    setDialogOpen(true)
  }

  const openEdit = (c: TestCaseItem) => {
    const f: CaseForm = {
      name: c.name,
      query: c.query,
      docIds: [...c.expectDocIds],
      chunkIds: [...c.expectChunkIds],
      mode: c.params.mode ?? 'hybrid',
      topK: c.params.topK ?? 5,
      rerank: c.params.rerank ?? false,
      prefetchLimit: c.params.prefetchLimit ?? 50,
    }
    setEditing(c)
    setInitialForm(f)
    setForm(f)
    setAdvOpen(false)
    setChunkSecOpen(false)
    setChunksByDoc({})
    setLoadingDocId(null)
    setDialogOpen(true)
    // 编辑已配 chunk 金标准的用例：预加载期望文档的 chunk 列表（子集联动 + 回显）
    if (c.expectChunkIds.length > 0 && c.expectDocIds.length > 0) {
      void preloadChunks(c.expectDocIds)
    }
  }

  /** 批量预加载文档 chunk 列表（静默尽力而为，不弹 toast） */
  const preloadChunks = async (docIds: string[]) => {
    const results = await Promise.allSettled(docIds.map((d) => ragApi.listChunks(d, { limit: 200 })))
    setChunksByDoc((m) => {
      const next = { ...m }
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') next[docIds[i]] = r.value.chunks
      })
      return next
    })
  }

  /** Dialog 内单文档「加载 chunk」按钮（带 loading 与错误反馈） */
  const loadDocChunks = async (docId: string) => {
    if (loadingDocId) return
    setLoadingDocId(docId)
    try {
      const { chunks } = await ragApi.listChunks(docId, { limit: 200 })
      setChunksByDoc((m) => ({ ...m, [docId]: chunks }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'chunk 列表加载失败')
    } finally {
      setLoadingDocId(null)
    }
  }

  /** 勾选 chunk：自动勾选其所属文档（chunk 期望 ⊆ 文档期望） */
  const toggleChunk = (chunkId: string, docId: string, checked: boolean) => {
    setForm((f) => {
      const chunkIds = checked
        ? f.chunkIds.includes(chunkId)
          ? f.chunkIds
          : [...f.chunkIds, chunkId]
        : f.chunkIds.filter((x) => x !== chunkId)
      const docIds = checked && !f.docIds.includes(docId) ? [...f.docIds, docId] : f.docIds
      return { ...f, chunkIds, docIds }
    })
  }

  /** 取消文档守卫：该文档下已选 chunk 时禁止取消（需先取消 chunk） */
  const toggleDoc = (docId: string, checked: boolean) => {
    if (!checked && form.chunkIds.some((id) => chunkDocMap.get(id) === docId)) {
      toast.error('该文档下已配置 chunk 级期望，请先取消对应的 chunk')
      return
    }
    setForm((f) => ({
      ...f,
      docIds: checked ? [...f.docIds, docId] : f.docIds.filter((x) => x !== docId),
    }))
  }

  const doSave = async () => {
    if (!kbId || !canSave) return
    setSaving(true)
    try {
      const params: TestCaseParams = {
        ...(editing?.params ?? {}),
        mode: form.mode,
        topK: form.topK,
        rerank: form.rerank,
        prefetchLimit: form.prefetchLimit,
      }
      const payload = {
        name: form.name.trim(),
        query: form.query.trim(),
        expectDocIds: form.docIds,
        expectChunkIds: form.chunkIds,
        params,
      }
      if (editing) {
        await ragApi.patchTestCase(editing.id, payload)
        toast.success(`用例「${payload.name}」已更新`)
      } else {
        await ragApi.createTestCase(kbId, payload)
        toast.success(`用例「${payload.name}」已创建`)
      }
      setDialogOpen(false)
      await qc.invalidateQueries({ queryKey: ['testcases', kbId] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  /**
   * §21 统一运行入口（一键回归 / 仅重跑过期用例共用）：
   * - 200 { report }（≤8 例同步直跑）→ 保持旧成功路径（toast + invalidate）
   * - 200 { run }（>8 例或 async）→ 进入异步运行模式：进度卡 + 轮询/事件双通道
   * - 409 { run, note }（已有进行中的运行）→ 接管进度显示（toast.info，不视为错误）
   * 阻塞解除：同步/异常路径在 release()；异步路径由终态转换 effect 负责（见上方追踪副作用）。
   */
  const launchRun = async (
    body: { caseIds?: string[]; onlyEnabled?: boolean },
    syncDoneToast: (report: TestRunReport) => string,
  ) => {
    const release = () => {
      runningRef.current = false
      setRunningAll(false)
    }
    if (!kbId) {
      release()
      return
    }
    try {
      const r = await postTestRun(kbId, body)
      if (r.report) {
        // 同步路径（≤8 例）：旧行为不变；旧异步运行卡让位（新结果已在用例表中）
        toast.success(syncDoneToast(r.report))
        setAsyncRun(null)
        await qc.invalidateQueries({ queryKey: ['testcases', kbId] })
        release()
        return
      }
      if (r.run) {
        // 异步路径（或 409 接管已有运行）：进入异步运行模式，进度卡 + 双通道，阻塞由终态解除
        if (r.status === 409) toast.info('已有进行中的回归，已接管进度显示')
        setAsyncRun(r.run)
        // §24：新运行入表（或 409 接管）→ 历史区立即出现/刷新 running 行
        void qc.invalidateQueries({ queryKey: ['test-runs', kbId] })
        return
      }
      toast.error(r.error ?? `运行失败（HTTP ${r.status}）`)
      release()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '运行失败')
      release()
    }
  }

  const runAll = () => {
    if (!kbId || runningRef.current) return
    runningRef.current = true
    setRunningAll(true)
    void launchRun(
      { onlyEnabled: true },
      (report) =>
        `回归完成：${report.passed}/${report.total} 用例通过 · 平均命中率 ${(report.hitRateAvg * 100).toFixed(0)}% · MRR ${report.mrrAvg.toFixed(2)}`,
    )
  }

  /** 仅重跑过期用例（§18）：过滤 enabled && stale 的用例，caseIds 精确集合（§21 同样走三态分支） */
  const runStale = () => {
    if (!kbId || runningRef.current) return
    const staleIds = cases.filter((c) => c.stale === true && c.enabled).map((c) => c.id)
    if (staleIds.length === 0) return
    runningRef.current = true
    setRunningAll(true)
    void launchRun(
      { caseIds: staleIds },
      (report) =>
        `已重跑 ${report.total} 个过期用例：${report.passed} 通过 · 平均命中率 ${(report.hitRateAvg * 100).toFixed(0)}% · MRR ${report.mrrAvg.toFixed(2)}`,
    )
  }

  // ---- §19 quick-run-tests：命令面板「一键回归」快捷动作落地 --------------------
  // 触发即一键回归（直接跑 + toast 反馈）；回归进行中则忽略。
  // 组件刚挂载时 kbId 可能尚未由 kbsQuery effect 设定（事件与挂载竞态）→ 300ms × 5 次兑底重试。
  const quickRunAttemptRef = useRef<(attempt: number) => void>(() => {})
  const quickRunAttempt = async (attempt: number) => {
    if (runningRef.current) {
      toast.info('一键回归正在进行中，已忽略本次触发')
      return
    }
    if (!kbId) {
      if (attempt < 5) {
        window.setTimeout(() => quickRunAttemptRef.current(attempt + 1), 300)
        return
      }
      toast.error('尚未选定知识库，一键回归未触发')
      return
    }
    toast.info('已通过命令面板触发一键回归')
    await runAll()
  }
  // 每次渲染后同步最新闭包（监听器仅挂载一次，经 ref 调用最新版本）
  useEffect(() => {
    quickRunAttemptRef.current = quickRunAttempt
  })

  // 事件监听（挂载订阅、卸载清理）：组件已挂载时收到事件直接触发
  useEffect(() => {
    const handler = () => {
      // 组件收到事件即清除模块级 pending，避免下次挂载重复触发
      pendingQuickRunAt = 0
      quickRunAttemptRef.current(0)
    }
    window.addEventListener(QUICK_RUN_EVENT, handler)
    return () => window.removeEventListener(QUICK_RUN_EVENT, handler)
  }, [])

  // 挂载兑底：模块级监听器记录的 pending（2s 窗口内 = 事件派发时组件尚未挂载）→ 补触发
  useEffect(() => {
    if (pendingQuickRunAt > 0 && Date.now() - pendingQuickRunAt < QUICK_RUN_PENDING_WINDOW_MS) {
      pendingQuickRunAt = 0
      quickRunAttemptRef.current(0)
    }
  }, [])

  const runOne = async (c: TestCaseItem) => {
    // runningAll：批量/异步运行进行中后端会 409（每 KB 同时只允许一个异步 job）→ 直接禁用
    if (!kbId || runningCaseId || runningAll) return
    setRunningCaseId(c.id)
    try {
      const { report } = await ragApi.runTestCases(kbId, { caseIds: [c.id], onlyEnabled: false })
      const res = report.cases[0]
      if (res?.pass) {
        toast.success(`「${c.name}」通过 · 命中率 ${(res.hitRate * 100).toFixed(0)}% · MRR ${res.mrr.toFixed(2)}`)
      } else {
        const chunkMiss = res?.chunkMisses?.length ?? 0
        toast.error(
          res?.error
            ? `「${c.name}」未通过：${res.error}`
            : `「${c.name}」未通过 · 未命中 ${res?.misses.length ?? 0} 个期望文档${chunkMiss > 0 ? ` · chunk 级未命中 ${chunkMiss} 个` : ''}`,
        )
      }
      await qc.invalidateQueries({ queryKey: ['testcases', kbId] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '运行失败')
    } finally {
      setRunningCaseId(null)
    }
  }

  const toggleEnabled = async (c: TestCaseItem, enabled: boolean) => {
    if (togglingId) return
    setTogglingId(c.id)
    try {
      await ragApi.patchTestCase(c.id, { enabled })
      toast.success(enabled ? `「${c.name}」已启用` : `「${c.name}」已停用`)
      await qc.invalidateQueries({ queryKey: ['testcases', kbId] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setTogglingId(null)
    }
  }

  const doDelete = async () => {
    if (!deleting) return
    setDeleteLoading(true)
    try {
      await ragApi.deleteTestCase(deleting.id)
      toast.success(`用例「${deleting.name}」已删除`)
      const gone = deleting
      setDeleting(null)
      if (expandedId === gone.id) setExpandedId(null)
      await qc.invalidateQueries({ queryKey: ['testcases', kbId] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    } finally {
      setDeleteLoading(false)
    }
  }

  // ---- 渲染 -----------------------------------------------------------------

  if (kbsQuery.isLoading) {
    return (
      <ViewPage wide>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </ViewPage>
    )
  }
  if (kbsQuery.error) {
    return (
      <ViewPage wide>
        <ErrorCard
          title="知识库列表加载失败"
          message={kbsQuery.error instanceof Error ? kbsQuery.error.message : String(kbsQuery.error)}
          onRetry={() => kbsQuery.refetch()}
        />
      </ViewPage>
    )
  }
  if (kbs.length === 0) {
    return (
      <ViewPage wide>
        <EmptyHint
          icon={<FlaskConical className="h-6 w-6" />}
          title="还没有知识库"
          description="测试集回归依赖知识库中的文档作为金标准。请先在「知识库」视图创建知识库并上传文档。"
        />
      </ViewPage>
    )
  }

  return (
    <ViewPage wide>
      {/* 顶部：标题 + KB 选择器 + 动作 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <FlaskConical className="h-4 w-4 text-primary" />
            测试集回归
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            金标准用例 · 命中率 / MRR 报告 · 与生产同路径的检索执行
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            value={kbId}
            onValueChange={(v) => {
              setKbId(v)
              setKb(v)
            }}
          >
            <SelectTrigger className="h-8 w-56 text-xs" aria-label="选择知识库">
              <SelectValue placeholder="选择知识库" />
            </SelectTrigger>
            <SelectContent>
              {kbs.map((kb) => (
                <SelectItem key={kb.id} value={kb.id} className="text-xs">
                  {kb.name}（{kb.docCount} 文档）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            title="运行全部启用用例，生成命中率 / MRR 报告"
            className="h-8 gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
            onClick={runAll}
            disabled={runningAll || cases.length === 0}
          >
            {runningAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {runningAll ? '回归中…' : '一键回归'}
          </Button>
          <Button size="sm" className="h-8 gap-1.5" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            新建用例
          </Button>
        </div>
      </div>

      {/* §21 异步运行进度卡：running（primary 渐变 + 实时进度）/ done（emerald + 汇总）/ error（rose + 原因）。
          终态保留可手动关闭（取舍：不做 3s 自动收起——用户需要时间阅读汇总；关闭或开启新运行即消失） */}
      {asyncRun && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          role="status"
          aria-live="polite"
          aria-label={
            asyncRun.status === 'running'
              ? `回归进行中，已完成 ${asyncRun.done} / ${asyncRun.total}`
              : asyncRun.status === 'done'
                ? '回归完成'
                : `回归失败：${asyncRun.error ?? '未知错误'}`
          }
          className={cn(
            'rounded-xl border px-4 py-3',
            asyncRun.status === 'running' && 'border-primary/30 bg-gradient-to-r from-primary/10 to-primary/5',
            asyncRun.status === 'done' && 'border-emerald-500/30 bg-gradient-to-r from-emerald-500/10 to-emerald-500/5',
            asyncRun.status === 'error' && 'border-rose-500/30 bg-gradient-to-r from-rose-500/10 to-rose-500/5',
          )}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              {/* 行 1：状态标题 + 计数 / 汇总（数字 tabular-nums） */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {asyncRun.status === 'running' ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                ) : asyncRun.status === 'done' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                )}
                <span
                  className={cn(
                    'text-xs font-semibold',
                    asyncRun.status === 'running' && 'text-primary',
                    asyncRun.status === 'done' && 'text-emerald-700 dark:text-emerald-300',
                    asyncRun.status === 'error' && 'text-rose-700 dark:text-rose-300',
                  )}
                >
                  {asyncRun.status === 'running' ? '回归进行中' : asyncRun.status === 'done' ? '回归完成' : '回归失败'}
                </span>
                {asyncRun.status === 'running' && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    <span className="font-semibold text-foreground">{asyncRun.done}</span>/{asyncRun.total}
                  </span>
                )}
                {asyncRun.status === 'done' && asyncRun.report && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {asyncRun.report.passed}/{asyncRun.report.total} 用例通过 · 命中率{' '}
                    {(asyncRun.report.hitRateAvg * 100).toFixed(0)}% · MRR {asyncRun.report.mrrAvg.toFixed(2)}
                  </span>
                )}
                {asyncRun.status === 'error' && (
                  <span className="min-w-0 truncate text-xs text-rose-600 dark:text-rose-400" title={asyncRun.error}>
                    {asyncRun.error ?? '未知错误'}
                  </span>
                )}
              </div>
              {/* 行 2：进度条（primary 渐变 / emerald / rose；覆盖指示条渐变 + 终态轨道色） */}
              <Progress
                value={
                  asyncRun.status === 'done'
                    ? 100
                    : asyncRun.total > 0
                      ? Math.min(100, Math.round((asyncRun.done / asyncRun.total) * 100))
                      : 0
                }
                aria-label="回归进度"
                className={cn(
                  'mt-2.5 h-2.5',
                  asyncRun.status === 'running' &&
                    '[&>[data-slot=progress-indicator]]:bg-gradient-to-r [&>[data-slot=progress-indicator]]:from-primary [&>[data-slot=progress-indicator]]:to-primary/60',
                  asyncRun.status === 'done' &&
                    'bg-emerald-500/20 [&>[data-slot=progress-indicator]]:bg-gradient-to-r [&>[data-slot=progress-indicator]]:from-emerald-500 [&>[data-slot=progress-indicator]]:to-emerald-400',
                  asyncRun.status === 'error' &&
                    'bg-rose-500/20 [&>[data-slot=progress-indicator]]:bg-gradient-to-r [&>[data-slot=progress-indicator]]:from-rose-500 [&>[data-slot=progress-indicator]]:to-rose-400',
                )}
              />
              {/* 行 3：运行中 → 当前用例 / 预计剩余 / 不可中断提示（sm 以下堆叠）；终态 → 用时 */}
              {asyncRun.status === 'running' ? (
                <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
                    <span className="shrink-0 text-muted-foreground">当前用例</span>
                    <span className="min-w-0 max-w-72 truncate text-muted-foreground" title={asyncRun.current}>
                      {asyncRun.current ?? '—'}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground sm:ml-auto">
                    预计剩余 <span className="font-medium tabular-nums text-foreground">{etaOf(asyncRun)}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">运行不可中断，可离开本页</span>
                </div>
              ) : (
                <p className="mt-1.5 text-[10px] tabular-nums text-muted-foreground/70">
                  {asyncRun.finishedAt
                    ? `始于 ${new Date(asyncRun.startedAt).toLocaleTimeString()} · 用时 ${formatDuration(
                        Math.max(0, Date.parse(asyncRun.finishedAt) - Date.parse(asyncRun.startedAt)),
                      )}`
                    : `始于 ${new Date(asyncRun.startedAt).toLocaleTimeString()}`}
                </p>
              )}
            </div>
            {/* 终态手动关闭（不做 3s 自动收起的取舍见上方注释） */}
            {asyncRun.status !== 'running' && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label="关闭回归进度提示"
                title="关闭"
                onClick={() => setAsyncRun(null)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </motion.div>
      )}

      {/* §18 过期提示条：KB chunk 在上次运行后被编辑/重切分 → 结果待刷新 */}
      {stats.stale > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3"
          role="status"
          aria-label={`${stats.stale} 个用例结果已过期`}
        >
          <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
            <span className="font-semibold tabular-nums">{stats.stale}</span> 个用例结果已过期（chunk 已变更）
            <span className="text-amber-700/80 dark:text-amber-300/80">
              ——KB 下 chunk 在上次运行后被编辑/重切分，结果可能不再准确，重跑可刷新
            </span>
            {stats.stale - stats.staleEnabled > 0 && (
              <span className="text-amber-700/70 dark:text-amber-300/70">
                （另有 {stats.stale - stats.staleEnabled} 个已停用，不参与重跑）
              </span>
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
            onClick={runStale}
            disabled={runningAll || stats.staleEnabled === 0}
            title="仅重跑启用且结果过期的用例"
          >
            {runningAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            仅重跑过期用例（{stats.staleEnabled}）
          </Button>
        </motion.div>
      )}

      {/* 汇总统计卡（有运行结果时显示，淡入） */}
      {hasRun && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7"
        >
          <StatCard
            icon={<FlaskConical className="h-4 w-4" />}
            label="用例总数"
            value={cases.length}
            accent="primary"
            hint={`已启用 ${stats.enabled} · 运行 ${stats.ranCount}`}
          />
          <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="通过数" value={stats.passed} accent="emerald" />
          <StatCard icon={<XCircle className="h-4 w-4" />} label="失败数" value={stats.failed} accent="rose" />
          <StatCard
            icon={<Target className="h-4 w-4" />}
            label="平均命中率"
            value={`${(stats.hitAvg * 100).toFixed(0)}%`}
            accent={hitAccent}
            animate={false}
            hint="期望文档 ∩ Top-K 结果"
          />
          <StatCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="平均 MRR"
            value={stats.mrrAvg.toFixed(2)}
            accent="violet"
            animate={false}
            hint="1 / 首个期望文档排名"
          />
          <StatCard
            icon={<Timer className="h-4 w-4" />}
            label="平均耗时"
            value={formatDuration(stats.tookAvg)}
            accent="teal"
            animate={false}
          />
          {/* §18 过期用例：上次运行后 KB chunk 已变更，结果待重跑（常显，amber accent） */}
          <StatCard
            icon={<TriangleAlert className="h-4 w-4" />}
            label="过期用例"
            value={stats.stale}
            accent="amber"
            animate={false}
            hint="chunk 变更后结果待重跑"
          />
        </motion.div>
      )}

      {/* 通过率分段条 */}
      {cases.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">通过率</span>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {stats.passed}/{cases.length} 通过 · 数据取自各用例最近一次运行
            </span>
          </div>
          <div
            className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`通过 ${stats.passed}，未通过 ${stats.failed}，未运行 ${stats.notRun}，共 ${cases.length} 个用例`}
          >
            {[
              { key: 'pass', count: stats.passed, bar: 'bg-emerald-500', label: '通过' },
              { key: 'fail', count: stats.failed, bar: 'bg-rose-500', label: '未通过' },
            ]
              .filter((s) => s.count > 0)
              .map((s) => (
                <TooltipProvider key={s.key}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className={s.bar}
                        style={{ width: `${(s.count / cases.length) * 100}%` }}
                      />
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">
                      {s.label}：{s.count} 个（{((s.count / cases.length) * 100).toFixed(1)}%）
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ))}
            {/* 未运行 = 剩余 muted 底色 */}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {[
              { label: '通过', count: stats.passed, dot: 'bg-emerald-500' },
              { label: '未通过', count: stats.failed, dot: 'bg-rose-500' },
              { label: '未运行', count: stats.notRun, dot: 'bg-muted-foreground/40' },
            ].map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn('h-2 w-2 rounded-full', s.dot)} />
                {s.label}
                <span className="font-medium tabular-nums text-foreground">{s.count}</span>
              </span>
            ))}
          </div>
          {/* 严格模式（chunk 级金标准）用例统计 */}
          {stats.strictCount > 0 && (
            <p className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <Boxes className="h-3 w-3 text-violet-500" />
              严格模式（chunk 级金标准）
              <span className="font-medium tabular-nums text-violet-600 dark:text-violet-300">{stats.strictCount}</span>
              个用例 · 通过
              <span className="font-medium tabular-nums text-violet-600 dark:text-violet-300">{stats.strictPassed}</span>
            </p>
          )}
        </div>
      )}

      {/* §24 最近运行：异步运行历史（数据源 = §21 进程内注册表，重启清零）。
          同步直跑（≤8 例）不写注册表 → 本区只展示异步运行（>8 例或 async:true）的记录；
          与 §21 进度卡并存：进度卡是「当前运行」的主视图，本区是「全部运行记录」，
          正在 running 的运行两处都会出现（历史区该行仅显示简进度） */}
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <History className="h-3.5 w-3.5 text-primary" />
            最近运行
            <Badge variant="secondary" className="text-[10px]">
              {runs.length}
            </Badge>
            <span className="ml-auto text-[10px] font-normal text-muted-foreground">
              倒序 · 相对时间（悬停可见绝对时间）
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runsQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-md" />
              ))}
            </div>
          ) : runsQuery.error ? (
            <div className="p-4">
              <ErrorCard
                title="运行历史加载失败"
                message={runsQuery.error instanceof Error ? runsQuery.error.message : String(runsQuery.error)}
                onRetry={() => runsQuery.refetch()}
              />
            </div>
          ) : runs.length === 0 ? (
            <div className="p-4">
              <EmptyHint
                icon={<History className="h-6 w-6" />}
                title="暂无运行记录"
                description="同步直跑（≤8 用例）不留历史；异步运行（>8 用例或手动）在此展示。记录保存于进程内注册表，服务重启后清零。"
              />
            </div>
          ) : (
            <div className={cn('max-h-64 overflow-y-auto', ragScrollbar)}>
              {runs.map((r) => {
                const expanded = expandedRunId === r.runId
                const startedAbs = new Date(r.startedAt).toLocaleString()
                const time = (
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground" title={startedAbs}>
                    {timeAgo(r.startedAt)}
                  </span>
                )
                return (
                  <div key={r.runId} className="border-b border-border/40 last:border-b-0">
                    {r.status === 'running' ? (
                      // running 行：与 §21 进度卡并存，此处仅显示简进度（进度卡为主视图）
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2 transition-colors hover:bg-muted/40">
                        <Badge className="h-5 shrink-0 gap-1 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-normal text-amber-600 dark:text-amber-300">
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          running
                        </Badge>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{r.total} 用例</span>
                        <span className="shrink-0 text-xs font-medium tabular-nums text-primary">
                          {r.done}/{r.total}
                        </span>
                        {time}
                      </div>
                    ) : r.status === 'error' ? (
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2 transition-colors hover:bg-muted/40">
                        <Badge className="h-5 shrink-0 gap-1 border-rose-500/40 bg-rose-500/10 px-1.5 text-[10px] font-normal text-rose-600 dark:text-rose-300">
                          <XCircle className="h-2.5 w-2.5" />
                          error
                        </Badge>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{r.total} 用例</span>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-rose-600 dark:text-rose-400" title={r.error}>
                          {r.error ?? '未知错误'}
                        </span>
                        {time}
                      </div>
                    ) : (
                      // done 行：点击展开 summary 详情（passed/failed 计数 + 指标 + 起止时间）
                      <button
                        type="button"
                        className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2 text-left transition-colors hover:bg-muted/40"
                        aria-expanded={expanded}
                        title={r.summary ? '点击展开该次运行的汇总详情' : undefined}
                        onClick={() => r.summary && setExpandedRunId(expanded ? null : r.runId)}
                      >
                        <Badge className="h-5 shrink-0 gap-1 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] font-normal text-emerald-600 dark:text-emerald-300">
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          done
                        </Badge>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{r.total} 用例</span>
                        {r.summary ? (
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums">
                            通过率 {(r.summary.hitRateAvg * 100).toFixed(0)}% · MRR {r.summary.mrrAvg.toFixed(2)} ·{' '}
                            {r.summary.tookMsTotal}ms
                          </span>
                        ) : (
                          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">汇总不可用</span>
                        )}
                        {time}
                        {r.summary && (
                          <ChevronDown
                            className={cn(
                              'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                              expanded && 'rotate-180',
                            )}
                          />
                        )}
                      </button>
                    )}
                    {r.status === 'done' && r.summary && expanded && (
                      <div className="mx-4 mb-2 grid gap-x-6 gap-y-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px] sm:grid-cols-2">
                        <span className="text-muted-foreground">
                          通过{' '}
                          <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                            {r.summary.passed}
                          </span>
                          {' · '}失败{' '}
                          <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                            {r.summary.failed}
                          </span>
                          <span className="text-muted-foreground/70">（共 {r.total} 例）</span>
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          平均命中率{' '}
                          <span className="font-semibold text-foreground">
                            {(r.summary.hitRateAvg * 100).toFixed(1)}%
                          </span>
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          平均 MRR <span className="font-semibold text-foreground">{r.summary.mrrAvg.toFixed(4)}</span>
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          总检索耗时 <span className="font-semibold text-foreground">{r.summary.tookMsTotal}ms</span>
                          {r.summary.tookMsTotal >= 1000 && (
                            <span className="text-muted-foreground/70">（{formatDuration(r.summary.tookMsTotal)}）</span>
                          )}
                        </span>
                        <span className="text-muted-foreground">
                          开始 <span className="tabular-nums text-foreground">{startedAbs}</span>
                        </span>
                        <span className="text-muted-foreground">
                          结束{' '}
                          <span className="tabular-nums text-foreground">
                            {r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '—'}
                          </span>
                        </span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 用例表 */}
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            用例列表
            <Badge variant="secondary" className="text-[10px]">{cases.length}</Badge>
            {hasRun && (
              <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                点击用例名或箭头可展开运行详情（未命中文档 / Top-5 结果）
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {tcQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          ) : tcQuery.error ? (
            <div className="p-4">
              <ErrorCard
                title="用例列表加载失败"
                message={tcQuery.error instanceof Error ? tcQuery.error.message : String(tcQuery.error)}
                onRetry={() => tcQuery.refetch()}
              />
            </div>
          ) : cases.length === 0 ? (
            <div className="p-4">
              <EmptyHint
                icon={<FlaskConical className="h-6 w-6" />}
                title="还没有测试用例"
                description="三步开始检索回归：① 新建用例，填写名称与查询 → ② 勾选期望命中的金标准文档 → ③ 一键回归，查看命中率 / MRR 报告。"
                action={
                  <Button size="sm" className="h-8 gap-1.5" onClick={openCreate}>
                    <Plus className="h-3.5 w-3.5" />
                    新建第一个用例
                  </Button>
                }
              />
            </div>
          ) : (
            <div className={cn('overflow-x-auto', ragScrollbar)}>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-9 w-14 text-xs">启用</TableHead>
                    <TableHead className="h-9 min-w-28 text-xs">用例名</TableHead>
                    <TableHead className="h-9 min-w-44 text-xs">查询</TableHead>
                    <TableHead className="h-9 min-w-40 text-xs">期望文档</TableHead>
                    <TableHead className="h-9 w-28 text-xs">最近结果</TableHead>
                    <TableHead className="h-9 w-28 text-xs">命中率 · MRR</TableHead>
                    <TableHead className="h-9 w-24 text-xs">运行时间</TableHead>
                    <TableHead className="h-9 w-28 text-right text-xs">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cases.map((c) => {
                    const lr = c.lastRun as LastRun
                    const hasResult = typeof lr.pass === 'boolean'
                    const missNames = (lr.misses ?? []).map((d) => docNameMap.get(d) ?? shortCode(d))
                    const resultTop = lr.resultTop ?? []
                    const isStrict = c.expectChunkIds.length > 0
                    const chunkMisses = lr.chunkMisses ?? []
                    const docOk = (lr.misses?.length ?? 0) === 0 && !lr.error
                    const hasDetail =
                      hasResult &&
                      (resultTop.length > 0 || (lr.misses?.length ?? 0) > 0 || chunkMisses.length > 0 || !!lr.error)
                    const expanded = expandedId === c.id
                    const maxScore = Math.max(...resultTop.map((t) => t.score), 1e-6)
                    return (
                      <Fragment key={c.id}>
                        <TableRow className="group">
                          <TableCell>
                            <Switch
                              checked={c.enabled}
                              onCheckedChange={(v) => toggleEnabled(c, v)}
                              disabled={togglingId === c.id}
                              className="scale-90"
                              aria-label={`启用用例 ${c.name}`}
                            />
                          </TableCell>
                          <TableCell>
                            <button
                              type="button"
                              className={cn(
                                'flex items-center gap-1 text-left text-xs font-medium hover:underline',
                                hasDetail ? 'cursor-pointer' : 'cursor-default',
                              )}
                              disabled={!hasDetail}
                              aria-expanded={expanded}
                              onClick={() => hasDetail && setExpandedId(expanded ? null : c.id)}
                            >
                              {hasDetail && (
                                <ChevronDown
                                  className={cn(
                                    'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                                    expanded && 'rotate-180',
                                  )}
                                />
                              )}
                              <span className="max-w-40 truncate">{c.name}</span>
                            </button>
                          </TableCell>
                          <TableCell>
                            <span className="block max-w-56 truncate text-xs text-muted-foreground" title={c.query}>
                              {c.query}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap items-center gap-1">
                              {c.expectDocIds.slice(0, 2).map((d) => (
                                <Badge
                                  key={d}
                                  variant="outline"
                                  className="max-w-36 truncate px-1.5 text-[10px] font-normal"
                                  title={docNameMap.get(d) ?? d}
                                >
                                  {docNameMap.get(d) ?? shortCode(d)}
                                </Badge>
                              ))}
                              {c.expectDocIds.length > 2 && (
                                <Badge
                                  variant="secondary"
                                  className="text-[10px]"
                                  title={c.expectDocIds
                                    .slice(2)
                                    .map((d) => docNameMap.get(d) ?? d)
                                    .join('、')}
                                >
                                  +{c.expectDocIds.length - 2}
                                </Badge>
                              )}
                              {/* chunk 级金标准：violet +N chunk 徽标，tooltip 列出 chunk seq / 短码 */}
                              {isStrict && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge
                                        className="cursor-help border-violet-500/40 bg-violet-500/10 px-1.5 text-[10px] font-normal text-violet-600 dark:text-violet-300"
                                      >
                                        +{c.expectChunkIds.length} chunk
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-72 text-left text-[10px]" align="start">
                                      <p className="mb-1 font-medium text-xs">chunk 级金标准（严格模式）</p>
                                      {c.expectChunkIds.map((id) => {
                                        const meta = chunkMetaMap?.get(id)
                                        return (
                                          <p key={id} className="font-mono text-[10px] text-muted-foreground">
                                            {meta
                                              ? `#${meta.seq} · ${docNameMap.get(meta.documentId) ?? shortCode(meta.documentId)}${meta.textPreview ? ` · ${previewText(meta.textPreview, 24)}` : ''}`
                                              : shortCode(id, 6)}
                                          </p>
                                        )
                                      })}
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {!hasResult ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              <div className="flex flex-col gap-0.5">
                                {lr.pass ? (
                                  <span
                                    className={cn(
                                      'inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400',
                                      c.stale && 'opacity-70',
                                    )}
                                  >
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    通过
                                  </span>
                                ) : (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span
                                          className={cn(
                                            'inline-flex cursor-help items-center gap-1 text-xs font-medium text-rose-600 dark:text-rose-400',
                                            c.stale && 'opacity-70',
                                          )}
                                        >
                                          <XCircle className="h-3.5 w-3.5" />
                                          未通过
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent className="max-w-64 text-xs">
                                        未命中：{missNames.length > 0 ? missNames.join('、') : '—'}
                                        {chunkMisses.length > 0 ? `（chunk 级未命中 ${chunkMisses.length} 个）` : ''}
                                        {lr.error ? `（${lr.error}）` : ''}
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                )}
                                {/* §18 结果过期徽标：上次运行后 KB chunk 已变更（结果降透明度提示不再可信） */}
                                {c.stale && (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Badge className="w-fit cursor-help gap-0.5 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-normal text-amber-600 dark:text-amber-400">
                                          <TriangleAlert className="h-2.5 w-2.5" />
                                          结果过期
                                        </Badge>
                                      </TooltipTrigger>
                                      <TooltipContent className="max-w-64 text-xs">
                                        KB 下 chunk 在上次运行后被编辑/重切分，结果可能不再准确——重新运行可刷新
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                )}
                                {/* 严格模式：双行展示文档级 / chunk 级结果 */}
                                {isStrict && (
                                  <span className="text-[10px] text-muted-foreground">
                                    文档{' '}
                                    {docOk ? (
                                      <span className="font-bold text-emerald-600 dark:text-emerald-400">✓</span>
                                    ) : (
                                      <span className="font-bold text-rose-600 dark:text-rose-400">✗</span>
                                    )}
                                    {' · '}chunk{' '}
                                    {lr.chunkPass ? (
                                      <span className="font-bold text-emerald-600 dark:text-emerald-400">✓</span>
                                    ) : (
                                      <span className="font-bold text-rose-600 dark:text-rose-400">✗</span>
                                    )}
                                  </span>
                                )}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {hasResult ? (
                              <span className="font-mono text-[11px] tabular-nums">
                                {((lr.hitRate ?? 0) * 100).toFixed(0)}% · {(lr.mrr ?? 0).toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground">{hasResult ? timeAgo(lr.ranAt) : '—'}</span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-0.5 opacity-80 transition-opacity group-hover:opacity-100">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                title="运行此用例"
                                aria-label={`运行用例 ${c.name}`}
                                onClick={() => runOne(c)}
                                disabled={runningCaseId !== null || runningAll}
                              >
                                {runningCaseId === c.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600 dark:text-emerald-400" />
                                ) : (
                                  <Play className="h-3.5 w-3.5" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                title="编辑"
                                aria-label={`编辑用例 ${c.name}`}
                                onClick={() => openEdit(c)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-rose-600 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
                                title="删除"
                                aria-label={`删除用例 ${c.name}`}
                                onClick={() => setDeleting(c)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {expanded && hasDetail && (
                          <TableRow className="hover:bg-transparent">
                            <TableCell colSpan={8} className="bg-muted/30 px-4 py-3">
                              <div className="space-y-3">
                                {lr.error && (
                                  <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                                    错误：{lr.error}
                                  </div>
                                )}
                                {(lr.misses?.length ?? 0) > 0 && (
                                  <div>
                                    <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                                      未命中期望文档（{lr.misses!.length}）
                                    </p>
                                    <div className="flex flex-wrap gap-1.5">
                                      {lr.misses!.map((d) => (
                                        <Badge
                                          key={d}
                                          variant="outline"
                                          className="border-rose-500/40 bg-rose-500/10 text-[10px] font-normal text-rose-600 dark:text-rose-300"
                                        >
                                          {docNameMap.get(d) ?? shortCode(d)}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {/* chunk 级未命中（严格模式失败详情） */}
                                {chunkMisses.length > 0 && (
                                  <div className="rounded-md border border-violet-500/30 bg-violet-500/5 px-3 py-2">
                                    <p className="text-[11px] font-medium text-violet-600 dark:text-violet-300">
                                      chunk 级未命中（{chunkMisses.length}）
                                    </p>
                                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                                      以下期望 chunk 未进入 Top-K 结果（严格模式：文档级与 chunk 级全部命中才算通过）
                                    </p>
                                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                                      {chunkMisses.map((id) => {
                                        const meta = chunkMetaMap?.get(id)
                                        return (
                                          <TooltipProvider key={id}>
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <Badge className="cursor-help border-violet-500/40 bg-violet-500/10 font-mono text-[10px] font-normal text-violet-600 dark:text-violet-300">
                                                  {shortCode(id, 6)}
                                                </Badge>
                                              </TooltipTrigger>
                                              <TooltipContent className="max-w-72 break-all text-left text-[10px]">
                                                <p className="font-mono">{id}</p>
                                                {meta && (
                                                  <p className="mt-0.5 text-muted-foreground">
                                                    #{meta.seq} · {docNameMap.get(meta.documentId) ?? shortCode(meta.documentId)}
                                                    {meta.textPreview ? ` · ${previewText(meta.textPreview, 40)}` : ''}
                                                  </p>
                                                )}
                                              </TooltipContent>
                                            </Tooltip>
                                          </TooltipProvider>
                                        )
                                      })}
                                    </div>
                                  </div>
                                )}
                                {resultTop.length > 0 && (
                                  <div>
                                    <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                                      检索结果 Top {resultTop.length}（rank · chunk · 文档 · 分数）
                                    </p>
                                    <div className="space-y-1">
                                      {resultTop.map((t) => {
                                        const isExpect = c.expectDocIds.includes(t.docId)
                                        const isExpectChunk = c.expectChunkIds.includes(t.chunkId)
                                        return (
                                          <div
                                            key={`${t.rank}-${t.chunkId}`}
                                            className="flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted/50"
                                          >
                                            <span className="w-5 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                                              {t.rank}
                                            </span>
                                            <span
                                              className={cn(
                                                'w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground',
                                                isExpectChunk && 'font-medium text-violet-600 dark:text-violet-300',
                                              )}
                                              title={t.chunkId}
                                            >
                                              {shortCode(t.chunkId, 6)}
                                            </span>
                                            <span
                                              className={cn(
                                                'w-32 shrink-0 truncate text-[11px]',
                                                isExpect && 'font-medium text-emerald-600 dark:text-emerald-400',
                                              )}
                                              title={t.filename}
                                            >
                                              {t.filename}
                                            </span>
                                            <div className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-muted">
                                              <div
                                                className={cn(
                                                  'h-full rounded-full',
                                                  isExpect ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                                                )}
                                                style={{ width: `${Math.max((t.score / maxScore) * 100, 2)}%` }}
                                              />
                                            </div>
                                            <span className="w-14 shrink-0 text-right font-mono text-[11px] font-semibold tabular-nums">
                                              {t.score.toFixed(4)}
                                            </span>
                                          </div>
                                        )
                                      })}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 新建 / 编辑用例 Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">{editing ? '编辑测试用例' : '新建测试用例'}</DialogTitle>
            <DialogDescription className="text-xs">
              配置查询与期望命中的金标准文档；可选配置 chunk 级金标准（更严格断言）；运行后按 Top-K 结果计算命中率与 MRR。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">用例名称</Label>
              <Input
                className="mt-1 h-8 text-xs"
                value={form.name}
                placeholder="如：回归-标记查询"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">查询文本</Label>
              <Textarea
                className="mt-1 min-h-20 text-xs"
                value={form.query}
                placeholder="输入自然语言查询（Ctrl+Enter 提交）"
                onChange={(e) => setForm((f) => ({ ...f, query: e.target.value }))}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    if (canSave) void doSave()
                  }
                }}
              />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">期望命中文档（金标准）</Label>
                <span className="text-[10px] text-muted-foreground">
                  已选 {form.docIds.length} · 至少 1 个
                </span>
              </div>
              <div className={cn('mt-1 max-h-64 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2', ragScrollbar)}>
                {docs.length === 0 ? (
                  <p className="py-4 text-center text-[11px] text-muted-foreground">该知识库暂无文档</p>
                ) : (
                  docs.map((d) => (
                    <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50">
                      <Checkbox
                        checked={form.docIds.includes(d.id)}
                        onCheckedChange={(checked) => toggleDoc(d.id, checked === true)}
                      />
                      <span className="min-w-0 flex-1 truncate" title={d.filename}>
                        {d.filename}
                      </span>
                      <StatusBadge status={d.status} />
                    </label>
                  ))
                )}
              </div>
            </div>

            {/* chunk 级金标准（§16 严格模式，可选） */}
            <Collapsible open={chunkSecOpen} onOpenChange={setChunkSecOpen}>
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-xs text-muted-foreground hover:text-foreground">
                <Boxes className="h-3.5 w-3.5" />
                chunk 级金标准（可选）
                {form.chunkIds.length > 0 && (
                  <Badge className="border-violet-500/40 bg-violet-500/10 px-1.5 text-[10px] font-normal text-violet-600 dark:text-violet-300">
                    已选 {form.chunkIds.length}
                  </Badge>
                )}
                <ChevronDown
                  className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform', chunkSecOpen && 'rotate-180')}
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-2">
                <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
                  chunk 级金标准为更严格断言：要求指定 chunk 出现在 Top-K
                  结果中（严格模式下文档级与 chunk 级全部命中才算通过）。
                </p>
                {form.docIds.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border/60 px-3 py-2 text-center text-[11px] text-muted-foreground">
                    请先在上方选择至少 1 个期望文档，再配置 chunk 级金标准
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[10px] text-muted-foreground">对已选期望文档加载 chunk 并勾选（选择 chunk 会自动勾选其所属文档）</span>
                      {form.chunkIds.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 shrink-0 gap-1 px-2 text-[10px] text-muted-foreground"
                          title="清空已选的 chunk 级金标准"
                          onClick={() => setForm((f) => ({ ...f, chunkIds: [] }))}
                        >
                          <X className="h-3 w-3" />
                          清空
                        </Button>
                      )}
                    </div>
                    <div
                      className={cn('max-h-56 space-y-2 overflow-y-auto rounded-md border border-border/60 p-2', ragScrollbar)}
                    >
                      {form.docIds.map((docId) => {
                        const doc = docs.find((d) => d.id === docId)
                        const chunks = chunksByDoc[docId]
                        const selCount = form.chunkIds.filter((id) => chunkDocMap.get(id) === docId).length
                        return (
                          <div key={docId} className="rounded-md border border-border/60">
                            <div className="flex items-center gap-2 px-2 py-1.5">
                              <span className="min-w-0 flex-1 truncate text-xs font-medium" title={doc?.filename ?? docId}>
                                {doc?.filename ?? shortCode(docId)}
                              </span>
                              {selCount > 0 && (
                                <Badge className="shrink-0 border-violet-500/40 bg-violet-500/10 px-1.5 text-[10px] font-normal text-violet-600 dark:text-violet-300">
                                  已选 {selCount}/{chunks?.length ?? '—'}
                                </Badge>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 shrink-0 gap-1 px-2 text-[10px]"
                                onClick={() => void loadDocChunks(docId)}
                                disabled={loadingDocId !== null}
                              >
                                {loadingDocId === docId ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Boxes className="h-3 w-3" />
                                )}
                                {chunks ? '重新加载' : '加载 chunk'}
                              </Button>
                            </div>
                            {chunks && (
                              <div
                                className={cn('space-y-0.5 border-t border-border/60 p-1.5', chunks.length > 6 && 'max-h-40 overflow-y-auto', ragScrollbar)}
                              >
                                {chunks.length === 0 ? (
                                  <p className="py-2 text-center text-[11px] text-muted-foreground">该文档暂无子 chunk</p>
                                ) : (
                                  chunks.map((ch) => {
                                    const typeMeta = DOC_TYPE_META[ch.docType]
                                    return (
                                      <label
                                        key={ch.id}
                                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/50"
                                      >
                                        <Checkbox
                                          checked={form.chunkIds.includes(ch.id)}
                                          onCheckedChange={(checked) => toggleChunk(ch.id, docId, checked === true)}
                                        />
                                        <span className="shrink-0 font-mono text-muted-foreground">#{ch.seq}</span>
                                        <Badge
                                          variant="outline"
                                          className={cn('shrink-0 px-1 text-[9px]', typeMeta?.badge)}
                                        >
                                          {typeMeta?.label ?? ch.docType}
                                        </Badge>
                                        <span
                                          className="min-w-0 flex-1 truncate text-muted-foreground"
                                          title={ch.textPreview}
                                        >
                                          {previewText(ch.textPreview, 60)}
                                        </span>
                                        {!ch.enabled && (
                                          <Badge variant="secondary" className="shrink-0 text-[9px]" title="该 chunk 已停用，未参与检索">
                                            已停用
                                          </Badge>
                                        )}
                                      </label>
                                    )
                                  })
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {orphanChunkCount > 0 && (
                      <p className="px-1 text-[10px] text-violet-600 dark:text-violet-300">
                        另有 {orphanChunkCount} 个已选 chunk 不属于当前已选文档（保存时保留）
                      </p>
                    )}
                  </>
                )}
              </CollapsibleContent>
            </Collapsible>

            {/* 高级参数 */}
            <Collapsible open={advOpen} onOpenChange={setAdvOpen}>
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-xs text-muted-foreground hover:text-foreground">
                <Settings2 className="h-3.5 w-3.5" />
                高级参数
                {(form.mode !== 'hybrid' || form.topK !== 5 || form.rerank || form.prefetchLimit !== 50) && (
                  <Badge variant="secondary" className="text-[10px]">已自定义</Badge>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
                <div>
                  <Label className="text-[10px] text-muted-foreground">检索模式</Label>
                  <ToggleGroup
                    type="single"
                    value={form.mode}
                    onValueChange={(v) => v && setForm((f) => ({ ...f, mode: v as SearchMode }))}
                    className="mt-1 h-8"
                  >
                    <ToggleGroupItem value="hybrid" className="h-7 text-xs">hybrid</ToggleGroupItem>
                    <ToggleGroupItem value="dense" className="h-7 text-xs">dense</ToggleGroupItem>
                    <ToggleGroupItem value="sparse" className="h-7 text-xs">sparse</ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-muted-foreground">topK（取 Top-K 计算命中率）</Label>
                    <span className="font-mono text-[11px] tabular-nums">{form.topK}</span>
                  </div>
                  <Slider
                    className="mt-1.5"
                    min={1}
                    max={20}
                    step={1}
                    value={[form.topK]}
                    onValueChange={([v]) => setForm((f) => ({ ...f, topK: v }))}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                  <Label className="text-xs">Rerank 重排</Label>
                  <Switch checked={form.rerank} onCheckedChange={(v) => setForm((f) => ({ ...f, rerank: v }))} />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-muted-foreground">prefetchLimit（每路召回条数）</Label>
                    <span className="font-mono text-[11px] tabular-nums">{form.prefetchLimit}</span>
                  </div>
                  <Slider
                    className="mt-1.5"
                    min={1}
                    max={200}
                    step={1}
                    value={[form.prefetchLimit]}
                    onValueChange={([v]) => setForm((f) => ({ ...f, prefetchLimit: v }))}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={doSave} disabled={!canSave}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {editing ? '保存修改' : '创建用例'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">删除测试用例</AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              确定删除用例「{deleting?.name}」？该操作不可撤销（仅删除用例本身，不影响文档与向量数据）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs" disabled={deleteLoading}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-8 gap-1 bg-rose-600 text-xs hover:bg-rose-700"
              onClick={(e) => {
                e.preventDefault()
                void doDelete()
              }}
              disabled={deleteLoading}
            >
              {deleteLoading && <Loader2 className="h-3 w-3 animate-spin" />}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ViewPage>
  )
}

export default TestSetsView
