'use client'

// 切分沙盒（对标 RAGFlow，M4 核心）
// 参数面板（滑块/策略/保护块）→ 300ms 防抖 POST chunk-preview → 统计卡 + 预览列表
// 与当前生效配置 diff 高亮；「应用此配置并重切」AlertDialog → POST action rechunk

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FlaskConical,
  Gauge,
  Layers,
  RotateCcw,
  Scissors,
  Timer,
  Zap,
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
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { gotoDocs, usePlatformStore } from '../store'
import { DEFAULT_CHUNK_CONFIG, type ChunkConfig, type ChunkStrategy, type DocSummary } from '../types'
import { DOC_TYPE_META, EmptyHint, ErrorCard, StatCard, formatDuration, useDebouncedValue } from '../ui'

const PAGE_SIZE = 50

function configKey(c: ChunkConfig) {
  return `${c.size}|${c.overlap}|${c.parentSize}|${c.strategy}|${[...c.protects].sort().join(',')}`
}

export function SandboxView() {
  const queryClient = useQueryClient()
  const activeKbId = usePlatformStore((s) => s.activeKbId)
  const setKb = usePlatformStore((s) => s.setKb)
  const [docId, setDocId] = useState<string | null>(null)
  const [config, setConfig] = useState<ChunkConfig>(DEFAULT_CHUNK_CONFIG)
  const [appliedSnapKey, setAppliedSnapKey] = useState<string | null>(null)
  const [previewPage, setPreviewPage] = useState(0)
  const [applyOpen, setApplyOpen] = useState(false)

  const kbsQuery = useQuery({ queryKey: ['kbs'], queryFn: () => ragApi.listKbs() })
  const kbs = kbsQuery.data?.kbs ?? []

  useEffect(() => {
    if (!activeKbId && kbs.length > 0) setKb(kbs[0].id)
  }, [activeKbId, kbs, setKb])

  const docsQuery = useQuery({
    queryKey: ['docs', activeKbId, 'sandbox'],
    queryFn: () => ragApi.listDocs(activeKbId!, { limit: 300 }),
    enabled: !!activeKbId,
  })
  const docs = useMemo(
    () => (docsQuery.data?.docs ?? []).filter((d) => d.status === 'ready' || d.status === 'failed'),
    [docsQuery.data],
  )

  // 当前文档
  const currentDoc: DocSummary | null = useMemo(() => docs.find((d) => d.id === docId) ?? null, [docs, docId])
  const docDetailQuery = useQuery({
    queryKey: ['doc', docId],
    queryFn: () => ragApi.getDoc(docId!),
    enabled: !!docId,
  })
  const snapConfig = docDetailQuery.data?.doc?.chunkConfigSnap ?? null

  // 文档切换 / 当前生效配置变化 → 载入该配置（render 期间调整 state，避免 effect 级联）
  const snapKey = snapConfig
    ? `${docId}|${snapConfig.size}|${snapConfig.overlap}|${snapConfig.parentSize}|${snapConfig.strategy}|${[...snapConfig.protects].sort().join(',')}`
    : null
  if (snapKey && snapKey !== appliedSnapKey) {
    setAppliedSnapKey(snapKey)
    setConfig({ ...snapConfig })
  }

  // 300ms 防抖自动预览
  const debouncedConfig = useDebouncedValue(config, 300)
  const previewQuery = useQuery({
    queryKey: ['preview', docId, configKey(debouncedConfig)],
    queryFn: () => ragApi.chunkPreview(docId!, debouncedConfig),
    enabled: !!docId,
    placeholderData: (prev) => prev,
  })

  const applyMutation = useMutation({
    mutationFn: () => ragApi.docAction(docId!, 'rechunk', debouncedConfig),
    onSuccess: () => {
      toast.success('已应用新配置，文档已重新入队切分')
      setApplyOpen(false)
      queryClient.invalidateQueries({ queryKey: ['doc', docId] })
      queryClient.invalidateQueries({ queryKey: ['docs', activeKbId] })
      if (activeKbId) gotoDocs(activeKbId)
    },
    onError: (e: Error) => toast.error('应用失败：' + e.message),
  })

  const preview = previewQuery.data?.preview
  const stats = preview?.stats
  const changed = useMemo(() => {
    if (!snapConfig) return null
    const diff: string[] = []
    if (config.size !== snapConfig.size) diff.push(`size ${snapConfig.size} → ${config.size}`)
    if (config.overlap !== snapConfig.overlap) diff.push(`overlap ${snapConfig.overlap} → ${config.overlap}`)
    if (config.parentSize !== snapConfig.parentSize) diff.push(`parentSize ${snapConfig.parentSize} → ${config.parentSize}`)
    if (config.strategy !== snapConfig.strategy) diff.push(`strategy ${snapConfig.strategy} → ${config.strategy}`)
    const a = [...config.protects].sort().join(',')
    const b = [...snapConfig.protects].sort().join(',')
    if (a !== b) diff.push(`protects [${snapConfig.protects.join(',')}] → [${config.protects.join(',')}]`)
    return diff.length > 0 ? diff : null
  }, [config, snapConfig])

  const previewItems = preview?.chunks ?? []
  const pageItems = previewItems.slice(previewPage * PAGE_SIZE, (previewPage + 1) * PAGE_SIZE)
  const previewTotalPages = Math.max(1, Math.ceil(previewItems.length / PAGE_SIZE))

  const docTypeBars = useMemo(() => {
    if (!stats) return []
    const total = Object.values(stats.docTypeCounts).reduce((a, b) => a + b, 0) || 1
    return (Object.entries(stats.docTypeCounts) as [string, number][]).map(([type, count]) => ({
      type,
      count,
      pct: (count / total) * 100,
    }))
  }, [stats])

  // --- 渲染 ---------------------------------------------------------------

  if (kbsQuery.isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="min-h-[40vh] w-full rounded-xl" />
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
      <div className="p-6">
        <EmptyHint
          icon={<FlaskConical className="h-6 w-6" />}
          title="切分沙盒需要已有知识库与文档"
          description="先创建知识库并上传文档（解析完成），即可在此无损试验不同切分参数。"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
      {/* 顶部工具栏 */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border/60 bg-background/95 px-4 py-2.5 backdrop-blur">
        <FlaskConical className="h-4 w-4 shrink-0 text-primary" />
        <Select
          value={activeKbId ?? ""}
          onValueChange={(v) => {
            setKb(v)
            setDocId(null)
            setPreviewPage(0)
          }}
        >
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="选择知识库" />
          </SelectTrigger>
          <SelectContent>
            {kbs.map((kb) => (
              <SelectItem key={kb.id} value={kb.id} className="text-xs">
                {kb.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={docId ?? ""}
          onValueChange={(v) => {
            setDocId(v)
            setPreviewPage(0)
          }}
        >
          <SelectTrigger className="h-8 min-w-44 max-w-64 flex-1 text-xs">
            <SelectValue placeholder="选择文档（ready / failed）" />
          </SelectTrigger>
          <SelectContent>
            {docs.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">暂无已完成解析的文档</div>
            ) : (
              docs.map((d) => (
                <SelectItem key={d.id} value={d.id} className="text-xs">
                  {d.filename}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        {stats && (
          <Badge
            variant="outline"
            className={cn(
              'gap-1 text-[10px] font-mono',
              stats.tookMs < 500
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300',
            )}
          >
            <Timer className="h-3 w-3" />
            {formatDuration(stats.tookMs)}
            {stats.tookMs < 500 ? ' · 达标' : ' · 超 500ms 目标'}
          </Badge>
        )}
      </div>

      {!docId ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyHint
            icon={<Scissors className="h-6 w-6" />}
            title="选择一个文档开始切分实验"
            description="沙盒只读缓存产物重切（不落库、不调外部服务），可无损对比不同参数的切分效果。"
          />
        </div>
      ) : (
        <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[320px_1fr]">
          {/* 左侧参数面板 */}
          <div className="space-y-4 lg:sticky lg:top-16 lg:self-start">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Gauge className="h-4 w-4 text-primary" />
                  切分参数
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <Label className="text-xs">子块 size（token）</Label>
                    <span className={cn('font-mono text-xs font-medium', snapConfig && config.size !== snapConfig.size && 'text-amber-600')}>
                      {config.size}
                    </span>
                  </div>
                  <Slider
                    value={[config.size]}
                    min={64}
                    max={2048}
                    step={32}
                    onValueChange={([v]) => setConfig((c) => ({ ...c, size: v }))}
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">推荐 512（BGE-M3 最大 8192，父子上限由 parentSize 控制）</p>
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <Label className="text-xs">overlap（token）</Label>
                    <span className={cn('font-mono text-xs font-medium', snapConfig && config.overlap !== snapConfig.overlap && 'text-amber-600')}>
                      {config.overlap}
                    </span>
                  </div>
                  <Slider
                    value={[config.overlap]}
                    min={0}
                    max={256}
                    step={8}
                    onValueChange={([v]) => setConfig((c) => ({ ...c, overlap: v }))}
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">相邻子块重叠 token（提高召回连续性，默认 0）</p>
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <Label className="text-xs">父块上限（token）</Label>
                    <span className={cn('font-mono text-xs font-medium', snapConfig && config.parentSize !== snapConfig.parentSize && 'text-amber-600')}>
                      {config.parentSize}
                    </span>
                  </div>
                  <Slider
                    value={[config.parentSize]}
                    min={256}
                    max={8192}
                    step={128}
                    onValueChange={([v]) => setConfig((c) => ({ ...c, parentSize: v }))}
                  />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs">切分策略</Label>
                  <Select
                    value={config.strategy}
                    onValueChange={(v) => setConfig((c) => ({ ...c, strategy: v as ChunkStrategy }))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="token" className="text-xs">token — 固定窗口</SelectItem>
                      <SelectItem value="title" className="text-xs">title — 按标题切分</SelectItem>
                      <SelectItem value="hybrid" className="text-xs">hybrid — 标题优先 + token 兜底</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs">原子保护块（不参与切分）</Label>
                  <div className="flex flex-wrap gap-3">
                    {(['code', 'table', 'image'] as const).map((t) => (
                      <label key={t} className="flex cursor-pointer items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={config.protects.includes(t)}
                          onCheckedChange={(checked) =>
                            setConfig((c) => {
                              const set = new Set(c.protects)
                              if (checked) set.add(t)
                              else set.delete(t)
                              return { ...c, protects: Array.from(set) }
                            })
                          }
                        />
                        {t}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={!changed || applyMutation.isPending}
                    onClick={() => setApplyOpen(true)}
                  >
                    <Zap className="h-3.5 w-3.5" />
                    应用此配置并重切
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={!snapConfig}
                    onClick={() => {
                      if (snapConfig) {
                        setConfig({ ...snapConfig })
                        toast.info('已载入当前生效配置')
                      }
                    }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    载入当前配置
                  </Button>
                  {changed && (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
                      <div className="mb-1 flex items-center gap-1 font-medium">
                        <AlertTriangle className="h-3 w-3" />
                        与当前生效配置的差异：
                      </div>
                      <ul className="space-y-0.5 font-mono">
                        {changed.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* 右侧：统计 + 预览 */}
          <div className="min-w-0 space-y-4">
            {previewQuery.isLoading && !preview ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-[104px] rounded-xl" />
                ))}
              </div>
            ) : previewQuery.error ? (
              <ErrorCard
                title="切分预览失败"
                message={previewQuery.error instanceof Error ? previewQuery.error.message : String(previewQuery.error)}
                onRetry={() => previewQuery.refetch()}
              />
            ) : stats ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard icon={<Layers className="h-4 w-4" />} label="子 chunk 总数" value={stats.total} accent="violet" />
                  <StatCard icon={<Scissors className="h-4 w-4" />} label="父 chunk 数" value={stats.parentCount} accent="teal" />
                  <StatCard
                    icon={<Gauge className="h-4 w-4" />}
                    label="token min / avg / max"
                    value={`${stats.tokenMin} / ${Math.round(stats.tokenAvg)} / ${stats.tokenMax}`}
                    accent="amber"
                    animate={false}
                    hint={`P95 = ${stats.tokenP95}`}
                  />
                  <StatCard icon={<Timer className="h-4 w-4" />} label="预览耗时" value={formatDuration(stats.tookMs)} accent={stats.tookMs < 500 ? 'emerald' : 'rose'} animate={false} hint="目标 < 500ms" />
                </div>

                {/* docType 分布 */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs">docType 分布</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      {docTypeBars.map((b) => {
                        const meta = DOC_TYPE_META[b.type as keyof typeof DOC_TYPE_META]
                        return <div key={b.type} className={meta?.bar ?? 'bg-stone-400'} style={{ width: `${b.pct}%` }} title={`${b.type}: ${b.count}`} />
                      })}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3">
                      {docTypeBars.map((b) => {
                        const meta = DOC_TYPE_META[b.type as keyof typeof DOC_TYPE_META]
                        return (
                          <span key={b.type} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span className={cn('h-2 w-2 rounded-full', meta?.bar ?? 'bg-stone-400')} />
                            {meta?.label ?? b.type} <span className="font-medium tabular-nums text-foreground">{b.count}</span>
                            <span className="text-[10px]">({b.pct.toFixed(0)}%)</span>
                          </span>
                        )
                      })}
                    </div>
                  </CardContent>
                </Card>

                {/* 预览列表 */}
                <Card>
                  <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-xs">子 chunk 预览（{previewItems.length} 条）</CardTitle>
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Button variant="outline" size="icon" className="h-6 w-6" disabled={previewPage <= 0} onClick={() => setPreviewPage((p) => p - 1)}>
                        ‹
                      </Button>
                      <span className="tabular-nums">
                        {previewPage + 1}/{previewTotalPages}
                      </span>
                      <Button variant="outline" size="icon" className="h-6 w-6" disabled={previewPage >= previewTotalPages - 1} onClick={() => setPreviewPage((p) => p + 1)}>
                        ›
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="max-h-[52vh] space-y-2 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
                    {pageItems.length === 0 ? (
                      <p className="py-8 text-center text-xs text-muted-foreground">没有匹配的预览结果</p>
                    ) : (
                      pageItems.map((c) => {
                        const meta = DOC_TYPE_META[c.docType] ?? DOC_TYPE_META.text
                        const parent = preview?.parents.find((p) => p.id === c.parentId)
                        return (
                          <details key={c.id} className="group rounded-lg border border-border/60 transition-colors hover:border-border">
                            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
                              <span className={cn('h-4 w-1 shrink-0 rounded-full', meta.bar)} />
                              <Badge variant="outline" className="shrink-0 text-[10px] font-mono">#{c.seq}</Badge>
                              {parent && <Badge variant="secondary" className="shrink-0 text-[10px] font-mono">父#{parent.seq}</Badge>}
                              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                {c.tokenCount} tok · P{c.pageFrom}
                                {c.pageTo > c.pageFrom ? `-${c.pageTo}` : ''}
                              </span>
                              <span className="truncate text-[11px] text-muted-foreground">{c.textPreview}</span>
                              <ArrowRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                            </summary>
                            <div className="border-t border-border/40 px-3 py-2">
                              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
                                {c.textPreview || '（预览文本截断，点击应用后可在三屏视图查看全文）'}
                              </pre>
                            </div>
                          </details>
                        )
                      })
                    )}
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* 应用确认 */}
      <AlertDialog open={applyOpen} onOpenChange={setApplyOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              应用切分配置并重切「{currentDoc?.filename}」？
            </AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              将以当前沙盒参数执行 rechunk：parse_config_v + 1，先清空旧 chunk 与向量点，再重新切分 / 向量化 / 写入。
              <br />
              {changed && (
                <span className="mt-1 block font-mono text-[11px] text-amber-600 dark:text-amber-400">
                  变更项：{changed.join('；')}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => applyMutation.mutate()} disabled={applyMutation.isPending}>
              {applyMutation.isPending ? '提交中…' : '确认应用'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
