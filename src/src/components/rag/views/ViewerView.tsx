'use client'

// 三屏联动（对标 RAGFlow，M6 核心）
// 左屏 PdfViewer（bbox 高亮）/ 中屏 MarkdownPane（charRange 高亮）/ 右屏 ChunkList
// 联动：选中 chunk → 左屏跳页 + bbox 高亮 + 中屏滚动高亮；点击左/中屏块 → 反查 chunk 选中

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpenCheck, FileText, Layers, Link2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ragApi } from '../api'
import { usePlatformStore, useViewerStore } from '../store'
import { useRealtime } from '../useRealtime'
import type { ChunkItem, LayoutBlock } from '../types'
import { ErrorCard, PROCESSING_STATUSES, StatusBadge, shortCode } from '../ui'
import { ChunkList, PAGE_SIZE } from './viewer/ChunkList'
import { MarkdownPane } from './viewer/MarkdownPane'
import { PdfViewer } from './viewer/PdfViewer'

export function ViewerView() {
  const queryClient = useQueryClient()
  const activeKbId = usePlatformStore((s) => s.activeKbId)
  const setKb = usePlatformStore((s) => s.setKb)
  const viewerDocId = useViewerStore((s) => s.docId)
  const selectedChunkId = useViewerStore((s) => s.selectedChunkId)
  const selectChunkId = useViewerStore((s) => s.selectChunk)
  const [remoteChunk, setRemoteChunk] = useState<ChunkItem | null>(null)
  const [page, setPage] = useState(0)
  const [q, setQ] = useState('')
  const { subscribeRooms, on } = useRealtime()

  // KB 列表
  const kbsQuery = useQuery({ queryKey: ['kbs'], queryFn: () => ragApi.listKbs() })
  const kbs = kbsQuery.data?.kbs ?? []
  const activeKb = kbs.find((k) => k.id === activeKbId) ?? null

  // 文档列表（用于两级选择器；默认取 activeKb）
  const docsQuery = useQuery({
    queryKey: ['docs', activeKbId, 'viewer-select'],
    queryFn: () => ragApi.listDocs(activeKbId!, { limit: 300 }),
    enabled: !!activeKbId,
  })
  const docs = docsQuery.data?.docs ?? []

  // KB 未指定时默认选第一个（与文档中心行为一致）
  useEffect(() => {
    if (!activeKbId && kbs.length > 0) setKb(kbs[0].id)
  }, [activeKbId, kbs, setKb])

  // 当前文档：viewerStore.docId 优先（跨视图跳转），否则该 KB 第一个文档
  const docId = useMemo(() => {
    if (viewerDocId) return viewerDocId
    return docs[0]?.id ?? null
  }, [viewerDocId, docs])

  const docQuery = useQuery({
    queryKey: ['doc', docId],
    queryFn: () => ragApi.getDoc(docId!),
    enabled: !!docId,
  })
  const doc = docQuery.data?.doc ?? null

  const layoutQuery = useQuery({
    queryKey: ['layout', docId],
    queryFn: () => ragApi.getLayout(docId!),
    enabled: !!docId,
    staleTime: 5 * 60_000,
  })
  const layout = layoutQuery.data?.layout ?? []
  const pageSizes = layoutQuery.data?.pageSizes ?? []

  const chunksQuery = useQuery({
    queryKey: ['chunks', docId, { offset: page * PAGE_SIZE, q, pageSize: PAGE_SIZE }],
    queryFn: () => ragApi.listChunks(docId!, { limit: PAGE_SIZE, offset: page * PAGE_SIZE, q: q.trim() || undefined }),
    enabled: !!docId,
  })
  const parentsQuery = useQuery({
    queryKey: ['chunks', docId, 'parents'],
    queryFn: () => ragApi.listChunks(docId!, { parentOnly: true, limit: 500 }),
    enabled: !!docId,
  })
  const chunks = chunksQuery.data?.chunks ?? []
  const parents = parentsQuery.data?.chunks ?? []

  // 当前文档若属于其它 KB，同步 activeKbId
  useEffect(() => {
    if (doc?.kbId && doc.kbId !== activeKbId) setKb(doc.kbId)
  }, [doc?.kbId, activeKbId, setKb])

  // 选中 chunk 对象：优先本地数据派生；不在已加载列表（跨视图跳转）时异步拉详情
  const selectedChunk = useMemo(() => {
    if (!selectedChunkId) return null
    const local = chunks.find((c) => c.id === selectedChunkId) ?? parents.find((c) => c.id === selectedChunkId)
    if (local) return local
    if (remoteChunk?.id === selectedChunkId) return remoteChunk
    return null
  }, [selectedChunkId, chunks, parents, remoteChunk])

  useEffect(() => {
    if (!selectedChunkId || !docId) return
    if (selectedChunk) return
    let cancelled = false
    ragApi
      .getChunk(docId, selectedChunkId)
      .then((r) => {
        if (!cancelled) setRemoteChunk((prev) => (prev?.id === r.chunk.id ? prev : r.chunk))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [selectedChunkId, docId, selectedChunk])

  // 父 chunk 范围（中屏虚线描边）
  const parentRange = useMemo(() => {
    if (!selectedChunk?.parentId) return null
    const p = parents.find((x) => x.id === selectedChunk.parentId)
    if (!p) return null
    return { charStart: p.charStart, charEnd: p.charEnd }
  }, [selectedChunk, parents])

  // 同步到 store（供其它视图读取）
  useEffect(() => {
    if (parentRange !== useViewerStore.getState().selectedParentRange) {
      useViewerStore.getState().setParentRange(parentRange)
    }
  }, [parentRange])

  // 与选中 chunk 相交的布局块 idx（左屏热区联动高亮）
  const highlightBlockIdx = useMemo(() => {
    const set = new Set<number>()
    if (!selectedChunk) return set
    for (const b of layout) {
      if (b.charStart < selectedChunk.charEnd && b.charEnd > selectedChunk.charStart) set.add(b.idx)
    }
    return set
  }, [selectedChunk, layout])

  // 左/中屏点击块 → 反查覆盖该块中心的 chunk
  const onBlockClick = (b: LayoutBlock) => {
    const center = (b.charStart + b.charEnd) / 2
    let best: ChunkItem | null = null
    for (const c of chunks) {
      if (center >= c.charStart && center <= c.charEnd) {
        if (!best || c.charEnd - c.charStart < best.charEnd - best.charStart) best = c
      }
    }
    if (best) selectChunkId(best.id)
  }

  // socket：doc 房间（进度 + 完成 + chunk 编辑/还原）
  useEffect(() => {
    if (!docId) return
    subscribeRooms([`doc:${docId}`])
    const onStatus = (e: { docId: string }) => {
      if (e.docId !== docId) return
      queryClient.invalidateQueries({ queryKey: ['doc', docId] })
      queryClient.invalidateQueries({ queryKey: ['chunks', docId] })
      queryClient.invalidateQueries({ queryKey: ['layout', docId] })
    }
    // chunk 编辑/还原（含其他客户端发起的操作）→ 刷新 chunk 列表
    const un3 = on('chunk:update', (e: { docId: string }) => {
      if (e.docId !== docId) return
      queryClient.invalidateQueries({ queryKey: ['chunks', docId] })
    })
    const un1 = on('document:status', onStatus)
    const un2 = on('document:done', onStatus)
    return () => {
      un1()
      un2()
      un3()
    }
  }, [docId, subscribeRooms, on, queryClient])

  const isPdf = !!doc?.mimeType?.includes('pdf') || /\.pdf$/i.test(doc?.filename ?? '')
  const processing = doc ? PROCESSING_STATUSES.includes(doc.status) : false

  // --- 加载与空态 ----------------------------------------------------------
  if (kbsQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
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
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <BookOpenCheck className="h-8 w-8 opacity-60" />
        <p className="text-sm font-medium text-foreground">三屏联动需要先选择文档</p>
        <p className="max-w-sm text-xs leading-relaxed">请先在「知识库」创建库并上传文档；解析完成后即可在此查看 PDF 原文 / Markdown / chunk 三屏联动。</p>
      </div>
    )
  }

  const header = (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-background px-3 py-2">
      <BookOpenCheck className="h-4 w-4 shrink-0 text-primary" />
      <Select
        value={activeKbId ?? ""}
        onValueChange={(v) => {
          setKb(v)
          selectChunkId(null)
          useViewerStore.getState().setDocId(null)
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
          useViewerStore.getState().setDocId(v)
          setPage(0)
          setQ('')
        }}
      >
        <SelectTrigger className="h-8 min-w-40 max-w-64 flex-1 text-xs">
          <SelectValue placeholder="选择文档" />
        </SelectTrigger>
        <SelectContent>
          {docs.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">该知识库暂无文档</div>
          ) : (
            docs.map((d) => (
              <SelectItem key={d.id} value={d.id} className="text-xs">
                {d.filename}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {doc && (
        <>
          <StatusBadge status={doc.status} />
          {processing && <Progress value={doc.stageProgress ?? 0} className="h-1 w-28" />}
          <Badge variant="secondary" className="hidden text-[10px] font-mono sm:inline-flex">
            {shortCode(doc.id)}
          </Badge>
          <span className="ml-auto hidden items-center gap-1 text-[10px] text-muted-foreground lg:flex">
            <Link2 className="h-3 w-3" />
            点击右屏 chunk / 左屏块 / 中屏段落 三方联动
          </span>
        </>
      )}
    </div>
  )

  if (!docId) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
          <FileText className="h-8 w-8 opacity-60" />
          <p className="text-sm font-medium text-foreground">该知识库还没有文档</p>
          <p className="text-xs">请先到「文档中心」上传文件。</p>
        </div>
      </div>
    )
  }

  const threePanes = (
    <>
      {/* 左屏：原文渲染 */}
      <ResizablePanel defaultSize={40} minSize={22}>
        <div className="h-full min-h-[280px]">
          {docQuery.isLoading || layoutQuery.isLoading ? (
            <div className="h-full space-y-3 overflow-hidden p-4">
              <Skeleton className="mx-auto h-[500px] w-full max-w-[520px]" />
            </div>
          ) : (
            <PdfViewer
              docId={docId}
              isPdf={isPdf}
              layout={layout}
              pageSizes={pageSizes}
              pageCount={layoutQuery.data?.pageCount ?? 0}
              selectedChunk={selectedChunk}
              highlightBlockIdx={highlightBlockIdx}
              onBlockClick={onBlockClick}
            />
          )}
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      {/* 中屏：Markdown */}
      <ResizablePanel defaultSize={35} minSize={20}>
        <div className="h-full min-h-[280px] border-x border-border/60">
          <MarkdownPane
            docId={docId}
            layout={layout}
            selectedChunk={selectedChunk}
            parentRange={parentRange}
            onBlockClick={onBlockClick}
          />
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      {/* 右屏：chunk 列表 */}
      <ResizablePanel defaultSize={25} minSize={16}>
        <div className="h-full min-h-[280px]">
          <ChunkList
            docId={docId}
            chunks={chunks}
            parents={parents}
            total={chunksQuery.data?.total ?? 0}
            page={page}
            setPage={setPage}
            q={q}
            setQ={setQ}
            loading={chunksQuery.isLoading}
            selectedChunkId={selectedChunkId}
            onSelect={(c) => selectChunkId(c.id)}
          />
        </div>
      </ResizablePanel>
    </>
  )

  return (
    <div className="flex h-full flex-col">
      {header}
      {docQuery.error ? (
        <div className="p-4">
          <ErrorCard
            title="文档详情加载失败"
            message={docQuery.error instanceof Error ? docQuery.error.message : String(docQuery.error)}
            onRetry={() => docQuery.refetch()}
          />
        </div>
      ) : (
        <>
          {/* 桌面：三栏可调布局 */}
          <ResizablePanelGroup direction="horizontal" className="hidden min-h-0 flex-1 lg:flex">
            {threePanes}
          </ResizablePanelGroup>

          {/* 窄屏：Tabs 切换 */}
          <Tabs defaultValue="pdf" className="flex min-h-0 flex-1 flex-col lg:hidden">
            <TabsList className="mx-auto mt-2 grid h-8 w-full max-w-sm grid-cols-3">
              <TabsTrigger value="pdf" className="text-xs">原文</TabsTrigger>
              <TabsTrigger value="md" className="text-xs">Markdown</TabsTrigger>
              <TabsTrigger value="chunks" className="text-xs">Chunks</TabsTrigger>
            </TabsList>
            <TabsContent value="pdf" className="min-h-0 flex-1 data-[state=active]:flex">
              <div className="h-full min-h-[280px] w-full">
                {docQuery.isLoading || layoutQuery.isLoading ? (
                  <div className="h-full p-4">
                    <Skeleton className="mx-auto h-[480px] w-full max-w-[420px]" />
                  </div>
                ) : (
                  <PdfViewer
                    docId={docId}
                    isPdf={isPdf}
                    layout={layout}
                    pageSizes={pageSizes}
                    pageCount={layoutQuery.data?.pageCount ?? 0}
                    selectedChunk={selectedChunk}
                    highlightBlockIdx={highlightBlockIdx}
                    onBlockClick={onBlockClick}
                  />
                )}
              </div>
            </TabsContent>
            <TabsContent value="md" className="min-h-0 flex-1 data-[state=active]:flex">
              <div className="h-full min-h-[280px] w-full border-x border-border/60">
                <MarkdownPane docId={docId} layout={layout} selectedChunk={selectedChunk} parentRange={parentRange} onBlockClick={onBlockClick} />
              </div>
            </TabsContent>
            <TabsContent value="chunks" className="min-h-0 flex-1 data-[state=active]:flex">
              <div className="h-full min-h-[280px] w-full">
                <ChunkList
                  docId={docId}
                  chunks={chunks}
                  parents={parents}
                  total={chunksQuery.data?.total ?? 0}
                  page={page}
                  setPage={setPage}
                  q={q}
                  setQ={setQ}
                  loading={chunksQuery.isLoading}
                  selectedChunkId={selectedChunkId}
                  onSelect={(c) => selectChunkId(c.id)}
                />
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}
      {/* 底部信息条 */}
      <div className="flex shrink-0 items-center gap-3 border-t border-border/60 bg-background px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Layers className="h-3 w-3" />
          {layout.length} 布局块 · {pageSizes.length} 页
        </span>
        {selectedChunk && (
          <span className="font-mono">
            选中 #{selectedChunk.seq} · char {selectedChunk.charStart}-{selectedChunk.charEnd} · {selectedChunk.tokenCount} tok
          </span>
        )}
        {parentRange && <span className="font-mono">父范围 char {parentRange.charStart}-{parentRange.charEnd}</span>}
      </div>
    </div>
  )
}
