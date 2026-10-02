'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X, Hash, FileText, Copy, MapPin, Braces, Eye, EyeOff } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { api, payloadContent, payloadFileRef } from './api'
import { truncate } from './format'
import type { QdrantPoint } from './types'

interface Props {
  collection: string
  point: QdrantPoint
  onClose: () => void
}

export function PointDetailDialog({ collection, point, onClose }: Props) {
  // Re-fetch with vector included for full detail. We intentionally do NOT
  // pass `initialData` so the dialog always starts with `data === undefined`
  // and react-query actually fires the request. Otherwise the cached
  // initialData (which has no vector) shadows the real fetch.
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['point', collection, String(point.id), 'with_vector'],
    queryFn: () => api.getPoint(collection, String(point.id), true),
    enabled: !!collection && !!point,
    staleTime: 0,
  })

  const fullPoint = data?.point ?? point
  const content = payloadContent(fullPoint.payload)
  const fileRef = payloadFileRef(fullPoint.payload)
  const vectorInfo = summarizeVector(fullPoint.vector)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] min-w-[640px] max-w-3xl flex-col overflow-hidden p-0">
        {/* Header — fixed at top */}
        <DialogHeader className="shrink-0 border-b px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-primary" />
            分块详情
            <Badge variant="outline" className="font-mono text-[11px]" title={String(point.id)}>
              <Hash className="mr-1 h-2.5 w-2.5" />
              {truncate(String(point.id), 24)}
            </Badge>
            {isFetching && <span className="text-[10px] text-muted-foreground">（加载中…）</span>}
          </DialogTitle>
          <DialogDescription className="text-xs">
            集合 <span className="font-mono">{collection}</span> · 完整 payload 与向量预览
          </DialogDescription>
        </DialogHeader>

        {/* File ref banner */}
        {fileRef && (
          <div className="flex shrink-0 items-center gap-2 border-b bg-muted/20 px-5 py-2">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="shrink-0 text-xs text-muted-foreground">源文件：</span>
            <span className="truncate font-mono text-xs" title={fileRef.value}>
              {fileRef.value}
            </span>
            <Badge variant="secondary" className="ml-auto shrink-0 text-[10px]">{fileRef.label}</Badge>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0"
              onClick={() => {
                navigator.clipboard?.writeText(fileRef.value).then(
                  () => toast.success('已复制'),
                  () => toast.error('复制失败')
                )
              }}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        )}

        {/* Tabs — fills remaining space */}
        <Tabs defaultValue="payload" className="flex min-h-0 flex-1 flex-col px-5 pt-3">
          <TabsList className="h-8 shrink-0">
            <TabsTrigger value="payload" className="text-xs">Payload</TabsTrigger>
            <TabsTrigger value="content" className="text-xs">文本内容</TabsTrigger>
            <TabsTrigger value="vector" className="text-xs">向量 ({vectorInfo.dimLabel})</TabsTrigger>
          </TabsList>

          {/* Each TabsContent is its own scroll region, sized to fill remaining height */}
          <TabsContent value="payload" className="mt-3 min-h-0 flex-1 data-[state=inactive]:hidden">
            <ScrollArea className="h-[min(52vh,42rem)] min-h-[280px] rounded-md border bg-muted/20 p-3">
              {isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : (
                <pre className="text-[11px] leading-relaxed font-mono">
{JSON.stringify(fullPoint.payload ?? {}, null, 2)}
                </pre>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="content" className="mt-3 min-h-0 flex-1 data-[state=inactive]:hidden">
            <ScrollArea className="h-[min(52vh,42rem)] min-h-[280px] rounded-md border bg-muted/20 p-3">
              {isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {content || '(此分块的 payload 中没有找到 content/text/_node_content.text 字段)'}
                </p>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="vector" className="mt-3 min-h-0 flex-1 data-[state=inactive]:hidden">
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Braces className="h-3.5 w-3.5" />
              <span>{vectorInfo.label}</span>
            </div>
            <ScrollArea className="h-[calc(min(52vh,42rem)-2rem)] min-h-[260px] rounded-md border bg-muted/20 p-3">
              {isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : vectorInfo.sections.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
                  <Braces className="h-6 w-6 opacity-50" />
                  <p className="text-xs">未返回向量数据</p>
                  <p className="text-[11px]">可能因为 Qdrant 配置了 on_disk_payload 或向量未在响应中</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {vectorInfo.sections.map((s, i) => (
                    <div key={i}>
                      <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {s.name} · {s.count} 项
                      </p>
                      <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed font-mono">
                        {s.preview}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>

        {/* Footer — fixed at bottom */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-5 py-3">
          <span className="text-[10px] text-muted-foreground">
            payload 长度: {JSON.stringify(fullPoint.payload ?? {}).length} 字符 · 向量维度: {vectorInfo.dimLabel}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onClose}>
              <X className="h-3.5 w-3.5 mr-1" />
              关闭
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard?.writeText(JSON.stringify(fullPoint.payload ?? {}, null, 2)).then(
                  () => toast.success('已复制 payload JSON'),
                  () => toast.error('复制失败')
                )
              }}
            >
              <Copy className="h-3.5 w-3.5 mr-1" />
              复制 Payload
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface VectorSummary {
  label: string
  dimLabel: string
  sections: { name: string; preview: string; count: number }[]
}

function summarizeVector(vector: any): VectorSummary {
  if (!vector) {
    return { label: '无向量数据', dimLabel: '0d', sections: [] }
  }
  if (Array.isArray(vector)) {
    const dim = vector.length
    return {
      label: `单向量 · ${dim}d`,
      dimLabel: `${dim}d`,
      sections: [{ name: 'vector', preview: previewArr(vector), count: dim }],
    }
  }
  if (typeof vector === 'object') {
    const sections: { name: string; preview: string; count: number }[] = []
    let totalDim = 0
    for (const [k, v] of Object.entries(vector)) {
      if (Array.isArray(v)) {
        sections.push({ name: k, preview: previewArr(v), count: v.length })
        totalDim += v.length
      } else if (v && typeof v === 'object' && 'indices' in (v as any)) {
        const sp = v as { indices: number[]; values: number[] }
        sections.push({
          name: `${k} (sparse)`,
          preview: `indices: ${previewArr(sp.indices, true)}\nvalues:  ${previewArr(sp.values, true)}`,
          count: sp.indices.length,
        })
        totalDim += sp.indices.length
      }
    }
    return {
      label: `多向量 · ${sections.length} 个字段`,
      dimLabel: `${totalDim}d`,
      sections,
    }
  }
  return { label: '未知向量类型', dimLabel: '?', sections: [] }
}

function previewArr(arr: any[], sparse = false): string {
  const max = sparse ? 20 : 12
  const head = arr.slice(0, max).map((x) => (typeof x === 'number' ? x.toFixed(4) : String(x))).join(', ')
  return arr.length > max ? `[${head}, ... (${arr.length} total)]` : `[${head}]`
}
