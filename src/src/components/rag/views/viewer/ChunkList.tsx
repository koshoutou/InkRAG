'use client'

// 三屏联动 · 右屏：chunk 列表（父子分组 / 分页 / enabled 开关 / 删除 / 全文查看）

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FileText,
  History,
  Image as ImageIcon,
  Layers,
  Loader2,
  Pencil,
  Search,
  Save,
  Table2,
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
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ragApi } from '../../api'
import { DOC_TYPE_META, EmptyHint, shortCode } from '../../ui'
import type { ChunkFull, ChunkItem } from '../../types'

export const PAGE_SIZE = 50

function docTypeIcon(type: string) {
  switch (type) {
    case 'code':
      return <Code2 className="h-3 w-3" />
    case 'table':
      return <Table2 className="h-3 w-3" />
    case 'image':
      return <ImageIcon className="h-3 w-3" />
    default:
      return <FileText className="h-3 w-3" />
  }
}

export interface ChunkListProps {
  docId: string
  chunks: ChunkItem[]
  parents: ChunkItem[]
  total: number
  page: number
  setPage: (p: number) => void
  q: string
  setQ: (q: string) => void
  loading: boolean
  selectedChunkId: string | null
  onSelect: (chunk: ChunkItem) => void
}

export function ChunkList({
  docId,
  chunks,
  parents,
  total,
  page,
  setPage,
  q,
  setQ,
  loading,
  selectedChunkId,
  onSelect,
}: ChunkListProps) {
  const queryClient = useQueryClient()
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [viewChunk, setViewChunk] = useState<string | null>(null)
  const [deleteChunk, setDeleteChunk] = useState<ChunkItem | null>(null)
  const [fullChunk, setFullChunk] = useState<ChunkFull | null>(null)
  const [fullLoading, setFullLoading] = useState(false)
  const [editChunk, setEditChunk] = useState<ChunkItem | null>(null)
  const [editText, setEditText] = useState('')
  const [editOrigText, setEditOrigText] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // ---- 多选模式（批量启停） ----
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  /** 批量确认动作（禁用超过 20 条时 AlertDialog 二次确认） */
  const [batchConfirm, setBatchConfirm] = useState<'enable' | 'disable' | null>(null)
  /** 导出选项 */
  const [exportIncludeParents, setExportIncludeParents] = useState(false)

  // 切换文档时清空选中集（chunkId 是全文档空间）
  useEffect(() => {
    setSelectedIds(new Set())
  }, [docId])

  const pageChildIds = useMemo(() => chunks.map((c) => c.id), [chunks])
  const selectedCount = selectedIds.size
  const allPageSelected = pageChildIds.length > 0 && pageChildIds.every((id) => selectedIds.has(id))

  const toggleSelect = (chunkId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(chunkId)
      else next.delete(chunkId)
      return next
    })
  }
  const selectAllPage = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of pageChildIds) next.add(id)
      return next
    })
  const clearSelection = () => setSelectedIds(new Set())

  // 分组：children 按 parentId 归组；无父的单独组
  const groups = useMemo(() => {
    const byParent = new Map<string | null, ChunkItem[]>()
    for (const c of chunks) {
      const key = c.parentId
      if (!byParent.has(key)) byParent.set(key, [])
      byParent.get(key)!.push(c)
    }
    const result: { parent: ChunkItem | null; items: ChunkItem[] }[] = []
    for (const p of parents) {
      const items = byParent.get(p.id) ?? []
      if (items.length > 0 || expandedParents.has(p.id)) result.push({ parent: p, items })
    }
    const orphan = byParent.get(null)
    if (orphan && orphan.length > 0) result.push({ parent: null, items: orphan })
    return result
  }, [chunks, parents, expandedParents])

  // 选中 → 展开所属父组 + 滚动到卡片
  useEffect(() => {
    if (!selectedChunkId) return
    const sel = chunks.find((c) => c.id === selectedChunkId)
    if (sel?.parentId) {
      setExpandedParents((prev) => new Set(prev).add(sel.parentId!))
    }
    const t = setTimeout(() => {
      listRef.current?.querySelector(`[data-chunk-id="${selectedChunkId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    return () => clearTimeout(t)
  }, [selectedChunkId, chunks])

  const patchMutation = useMutation({
    mutationFn: ({ chunkId, enabled }: { chunkId: string; enabled: boolean }) => ragApi.patchChunk(docId, chunkId, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chunks', docId] })
      queryClient.invalidateQueries({ queryKey: ['doc', docId] })
    },
    onError: (e: Error) => toast.error('更新失败：' + e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (chunkId: string) => ragApi.deleteChunk(docId, chunkId),
    onSuccess: () => {
      toast.success('chunk 已删除')
      // 同步清理选中集，避免批量操作指向已删除的 chunk
      setSelectedIds((prev) => {
        if (!deleteChunk || !prev.has(deleteChunk.id)) return prev
        const next = new Set(prev)
        next.delete(deleteChunk.id)
        return next
      })
      setDeleteChunk(null)
      queryClient.invalidateQueries({ queryKey: ['chunks', docId] })
      queryClient.invalidateQueries({ queryKey: ['doc', docId] })
    },
    onError: (e: Error) => toast.error('删除失败：' + e.message),
  })

  // ---- 批量启停（契约 §13） ----
  const batchMutation = useMutation({
    mutationFn: (args: { action: 'enable' | 'disable'; chunkIds?: string[]; scope?: 'children' | 'all' }) =>
      ragApi.batchChunks(docId, args),
    onSuccess: (r, args) => {
      toast.success(`已更新 ${r.updated} 个 chunk 的检索状态`)
      if (r.payloadSyncFailed > 0) {
        toast.warning(`${r.payloadSyncFailed} 个 chunk 的向量 payload 同步失败（数据库已更新，重解析可修复）`)
      }
      // 禁用后同步清理选中集（被禁用 chunk 已退出检索）
      if (args.action === 'disable') setSelectedIds(new Set())
      setBatchConfirm(null)
      queryClient.invalidateQueries({ queryKey: ['chunks', docId] })
      queryClient.invalidateQueries({ queryKey: ['doc', docId] })
    },
    onError: (e: Error) => {
      toast.error('批量操作失败：' + e.message)
      setBatchConfirm(null)
    },
  })

  const runBatch = (action: 'enable' | 'disable') => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    // 禁用超过 20 条 → AlertDialog 提示影响面
    if (action === 'disable' && ids.length > 20) {
      setBatchConfirm('disable')
      return
    }
    batchMutation.mutate({ action, chunkIds: ids })
  }

  // ---- 导出（契约 §13） ----
  const doExport = (fmt: 'json' | 'csv' | 'md') => {
    window.open(ragApi.chunksExportUrl(docId, fmt, exportIncludeParents))
    toast.success(`正在导出 ${fmt.toUpperCase()}（${exportIncludeParents ? '含父块' : '仅子块'}）`)
  }

  // 编辑全文 → 重嵌入重入库（M6 T6.6）
  const editMutation = useMutation({
    mutationFn: ({ chunkId, text }: { chunkId: string; text: string }) =>
      ragApi.patchChunk(docId, chunkId, { text }),
    onSuccess: (r) => {
      const res = r.result
      toast.success(
        res
          ? `已保存并重嵌入（${res.oldTokens} → ${res.newTokens} tok · ${res.embedMode} · ${res.tookMs}ms）`
          : '已保存并重嵌入',
      )
      setEditChunk(null)
      queryClient.invalidateQueries({ queryKey: ['chunks', docId] })
      queryClient.invalidateQueries({ queryKey: ['doc', docId] })
    },
    onError: (e: Error) => toast.error('保存失败：' + e.message),
  })

  // 还原原文 → 重嵌入
  const revertMutation = useMutation({
    mutationFn: (chunkId: string) => ragApi.patchChunk(docId, chunkId, { revert: true }),
    onSuccess: (r) => {
      const res = r.result
      toast.success(res ? `已还原原文并重嵌入（${res.newTokens} tok · ${res.tookMs}ms）` : '已还原并重嵌入')
      setEditChunk(null)
      queryClient.invalidateQueries({ queryKey: ['chunks', docId] })
      queryClient.invalidateQueries({ queryKey: ['doc', docId] })
    },
    onError: (e: Error) => toast.error('还原失败：' + e.message),
  })

  const openFull = async (chunkId: string) => {
    setViewChunk(chunkId)
    setFullLoading(true)
    setFullChunk(null)
    try {
      const r = await ragApi.getChunk(docId, chunkId, true)
      setFullChunk(r.chunk)
    } catch (e) {
      toast.error('加载全文失败：' + (e as Error).message)
      setViewChunk(null)
    } finally {
      setFullLoading(false)
    }
  }

  const openEdit = async (c: ChunkItem) => {
    setEditChunk(c)
    setEditText('')
    setEditOrigText('')
    setEditLoading(true)
    try {
      const r = await ragApi.getChunk(docId, c.id, true)
      setEditText(r.chunk.text)
      setEditOrigText(r.chunk.text)
    } catch (e) {
      toast.error('加载全文失败：' + (e as Error).message)
      setEditChunk(null)
    } finally {
      setEditLoading(false)
    }
  }

  // 粗略 token 估算（中文≈1字符/token，英文≈0.25词/token），用于编辑器实时反馈
  const editTokenEstimate = useMemo(() => {
    if (!editText) return 0
    const cjk = (editText.match(/[\u4e00-\u9fff]/g) ?? []).length
    const rest = editText.length - cjk
    return Math.max(1, Math.round(cjk + rest / 4))
  }, [editText])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex h-full flex-col">
      {/* 搜索 + 多选工具栏 + 计数 */}
      <div className="shrink-0 space-y-2 border-b border-border/60 px-3 py-2.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="搜索 chunk 内容…" className="h-8 pl-7 text-xs" />
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-[10px]"
            disabled={chunks.length === 0}
            onClick={allPageSelected ? clearSelection : selectAllPage}
          >
            <CheckCheck className="h-3 w-3" />
            {allPageSelected ? '清除' : '全选本页'}
          </Button>
          {selectedCount > 0 && (
            <Badge className="h-5 gap-0.5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
              已选 {selectedCount}
            </Badge>
          )}
          {/* 导出下拉：JSON / CSV / Markdown + 包含父块开关 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="ml-auto h-6 gap-1 px-2 text-[10px]" title="导出 chunk（JSON / CSV / Markdown）">
                <Download className="h-3 w-3" />
                导出
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-[10px] text-muted-foreground">导出格式</DropdownMenuLabel>
              <DropdownMenuItem className="gap-2 text-xs" onClick={() => doExport('json')}>
                JSON
                <span className="ml-auto text-[9px] text-muted-foreground">结构化</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 text-xs" onClick={() => doExport('csv')}>
                CSV
                <span className="ml-auto text-[9px] text-muted-foreground">Excel</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 text-xs" onClick={() => doExport('md')}>
                Markdown
                <span className="ml-auto text-[9px] text-muted-foreground">阅读版</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={exportIncludeParents}
                onCheckedChange={(v) => setExportIncludeParents(v === true)}
                onSelect={(e) => e.preventDefault()}
                className="text-xs"
              >
                包含父块
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            共 <span className="font-medium tabular-nums text-foreground">{total}</span> 个子 chunk
            {parents.length > 0 && <> · {parents.length} 父</>}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-6 w-6" disabled={page <= 0} onClick={() => setPage(page - 1)} title="上一页">
              <ChevronRight className="h-3 w-3 rotate-180" />
            </Button>
            <span className="tabular-nums">
              {page + 1}/{totalPages}
            </span>
            <Button variant="outline" size="icon" className="h-6 w-6" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)} title="下一页">
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      {/* 列表 */}
      <div
        ref={listRef}
        className={cn(
          'flex-1 overflow-y-auto p-2',
          '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/45',
        )}
        role="region"
        aria-label="chunk 列表"
      >
        {loading && chunks.length === 0 ? (
          <div className="space-y-2 p-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          q ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
              <Layers className="h-6 w-6 opacity-50" />
              <p className="text-xs">没有匹配的 chunk</p>
            </div>
          ) : (
            <EmptyHint
              icon={<Layers className="h-6 w-6" />}
              title="暂无 chunk"
              description="上传并解析完成后，chunk 将在此展示；可在切分沙盒中预览切分效果。"
            />
          )
        ) : (
          <div className="space-y-2">
            {groups.map((g) => {
              const isExpanded = !g.parent || expandedParents.has(g.parent.id)
              return (
                <div key={g.parent?.id ?? 'orphan'} className="rounded-lg border border-border/60">
                  {g.parent ? (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedParents((prev) => {
                          const next = new Set(prev)
                          if (next.has(g.parent!.id)) next.delete(g.parent!.id)
                          else next.add(g.parent!.id)
                          return next
                        })
                      }
                      className="flex w-full items-center gap-2 rounded-t-lg bg-muted/40 px-2.5 py-2 text-left transition-colors hover:bg-muted/70"
                    >
                      {isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      <Badge variant="secondary" className="shrink-0 text-[10px] font-mono">父 #{g.parent.seq}</Badge>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {g.parent.textPreview.slice(0, 40)}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {g.parent.tokenCount} tok · P{g.parent.pageFrom}
                        {g.parent.pageTo > g.parent.pageFrom ? `-${g.parent.pageTo}` : ''}
                      </span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5 rounded-t-lg bg-muted/20 px-2.5 py-1.5 text-[10px] text-muted-foreground">
                      <Layers className="h-3 w-3" />
                      未分组子块（无父）
                    </div>
                  )}
                  {isExpanded && (
                    <div className="divide-y divide-border/40">
                      {g.items.map((c) => {
                        const selected = c.id === selectedChunkId
                        const typeMeta = DOC_TYPE_META[c.docType] ?? DOC_TYPE_META.text
                        return (
                          <div
                            key={c.id}
                            data-chunk-id={c.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`chunk ${c.seq}`}
                            onClick={() => onSelect(c)}
                            onKeyDown={(e) => e.key === 'Enter' && onSelect(c)}
                            className={cn(
                              'group cursor-pointer px-2.5 py-2 transition-colors',
                              selected ? 'bg-primary/10 ring-1 ring-inset ring-primary/40' : 'hover:bg-muted/40',
                              !c.enabled && 'opacity-55',
                            )}
                          >
                            <div className="flex items-center gap-1.5">
                              <Checkbox
                                checked={selectedIds.has(c.id)}
                                onCheckedChange={(v) => toggleSelect(c.id, v === true)}
                                onClick={(e) => e.stopPropagation()}
                                className="h-3.5 w-3.5 shrink-0"
                                aria-label={`选中 chunk ${c.seq}（批量操作）`}
                              />
                              <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded', typeMeta.badge)}>
                                {docTypeIcon(c.docType)}
                              </span>
                              <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px] font-mono">#{c.seq}</Badge>
                              {c.editedAt && (
                                <Badge
                                  variant="outline"
                                  className="h-4 shrink-0 gap-0.5 border-amber-500/40 bg-amber-500/10 px-1.5 text-[9px] text-amber-600 dark:text-amber-400"
                                  title={`人工编辑于 ${new Date(c.editedAt).toLocaleString()}`}
                                >
                                  <Pencil className="h-2.5 w-2.5" />
                                  已编辑
                                </Badge>
                              )}
                              {c.parentId && g.parent && (
                                <span className="shrink-0 text-[10px] text-muted-foreground">父#{g.parent.seq}</span>
                              )}
                              <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                {c.tokenCount} tok · P{c.pageFrom}
                                {c.pageTo > c.pageFrom ? `-${c.pageTo}` : ''}
                              </span>
                            </div>
                            <p className={cn('mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground', selected && 'text-foreground')}>
                              {c.textPreview || '（空内容）'}
                            </p>
                            <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                              <div className="flex items-center gap-1">
                                <Switch
                                  checked={c.enabled}
                                  disabled={patchMutation.isPending}
                                  onCheckedChange={(v) => patchMutation.mutate({ chunkId: c.id, enabled: v })}
                                  onClick={(e) => e.stopPropagation()}
                                  className="scale-75"
                                  aria-label={c.enabled ? '禁用此 chunk' : '启用此 chunk'}
                                />
                                <span className="text-[10px] text-muted-foreground">{c.enabled ? '启用' : '已禁用'}</span>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="ml-auto h-6 px-2 text-[10px]"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openFull(c.id)
                                }}
                              >
                                查看全文
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openEdit(c)
                                }}
                                title="编辑全文（保存后重新嵌入入库）"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-rose-500 hover:text-rose-600"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDeleteChunk(c)
                                }}
                                title="删除 chunk"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 批量操作浮动条：有选中时出现（列表底部固定） */}
      {selectedCount > 0 && (
        <div className="shrink-0 border-t border-border/60 bg-background/95 px-3 py-2 shadow-[0_-4px_12px_rgba(0,0,0,0.05)] backdrop-blur">
          <div className="flex items-center gap-2">
            <Badge className="h-5 shrink-0 gap-0.5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
              已选 {selectedCount}
            </Badge>
            <span className="hidden text-[10px] text-muted-foreground sm:inline">批量修改检索状态</span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                size="sm"
                className="h-7 gap-1 bg-emerald-600 px-2.5 text-[11px] text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-700"
                disabled={batchMutation.isPending}
                onClick={() => runBatch('enable')}
              >
                {batchMutation.isPending && batchMutation.variables?.action === 'enable' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCheck className="h-3 w-3" />
                )}
                启用所选
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 border-rose-500/50 px-2.5 text-[11px] text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                disabled={batchMutation.isPending}
                onClick={() => runBatch('disable')}
              >
                {batchMutation.isPending && batchMutation.variables?.action === 'disable' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Ban className="h-3 w-3" />
                )}
                禁用所选
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 全文 Dialog */}
      <Dialog open={!!viewChunk} onOpenChange={(v) => !v && setViewChunk(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              chunk 全文
              {fullChunk && (
                <>
                  <Badge variant="outline" className="text-[10px] font-mono">#{fullChunk.seq}</Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">{shortCode(fullChunk.id)}</span>
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          {fullLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : fullChunk ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                <Badge variant="secondary" className="font-mono">{fullChunk.docType}</Badge>
                <Badge variant="secondary" className="font-mono">{fullChunk.tokenCount} tokens</Badge>
                <Badge variant="secondary" className="font-mono">
                  P{fullChunk.pageFrom}
                  {fullChunk.pageTo > fullChunk.pageFrom ? `-${fullChunk.pageTo}` : ''}
                </Badge>
                <Badge variant="secondary" className="font-mono">char {fullChunk.charStart}-{fullChunk.charEnd}</Badge>
              </div>
              <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
                {fullChunk.text}
              </pre>
              {fullChunk.parentText && (
                <details className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <summary className="cursor-pointer text-xs font-medium text-amber-600 dark:text-amber-400">父 chunk 上下文</summary>
                  <pre className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">{fullChunk.parentText}</pre>
                </details>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 编辑 Dialog：保存后重嵌入重入库 */}
      <Dialog open={!!editChunk} onOpenChange={(v) => !v && setEditChunk(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Pencil className="h-4 w-4 text-amber-500" />
              编辑 chunk #{editChunk?.seq}
              {editChunk?.editedAt && (
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400">
                  <History className="h-2.5 w-2.5" />
                  曾编辑于 {new Date(editChunk.editedAt).toLocaleTimeString()}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          {editLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                保存后自动重新嵌入并以同一 ID 原地更新向量点（检索立即生效）。原文备份在磁盘，可随时还原。
              </p>
              <Textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="min-h-[240px] font-mono text-xs leading-relaxed"
                placeholder="chunk 全文…"
                aria-label="chunk 全文编辑区"
              />
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <Badge variant="secondary" className="font-mono">{editText.length} 字符</Badge>
                <Badge variant="secondary" className="font-mono">≈{editTokenEstimate} tok</Badge>
                {editChunk && editChunk.tokenCount !== editTokenEstimate && (
                  <span className="text-amber-600 dark:text-amber-400">原 {editChunk.tokenCount} tok</span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {editChunk?.editedAt && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 text-[11px]"
                      disabled={revertMutation.isPending || editMutation.isPending}
                      onClick={() => editChunk && revertMutation.mutate(editChunk.id)}
                    >
                      <History className="h-3 w-3" />
                      还原原文
                    </Button>
                  )}
                  <Button
                    size="sm"
                    className="h-7 gap-1 text-[11px]"
                    disabled={
                      editMutation.isPending ||
                      revertMutation.isPending ||
                      editLoading ||
                      !editText.trim() ||
                      editText === editOrigText
                    }
                    onClick={() => editChunk && editMutation.mutate({ chunkId: editChunk.id, text: editText })}
                  >
                    {editMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    保存并重嵌入
                  </Button>
                </div>
              </div>
              {editMutation.isPending && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在重新嵌入并向量入库…
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={!!deleteChunk} onOpenChange={(v) => !v && setDeleteChunk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 chunk #{deleteChunk?.seq}？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除向量点、数据行与磁盘全文，不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
              onClick={() => {
                if (deleteChunk) deleteMutation.mutate(deleteChunk.id)
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 批量禁用确认（超过 20 条时提示影响面） */}
      <AlertDialog open={batchConfirm === 'disable'} onOpenChange={(v) => !v && setBatchConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>批量禁用 {selectedCount} 个 chunk？</AlertDialogTitle>
            <AlertDialogDescription>
              即将禁用 {selectedCount} 个子 chunk（超过 20 条，影响面较大）。禁用后这些 chunk
              将立即退出检索召回；向量点与数据保留，可随时重新启用恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
              disabled={batchMutation.isPending}
              onClick={() => batchMutation.mutate({ action: 'disable', chunkIds: [...selectedIds] })}
            >
              {batchMutation.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              确认禁用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
