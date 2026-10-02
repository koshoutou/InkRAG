'use client'

import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ScrollText, Trash2, RefreshCw, Inbox, Clock, ChevronRight, Search,
  X, Server, FileJson, GitCompareArrows, CheckCircle2, Circle, ArrowRight,
  SlidersHorizontal, ChevronDown, ChevronLeft,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { api } from './api'
import { useQdrantStore } from './store'
import { truncate } from './format'
import type { CallLogItem } from './types'

/** Sheet panel — opened via TopBar "调用记录" button. */
export function CallLogsPanel() {
  const open = useQdrantStore((s) => s.callLogsOpen)
  const setOpen = useQdrantStore((s) => s.setCallLogsOpen)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-full max-w-md p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <ScrollText className="h-4 w-4 text-primary" />
            Qdrant 检索测试日志
          </SheetTitle>
          <SheetDescription className="text-xs">
            每次检索（本工具或外部程序）都会写入，记录时间 / 查询 / 集合 / 命中块 / 结果。勾选 2 条可对比。
          </SheetDescription>
        </SheetHeader>
        <CallLogsBody />
      </SheetContent>
    </Sheet>
  )
}

/** Inline panel shown when activeTab === 'logs'. */
export function CallLogsPanelTrigger() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ScrollText className="h-4 w-4 text-primary" />
          Qdrant 检索测试日志
        </CardTitle>
        <CardDescription className="text-xs">
          记录每次检索测试：什么时间、问了什么、哪个集合、召回/命中了哪些块、得到的结果。中文解释见每条详情。勾选 2 条可对比。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <CallLogsBody embedded />
      </CardContent>
    </Card>
  )
}

function CallLogsBody({ embedded = false }: { embedded?: boolean }) {
  const qc = useQueryClient()
  const active = useQdrantStore((s) => s.activeCollection)
  const [collection, setCollection] = useState<string>(active ?? '')
  const [q, setQ] = useState('')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showAllResults, setShowAllResults] = useState(false)
  const [compareMode, setCompareMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [showCompare, setShowCompare] = useState(false)
  const [cleanupOpen, setCleanupOpen] = useState(false)

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['call-logs', collection, q, pageSize, page],
    queryFn: () =>
      api.listCallLogs({ collection: collection || undefined, q: q || undefined, limit: pageSize, offset: page * pageSize }),
  })
  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min(total, page * pageSize + items.length)
  const hasNext = page + 1 < totalPages

  const goPrev = () => { if (page > 0) { setPage(page - 1); setActiveId(null); setShowAllResults(false); setSelected([]) } }
  const goNext = () => { if (hasNext) { setPage(page + 1); setActiveId(null); setShowAllResults(false); setSelected([]) } }

  const selectedItems = useMemo(
    () => selected.map(id => items.find(it => it.id === id)).filter(Boolean) as CallLogItem[],
    [selected, items]
  )

  const onDelete = async (id: string) => {
    try {
      await api.deleteCallLog(id)
      toast.success('已删除')
      qc.invalidateQueries({ queryKey: ['call-logs'] })
      setSelected(s => s.filter(x => x !== id))
    } catch (e: any) {
      toast.error('删除失败：' + (e?.message ?? String(e)))
    }
  }
  const afterCleanup = () => {
    setCleanupOpen(false)
    setSelected([])
    setActiveId(null)
    setPage(0)
    qc.invalidateQueries({ queryKey: ['call-logs'] })
  }

  const toggleSelect = (id: string) => {
    setSelected(cur => {
      if (cur.includes(id)) return cur.filter(x => x !== id)
      if (cur.length >= 2) {
        toast.info('最多对比 2 条，已替换最早的一条')
        return [cur[1], id]
      }
      return [...cur, id]
    })
  }

  const enterCompare = () => {
    if (selected.length !== 2) {
      toast.error('请勾选 2 条记录')
      return
    }
    setShowCompare(true)
  }

  if (isLoading) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-md" />)}
      </div>
    )
  }
  if (error) {
    return <p className="p-4 text-sm text-rose-500">{String((error as Error).message)}</p>
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-[11px] text-muted-foreground">
          共 {total} 条 · 第 {page + 1}/{totalPages} 页{compareMode && selected.length > 0 && ` · 已选 ${selected.length}/2`}
        </span>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1.5">
          <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(parseInt(v)); setPage(0); setActiveId(null); setSelected([]) }}>
            <SelectTrigger className="h-7 w-[86px] gap-1 text-[11px]" title="每页条数">
              <span>{pageSize} 条/页</span>
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 50, 100, 200].map((n) => (
                <SelectItem key={n} value={String(n)} className="text-xs">每页 {n} 条</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant={compareMode ? 'default' : 'ghost'}
            className="h-7 gap-1 text-[11px]"
            onClick={() => { setCompareMode(v => !v); setSelected([]) }}
            title="勾选模式：选 2 条后点对比"
          >
            <GitCompareArrows className="h-3 w-3" />
            对比
          </Button>
          {compareMode && selected.length === 2 && (
            <Button size="sm" variant="default" className="h-7 gap-1 text-[11px]" onClick={enterCompare}>
              <ArrowRight className="h-3 w-3" />
              查看差异
            </Button>
          )}
          <Input
            placeholder="查询关键词..."
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0) }}
            className="h-7 w-32 text-[11px]"
          />
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-[11px]" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-[11px] text-rose-500"
            onClick={() => setCleanupOpen(true)}
            title="管理 / 清理检索测试日志"
          >
            <SlidersHorizontal className="h-3 w-3" />
            清理
          </Button>
        </div>
      </div>

      <div className={`w-full min-w-0 ${embedded ? '' : 'max-h-[70vh] flex-1'} overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25`}>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
            <Inbox className="h-6 w-6 opacity-60" />
            <p className="text-xs">暂无检索测试日志</p>
            <p className="text-[11px]">在「检索召回」tab 完成一次检索后会自动记录</p>
          </div>
        ) : (
          <ul className="divide-y">
            {items.map((it) => {
              const isOpen = activeId === it.id
              const isSelected = selected.includes(it.id)
              return (
                <li key={it.id}>
                  <div className="flex items-stretch">
                    {compareMode && (
                      <button
                        type="button"
                        onClick={() => toggleSelect(it.id)}
                        className="flex w-8 items-center justify-center text-muted-foreground hover:bg-muted/40"
                        title={isSelected ? '取消选择' : '选择进行对比'}
                      >
                        {isSelected ? <CheckCircle2 className="h-4 w-4 text-primary" /> : <Circle className="h-4 w-4" />}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { if (compareMode) return; setActiveId(isOpen ? null : it.id); setShowAllResults(false) }}
                      className={`flex-1 px-3 py-2.5 text-left transition-colors ${compareMode ? 'cursor-default' : 'hover:bg-muted/40'} ${isSelected ? 'bg-primary/5' : ''}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px] font-mono">{it.mode}</Badge>
                        {it.reranked && <Badge variant="secondary" className="text-[10px]">reranked</Badge>}
                        <Badge variant="outline" className="text-[10px] font-mono">k={it.topK}</Badge>
                        <Badge variant="outline" className="text-[10px] font-mono">{it.tookMs}ms</Badge>
                        <Badge variant="outline" className="text-[10px] font-mono">→ {it.resultCount}条</Badge>
                        <Clock className="ml-auto h-3 w-3 text-muted-foreground" />
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(it.createdAt).toLocaleString('zh-CN', { hour12: false })}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 break-words text-xs">{it.query || '(recommend / 空)'}</p>
                      <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Server className="h-2.5 w-2.5" />
                        <span className="font-mono truncate">{it.collection}</span>
                        {!compareMode && <ChevronRight className="ml-auto h-3 w-3" />}
                      </div>
                    </button>
                  </div>
                  {!compareMode && isOpen && (
                    <div className="bg-muted/30 px-3 pb-3 pt-2 text-xs">
                      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">中文解释</p>
                      <p className="mb-2 rounded-md border bg-card p-2 text-[11px] leading-relaxed">
                        在 <span className="font-mono">{new Date(it.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>，
                        使用 <b className="font-mono">{it.mode}</b> 模式检索了集合 <span className="font-mono">{it.collection}</span>，
                        查询内容为「{it.query || '(recommend)'}」，
                        返回 <b>{it.resultCount}</b> 条结果，耗时 <b>{it.tookMs}ms</b>
                        {it.reranked ? '，并经过重排序' : ''}。
                      </p>

                      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">完整参数</p>
                      <div className="mb-2 grid grid-cols-2 gap-1.5">
                        <Field label="来源" value={it.source} />
                        <Field label="Top K" value={String(it.topK)} />
                        <Field label="阈值" value={String(it.scoreThreshold)} />
                        {it.params?.vector_name && <Field label="向量名" value={it.params.vector_name} mono />}
                        {it.params?.sparse_name && <Field label="稀疏名" value={it.params.sparse_name} mono />}
                        {it.params?.fusion && <Field label="融合" value={it.params.fusion} />}
                        {it.params?.embed_dim && <Field label="向量维度" value={`${it.params.embed_dim}d`} mono />}
                        {it.params?.embed_model && <Field label="Embed 模型" value={it.params.embed_model} mono />}
                        {it.params?.rerank_model && <Field label="Rerank" value={it.params.rerank_model} mono />}
                      </div>

                      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                        索引命中的块{it.results.length > 10 && showAllResults ? `（全部 ${it.results.length} 条）` : '（前 10 条）'}
                      </p>
                      <div className="space-y-1">
                        {(showAllResults ? it.results : it.results.slice(0, 10)).map((r, i) => (
                          <div key={i} className="rounded-md border bg-card p-2">
                            <div className="flex items-center gap-1.5">
                              <Badge variant="outline" className="text-[10px] font-mono">#{i + 1}</Badge>
                              <span className="font-mono text-[10px]">{r.score.toFixed(4)}</span>
                              {r.file && <Badge variant="secondary" className="truncate text-[10px]">{truncate(r.file, 28)}</Badge>}
                            </div>
                            <p className="mt-1 line-clamp-2 break-words text-[11px] leading-relaxed">{r.payload_summary}</p>
                          </div>
                        ))}
                        {it.results.length > 10 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1 text-[11px]"
                            onClick={() => setShowAllResults(v => !v)}
                          >
                            <ChevronDown className={`h-3 w-3 transition-transform ${showAllResults ? 'rotate-180' : ''}`} />
                            {showAllResults ? '收起' : `展开全部 ${it.results.length} 条`}
                          </Button>
                        )}
                      </div>

                      <div className="mt-2 flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 text-[11px]"
                          onClick={() => {
                            const blob = new Blob([JSON.stringify(it, null, 2)], { type: 'application/json' })
                            const url = URL.createObjectURL(blob)
                            const a = document.createElement('a')
                            a.href = url
                            a.download = `call-log_${it.id}.json`
                            a.click()
                            URL.revokeObjectURL(url)
                          }}
                        >
                          <FileJson className="h-3 w-3" />
                          导出 JSON
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 text-[11px] text-rose-500"
                          onClick={() => onDelete(it.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                          删除
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Pagination — 与「分块」一致的换页逻辑 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          {total === 0 ? '暂无记录' : `显示 ${from}–${to} / 共 ${total} 条`}
        </span>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={goPrev} disabled={page === 0}>
            <ChevronLeft className="h-3.5 w-3.5" />
            上一页
          </Button>
          <span className="px-1 text-muted-foreground">{page + 1} / {totalPages}</span>
          <Button size="sm" variant="outline" onClick={goNext} disabled={!hasNext}>
            下一页
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <AnimatePresence>
        {showCompare && selectedItems.length === 2 && (
          <CompareDialog items={selectedItems as [CallLogItem, CallLogItem]} onClose={() => setShowCompare(false)} />
        )}
      </AnimatePresence>

      {cleanupOpen && <CleanupDialog onClose={() => setCleanupOpen(false)} onDone={afterCleanup} />}
    </div>
  )
}

/** 清理检索测试日志：保留最近 N 条 / 删除 N 天以前 / 删除某天之前 / 全部清除。 */
function CleanupDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient()
  const [keepN, setKeepN] = useState('1000')
  const [days, setDays] = useState('30')
  const [beforeDate, setBeforeDate] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<any>, label: string) => {
    setBusy(true)
    try {
      const res = await fn()
      const deleted = typeof res?.deleted === 'number' ? `，删除 ${res.deleted} 条` : ''
      toast.success(`${label}完成${deleted}`)
      qc.invalidateQueries({ queryKey: ['call-logs'] })
      onDone()
    } catch (e: any) {
      toast.error(`${label}失败：${e?.message ?? String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md p-0">
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <SlidersHorizontal className="h-4 w-4 text-primary" />
            管理 / 清理检索测试日志
          </DialogTitle>
          <DialogDescription className="text-xs">
            清理操作不可恢复，请谨慎选择。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 py-4">
          {/* 保留最近 N 条 */}
          <div className="rounded-lg border p-3">
            <Label className="text-xs font-medium">保留最近 N 条（删除更早的）</Label>
            <div className="mt-2 flex gap-2">
              <Input type="number" min={0} value={keepN} onChange={(e) => setKeepN(e.target.value)} className="h-8 w-28 text-xs" />
              <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => run(() => api.cleanupCallLogs({ keep: parseInt(keepN) || 0 }), '已按条数清理')}>
                应用
              </Button>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">只保留最近 N 条记录，其余全部删除。</p>
          </div>

          {/* 删除 N 天以前 */}
          <div className="rounded-lg border p-3">
            <Label className="text-xs font-medium">删除 N 天以前的记录</Label>
            <div className="mt-2 flex gap-2">
              <Input type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} className="h-8 w-28 text-xs" />
              <span className="self-center text-xs text-muted-foreground">天前</span>
              <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => run(() => api.cleanupCallLogs({ olderThanDays: parseInt(days) || 0 }), '已按时间清理')}>
                应用
              </Button>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">删除创建时间早于截止日的所有记录。</p>
          </div>

          {/* 删除某天之前 */}
          <div className="rounded-lg border p-3">
            <Label className="text-xs font-medium">删除某日期之前产生的记录</Label>
            <div className="mt-2 flex gap-2">
              <Input type="date" value={beforeDate} onChange={(e) => setBeforeDate(e.target.value)} className="h-8 flex-1 text-xs" />
              <Button size="sm" variant="outline" className="h-8" disabled={busy || !beforeDate} onClick={() => { const d = new Date(beforeDate); d.setHours(23,59,59,999); run(() => api.cleanupCallLogs({ before: d.toISOString() }), '已按日期清理') }}>
                应用
              </Button>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">删除所选日期（含当天）之前产生的所有记录。</p>
          </div>

          {/* 全部清除 */}
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-rose-600 dark:text-rose-400">清空全部记录</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">删除数据库中的所有检索测试日志。</p>
              </div>
              <Button size="sm" variant="destructive" className="h-8" disabled={busy} onClick={() => { if (!confirm('确定清空全部检索测试日志？此操作不可恢复。')) return; run(() => api.clearCallLogs(), '已清空全部') }}>
                全部清除
              </Button>
            </div>
          </div>
        </div>

        <div className="flex justify-end border-t px-5 py-3">
          <Button size="sm" variant="outline" onClick={onClose}>关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`break-words text-xs ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  )
}

/** Side-by-side comparison of two call log entries. */
function CompareDialog({ items, onClose }: { items: [CallLogItem, CallLogItem]; onClose: () => void }) {
  const [a, b] = items
  const aIds = new Set(a.results.map(r => String(r.id)))
  const bIds = new Set(b.results.map(r => String(r.id)))
  const allIds = Array.from(new Set([...a.results.map(r => String(r.id)), ...b.results.map(r => String(r.id))]))
  const paramRows: { label: string; a: string; b: string; diff: boolean }[] = [
    { label: '集合', a: a.collection, b: b.collection, diff: a.collection !== b.collection },
    { label: '查询', a: a.query || '(空)', b: b.query || '(空)', diff: a.query !== b.query },
    { label: '模式', a: a.mode, b: b.mode, diff: a.mode !== b.mode },
    { label: 'Top K', a: String(a.topK), b: String(b.topK), diff: a.topK !== b.topK },
    { label: '阈值', a: String(a.scoreThreshold), b: String(b.scoreThreshold), diff: a.scoreThreshold !== b.scoreThreshold },
    { label: '向量维度', a: a.params?.embed_dim ? `${a.params.embed_dim}d` : '—', b: b.params?.embed_dim ? `${b.params.embed_dim}d` : '—', diff: a.params?.embed_dim !== b.params?.embed_dim },
    { label: 'Embed 模型', a: a.params?.embed_model ?? '—', b: b.params?.embed_model ?? '—', diff: (a.params?.embed_model ?? '') !== (b.params?.embed_model ?? '') },
    { label: 'Rerank', a: a.reranked ? '是' : '否', b: b.reranked ? '是' : '否', diff: a.reranked !== b.reranked },
  ]
  const overlap = allIds.filter(id => aIds.has(id) && bIds.has(id)).length
  const onlyA = allIds.filter(id => aIds.has(id) && !bIds.has(id)).length
  const onlyB = allIds.filter(id => !aIds.has(id) && bIds.has(id)).length
  const overlapPct = allIds.length === 0 ? 0 : Math.round((overlap / allIds.length) * 100)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <GitCompareArrows className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">检索测试日志对比</h3>
            <Badge variant="secondary" className="text-[10px]">重合度 {overlapPct}% ({overlap}/{allIds.length})</Badge>
          </div>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}><X className="h-3.5 w-3.5" /></Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
          <div className="p-5">
            <div className="mb-3 grid grid-cols-2 gap-3">
              {[a, b].map((item, idx) => (
                <div key={idx} className="rounded-lg border bg-muted/30 p-3">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px] font-mono">{idx === 0 ? 'A' : 'B'}</Badge>
                    <Badge variant="outline" className="text-[10px] font-mono">{item.mode}</Badge>
                    {item.reranked && <Badge variant="secondary" className="text-[10px]">reranked</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs">{item.query || '(recommend)'}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</p>
                </div>
              ))}
            </div>

            <div className="mb-4 grid grid-cols-3 gap-2">
              <MetricBox label="共同命中" value={overlap} accent="emerald" />
              <MetricBox label="仅 A 有" value={onlyA} accent="primary" />
              <MetricBox label="仅 B 有" value={onlyB} accent="amber" />
            </div>

            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">参数对比（差异行高亮）</p>
            <div className="mb-4 overflow-hidden rounded-lg border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">参数</th>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">A</th>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">B</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {paramRows.map(row => (
                    <tr key={row.label} className={row.diff ? 'bg-amber-500/10' : ''}>
                      <td className="px-2 py-1.5 font-medium">{row.label}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px]">{row.a}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px]">{row.b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">命中结果对比（⭐ 表示两边都命中）</p>
            <div className="grid grid-cols-2 gap-3">
              {[a, b].map((item, idx) => (
                <div key={idx}>
                  <p className="mb-2 text-[11px] font-medium text-muted-foreground">{idx === 0 ? 'A' : 'B'} · {item.results.length} 条</p>
                  <div className="space-y-1.5">
                    {item.results.length === 0 && <p className="text-[11px] text-muted-foreground">（无）</p>}
                    {item.results.slice(0, 15).map((r, i) => {
                      const inBoth = (idx === 0 ? bIds : aIds).has(String(r.id))
                      return (
                        <div key={i} className={`rounded-md border p-2 ${inBoth ? 'border-emerald-500/40 bg-emerald-500/5' : ''}`}>
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="text-[10px] font-mono">#{i + 1}</Badge>
                            <span className="font-mono text-[10px]">{r.score.toFixed(4)}</span>
                            {inBoth && <Badge variant="secondary" className="ml-auto gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">⭐ 共同</Badge>}
                          </div>
                          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed">{r.payload_summary}</p>
                          {r.file && <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={r.file}>📄 {truncate(r.file, 30)}</p>}
                        </div>
                      )
                    })}
                    {item.results.length > 15 && <p className="text-[10px] text-muted-foreground">… 还有 {item.results.length - 15} 条</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

function MetricBox({ label, value, accent }: { label: string; value: number; accent: 'emerald' | 'primary' | 'amber' }) {
  const colors = {
    emerald: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400',
    primary: 'border-primary/40 bg-primary/5 text-primary',
    amber: 'border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-400',
  }
  return (
    <div className={`rounded-lg border p-3 ${colors[accent]}`}>
      <p className="text-[10px] uppercase tracking-wider opacity-80">{label}</p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
    </div>
  )
}
