'use client'

// RAG 知识库平台 · 文档文档版本管理视图（契约 §17，Task 9-c 完整实现；Task 11-c 增补导出报告 §22）
// 数据流：选 KB / 文档 → GET /api/documents/{id}/versions → 选 v1 / v2 → GET …/versions/compare?v1=&v2=
// 导出：diff 就绪后版本信息条右端「导出报告」下拉 → compare/export?format=md|json 直链下载
// 可视化对标 RAGFlow 版本管理 + Git diff：same 折叠 / added emerald / removed rose / changed amber 双栏 + 相似度
// 颜色体系：same teal · added emerald · removed rose · changed amber（禁 indigo/blue）

import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import {
  ArrowLeftRight,
  ArrowRight,
  Boxes,
  Braces,
  CheckCircle2,
  ChevronDown,
  Coins,
  Download,
  FileMinus2,
  FilePenLine,
  FilePlus2,
  FileText,
  GitCompareArrows,
  History,
  ListFilter,
  Loader2,
  Settings2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { usePlatformStore } from '../store'
import type { DocVersionInfo, VersionDiffType } from '../types'
import { EmptyHint, ErrorCard, StatCard, ViewPage, formatNumber, ragScrollbar } from '../ui'
import { DIFF_TYPE_META, DiffItemCard, SameOnlyHint } from './compare/DiffItemCard'
import { TrendStatCard } from './compare/TrendStatCard'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

type FilterMode = 'all' | 'changes' | VersionDiffType

const CONFIG_KEY_LABELS: Record<string, string> = {
  size: '子块目标（tokens）',
  overlap: '重叠（tokens）',
  parentSize: '父块上限（tokens）',
  strategy: '切分策略',
  protects: '原子保护块',
}

/** MM-DD HH:mm（Select / 信息条紧凑日期） */
function fmtShort(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function versionLabel(v: DocVersionInfo): string {
  return v.source === 'current' ? '当前' : `v${v.version} 快照`
}

/** 内容区骨架（统计 + 参数表 + 列表） */
function ContentSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-44 rounded-xl" />
      <Skeleton className="h-80 rounded-xl" />
    </>
  )
}

// ---------------------------------------------------------------------------
// 版本选择器（v1 / v2 复用）
// ---------------------------------------------------------------------------

function VersionSelect({
  side,
  value,
  versions,
  exclude,
  onChange,
}: {
  side: 'v1' | 'v2'
  value: string | null
  versions: DocVersionInfo[]
  exclude: string | null
  onChange: (v: string) => void
}) {
  const isV1 = side === 'v1'
  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-52">
      <span className="text-[11px] font-medium text-muted-foreground">
        {isV1 ? 'v1 · 对比基准' : 'v2 · 目标版本'}
      </span>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger
          className="h-8 w-full text-xs"
          aria-label={`选择${isV1 ? '基准（v1）' : '目标（v2）'}版本`}
        >
          <SelectValue placeholder="选择版本" />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.version} value={v.version} className="text-xs" disabled={exclude === v.version}>
              <span className="font-medium">{versionLabel(v)}</span>
              <span className="text-muted-foreground">{formatNumber(v.chunkCount)} chunks</span>
              <span className="ml-auto pl-2 text-[10px] tabular-nums text-muted-foreground">
                {fmtShort(v.createdAt)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 导出报告下拉（契约 §22：md 人读报告 same 折叠 / json 完整数据全部 items）
// ---------------------------------------------------------------------------

function ExportCompareMenu({ docId, v1, v2 }: { docId: string; v1: string; v2: string }) {
  const doExport = (fmt: 'md' | 'json') => {
    // 同源直链 + Content-Disposition attachment：动态 <a download> 触发下载（无弹窗拦截）
    const a = document.createElement('a')
    a.href = ragApi.compareExportUrl(docId, v1, v2, fmt)
    a.download = ''
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    toast.success(fmt === 'md' ? 'Markdown 报告已开始下载' : 'JSON 完整数据已开始下载')
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          title="导出当前版本对的对比报告（Markdown / JSON）"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          导出报告
          <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem className="gap-2.5 py-2" onClick={() => doExport('md')}>
          <FileText className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="text-xs font-medium">Markdown 报告（.md）</span>
            <span className="text-[10px] text-muted-foreground">人读向 · same 折叠</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2" onClick={() => doExport('json')}>
          <Braces className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="text-xs font-medium">JSON 完整数据（.json）</span>
            <span className="text-[10px] text-muted-foreground">机器可读 · 全部 items</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// 主视图
// ---------------------------------------------------------------------------

export function DocCompareView() {
  const activeKbId = usePlatformStore((s) => s.activeKbId)
  const setKb = usePlatformStore((s) => s.setKb)
  const activeDocId = usePlatformStore((s) => s.activeDocId)
  const setView = usePlatformStore((s) => s.setView)

  // 用户选择覆盖（派生默认值，避免 setState-in-effect）：
  // docSel = 手动选的文档；vSel = 按文档锁定的版本对（docId 变更时自然失效回退默认）
  const [docSel, setDocSel] = useState<string | null>(null)
  const [vSel, setVSel] = useState<{ docId: string; v1: string | null; v2: string | null } | null>(null)
  const [filter, setFilter] = useState<FilterMode>('changes')

  // -- KB 列表（与文档中心 / 三屏一致：默认 activeKbId，无则第一个） ------------------
  const kbsQuery = useQuery({ queryKey: ['kbs'], queryFn: () => ragApi.listKbs() })
  const kbs = kbsQuery.data?.kbs ?? []
  useEffect(() => {
    if (!activeKbId && kbs.length > 0) setKb(kbs[0].id)
  }, [activeKbId, kbs, setKb])

  // -- 文档列表（当前 KB，上限 300 与三屏选择器一致） ---------------------------------
  const docsQuery = useQuery({
    queryKey: ['docs', activeKbId, 'compare-select'],
    queryFn: () => ragApi.listDocs(activeKbId!, { limit: 300 }),
    enabled: !!activeKbId,
  })
  const docs = docsQuery.data?.docs ?? []

  // 当前文档（派生）：手动选择 > store.activeDocId（跨视图上下文，需在列表内）> 第一个
  const inDocs = (id: string | null) => !!id && docs.some((d) => d.id === id)
  const docId = inDocs(docSel) ? docSel : inDocs(activeDocId) ? activeDocId : (docs[0]?.id ?? null)

  // -- 版本列表 -----------------------------------------------------------------------
  const versionsQuery = useQuery({
    queryKey: ['doc-versions', docId],
    queryFn: () => ragApi.listDocVersions(docId!),
    enabled: !!docId,
  })
  const versions = versionsQuery.data?.versions ?? []

  // 当前版本对（派生）：用户选择（按 docId 锁定且仍有效）优先；默认 v2 = current、v1 = 最新快照
  const hasPair = versions.length > 1
  const vDefault2 = hasPair ? (versions.find((v) => v.source === 'current')?.version ?? versions[0].version) : null
  const vDefault1 = hasPair ? (versions[1]?.version ?? null) : null
  const userPair = vSel && vSel.docId === docId ? vSel : null
  const v1Sel =
    userPair && userPair.v1 && versions.some((v) => v.version === userPair.v1) ? userPair.v1 : vDefault1
  const v2Sel =
    userPair && userPair.v2 && versions.some((v) => v.version === userPair.v2) ? userPair.v2 : vDefault2

  const chooseV1 = (v: string) => {
    if (docId) setVSel({ docId, v1: v, v2: v2Sel })
  }
  const chooseV2 = (v: string) => {
    if (docId) setVSel({ docId, v1: v1Sel, v2: v })
  }

  const v1Info = versions.find((v) => v.version === v1Sel) ?? null
  const v2Info = versions.find((v) => v.version === v2Sel) ?? null

  // -- 对比结果（keepPreviousData 防切换闪烁） ----------------------------------------
  const canCompare = !!docId && !!v1Sel && !!v2Sel && v1Sel !== v2Sel
  const compareQuery = useQuery({
    queryKey: ['doc-compare', docId, v1Sel, v2Sel],
    queryFn: () => ragApi.compareDocVersions(docId!, v1Sel!, v2Sel!),
    enabled: canCompare,
    placeholderData: keepPreviousData,
  })
  const compare = compareQuery.data?.compare ?? null

  const swapVersions = () => {
    if (docId && v1Sel && v2Sel) setVSel({ docId, v1: v2Sel, v2: v1Sel })
  }

  // -- 过滤与计数 ---------------------------------------------------------------------
  const items = useMemo(() => compare?.items ?? [], [compare])
  const counts = useMemo(() => {
    const c: Record<VersionDiffType, number> = { same: 0, added: 0, removed: 0, changed: 0 }
    for (const it of items) c[it.type]++
    return c
  }, [items])
  const changesCount = counts.added + counts.removed + counts.changed
  const filtered = useMemo(() => {
    if (filter === 'all') return items
    if (filter === 'changes') return items.filter((i) => i.type !== 'same')
    return items.filter((i) => i.type === filter)
  }, [items, filter])
  const noDiffs = compare !== null && changesCount === 0
  // 导出按钮可见性：diff 数据就绪（空态/仅 current 一版/加载失败时整个内容区不渲染，自然隐藏）
  const canExport = !!compare && !compareQuery.error

  // -- 渲染：框架态 -------------------------------------------------------------------
  if (kbsQuery.isLoading) {
    return (
      <ViewPage wide>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-28 rounded-xl" />
        <ContentSkeleton />
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
          icon={<GitCompareArrows className="h-6 w-6" />}
          title="还没有知识库"
          description="文档版本管理依赖文档的切分版本快照。请先在「知识库」视图创建知识库并上传文档。"
        />
      </ViewPage>
    )
  }

  const onlyCurrent = versionsQuery.isSuccess && versions.length <= 1

  return (
    <ViewPage wide>
      {/* 标题 */}
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <GitCompareArrows className="h-4 w-4 text-primary" aria-hidden />
            文档版本管理
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            切分版本快照 · chunk 级 diff（未变化 / 新增 / 移除 / 修改）与切分参数对照
          </p>
        </div>
      </header>

      {/* 控制条 */}
      {docsQuery.error ? (
        <ErrorCard
          title="文档列表加载失败"
          message={docsQuery.error instanceof Error ? docsQuery.error.message : String(docsQuery.error)}
          onRetry={() => docsQuery.refetch()}
        />
      ) : docsQuery.isLoading || !docId ? (
        <Skeleton className="h-28 rounded-xl" />
      ) : docs.length === 0 ? (
        <EmptyHint
          icon={<FileText className="h-6 w-6" />}
          title="该知识库还没有文档"
          description="上传并解析文档后，即可对比其切分版本。"
          action={
            <Button size="sm" className="h-8 gap-1.5" onClick={() => setView('docs')}>
              <FileText className="h-3.5 w-3.5" aria-hidden />
              前往文档中心
            </Button>
          }
        />
      ) : (
        <Card className="p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
            {/* 知识库 + 文档 */}
            <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:gap-2 xl:flex-1">
              <div className="flex w-full flex-col gap-1 sm:w-44 xl:w-40">
                <span className="text-[11px] font-medium text-muted-foreground">知识库</span>
                <Select
                  value={activeKbId ?? ''}
                  onValueChange={(v) => {
                    setKb(v)
                  }}
                >
                  <SelectTrigger className="h-8 w-full text-xs" aria-label="选择知识库">
                    <SelectValue placeholder="选择知识库" />
                  </SelectTrigger>
                  <SelectContent>
                    {kbs.map((kb) => (
                      <SelectItem key={kb.id} value={kb.id} className="text-xs">
                        <span className="truncate">{kb.name}</span>
                        <span className="ml-auto pl-2 text-[10px] text-muted-foreground">
                          {formatNumber(kb.docCount)} 文档
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-full min-w-0 flex-1 flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">文档</span>
                <Select
                  value={docId}
                  onValueChange={(v) => {
                    setDocSel(v)
                  }}
                >
                  <SelectTrigger className="h-8 w-full text-xs" aria-label="选择文档">
                    <SelectValue placeholder="选择文档" />
                  </SelectTrigger>
                  <SelectContent>
                    {docs.map((d) => (
                      <SelectItem key={d.id} value={d.id} className="text-xs">
                        <span className="truncate">{d.filename}</span>
                        <span className="ml-auto pl-2 text-[10px] tabular-nums text-muted-foreground">
                          {formatNumber(d.chunkCount)} chunks
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* v1 / 交换 / v2 */}
            <div className="flex flex-wrap items-end gap-2">
              <VersionSelect side="v1" value={v1Sel} versions={versions} exclude={v2Sel} onChange={chooseV1} />
              <motion.div whileTap={{ scale: 0.88, rotate: 180 }} className="flex sm:pt-5">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={swapVersions}
                  disabled={!v1Sel || !v2Sel}
                  aria-label="交换 v1 与 v2"
                  title="交换 v1 / v2"
                >
                  <ArrowLeftRight className="h-4 w-4" aria-hidden />
                </Button>
              </motion.div>
              <VersionSelect side="v2" value={v2Sel} versions={versions} exclude={v1Sel} onChange={chooseV2} />
            </div>
          </div>

          {/* 版本信息条 */}
          {v1Info && v2Info && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
              <History className="h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
              <span className="font-medium text-foreground/80">v1 · {versionLabel(v1Info)}</span>
              <span className="tabular-nums">
                {formatNumber(v1Info.chunkCount)} chunks · {formatNumber(v1Info.totalTokens)} tokens ·{' '}
                {fmtShort(v1Info.createdAt)}
              </span>
              <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
              <span className="font-medium text-foreground/80">v2 · {versionLabel(v2Info)}</span>
              <span className="tabular-nums">
                {formatNumber(v2Info.chunkCount)} chunks · {formatNumber(v2Info.totalTokens)} tokens ·{' '}
                {fmtShort(v2Info.createdAt)}
              </span>
              {/* 导出报告（契约 §22）：仅 diff 数据就绪时可见，挂在版本信息条右端 */}
              {canExport && docId && v1Sel && v2Sel && (
                <div className="ml-auto pl-2">
                  <ExportCompareMenu docId={docId} v1={v1Sel} v2={v2Sel} />
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* 内容区（文档就绪后） */}
      {docId && docs.length > 0 && (
        <>
          {versionsQuery.error ? (
            <ErrorCard
              title="版本列表加载失败"
              message={versionsQuery.error instanceof Error ? versionsQuery.error.message : String(versionsQuery.error)}
              onRetry={() => versionsQuery.refetch()}
            />
          ) : versionsQuery.isLoading ? (
            <ContentSkeleton />
          ) : onlyCurrent ? (
            /* 只有 current 一个版本：空态引导 */
            <EmptyHint
              icon={<GitCompareArrows className="h-6 w-6" />}
              title="该文档暂无可对比的历史版本"
              description="重解析 / 重切分文档时会自动归档旧版本快照，产生可对比的历史版本。当前仅有「当前」一个切分版本。"
              action={
                <Button size="sm" className="h-8 gap-1.5" onClick={() => setView('docs')}>
                  <FileText className="h-3.5 w-3.5" aria-hidden />
                  前往文档中心
                </Button>
              }
            />
          ) : !canCompare ? (
            <ContentSkeleton />
          ) : compareQuery.error ? (
            <ErrorCard
              title="文档版本管理加载失败"
              message={compareQuery.error instanceof Error ? compareQuery.error.message : String(compareQuery.error)}
              onRetry={() => compareQuery.refetch()}
            />
          ) : !compare ? (
            <ContentSkeleton />
          ) : (
            <>
              {/* 汇总统计：chunk / token 趋势 + 四色计数 */}
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
              >
                <TrendStatCard icon={<Boxes className="h-4 w-4" />} label="chunk 数" from={compare.summary.v1Chunks} to={compare.summary.v2Chunks} />
                <TrendStatCard icon={<Coins className="h-4 w-4" />} label="token 总量" from={compare.summary.v1Tokens} to={compare.summary.v2Tokens} />
                <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="未变化" value={compare.summary.same} accent="teal" />
                <StatCard icon={<FilePlus2 className="h-4 w-4" />} label="新增" value={compare.summary.added} accent="emerald" />
                <StatCard icon={<FileMinus2 className="h-4 w-4" />} label="已移除" value={compare.summary.removed} accent="rose" />
                <StatCard icon={<FilePenLine className="h-4 w-4" />} label="已修改" value={compare.summary.changed} accent="amber" />
              </motion.div>

              {/* 参数差异（chunkConfigSnap 逐 key） */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
                    <Settings2 className="h-3.5 w-3.5 text-primary" aria-hidden />
                    切分参数差异
                    <Badge variant="secondary" className="text-[10px] tabular-nums">
                      {compare.configDiff.length}
                    </Badge>
                    <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                      取自两版本 chunkConfigSnap 逐 key 对比
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {compare.configDiff.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 px-4 py-5 text-xs text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-teal-500" aria-hidden />
                      两版本切分参数一致
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="h-9 pl-4 text-[11px] font-medium">参数</TableHead>
                            <TableHead className="h-9 text-[11px] font-medium">
                              v1 · {versionLabel(compare.v1)}
                            </TableHead>
                            <TableHead className="h-9 pr-4 text-[11px] font-medium">
                              v2 · {versionLabel(compare.v2)}
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {compare.configDiff.map((e) => (
                            <TableRow key={e.key}>
                              <TableCell className="py-2.5 pl-4 text-xs font-medium">
                                {CONFIG_KEY_LABELS[e.key] ?? e.key}
                              </TableCell>
                              <TableCell className="py-2.5 font-mono text-xs text-rose-600 dark:text-rose-400">
                                <span className="line-through decoration-rose-400/60 decoration-1">{e.v1}</span>
                              </TableCell>
                              <TableCell className="py-2.5 pr-4 font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                                {e.v2}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* diff 列表 */}
              <Card className="overflow-hidden">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
                    <ListFilter className="h-3.5 w-3.5 text-primary" aria-hidden />
                    chunk 差异明细
                    <Badge variant="secondary" className="text-[10px] tabular-nums">
                      {filtered.length}/{items.length}
                    </Badge>
                    {compareQuery.isFetching && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label="加载中" />
                    )}
                    <div className="ml-auto flex flex-wrap items-center gap-1.5" role="group" aria-label="过滤">
                      {(
                        [
                          { key: 'all' as FilterMode, label: '全部', count: items.length, dot: null, active: 'border-primary/50 bg-primary/10 text-primary' },
                          { key: 'changes' as FilterMode, label: '仅变化', count: changesCount, dot: null, active: 'border-primary/50 bg-primary/10 text-primary' },
                          ...(['same', 'added', 'removed', 'changed'] as VersionDiffType[]).map((t) => ({
                            key: t as FilterMode,
                            label: DIFF_TYPE_META[t].label,
                            count: counts[t],
                            dot: DIFF_TYPE_META[t].dot,
                            active: DIFF_TYPE_META[t].activeChip,
                          })),
                        ] as { key: FilterMode; label: string; count: number; dot: string | null; active: string }[]
                      ).map((c) => (
                        <button
                          key={c.key}
                          type="button"
                          onClick={() => setFilter(c.key)}
                          aria-pressed={filter === c.key}
                          className={cn(
                            'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                            filter === c.key
                              ? c.active
                              : 'border-border/60 bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                          )}
                        >
                          {c.dot && <span className={cn('h-1.5 w-1.5 rounded-full', c.dot)} aria-hidden />}
                          {c.label}
                          <span className="tabular-nums">{c.count}</span>
                        </button>
                      ))}
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {compareQuery.isLoading ? (
                    <div className="space-y-2 p-3 sm:p-4">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-16 rounded-lg" />
                      ))}
                    </div>
                  ) : (
                    <div
                      className={cn('max-h-[70vh] overflow-y-auto p-3 sm:p-4', ragScrollbar)}
                      role="region"
                      aria-label="chunk 差异列表"
                    >
                      {filtered.length === 0 ? (
                        noDiffs ? (
                          <SameOnlyHint />
                        ) : (
                          <p className="py-12 text-center text-xs text-muted-foreground">当前过滤条件下没有条目</p>
                        )
                      ) : (
                        <motion.div
                          key={`${docId}-${v1Sel}-${v2Sel}-${filter}`}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.2 }}
                          className="space-y-2"
                        >
                          {filtered.map((item, idx) => (
                            <DiffItemCard
                              key={`${item.type}-${item.v1?.seq ?? 'x'}-${item.v2?.seq ?? 'y'}-${idx}`}
                              item={item}
                              v1Label={versionLabel(compare.v1)}
                              v2Label={versionLabel(compare.v2)}
                            />
                          ))}
                        </motion.div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </ViewPage>
  )
}
