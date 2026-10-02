'use client'

import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, Search, ChevronRight, ChevronLeft, Inbox, MapPin, Copy, Eye, X } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import { api, payloadContent, payloadFileRef } from './api'
import { useQdrantStore } from './store'
import { truncate, shortId } from './format'
import { PointDetailDialog } from './PointDetailDialog'
import type { QdrantPoint } from './types'

const PAGE_SIZE = 20

export function PointsBrowser() {
  const name = useQdrantStore((s) => s.activeCollection)!
  const [offset, setOffset] = useState<string | number | null>(null)
  const [pages, setPages] = useState<(string | number | null)[]>([null])
  const [pageIndex, setPageIndex] = useState(0)
  const [search, setSearch] = useState('')
  const [withVector, setWithVector] = useState(false)
  const [activePoint, setActivePoint] = useState<QdrantPoint | null>(null)

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['scroll', name, offset, search, withVector],
    queryFn: () =>
      api.scrollPoints(name, {
        limit: PAGE_SIZE,
        offset,
        with_payload: true,
        with_vector: withVector,
        filter: search ? buildTextFilter(search) : null,
      }),
    enabled: !!name,
  })
  // Pagination state resets via the `key={activeCollection}` prop on this
  // component in AppShell — we deliberately do not call setState in effect.

  const goNext = () => {
    if (!data?.next_page_offset) return
    const next = data.next_page_offset
    setOffset(next)
    setPages((p) => [...p, next])
    setPageIndex((i) => i + 1)
  }
  const goPrev = () => {
    if (pageIndex === 0) return
    const newIndex = pageIndex - 1
    setPageIndex(newIndex)
    setOffset(pages[newIndex])
  }

  const onOpenPoint = useCallback((p: QdrantPoint) => {
    setActivePoint(p)
  }, [])

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-rose-500">
          加载分块失败：{String((error as Error).message)}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3">
        <div className="flex-1 min-w-[200px]">
          <Label htmlFor="pb-search" className="text-[11px] text-muted-foreground">在 payload 上关键字过滤（精确匹配；可用 field:value 指定字段）</Label>
          <div className="relative mt-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="pb-search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setOffset(null); setPages([null]); setPageIndex(0)
              }}
              placeholder="例如：file:report.pdf 或 精确字段值"
              className="h-9 pl-7"
            />
            {search && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => { setSearch(''); setOffset(null); setPages([null]); setPageIndex(0) }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="pb-vec" checked={withVector} onCheckedChange={setWithVector} />
          <Label htmlFor="pb-vec" className="text-xs">显示向量</Label>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? '加载中…' : '刷新当前页'}
        </Button>
      </div>

      {/* List */}
      <div className="space-y-2">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)
        ) : (data?.points?.length ?? 0) === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/20 py-12 text-center">
            <Inbox className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              没有匹配的分块{search ? `：${search}` : ''}。
            </p>
            <p className="text-xs text-muted-foreground">
              此集合可能为空，或你的过滤条件太严格。
            </p>
          </div>
        ) : (
          (data?.points ?? []).map((p) => (
            <PointRow key={String(p.id)} point={p} withVector={withVector} onOpen={() => onOpenPoint(p)} />
          ))
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between rounded-xl border bg-card px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          第 {pageIndex + 1} 页 · 本页 {data?.points?.length ?? 0} 条
        </span>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={goPrev} disabled={pageIndex === 0}>
            <ChevronLeft className="h-3.5 w-3.5" />
            上一页
          </Button>
          <Button size="sm" variant="outline" onClick={goNext} disabled={!data?.next_page_offset}>
            下一页
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Detail dialog */}
      {activePoint && (
        <PointDetailDialog
          collection={name}
          point={activePoint}
          onClose={() => { setActivePoint(null) }}
        />
      )}
    </div>
  )
}

function PointRow({ point, withVector, onOpen }: { point: QdrantPoint; withVector: boolean; onOpen: () => void }) {
  const content = payloadContent(point.payload)
  const fileRef = payloadFileRef(point.payload)
  return (
    <Card className="overflow-hidden transition-colors hover:border-primary/40 hover:bg-muted/20">
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileText className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="font-mono text-[10px]" title={String(point.id)}>
                {shortId(point.id)}
              </Badge>
              {fileRef && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <MapPin className="h-2.5 w-2.5" />
                        {truncate(fileRef.value, 32)}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-md">
                      <p className="font-mono text-[11px]">{fileRef.label}: {fileRef.value}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {Object.keys(point.payload ?? {}).filter((k) => !['content', 'text', 'page_content', 'chunk', 'segment', 'document', 'doc_text'].includes(k)).slice(0, 5).map((k) => (
                <Badge key={k} variant="outline" className="text-[10px] font-mono">
                  {k}
                </Badge>
              ))}
            </div>
            <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-foreground/90">
              {content || '(无文本内容)'}
            </p>
            {withVector && point.vector != null && (
              <div className="mt-2 rounded-md border bg-muted/20 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
                <span className="mr-1 font-semibold text-foreground/70">向量:</span>
                {summarizeVectorFlat(point.vector)}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={onOpen}>
              <Eye className="h-3 w-3" />
              查看
            </Button>
            {fileRef && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-[11px] text-muted-foreground"
                onClick={() => {
                  navigator.clipboard?.writeText(fileRef.value).then(
                    () => toast.success('已复制文件路径'),
                    () => toast.error('复制失败')
                  )
                }}
              >
                <Copy className="h-3 w-3" />
                复制路径
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/** Compact one-line vector preview for list rows. */
function summarizeVectorFlat(vector: any): string {
  const show = (arr: any[]) => {
    const head = arr.slice(0, 6).map((x) => (typeof x === 'number' ? x.toFixed(4) : String(x))).join(', ')
    return `[${head}${arr.length > 6 ? `, … (${arr.length} 维)` : ''}]`
  }
  if (Array.isArray(vector)) return show(vector)
  if (vector && typeof vector === 'object') {
    const parts: string[] = []
    for (const [k, v] of Object.entries(vector as any)) {
      if (Array.isArray(v)) parts.push(`${k}: ${show(v)}`)
      else if (v && typeof v === 'object' && 'indices' in (v as any))
        parts.push(`${k}(sparse): ${((v as any).indices as any[]).length} 项`)
    }
    return parts.join('  ') || '（空）'
  }
  return '（无）'
}

/** Build a Qdrant filter that OR-matches the search string in common text fields. */
function buildTextFilter(search: string): any {
  // Allow `field:value` syntax to filter on a specific field.
  const m = search.match(/^([a-zA-Z0-9_.]+):\s*(.*)$/)
  if (m) {
    const field = m[1]
    const value = m[2]
    return { should: [{ key: field, match: { value } }] }
  }
  const fields = ['content', 'text', 'page_content', 'chunk', 'source', 'file', 'doc_name', 'name']
  // 默认 should 语义即“至少一条匹配”(OR)；在 Qdrant v1.19 中 min_should 需用对象形式，
  // 直接省略即可避免格式错误。
  return {
    should: fields.map((f) => ({ key: f, match: { value: search } })),
  }
}
