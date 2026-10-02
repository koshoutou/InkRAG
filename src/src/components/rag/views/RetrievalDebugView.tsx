'use client'

// 检索白盒调试台（对标 RAGFlow，M7 核心）
// 四阶段透明面板：① Embedding 摘要 ② Dense 召回 ③ Sparse 召回 ④ 融合 ⑤ Rerank
// 每条可溯源 → 跳三屏；耗时分解堆叠条；检索历史（localStorage 最近 20 条）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Crosshair,
  ExternalLink,
  FileText,
  Filter,
  GitCompare,
  History,
  Loader2,
  Minus,
  Pin,
  PinOff,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { gotoViewer, usePlatformStore } from '../store'
import type { FusionMode, SearchMode, SearchResponse } from '../types'
import { DOC_TYPE_META, EmptyHint, ErrorCard, formatDuration, shortCode, timeAgo } from '../ui'

const HISTORY_KEY = 'rag-retrieval-history-v1'
const BASELINE_KEY = 'rag-retrieval-baseline-v1'

/** 时间戳 → 本地日期键（YYYY-MM-DD，与趋势下钻日期比对） */
const toLocalDateKey = (ts: number): string => {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}
const STAGE_COLORS = {
  embedMs: 'bg-teal-500',
  recallMs: 'bg-violet-500',
  fusionMs: 'bg-amber-500',
  rerankMs: 'bg-emerald-500',
  contextMs: 'bg-rose-500',
} as const
const STAGE_LABELS = {
  embedMs: 'Embedding',
  recallMs: '召回',
  fusionMs: '融合',
  rerankMs: 'Rerank',
  contextMs: '上下文',
} as const

/** 结果快照（历史回放对比用，精简字段） */
interface SnapshotItem {
  chunkId: string
  score: number
  rerankScore: number | null
  seq: number
  filename: string
  preview: string
}
interface HistorySnapshot {
  tookMs: number
  items: SnapshotItem[]
}

/** 对比基准：某次检索的完整快照 + 参数指纹 */
interface Baseline {
  ts: number
  query: string
  mode: SearchMode
  rerank: boolean
  snapshot: HistorySnapshot
  /** v2：完整参数快照（旧 localStorage 数据无此字段 → 降级提示「基准无参数快照」） */
  params?: BaselineParams
}

/** 参数快照（基准固定 / 最近一次实际请求的完整检索参数） */
interface BaselineParams {
  mode: SearchMode
  topK: number
  prefetchLimit: number
  rerank: boolean
  fusion: FusionMode
  rrfK: number
  rrfWeights: [number, number]
  docIds: string[]
  pageRange: [number, number] | null
}

interface HistoryItem {
  ts: number
  kbId: string
  query: string
  mode: SearchMode
  topK: number
  prefetchLimit: number
  rerank: boolean
  fusion: FusionMode
  rrfK: number
  rrfWeights: [number, number]
  docIds: string[]
  pageRange: [number, number] | null
  snapshot?: HistorySnapshot
}

export function RetrievalDebugView() {
  const activeKbId = usePlatformStore((s) => s.activeKbId)
  const setKb = usePlatformStore((s) => s.setKb)
  const setDoc = usePlatformStore((s) => s.setDoc)

  const [kbId, setKbId] = useState<string>(activeKbId ?? '')
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const [topK, setTopK] = useState(5)
  const [prefetchLimit, setPrefetchLimit] = useState(50)
  const [rerank, setRerank] = useState(false)
  const [fusion, setFusion] = useState<FusionMode>('rrf')
  const [rrfK, setRrfK] = useState(60)
  const [rrfWeights, setRrfWeights] = useState<[number, number]>([0.5, 0.5])
  const [docIds, setDocIds] = useState<string[]>([])
  const [pageRange, setPageRange] = useState<[number, number] | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  /** 趋势下钻日期过滤（'YYYY-MM-DD'，可关闭；非 null 时历史列表按该日过滤） */
  const [dateFilter, setDateFilter] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  /** 产生当前 result 的完整参数（参数差异对比的「当前值」来源） */
  const [lastParams, setLastParams] = useState<BaselineParams | null>(null)

  const [searching, setSearching] = useState(false)
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [traceChunkId, setTraceChunkId] = useState<string | null>(null)

  // 跨视图下钻视觉反馈（契约 §19）：命中下钻事件的目标控件短暂 amber 高亮（1.8s 后消退）
  const [drillFlash, setDrillFlash] = useState<'mode' | 'query' | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queryInputRef = useRef<HTMLTextAreaElement>(null)
  const flashDrill = useCallback((target: 'mode' | 'query') => {
    setDrillFlash(target)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setDrillFlash(null), 1_800)
  }, [])

  // KB 列表
  const kbsQuery = useQuery({ queryKey: ['kbs'], queryFn: () => ragApi.listKbs() })
  const kbs = kbsQuery.data?.kbs ?? []
  useEffect(() => {
    if (!kbId && kbs.length > 0) setKbId(activeKbId && kbs.some((k) => k.id === activeKbId) ? activeKbId : kbs[0].id)
  }, [kbId, kbs, activeKbId])

  // 该 KB 文档列表（filter 多选）
  const docsQuery = useQuery({
    queryKey: ['docs', kbId, 'debug-filter'],
    queryFn: () => ragApi.listDocs(kbId, { limit: 100 }),
    enabled: !!kbId,
  })
  const docs = docsQuery.data?.docs ?? []

  // 历史（localStorage）+ 对比基准（localStorage，跨会话保留）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      if (raw) setHistory(JSON.parse(raw))
    } catch {}
    try {
      const rawB = localStorage.getItem(BASELINE_KEY)
      if (rawB) setBaseline(JSON.parse(rawB))
    } catch {}
  }, [])
  const pushHistory = useCallback((item: HistoryItem) => {
    setHistory((prev) => {
      const next = [item, ...prev].slice(0, 20)
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      } catch {}
      return next
    })
  }, [])

  // 趋势下钻消费（契约 §19）：挂载时读取 store 的下钻日期（先读再清，防再次进入重复触发）
  // 非空 → 打开历史侧栏 + 按该日过滤历史（amber 徽标可关闭）
  useEffect(() => {
    const pending = usePlatformStore.getState().retrievalDateFilter
    if (pending) {
      usePlatformStore.getState().setRetrievalDateFilter(null)
      setDateFilter(pending)
      setHistoryOpen(true)
    }
  }, [])

  // 跨视图下钻消费（契约 §19 双通道，派发端 TrendsCard）：
  //  a) 缓冲通道 —— 派发前写 window.__ragDrillPending；本视图 dynamic() 懒加载首编
  //     可能晚于事件派发（250ms），挂载时读缓冲兑底（TTL 8s，过期丢弃）
  //  b) 实时通道 —— addEventListener（挂载后的常规路径；消费时同步清缓冲防重复应用）
  const applyDrill = useCallback(
    (kind: 'goto-retrieval' | 'prefill-query', detail: { mode?: string; query?: string; kbId?: string }) => {
      // KB 过滤上下文跟随下钻（派发端已校验存在性；不等于当前值才切，避免覆盖用户选择）
      if (detail.kbId && detail.kbId !== kbId) setKbId(detail.kbId)
      if (kind === 'goto-retrieval') {
        if (detail.mode === 'hybrid' || detail.mode === 'dense' || detail.mode === 'sparse') {
          setMode(detail.mode)
          flashDrill('mode')
        }
      } else if (kind === 'prefill-query' && detail.query) {
        setQuery(detail.query)
        flashDrill('query')
        // 聚焦查询框（下一帧，确保 value 已渲染）
        requestAnimationFrame(() => queryInputRef.current?.focus())
      }
    },
    [kbId, flashDrill],
  )
  useEffect(() => {
    const DRILL_PENDING_TTL_MS = 8_000
    const w = window as unknown as {
      __ragDrillPending?: {
        ts: number
        kind: 'goto-retrieval' | 'prefill-query'
        detail: { mode?: string; query?: string; kbId?: string }
      }
    }
    // a) 缓冲通道（先到先消费，读后即清）
    const pending = w.__ragDrillPending
    if (pending && Date.now() - pending.ts < DRILL_PENDING_TTL_MS) {
      applyDrill(pending.kind, pending.detail)
    }
    delete w.__ragDrillPending
    // b) 实时通道
    const onGoto = (e: Event) => {
      delete w.__ragDrillPending
      applyDrill('goto-retrieval', (e as CustomEvent<{ mode?: string; kbId?: string }>).detail ?? {})
    }
    const onPrefill = (e: Event) => {
      delete w.__ragDrillPending
      applyDrill('prefill-query', (e as CustomEvent<{ query?: string; kbId?: string }>).detail ?? {})
    }
    window.addEventListener('rag:goto-retrieval', onGoto)
    window.addEventListener('rag:prefill-query', onPrefill)
    return () => {
      window.removeEventListener('rag:goto-retrieval', onGoto)
      window.removeEventListener('rag:prefill-query', onPrefill)
    }
  }, [applyDrill])

  // 下钻日期过滤后的历史（时间转本地日期键比对；无过滤 = 全量）
  const visibleHistory = useMemo(
    () => (dateFilter ? history.filter((h) => toLocalDateKey(h.ts) === dateFilter) : history),
    [history, dateFilter],
  )

  const pinBaseline = useCallback((b: Baseline | null) => {
    setBaseline(b)
    try {
      if (b) localStorage.setItem(BASELINE_KEY, JSON.stringify(b))
      else localStorage.removeItem(BASELINE_KEY)
    } catch {}
  }, [])

  const buildRequest = useCallback((p: {
    kbId: string; query: string; topK: number; mode: SearchMode; rerank: boolean; prefetchLimit: number;
    docIds: string[]; pageRange: [number, number] | null; fusion: FusionMode; rrfK: number; rrfWeights: [number, number]
  }) => ({
    kbId: p.kbId,
    query: p.query,
    topK: p.topK,
    mode: p.mode,
    rerank: p.rerank,
    prefetchLimit: p.prefetchLimit,
    withParentContext: true,
    ...(p.docIds.length > 0 || p.pageRange
      ? {
          filter: {
            ...(p.docIds.length > 0 ? { docIds: p.docIds } : {}),
            ...(p.pageRange ? { pageRange: p.pageRange } : {}),
          },
        }
      : {}),
    debug: {
      fusion: p.fusion,
      ...(p.fusion === 'rrf' && p.mode === 'hybrid' ? { rrfK: p.rrfK, rrfWeights: p.rrfWeights } : {}),
    },
  }), [])

  const takeSnapshot = (r: SearchResponse): HistorySnapshot => ({
    tookMs: r.tookMs,
    items: r.results.map((h) => ({
      chunkId: h.chunkId,
      score: h.score,
      rerankScore: h.rerankScore ?? null,
      seq: h.source.seq,
      filename: h.source.filename,
      preview: h.text.replace(/\s+/g, ' ').slice(0, 70),
    })),
  })

  const doSearch = useCallback(async () => {
    if (!kbId) {
      toast.error('请选择知识库')
      return
    }
    if (!query.trim()) {
      toast.error('请输入查询文本')
      return
    }
    setSearching(true)
    setSearchError(null)
    try {
      const r = await ragApi.searchDebug(buildRequest({ kbId, query: query.trim(), topK, mode, rerank, prefetchLimit, docIds, pageRange, fusion, rrfK, rrfWeights }))
      setResult(r.result)
      setLastParams({ mode, topK, prefetchLimit, rerank, fusion, rrfK, rrfWeights, docIds, pageRange })
      pushHistory({ ts: Date.now(), kbId, query: query.trim(), mode, topK, prefetchLimit, rerank, fusion, rrfK, rrfWeights, docIds, pageRange, snapshot: takeSnapshot(r.result) })
    } catch (e) {
      setResult(null)
      setSearchError((e as Error).message)
      toast.error('检索失败：' + (e as Error).message)
    } finally {
      setSearching(false)
    }
  }, [kbId, query, topK, mode, rerank, prefetchLimit, docIds, pageRange, fusion, rrfK, rrfWeights, pushHistory, buildRequest])

  const replay = async (h: HistoryItem) => {
    setKbId(h.kbId)
    setQuery(h.query)
    setMode(h.mode)
    setTopK(h.topK)
    setPrefetchLimit(h.prefetchLimit)
    setRerank(h.rerank)
    setFusion(h.fusion)
    setRrfK(h.rrfK)
    setRrfWeights(h.rrfWeights)
    setDocIds(h.docIds)
    setPageRange(h.pageRange)
    // 立即以历史参数重放（不等 setState 生效，直接用 h 的参数请求）
    setSearching(true)
    setSearchError(null)
    try {
      const r = await ragApi.searchDebug(buildRequest({
        kbId: h.kbId, query: h.query, topK: h.topK, mode: h.mode, rerank: h.rerank,
        prefetchLimit: h.prefetchLimit, docIds: h.docIds, pageRange: h.pageRange,
        fusion: h.fusion, rrfK: h.rrfK, rrfWeights: h.rrfWeights,
      }))
      setResult(r.result)
      setLastParams({
        mode: h.mode, topK: h.topK, prefetchLimit: h.prefetchLimit, rerank: h.rerank,
        fusion: h.fusion, rrfK: h.rrfK, rrfWeights: h.rrfWeights, docIds: h.docIds, pageRange: h.pageRange,
      })
      toast.success(`已重放历史检索（${r.result.results.length} 命中 · ${r.result.tookMs}ms）`)
    } catch (e) {
      setResult(null)
      setSearchError((e as Error).message)
      toast.error('重放失败：' + (e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const clearHistory = () => {
    setHistory([])
    try {
      localStorage.removeItem(HISTORY_KEY)
    } catch {}
  }

  // 溯源：从最终结果找 chunk source
  const traceHit = useMemo(
    () => (result?.results ?? []).find((r) => r.chunkId === traceChunkId) ?? null,
    [result, traceChunkId],
  )

  // 对比基准 vs 当前结果：rank 升降 / score delta / 新增与消失
  const compare = useMemo(() => {
    if (!baseline || !result) return null
    const effScore = (s: { score: number; rerankScore?: number | null }) => s.rerankScore ?? s.score
    const baseMap = new Map(
      baseline.snapshot.items.map((it, i) => [it.chunkId, { ...it, rank: i + 1 }]),
    )
    const curMap = new Map(
      result.results.map((r, i) => [r.chunkId, { ...r, rank: i + 1 }]),
    )
    const rows = result.results.map((r, i) => {
      const b = baseMap.get(r.chunkId)
      const cur = effScore(r)
      const base = b ? effScore(b) : null
      return {
        chunkId: r.chunkId,
        seq: r.source.seq,
        filename: r.source.filename,
        preview: r.text.replace(/\s+/g, ' ').slice(0, 70),
        rank: i + 1,
        baseRank: b?.rank ?? null,
        score: cur,
        baseScore: base,
        delta: base !== null ? cur - base : null,
        status: !b ? ('new' as const) : b.rank > i + 1 ? ('up' as const) : b.rank < i + 1 ? ('down' as const) : ('same' as const),
      }
    })
    const lost = [...baseMap.values()]
      .filter((b) => !curMap.has(b.chunkId))
      .map((b) => ({
        chunkId: b.chunkId,
        seq: b.seq,
        filename: b.filename,
        preview: b.preview,
        baseRank: b.rank,
        score: effScore(b),
      }))
    const common = rows.filter((r) => r.status !== 'new')
    return {
      rows,
      lost,
      baseCount: baseMap.size,
      curCount: curMap.size,
      overlap: common.length,
      avgDelta: common.length > 0 ? common.reduce((s, r) => s + (r.delta ?? 0), 0) / common.length : null,
      tookDelta: result.tookMs - baseline.snapshot.tookMs,
    }
  }, [baseline, result])

  // 溯源跳三屏
  const jumpToViewer = async (docId: string, chunkId: string) => {
    try {
      const { doc } = await ragApi.getDoc(docId)
      setKb(doc.kbId)
      setDoc(docId)
      gotoViewer(docId, chunkId)
    } catch (e) {
      toast.error('跳转失败：' + (e as Error).message)
    }
  }

  // 基准参数 vs 产生当前结果的参数：差异高亮（amber）
  const fmtFilter = (p: BaselineParams): string => {
    const parts: string[] = []
    if (p.docIds.length > 0) parts.push(`文档×${p.docIds.length}`)
    if (p.pageRange) parts.push(`页 ${p.pageRange[0]}-${p.pageRange[1]}`)
    return parts.length > 0 ? parts.join(' + ') : '—'
  }
  const paramDiffs = useMemo(() => {
    if (!baseline?.params || !lastParams) return null
    const bp = baseline.params
    const cp = lastParams
    const diffs: { key: string; from: string; to: string }[] = []
    if (bp.mode !== cp.mode) diffs.push({ key: 'mode', from: bp.mode, to: cp.mode })
    if (bp.topK !== cp.topK) diffs.push({ key: 'topK', from: String(bp.topK), to: String(cp.topK) })
    if (bp.prefetchLimit !== cp.prefetchLimit)
      diffs.push({ key: 'prefetchLimit', from: String(bp.prefetchLimit), to: String(cp.prefetchLimit) })
    if (bp.rerank !== cp.rerank) diffs.push({ key: 'rerank', from: String(bp.rerank), to: String(cp.rerank) })
    if (bp.fusion !== cp.fusion) diffs.push({ key: 'fusion', from: bp.fusion, to: cp.fusion })
    if (bp.rrfK !== cp.rrfK) diffs.push({ key: 'rrfK', from: String(bp.rrfK), to: String(cp.rrfK) })
    if (bp.rrfWeights[0] !== cp.rrfWeights[0] || bp.rrfWeights[1] !== cp.rrfWeights[1])
      diffs.push({ key: 'rrfWeights', from: `[${bp.rrfWeights.join(', ')}]`, to: `[${cp.rrfWeights.join(', ')}]` })
    const sameFilter =
      bp.docIds.length === cp.docIds.length &&
      bp.docIds.every((x) => cp.docIds.includes(x)) &&
      bp.pageRange?.[0] === cp.pageRange?.[0] &&
      bp.pageRange?.[1] === cp.pageRange?.[1]
    if (!sameFilter) diffs.push({ key: 'filter', from: fmtFilter(bp), to: fmtFilter(cp) })
    return diffs
  }, [baseline, lastParams])

  if (kbsQuery.isLoading) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <Skeleton className="h-full w-full rounded-xl" />
      </div>
    )
  }
  if (kbsQuery.error) {
    return (
      <div className="p-4">
        <ErrorCard message={kbsQuery.error instanceof Error ? kbsQuery.error.message : String(kbsQuery.error)} onRetry={() => kbsQuery.refetch()} />
      </div>
    )
  }
  if (kbs.length === 0) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <EmptyHint
          icon={<Crosshair className="h-6 w-6" />}
          title="检索调试台需要已有知识库"
          description="创建知识库并完成文档入库后，可在此白盒调试检索全链路：Embedding → 双路召回 → 融合 → Rerank。"
        />
      </div>
    )
  }

  const showRrfWeights = fusion === 'rrf' && mode === 'hybrid'
  const stageTotal = result
    ? result.stages.embedMs + result.stages.recallMs + result.stages.fusionMs + result.stages.rerankMs + result.stages.contextMs
    : 0

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
        <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
          {/* 查询区 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <Crosshair className="h-4 w-4 text-primary" />
                检索白盒调试台
                {dateFilter && (
                  <Badge
                    variant="outline"
                    className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] font-normal text-amber-600 dark:text-amber-300"
                    title="来自仪表盘趋势图下钻：历史列表仅显示该日检索"
                  >
                    趋势下钻 · {dateFilter}
                    <button
                      type="button"
                      className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-sm hover:bg-amber-500/20"
                      onClick={() => setDateFilter(null)}
                      aria-label="关闭日期过滤"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                <span className="ml-auto text-[10px] font-normal text-muted-foreground">与生产 Agent API 同一条检索路径</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={kbId || undefined} onValueChange={(v) => { setKbId(v); setDocIds([]) }}>
                  <SelectTrigger className="h-8 w-48 text-xs">
                    <SelectValue placeholder="选择知识库" />
                  </SelectTrigger>
                  <SelectContent>
                    {kbs.map((kb) => (
                      <SelectItem key={kb.id} value={kb.id} className="text-xs">
                        {kb.name} · {kb.pointCount} 点
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ToggleGroup
                  type="single"
                  value={mode}
                  onValueChange={(v) => v && setMode(v as SearchMode)}
                  className={cn(
                    'h-8 rounded-md transition-shadow duration-500',
                    drillFlash === 'mode' && 'ring-2 ring-amber-400/80 ring-offset-1 ring-offset-background animate-pulse',
                  )}
                >
                  <ToggleGroupItem value="hybrid" className="h-8 px-3 text-xs">hybrid</ToggleGroupItem>
                  <ToggleGroupItem value="dense" className="h-8 px-3 text-xs">dense</ToggleGroupItem>
                  <ToggleGroupItem value="sparse" className="h-8 px-3 text-xs">sparse</ToggleGroupItem>
                </ToggleGroup>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Switch checked={rerank} onCheckedChange={setRerank} />
                  Rerank
                </div>
              </div>

              <Textarea
                ref={queryInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    doSearch()
                  }
                }}
                placeholder="输入查询文本…（Ctrl+Enter 发起检索）"
                className={cn(
                  'min-h-[72px] text-sm transition-shadow duration-500',
                  drillFlash === 'query' && 'ring-2 ring-amber-400/80 animate-pulse',
                )}
              />

              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label className="text-[10px] text-muted-foreground">topK</Label>
                  <Input type="number" min={1} max={50} value={topK} onChange={(e) => setTopK(Number(e.target.value) || 5)} className="mt-0.5 h-8 w-20 text-xs" />
                </div>
                <div>
                  <Label className="text-[10px] text-muted-foreground">prefetchLimit</Label>
                  <Input type="number" min={1} max={200} value={prefetchLimit} onChange={(e) => setPrefetchLimit(Number(e.target.value) || 50)} className="mt-0.5 h-8 w-24 text-xs" />
                </div>
                <div>
                  <Label className="text-[10px] text-muted-foreground">fusion</Label>
                  <Select value={fusion} onValueChange={(v) => setFusion(v as FusionMode)}>
                    <SelectTrigger className="mt-0.5 h-8 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rrf" className="text-xs">rrf</SelectItem>
                      <SelectItem value="dbsf" className="text-xs">dbsf</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {fusion === 'rrf' && (
                  <div>
                    <Label className="text-[10px] text-muted-foreground">rrfK</Label>
                    <Input type="number" min={1} max={1000} value={rrfK} onChange={(e) => setRrfK(Number(e.target.value) || 60)} className="mt-0.5 h-8 w-20 text-xs" />
                  </div>
                )}
                <Button size="sm" className="ml-auto h-8 gap-1.5 px-4" onClick={doSearch} disabled={searching}>
                  {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                  检索
                </Button>
              </div>

              {showRrfWeights && (
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">RRF 权重（dense / sparse）</span>
                    <span className="font-mono text-[11px]">{rrfWeights[0].toFixed(2)} : {rrfWeights[1].toFixed(2)}</span>
                  </div>
                  <Slider
                    value={rrfWeights}
                    min={0}
                    max={1}
                    step={0.05}
                    onValueChange={(v) => setRrfWeights([v[0], +(1 - v[0]).toFixed(2)])}
                  />
                </div>
              )}

              {/* filter 折叠 */}
              <Collapsible open={filterOpen} onOpenChange={setFilterOpen}>
                <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-xs text-muted-foreground hover:text-foreground">
                  <Filter className="h-3.5 w-3.5" />
                  过滤条件
                  {(docIds.length > 0 || pageRange) && (
                    <Badge variant="secondary" className="text-[10px]">已设置 {docIds.length > 0 ? `${docIds.length} 文档` : ''}{docIds.length > 0 && pageRange ? ' + ' : ''}{pageRange ? `页 ${pageRange[0]}-${pageRange[1]}` : ''}</Badge>
                  )}
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 pt-2">
                  <div>
                    <Label className="text-[10px] text-muted-foreground">限定文档（不选 = 全部）</Label>
                    <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
                      {docs.length === 0 ? (
                        <p className="py-2 text-center text-[11px] text-muted-foreground">该知识库暂无文档</p>
                      ) : (
                        docs.map((d) => (
                          <label key={d.id} className="flex cursor-pointer items-center gap-2 text-xs">
                            <Checkbox
                              checked={docIds.includes(d.id)}
                              onCheckedChange={(checked) =>
                                setDocIds((prev) => (checked ? [...prev, d.id] : prev.filter((x) => x !== d.id)))
                              }
                            />
                            <span className="truncate">{d.filename}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="flex items-end gap-2">
                    <div>
                      <Label className="text-[10px] text-muted-foreground">页码范围（起-止）</Label>
                      <div className="mt-0.5 flex items-center gap-1">
                        <Input
                          type="number"
                          min={1}
                          placeholder="1"
                          className="h-8 w-16 text-xs"
                          value={pageRange?.[0] ?? ''}
                          onChange={(e) => {
                            const v = e.target.value ? Number(e.target.value) : null
                            setPageRange(v || pageRange?.[1] ? [v ?? 1, pageRange?.[1] ?? 9999] : null)
                          }}
                        />
                        <Minus className="h-3 w-3 text-muted-foreground" />
                        <Input
                          type="number"
                          min={1}
                          placeholder="9999"
                          className="h-8 w-16 text-xs"
                          value={pageRange?.[1] ?? ''}
                          onChange={(e) => {
                            const v = e.target.value ? Number(e.target.value) : null
                            setPageRange(v || pageRange?.[0] ? [pageRange?.[0] ?? 1, v ?? 9999] : null)
                          }}
                        />
                        {pageRange && (
                          <Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={() => setPageRange(null)}>
                            清除
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </CardContent>
          </Card>

          {/* 结果区 */}
          {searching && !result ? (
            <div className="flex h-48 items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">检索中…</span>
            </div>
          ) : searchError ? (
            <ErrorCard title="检索失败" message={searchError} onRetry={doSearch} />
          ) : !result ? (
            <EmptyHint
              icon={<Search className="h-6 w-6" />}
              title="输入查询开始白盒调试"
              description="执行后会展示 Embedding 摘要、Dense/Sparse 双路召回、融合排序变化与 Rerank 结果的全过程。"
            />
          ) : (
            <div className="space-y-4">
              {/* 耗时分解 */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-xs">
                    耗时分解
                    <Badge variant="secondary" className="font-mono text-[10px]">总 {formatDuration(result.tookMs)}</Badge>
                    {result.debug.fusion && (
                      <Badge variant="outline" className="ml-auto text-[10px]">
                        {result.debug.fusion}
                        {result.debug.rrfK ? ` k=${result.debug.rrfK}` : ''} · {result.debug.mode}
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="阶段耗时堆叠条">
                    {(Object.keys(STAGE_COLORS) as (keyof typeof STAGE_COLORS)[]).map((k) => {
                      const v = result.stages[k]
                      if (v <= 0) return null
                      return (
                        <div
                          key={k}
                          className={STAGE_COLORS[k]}
                          style={{ width: `${(v / Math.max(stageTotal, 1)) * 100}%` }}
                          title={`${STAGE_LABELS[k]}: ${formatDuration(v)}`}
                        />
                      )
                    })}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {(Object.keys(STAGE_COLORS) as (keyof typeof STAGE_COLORS)[]).map((k) => (
                      <span key={k} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className={cn('h-2 w-2 rounded-full', STAGE_COLORS[k])} />
                        {STAGE_LABELS[k]}
                        <span className="font-medium tabular-nums text-foreground">{formatDuration(result.stages[k])}</span>
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* ① Embedding 摘要 */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-xs">
                    <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-[10px] font-bold text-primary">①</span>
                    Embedding 摘要
                    <Badge
                      variant="outline"
                      className={cn(
                        'ml-auto text-[10px]',
                        result.debug.embed.provider.toLowerCase().includes('mock')
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300'
                          : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
                      )}
                    >
                      {result.debug.embed.provider}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                    <div>
                      <div className="text-[10px] text-muted-foreground">维度</div>
                      <div className="font-mono text-sm font-semibold">{result.debug.embed.dim}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">Dense 向量 hash</div>
                      <div className="truncate font-mono text-[11px]" title={result.debug.embed.denseHash}>
                        {shortCode(result.debug.embed.denseHash, 10)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">Sparse 非零项</div>
                      <div className="font-mono text-sm font-semibold">{result.debug.embed.sparseNnz}</div>
                    </div>
                    <div>
                      <div className="mb-1 text-[10px] text-muted-foreground">前 8 维 sparkline</div>
                      <div className="flex h-8 items-end gap-1">
                        {result.debug.embed.denseFirst8.map((v, i) => {
                          const abs = Math.abs(v)
                          const max = Math.max(...result.debug.embed.denseFirst8.map(Math.abs), 0.0001)
                          return (
                            <div
                              key={i}
                              className={cn('w-2 rounded-t', v >= 0 ? 'bg-teal-500/80' : 'bg-rose-500/80')}
                              style={{ height: `${Math.max((abs / max) * 100, 6)}%` }}
                              title={`dim[${i}] = ${v.toFixed(4)}`}
                            />
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* ②③④⑤ 四阶段列表 */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <RankList
                  index="②"
                  title="Dense 召回"
                  items={result.debug.denseTop}
                  onTrace={(id) => setTraceChunkId(id)}
                  renderScore={(item) => (
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-teal-500"
                          style={{ width: `${Math.min(100, Math.max(2, (item.score / (result.debug.denseTop[0]?.score || 1)) * 100))}%` }}
                        />
                      </div>
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{item.score.toFixed(4)}</span>
                    </div>
                  )}
                />
                <RankList
                  index="③"
                  title="Sparse 召回"
                  items={result.debug.sparseTop}
                  onTrace={(id) => setTraceChunkId(id)}
                  renderScore={(item) => (
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-violet-500"
                          style={{ width: `${Math.min(100, Math.max(2, (item.score / (result.debug.sparseTop[0]?.score || 1)) * 100))}%` }}
                        />
                      </div>
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{item.score.toFixed(4)}</span>
                    </div>
                  )}
                />
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-xs">
                    <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-[10px] font-bold text-primary">④</span>
                    融合排序
                    <Badge variant="outline" className="ml-auto text-[10px]">
                      {result.debug.fusion.toUpperCase()}
                      {result.debug.rrfK ? ` k=${result.debug.rrfK}` : ''}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="max-h-72 space-y-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
                  {result.debug.fusedTop.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">无融合结果</p>
                  ) : (
                    result.debug.fusedTop.map((item, i) => {
                      const rank = i + 1
                      return (
                        <button
                          key={item.chunkId}
                          type="button"
                          onClick={() => setTraceChunkId(item.chunkId)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
                        >
                          <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{rank}</span>
                          <RankDelta rank={rank} prevRank={item.denseRank} label="D" />
                          <RankDelta rank={rank} prevRank={item.sparseRank} label="S" />
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{shortCode(item.chunkId)}</span>
                          <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums">{item.score.toFixed(4)}</span>
                        </button>
                      )
                    })
                  )}
                </CardContent>
              </Card>

              {result.debug.rerankTop && result.debug.rerankTop.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-xs">
                      <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-[10px] font-bold text-primary">⑤</span>
                      Rerank 后
                      <Sparkles className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="max-h-72 space-y-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
                    {result.debug.rerankTop.map((item, i) => (
                      <button
                        key={item.chunkId}
                        type="button"
                        onClick={() => setTraceChunkId(item.chunkId)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
                      >
                        <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                        <RankDelta rank={i + 1} prevRank={item.prevRank} label="融合" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{shortCode(item.chunkId)}</span>
                        <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {item.rerankScore.toFixed(4)}
                        </span>
                      </button>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* 最终结果 */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-xs">
                    最终结果（Top {result.results.length}）
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto h-6 gap-1 px-2 text-[10px]"
                      onClick={() => {
                        pinBaseline({
                          ts: Date.now(),
                          query: query.trim(),
                          mode,
                          rerank,
                          snapshot: takeSnapshot(result),
                          // 与当前 result 匹配的完整参数快照（含表单未提交的变更）
                          ...(lastParams ? { params: lastParams } : {}),
                        })
                        toast.success('已固定为对比基准（含参数快照），再次检索后查看差异')
                      }}
                    >
                      <Pin className="h-3 w-3" />
                      固定为对比基准
                    </Button>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {result.results.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">没有命中结果</p>
                  ) : (
                    result.results.map((hit, i) => {
                      const meta = DOC_TYPE_META[hit.source.docType as keyof typeof DOC_TYPE_META] ?? DOC_TYPE_META.text
                      return (
                        <div key={hit.chunkId} className="rounded-lg border border-border/60 p-3 transition-colors hover:border-border">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary" className="text-[10px] font-mono">#{i + 1}</Badge>
                            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', meta.badge)}>{hit.source.docType}</span>
                            <button
                              type="button"
                              className="flex min-w-0 items-center gap-1 text-xs font-medium hover:underline"
                              onClick={() => jumpToViewer(hit.source.docId, hit.chunkId)}
                              title="在三屏视图中查看"
                            >
                              <FileText className="h-3 w-3 shrink-0" />
                              <span className="truncate">{hit.source.filename} · P{hit.source.page}</span>
                              <ExternalLink className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                            </button>
                            <span className="ml-auto font-mono text-[11px] font-semibold tabular-nums">
                              {hit.rerankScore != null ? `${hit.rerankScore.toFixed(4)} (rerank)` : hit.score.toFixed(4)}
                            </span>
                          </div>
                          <p className="mt-1.5 line-clamp-3 text-[11.5px] leading-relaxed text-muted-foreground">{hit.text}</p>
                          {hit.parentText && (
                            <details className="mt-1.5">
                              <summary className="cursor-pointer text-[10px] text-amber-600 dark:text-amber-400">父 chunk 上下文</summary>
                              <p className="mt-1 line-clamp-4 text-[11px] leading-relaxed text-muted-foreground">{hit.parentText}</p>
                            </details>
                          )}
                        </div>
                      )
                    })
                  )}
                </CardContent>
              </Card>

              {/* 对比基准卡片：基准 vs 当前结果 */}
              {baseline && compare && (
                <Card className="border-violet-500/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
                      <GitCompare className="h-4 w-4 text-violet-500" />
                      对比基准
                      <span className="truncate font-mono text-[10px] font-normal text-muted-foreground" title={baseline.query}>
                        「{baseline.query}」{baseline.mode}{baseline.rerank ? ' +rerank' : ''} · {new Date(baseline.ts).toLocaleString()}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-6 gap-1 px-2 text-[10px] text-muted-foreground"
                        onClick={() => { pinBaseline(null); toast.info('已清除对比基准') }}
                      >
                        <PinOff className="h-3 w-3" />
                        取消基准
                      </Button>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* 参数差异（amber 高亮；一致时 emerald 说明；旧基准降级提示） */}
                    {baseline.params ? (
                      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5">
                        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                          <GitCompare className="h-3 w-3" />
                          参数差异
                          <span className="ml-auto text-[9px] font-normal text-muted-foreground">基准 → 本次检索</span>
                        </div>
                        {!paramDiffs ? (
                          <p className="text-[10px] text-muted-foreground">—</p>
                        ) : paramDiffs.length === 0 ? (
                          <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                            参数完全一致（纯结果波动对比）
                          </p>
                        ) : (
                          <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                            {paramDiffs.map((d) => (
                              <div key={d.key} className="flex flex-wrap items-center gap-1 text-[11px]">
                                <span className="font-mono text-muted-foreground">{d.key}</span>
                                <span className="font-mono text-muted-foreground line-through decoration-muted-foreground/60">
                                  {d.from}
                                </span>
                                <ArrowRight className="h-3 w-3 shrink-0 text-amber-500" aria-hidden />
                                <span className="font-mono font-semibold text-amber-600 dark:text-amber-400">{d.to}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-2.5 text-[10px] leading-relaxed text-muted-foreground">
                        基准无参数快照（旧版本固定）；重新「固定为对比基准」后可对比参数差异。
                      </div>
                    )}
                    {/* 汇总 */}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                        <p className="text-[9px] text-muted-foreground">基准命中</p>
                        <p className="font-mono text-sm font-semibold tabular-nums">{compare.baseCount}</p>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                        <p className="text-[9px] text-muted-foreground">当前命中</p>
                        <p className="font-mono text-sm font-semibold tabular-nums">{compare.curCount}</p>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                        <p className="text-[9px] text-muted-foreground">重叠 chunk</p>
                        <p className="font-mono text-sm font-semibold tabular-nums">{compare.overlap}</p>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                        <p className="text-[9px] text-muted-foreground">耗时差</p>
                        <p className={cn('font-mono text-sm font-semibold tabular-nums', compare.tookDelta > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
                          {compare.tookDelta > 0 ? '+' : ''}{compare.tookDelta}ms
                        </p>
                      </div>
                    </div>
                    {compare.avgDelta !== null && (
                      <p className="text-[10px] text-muted-foreground">
                        共同命中平均 score 变化：
                        <span className={cn('font-mono font-semibold', compare.avgDelta > 0 ? 'text-emerald-600 dark:text-emerald-400' : compare.avgDelta < 0 ? 'text-rose-600 dark:text-rose-400' : '')}>
                          {compare.avgDelta > 0 ? '+' : ''}{compare.avgDelta.toFixed(4)}
                        </span>
                      </p>
                    )}
                    {/* 行级对比 */}
                    <div className="space-y-1">
                      {compare.rows.map((r) => (
                        <button
                          key={r.chunkId}
                          type="button"
                          onClick={() => setTraceChunkId(r.chunkId)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
                        >
                          <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground">#{r.rank}</span>
                          <span className="flex w-16 shrink-0 items-center gap-1 font-mono text-[10px]">
                            {r.status === 'new' ? (
                              <Badge className="h-4 border-emerald-500/40 bg-emerald-500/10 px-1 text-[9px] text-emerald-600 dark:text-emerald-300">NEW</Badge>
                            ) : (
                              <RankDelta rank={r.rank} prevRank={r.baseRank ?? undefined} label="基准" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={`${r.filename} · chunk #${r.seq}`}>
                            {r.preview}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums">{r.score.toFixed(4)}</span>
                          {r.delta !== null && (
                            <span
                              className={cn(
                                'w-16 shrink-0 text-right font-mono text-[10px] tabular-nums',
                                r.delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : r.delta < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground',
                              )}
                            >
                              {r.delta > 0 ? '+' : ''}{r.delta.toFixed(4)}
                            </span>
                          )}
                        </button>
                      ))}
                      {compare.lost.map((r) => (
                        <div
                          key={r.chunkId}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 opacity-60"
                          title="该 chunk 在基准中命中，但当前检索未召回"
                        >
                          <span className="w-8 shrink-0 text-right font-mono text-[11px]">—</span>
                          <Badge variant="outline" className="h-4 shrink-0 border-rose-500/40 bg-rose-500/10 px-1 text-[9px] text-rose-600 dark:text-rose-300">LOST</Badge>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{r.preview}</span>
                          <span className="shrink-0 font-mono text-[11px] tabular-nums">{r.score.toFixed(4)}</span>
                          <span className="w-16 shrink-0" />
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 历史侧栏（dateFilter 非空时仅显示下钻日期的记录） */}
      <aside className="hidden w-72 shrink-0 flex-col border-l border-border/60 bg-muted/20 xl:flex">
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            检索历史
            {dateFilter && (
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-amber-500/10 text-[9px] font-normal text-amber-600 dark:text-amber-300"
              >
                仅 {dateFilter}
              </Badge>
            )}
          </span>
          <div className="flex items-center gap-1">
            {history.length > 0 && (
              <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={clearHistory} title="清空历史">
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
          {visibleHistory.length === 0 ? (
            dateFilter ? (
              <p className="px-2 py-8 text-center text-[11px] leading-relaxed text-muted-foreground">
                {dateFilter} 无检索历史记录
              </p>
            ) : (
              <p className="px-2 py-8 text-center text-[11px] leading-relaxed text-muted-foreground">
                暂无历史记录
                <br />
                每次检索会保存最近 20 条
              </p>
            )
          ) : (
            <ul className="space-y-1.5">
              {visibleHistory.map((h) => (
                <li key={h.ts}>
                  <div className="group relative rounded-lg border border-border/50 bg-background transition-colors hover:border-primary/40">
                    <button
                      type="button"
                      onClick={() => replay(h)}
                      className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
                    >
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary" className="text-[9px] font-mono">{h.mode}</Badge>
                        {h.snapshot && h.snapshot.items.length > 0 && (
                          <span className="font-mono text-[9px] text-muted-foreground">{h.snapshot.items.length} 命中</span>
                        )}
                        <span className="ml-auto text-[9px] text-muted-foreground">{timeAgo(new Date(h.ts).toISOString())}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-snug">{h.query}</p>
                      <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground">
                        <span>topK={h.topK}</span>
                        {h.rerank && <span>rerank</span>}
                        <span>{h.fusion}</span>
                      </div>
                    </button>
                    {h.snapshot && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          pinBaseline({
                            ts: h.ts,
                            query: h.query,
                            mode: h.mode,
                            rerank: h.rerank,
                            snapshot: h.snapshot!,
                            params: {
                              mode: h.mode,
                              topK: h.topK,
                              prefetchLimit: h.prefetchLimit,
                              rerank: h.rerank,
                              fusion: h.fusion,
                              rrfK: h.rrfK,
                              rrfWeights: h.rrfWeights,
                              docIds: h.docIds,
                              pageRange: h.pageRange,
                            },
                          })
                          toast.success('已将该历史结果设为对比基准')
                        }}
                        className="absolute right-1.5 top-1.5 hidden h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground group-hover:flex"
                        title="设为对比基准"
                      >
                        <Pin className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* 溯源 Dialog */}
      <Dialog open={!!traceChunkId} onOpenChange={(v) => !v && setTraceChunkId(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              溯源卡片
              {traceChunkId && <span className="font-mono text-[10px] text-muted-foreground">{shortCode(traceChunkId)}</span>}
            </DialogTitle>
          </DialogHeader>
          {traceHit ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md border border-border/60 p-2">
                  <div className="text-[10px] text-muted-foreground">文档</div>
                  <div className="truncate font-medium">{traceHit.source.filename}</div>
                </div>
                <div className="rounded-md border border-border/60 p-2">
                  <div className="text-[10px] text-muted-foreground">docId</div>
                  <div className="truncate font-mono text-[11px]">{traceHit.source.docId}</div>
                </div>
                <div className="rounded-md border border-border/60 p-2">
                  <div className="text-[10px] text-muted-foreground">页码 / seq</div>
                  <div className="font-mono">P{traceHit.source.page} · #{traceHit.source.seq}</div>
                </div>
                <div className="rounded-md border border-border/60 p-2">
                  <div className="text-[10px] text-muted-foreground">docType / bbox</div>
                  <div className="font-mono text-[11px]">
                    {traceHit.source.docType}
                    {traceHit.source.bbox ? ` · [${traceHit.source.bbox.map((n) => Math.round(n)).join(',')}]` : ' · 无'}
                  </div>
                </div>
              </div>
              <div className="rounded-md border border-border/60 bg-muted/30 p-2.5">
                <div className="mb-1 text-[10px] text-muted-foreground">chunk 文本</div>
                <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
                  {traceHit.text}
                </p>
              </div>
              {traceHit.parentText && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
                  <div className="mb-1 text-[10px] text-amber-600 dark:text-amber-400">父 chunk 上下文</div>
                  <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
                    {traceHit.parentText}
                  </p>
                </div>
              )}
              <Button
                size="sm"
                className="w-full gap-1.5"
                onClick={() => jumpToViewer(traceHit.source.docId, traceHit.chunkId)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                在三屏视图中查看
              </Button>
            </div>
          ) : (
            <div className="space-y-2 py-2">
              <p className="text-xs text-muted-foreground">
                该 chunk 未进入最终 Top-K 结果，无法取到完整溯源（docId / bbox）。
              </p>
              <p className="break-all font-mono text-[11px] text-muted-foreground">{traceChunkId}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 窄屏历史开关 */}
      <div className="xl:hidden">
        <Button
          variant="outline"
          size="icon"
          className={cn('fixed bottom-20 right-4 z-30 h-10 w-10 rounded-full shadow-lg', historyOpen && 'hidden')}
          onClick={() => setHistoryOpen(true)}
          aria-label="打开检索历史"
        >
          <History className="h-4 w-4" />
        </Button>
        {historyOpen && (
          <div className="fixed inset-0 z-40 flex items-end bg-black/30 p-3 xl:hidden" onClick={() => setHistoryOpen(false)}>
            <div className="max-h-[60vh] w-full overflow-y-auto rounded-xl border border-border/60 bg-background p-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-2 py-1.5 text-xs font-medium">
                <span className="flex items-center gap-1.5">
                  检索历史
                  {dateFilter && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/40 bg-amber-500/10 text-[9px] font-normal text-amber-600 dark:text-amber-300"
                    >
                      仅 {dateFilter}
                    </Badge>
                  )}
                </span>
                <div className="flex gap-1">
                  {history.length > 0 && (
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={clearHistory}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setHistoryOpen(false)}>
                    ✕
                  </Button>
                </div>
              </div>
              {visibleHistory.length === 0 ? (
                <p className="py-6 text-center text-[11px] text-muted-foreground">
                  {dateFilter ? `${dateFilter} 无检索历史记录` : '暂无历史记录'}
                </p>
              ) : (
                <ul className="space-y-1.5 pb-2">
                  {visibleHistory.map((h) => (
                    <li key={h.ts}>
                      <button
                        type="button"
                        onClick={() => {
                          replay(h)
                          setHistoryOpen(false)
                        }}
                        className="w-full rounded-lg border border-border/50 px-2.5 py-2 text-left hover:bg-muted/40"
                      >
                        <div className="flex items-center gap-1.5">
                          <Badge variant="secondary" className="text-[9px] font-mono">{h.mode}</Badge>
                          <span className="ml-auto text-[9px] text-muted-foreground">{timeAgo(new Date(h.ts).toISOString())}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[11px]">{h.query}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function RankDelta({ rank, prevRank, label }: { rank: number; prevRank?: number; label: string }) {
  if (prevRank === undefined || prevRank === null) return null
  const delta = prevRank - rank
  if (delta === 0) {
    return <Badge variant="outline" className="h-4 px-1 text-[9px] text-muted-foreground">{label}{prevRank} →</Badge>
  }
  const up = delta > 0
  return (
    <span
      className={cn(
        'inline-flex h-4 items-center gap-0.5 rounded border px-1 text-[9px] font-medium',
        up
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
          : 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300',
      )}
      title={`${label} 路 rank ${prevRank} → ${rank}`}
    >
      {up ? <ArrowUp className="h-2 w-2" /> : <ArrowDown className="h-2 w-2" />}
      {Math.abs(delta)}
      <span className="opacity-60">{label}{prevRank}</span>
    </span>
  )
}

function RankList({
  index,
  title,
  items,
  renderScore,
  onTrace,
}: {
  index: string
  title: string
  items: { chunkId: string; score: number; page: number; preview: string }[]
  renderScore: (item: { chunkId: string; score: number; page: number; preview: string }) => React.ReactNode
  onTrace: (chunkId: string) => void
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-[10px] font-bold text-primary">{index}</span>
          {title}
          <Badge variant="secondary" className="ml-auto text-[10px]">{items.length} 条</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="max-h-72 space-y-0.5 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
        {items.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">无结果</p>
        ) : (
          items.slice(0, 10).map((item, i) => (
            <button
              key={item.chunkId}
              type="button"
              onClick={() => onTrace(item.chunkId)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
              title={item.preview}
            >
              <span className="w-5 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{i + 1}</span>
              {renderScore(item)}
              <span className="w-8 shrink-0 text-center font-mono text-[10px] text-muted-foreground">P{item.page}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{item.preview}</span>
            </button>
          ))
        )}
      </CardContent>
    </Card>
  )
}
