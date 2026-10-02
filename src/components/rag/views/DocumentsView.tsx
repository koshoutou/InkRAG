'use client'

// 文档中心：KB 选择器 + 批量上传/URL 导入入口（BatchUploadDialog，契约 §26）+ 文档表（实时状态）+ 操作
// socket kb:{kbId} 房间：document:status 实时更新行内状态与进度

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  BookOpenCheck,
  ExternalLink,
  FileCode2,
  FileSearch,
  FileText,
  FileType2,
  Layers,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Trash2,
  UploadCloud,
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
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { gotoViewer, usePlatformStore } from '../store'
import { useRealtime } from '../useRealtime'
import type { DocSummary, KbSummary } from '../types'
import { BatchUploadDialog } from './documents/BatchUploadDialog'
import {
  DOC_STATUSES,
  EmptyHint,
  ErrorCard,
  PROCESSING_STATUSES,
  STATUS_META,
  StatusBadge,
  ViewPage,
  formatBytes,
  formatDateTime,
  formatNumber,
  ragScrollbar,
} from '../ui'

function fileIcon(mime: string, filename: string) {
  if (mime.includes('pdf') || filename.toLowerCase().endsWith('.pdf')) return <FileText className="h-3.5 w-3.5 text-rose-500" />
  if (/\.docx$/i.test(filename.toLowerCase())) return <FileText className="h-3.5 w-3.5 text-orange-500" />
  if (/\.(md|markdown)$/.test(filename.toLowerCase()) || mime.includes('markdown')) return <FileCode2 className="h-3.5 w-3.5 text-violet-500" />
  if (mime.includes('html')) return <FileType2 className="h-3.5 w-3.5 text-amber-500" />
  return <FileText className="h-3.5 w-3.5 text-teal-500" />
}

export function DocumentsView() {
  const queryClient = useQueryClient()
  const activeKbId = usePlatformStore((s) => s.activeKbId)
  const setKb = usePlatformStore((s) => s.setKb)
  const setView = usePlatformStore((s) => s.setView)
  const { subscribeRooms, on } = useRealtime()

  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [q, setQ] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [deleteDoc, setDeleteDoc] = useState<DocSummary | null>(null)

  const kbsQuery = useQuery({ queryKey: ['kbs'], queryFn: () => ragApi.listKbs() })
  const kbs: KbSummary[] = kbsQuery.data?.kbs ?? []

  // KB 未指定时默认选第一个
  useEffect(() => {
    if (!activeKbId && kbs.length > 0) setKb(kbs[0].id)
  }, [activeKbId, kbs, setKb])

  const docsQuery = useQuery({
    queryKey: ['docs', activeKbId, statusFilter, q],
    queryFn: () =>
      ragApi.listDocs(activeKbId!, {
        status: statusFilter !== 'all' ? statusFilter : undefined,
        q: q.trim() || undefined,
        limit: 200,
      }),
    enabled: !!activeKbId,
    refetchInterval: 15_000,
  })

  // socket 实时：kb 房间
  useEffect(() => {
    if (!activeKbId) return
    subscribeRooms([`kb:${activeKbId}`])
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ['docs', activeKbId] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    }
    const un1 = on('document:status', invalidate)
    const un2 = on('document:done', invalidate)
    const un3 = on('document:progress', invalidate)
    return () => {
      un1()
      un2()
      un3()
    }
  }, [activeKbId, subscribeRooms, on, queryClient])

  const actionMutation = useMutation({
    mutationFn: ({ docId, action }: { docId: string; action: 'reparse' | 'rechunk' | 'retry' }) =>
      ragApi.docAction(docId, action),
    onSuccess: (_r, v) => {
      toast.success(
        v.action === 'reparse' ? '已重新入队：全流水线重跑' : v.action === 'rechunk' ? '已重新入队：重切分' : '已重新入队：从失败阶段续跑',
      )
      queryClient.invalidateQueries({ queryKey: ['docs', activeKbId] })
    },
    onError: (e: Error) => toast.error('操作失败：' + e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => ragApi.deleteDoc(id),
    onSuccess: (r) => {
      toast.success(`文档已删除（清理 ${r.deletedChunks} 个 chunk 与向量点）`)
      setDeleteDoc(null)
      queryClient.invalidateQueries({ queryKey: ['docs', activeKbId] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (e: Error) => toast.error('删除失败：' + e.message),
  })

  const docs = docsQuery.data?.docs ?? []
  const activeKb = kbs.find((k) => k.id === activeKbId)

  // 批量重新解析（模式切换后的恢复路径：对当前 KB 全部可重跑文档逐个 reparse）
  const [batchReparseOpen, setBatchReparseOpen] = useState(false)
  const [batchReparseBusy, setBatchReparseBusy] = useState(false)
  const batchReparseTargets = useMemo(
    () => docs.filter((d) => d.status === 'ready' || d.status === 'failed'),
    [docs],
  )
  const runBatchReparse = useCallback(async () => {
    if (!activeKbId || batchReparseTargets.length === 0) return
    setBatchReparseBusy(true)
    let ok = 0
    let fail = 0
    for (const d of batchReparseTargets) {
      try {
        await ragApi.docAction(d.id, 'reparse')
        ok++
      } catch {
        fail++
      }
    }
    setBatchReparseBusy(false)
    setBatchReparseOpen(false)
    if (fail === 0) toast.success(`已批量入队 ${ok} 个文档（全流水线重跑）`)
    else toast.warning(`批量入队完成：成功 ${ok} · 失败 ${fail}`)
    queryClient.invalidateQueries({ queryKey: ['docs', activeKbId] })
  }, [activeKbId, batchReparseTargets, queryClient])

  if (kbsQuery.isLoading) {
    return (
      <ViewPage>
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </ViewPage>
    )
  }
  if (kbsQuery.error) {
    return (
      <ViewPage>
        <ErrorCard message={kbsQuery.error instanceof Error ? kbsQuery.error.message : String(kbsQuery.error)} onRetry={() => kbsQuery.refetch()} />
      </ViewPage>
    )
  }
  if (kbs.length === 0) {
    return (
      <ViewPage>
        <EmptyHint
          icon={<Layers className="h-6 w-6" />}
          title="还没有知识库"
          description="请先创建知识库，再上传文档。"
          action={
            <Button size="sm" variant="outline" onClick={() => setView('kbs')}>
              去创建知识库
            </Button>
          }
        />
      </ViewPage>
    )
  }

  return (
    <ViewPage wide>
      {/* KB 选择器 + 上传区 */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">当前知识库</span>
            <Select value={activeKbId ?? ""} onValueChange={(v) => setKb(v)}>
              <SelectTrigger className="h-8 w-64 text-xs">
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
          </div>
          {activeKb && (
            <Badge variant="secondary" className="text-[10px] font-mono">
              {activeKb.collection}
            </Badge>
          )}
          <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs" onClick={() => docsQuery.refetch()} disabled={docsQuery.isRefetching}>
            <RefreshCw className={cn('h-3 w-3', docsQuery.isRefetching && 'animate-spin')} />
            刷新
          </Button>
          {batchReparseTargets.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => setBatchReparseOpen(true)}
              disabled={batchReparseBusy}
              title={`对当前知识库 ${batchReparseTargets.length} 个就绪/失败文档重新走全流水线（切换向量库模式后重新入库）`}
            >
              <Layers className={cn('h-3 w-3', batchReparseBusy && 'animate-pulse')} />
              批量重解析
            </Button>
          )}
          <Button
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setUploadOpen(true)}
            title="多文件批量上传 / URL 导入（支持 pdf、docx、md、txt、html 与外部链接）"
          >
            <UploadCloud className="h-3.5 w-3.5" />
            上传 / 导入
          </Button>
        </div>

        {/* 上传能力说明（入口收进对话框，契约 §26） */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border/60 bg-muted/20 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <UploadCloud className="h-3.5 w-3.5 shrink-0 text-teal-500" />
            批量上传 .pdf / .docx / .md / .markdown / .txt / .html，并发 2 路 + 流式进度，相同内容自动秒传
          </span>
          <span className="flex items-center gap-1.5">
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            或输入外部 wiki / 文档站 URL，服务端抓取抽取正文导入（sitemap 自动展开）
          </span>
        </div>
      </div>

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索文件名…" className="h-8 w-52 pl-7 text-xs" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">全部状态</SelectItem>
            {DOC_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {STATUS_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-[11px] text-muted-foreground">
          共 {formatNumber(docsQuery.data?.total ?? 0)} 个文档
        </span>
      </div>

      {/* 文档表 */}
      {docsQuery.isLoading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : docsQuery.error ? (
        <ErrorCard
          title="文档列表加载失败"
          message={docsQuery.error instanceof Error ? docsQuery.error.message : String(docsQuery.error)}
          onRetry={() => docsQuery.refetch()}
        />
      ) : docs.length === 0 ? (
        <EmptyHint
          icon={<FileSearch className="h-6 w-6" />}
          title={q || statusFilter !== 'all' ? '没有匹配的文档' : '该知识库还没有文档'}
          description={q || statusFilter !== 'all' ? '试试调整搜索关键词或状态筛选' : '把文件拖到上方上传区，开始构建知识库'}
        />
      ) : (
        <div className={cn('overflow-hidden rounded-xl border border-border/60 bg-card', ragScrollbar)}>
          <div className="max-h-[calc(100vh-380px)] min-h-[240px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="h-9 text-[11px]">文件名</TableHead>
                  <TableHead className="h-9 text-[11px] text-right">大小</TableHead>
                  <TableHead className="h-9 text-[11px]">状态 / 进度</TableHead>
                  <TableHead className="h-9 text-[11px]">引擎</TableHead>
                  <TableHead className="h-9 text-[11px] text-right">Chunk / 块</TableHead>
                  <TableHead className="h-9 text-[11px] text-right">cfg</TableHead>
                  <TableHead className="h-9 text-[11px]">更新时间</TableHead>
                  <TableHead className="h-9 text-[11px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((doc) => (
                  <DocRow
                    key={doc.id}
                    doc={doc}
                    onClick={() => gotoViewer(doc.id)}
                    onAction={(action) => actionMutation.mutate({ docId: doc.id, action })}
                    onDelete={() => setDeleteDoc(doc)}
                    actionPending={actionMutation.isPending}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      <AlertDialog open={!!deleteDoc} onOpenChange={(v) => !v && setDeleteDoc(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除文档「{deleteDoc?.filename}」？</AlertDialogTitle>
            <AlertDialogDescription>
              将级联删除该文档的 {deleteDoc?.chunkCount ?? 0} 个 chunk、对应向量点与全部磁盘产物，操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
              onClick={() => {
                if (deleteDoc) deleteMutation.mutate(deleteDoc.id)
              }}
            >
              {deleteMutation.isPending ? '删除中…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 批量重解析确认 */}
      <AlertDialog open={batchReparseOpen} onOpenChange={setBatchReparseOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>批量重新解析 {batchReparseTargets.length} 个文档？</AlertDialogTitle>
            <AlertDialogDescription>
              将对「{activeKb?.name ?? '当前知识库'}」全部就绪 / 失败文档重新走完整流水线（旧版本自动快照，可用于文档版本管理）。
              适用于切换向量库模式后的重新入库、批量配置变更后的重建。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={batchReparseBusy}
              onClick={(e) => {
                e.preventDefault()
                void runBatchReparse()
              }}
            >
              {batchReparseBusy ? '入队中…' : '开始批量入队'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 批量上传 / URL 导入（契约 §26）：容器常驻，关闭对话框后任务与事件继续 */}
      <BatchUploadDialog kbId={activeKbId} open={uploadOpen} onOpenChange={setUploadOpen} />
    </ViewPage>
  )
}

function DocRow({
  doc,
  onClick,
  onAction,
  onDelete,
  actionPending,
}: {
  doc: DocSummary
  onClick: () => void
  onAction: (action: 'reparse' | 'rechunk' | 'retry') => void
  onDelete: () => void
  actionPending: boolean
}) {
  const processing = PROCESSING_STATUSES.includes(doc.status)
  return (
    <TableRow
      className={cn('cursor-pointer transition-colors hover:bg-muted/40', doc.status === 'failed' && 'bg-rose-500/[0.03]')}
      onClick={onClick}
    >
      <TableCell className="max-w-[260px] py-2.5">
        <div className="flex items-center gap-2">
          {fileIcon(doc.mimeType, doc.filename)}
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="truncate text-xs font-medium" title={doc.filename}>{doc.filename}</span>
              {doc.sourceUrl && (
                <a
                  href={doc.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-emerald-500 transition-colors hover:text-emerald-600"
                  title={`来源：${doc.sourceUrl}`}
                  aria-label={`打开来源页面 ${doc.sourceUrl}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            {doc.status === 'failed' && doc.errorMessage && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="mt-0.5 flex items-center gap-1 text-[10px] text-rose-500">
                      <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                      <span className="font-mono">{doc.errorCode || 'ERROR'}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-xs">
                    {doc.errorMessage}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="py-2.5 text-right text-[11px] tabular-nums text-muted-foreground">{formatBytes(doc.sizeBytes)}</TableCell>
      <TableCell className="py-2.5">
        <div className="flex w-40 flex-col gap-1">
          <StatusBadge status={doc.status} />
          {processing && (
            <Progress value={doc.stageProgress ?? 0} className="h-1" />
          )}
          {doc.status === 'failed' && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 w-fit gap-1 px-2 text-[10px]"
              disabled={actionPending}
              onClick={(e) => {
                e.stopPropagation()
                onAction('retry')
              }}
            >
              <RotateCcw className="h-2.5 w-2.5" />
              重试
            </Button>
          )}
        </div>
      </TableCell>
      <TableCell className="py-2.5">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px]',
                  doc.parseEngine === 'mineru'
                    ? 'border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
                )}
              >
                {doc.parseEngine === 'mineru' ? 'MinerU' : '降级解析'}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="text-xs">解析引擎：{doc.parseEngine}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </TableCell>
      <TableCell className="py-2.5 text-right text-[11px] tabular-nums text-muted-foreground">
        {formatNumber(doc.chunkCount)} / {formatNumber(doc.layoutBlocks)}
      </TableCell>
      <TableCell className="py-2.5 text-right text-[11px] font-mono text-muted-foreground">v{doc.parseConfigV}</TableCell>
      <TableCell className="py-2.5 text-[11px] text-muted-foreground">{formatDateTime(doc.updatedAt)}</TableCell>
      <TableCell className="py-2.5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-0.5">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClick} title="三屏查看">
                  <BookOpenCheck className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">三屏联动查看</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={actionPending} onClick={() => onAction('rechunk')} title="重切分（跳过解析）">
                  <Scissors className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">重切分（parse_config_v + 1）</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={actionPending} onClick={() => onAction('reparse')} title="重新解析（全流水线）">
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">重新解析（全流水线重跑）</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-500 hover:text-rose-600" onClick={onDelete} title="删除">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">删除文档</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </TableCell>
    </TableRow>
  )
}


