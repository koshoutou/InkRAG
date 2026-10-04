'use client'

// 三屏联动 · 左屏：统一文档渲染器
// - PDF：pdfjs-dist 渲染 canvas（worker 走 CDN）
// - md/txt/html：middle.json 合成分页布局（白底类 PDF 页面，每页按 layout blocks 绝对定位）
// 两类页面共用同一 bbox 高亮层（计划书 §13.3 bboxToViewport 唯一转换点）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  FileWarning,
  Image as ImageIcon,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ragApi } from '../../api'
import { DOC_TYPE_META } from '../../ui'
import type { ChunkItem, LayoutBlock } from '../../types'

const BASE_WIDTH = 700 // 页面基准宽度（CSS px），A4 下高约 990
const PDFJS_CDN = 'https://unpkg.com/pdfjs-dist@4.10.38'
const WORKER_SRC = `${PDFJS_CDN}/build/pdf.worker.min.mjs`
// 中文 PDF 常见问题：cMap 缺失 → CJK 字符渲染为空白；standard_fonts 缺失 → 标准字体降级告警
const CMAP_URL = `${PDFJS_CDN}/cmaps/`
const STANDARD_FONTS_URL = `${PDFJS_CDN}/standard_fonts/`

// ---------------------------------------------------------------------------
// bbox → 视口（计划书 §13.3，唯一转换点；PDF 点空间原点左下 → 页面左上原点）
// ---------------------------------------------------------------------------

export function bboxToViewport(
  bbox: [number, number, number, number],
  viewport: { width: number; height: number; scale: number },
  pageHeightPt: number,
): { top: number; left: number; width: number; height: number } {
  const s = viewport.scale
  const [x0, y0, x1, y1] = bbox
  return {
    top: (pageHeightPt - y1) * s,
    left: x0 * s,
    width: (x1 - x0) * s,
    height: (y1 - y0) * s,
  }
}

// 轻量 pdfjs 类型（避免与库类型耦合）
type PdfPageProxy = {
  getViewport: (opts: { scale: number }) => { width: number; height: number; viewBox: number[] }
  render: (opts: Record<string, unknown>) => { promise: Promise<void>; cancel: () => void }
}
type PdfDocumentProxy = {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfPageProxy>
}

let workerConfigured = false

// ---------------------------------------------------------------------------
// 页面 overlay：布局块热区 + 选中 chunk 高亮框（两模式共用）
// ---------------------------------------------------------------------------

interface OverlayProps {
  pageNumber: number
  scale: number
  wPt: number
  hPt: number
  blocks: LayoutBlock[]
  highlightBlockIdx: Set<number>
  selectedChunk: ChunkItem | null
  onBlockClick?: (b: LayoutBlock) => void
}

function PageOverlay({ pageNumber, scale, wPt, hPt, blocks, highlightBlockIdx, selectedChunk, onBlockClick }: OverlayProps) {
  const viewport = { width: wPt * scale, height: hPt * scale, scale }
  const pageBlocks = blocks.filter((b) => b.page === pageNumber)

  // 选中 chunk 高亮：pageFrom 页用 bboxFrom，pageTo 页（跨页时）用 bboxTo
  let selectedBox: { top: number; left: number; width: number; height: number } | null = null
  if (selectedChunk && pageNumber >= selectedChunk.pageFrom && pageNumber <= selectedChunk.pageTo) {
    const raw = pageNumber === selectedChunk.pageFrom ? selectedChunk.bboxFrom : selectedChunk.bboxTo
    if (raw && raw.length >= 4) {
      selectedBox = bboxToViewport([raw[0], raw[1], raw[2], raw[3]], viewport, hPt)
    }
  }
  const typeMeta = selectedChunk ? DOC_TYPE_META[selectedChunk.docType] ?? DOC_TYPE_META.text : DOC_TYPE_META.text
  const labelBg: Record<string, string> = { text: 'bg-emerald-600', table: 'bg-amber-600', code: 'bg-violet-600', image: 'bg-rose-600' }

  return (
    <>
      {pageBlocks.map((b) => {
        const pos = bboxToViewport(b.bbox, viewport, hPt)
        const hit = highlightBlockIdx.has(b.idx)
        return (
          <button
            key={b.idx}
            type="button"
            aria-label={`布局块 ${b.idx}：${b.type}`}
            onClick={(e) => {
              e.stopPropagation()
              onBlockClick?.(b)
            }}
            className={cn(
              'absolute cursor-pointer rounded-[2px] border transition-colors',
              hit
                ? cn(DOC_TYPE_META[(b.type === 'title' ? 'text' : b.type) as keyof typeof DOC_TYPE_META]?.overlay ?? 'border-emerald-500/60 bg-emerald-500/15', 'z-[2]')
                : 'border-transparent hover:border-primary/70 hover:bg-primary/10',
            )}
            style={{ top: pos.top, left: pos.left, width: Math.max(pos.width, 4), height: Math.max(pos.height, 4) }}
            title={`${b.type} · 块 ${b.idx}${hit ? ' · 属于选中 chunk' : ''}`}
          />
        )
      })}
      {selectedBox && (
        <div
          className={cn('pointer-events-none absolute z-[3] rounded-[3px] ring-2', typeMeta.overlay, typeMeta.ring)}
          style={{ top: selectedBox.top, left: selectedBox.left, width: Math.max(selectedBox.width, 6), height: Math.max(selectedBox.height, 6) }}
        >
          <span className={cn('absolute -top-5 left-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none text-white', labelBg[selectedChunk?.docType ?? 'text'])}>
            chunk #{selectedChunk?.seq} · P{selectedChunk?.pageFrom}
            {selectedChunk && selectedChunk.pageTo > selectedChunk.pageFrom ? `-${selectedChunk.pageTo}` : ''}
          </span>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// 单页容器 —— FE-002 后由 LazyPdfPage 统一承载 data-page + 尺寸，旧 PageFrame 已移除
// ---------------------------------------------------------------------------

/**
 * 懒加载页（FE-002）：用 IntersectionObserver 只挂载视口附近页面，避免长文档一次性渲染崩溃。
 *
 * - 占位骨架屏：始终保留与真实页面等宽等高的占位 div（带 data-page），保证滚动条高度、
 *   onScroll 页码探测、scrollToPage 跳转在页面未挂载时仍精确（无布局抖动）。
 * - 可见判定：IntersectionObserver rootMargin='400px 0px' 提前预挂载，滚动到时已渲染好。
 * - 卸载回收：离开预挂载区超过一屏则卸载真实内容（canvas/文本块释放），仅留占位；
 *   重新进入视口时再次挂载（pdfjs render 可重入，无副作用）。
 */
function LazyPdfPage({
  pageNumber,
  widthPx,
  heightPx,
  visible,
  onVisibleChange,
  children,
}: {
  pageNumber: number
  widthPx: number
  heightPx: number
  visible: boolean
  onVisibleChange: (pageNumber: number, visible: boolean) => void
  children: (visible: boolean) => React.ReactNode
}) {
  const placeholderRef = useRef<HTMLDivElement>(null)
  const ioRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    const el = placeholderRef.current
    const root = el?.closest<HTMLElement>('.pdf-viewer-scroll-root') ?? null
    if (!el) return
    // 提前 400px 预挂载，避免快速滚动时出现空白闪屏
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          onVisibleChange(pageNumber, e.isIntersecting)
        }
      },
      { root, rootMargin: '400px 0px', threshold: 0 },
    )
    io.observe(el)
    ioRef.current = io
    return () => {
      io.disconnect()
      ioRef.current = null
    }
  }, [pageNumber, onVisibleChange])

  return (
    <div
      ref={placeholderRef}
      data-page={pageNumber}
      className="relative shrink-0"
      style={{ width: Math.round(widthPx), height: Math.round(heightPx) }}
    >
      {visible ? (
        children(true)
      ) : (
        <div
          className="absolute inset-0 flex items-center justify-center rounded-[2px] bg-stone-50 ring-1 ring-black/5"
          aria-hidden
        >
          <div className="flex flex-col items-center gap-2 text-stone-300">
            <Loader2 className="h-4 w-4 animate-spin opacity-50" />
            <span className="text-[10px] tabular-nums">P{pageNumber}</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** PDF canvas 页（pdfjs 渲染） */
function PdfCanvasPage({
  pdf,
  pageNumber,
  scale,
  wPt,
  hPt,
  onRendered,
  children,
}: {
  pdf: PdfDocumentProxy
  pageNumber: number
  scale: number
  wPt: number
  hPt: number
  onRendered?: () => void
  children?: React.ReactNode
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    let task: { promise: Promise<void>; cancel: () => void } | null = null
    ;(async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return
        const viewport = page.getViewport({ scale })
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        task = page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        })
        await task.promise
        if (!cancelled) onRendered?.()
      } catch {
        /* render cancel 等非致命错误 */
      }
    })()
    return () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {}
    }
  }, [pdf, pageNumber, scale, onRendered])

  return (
    <div className="relative" style={{ width: Math.round(wPt * scale), height: Math.round(hPt * scale) }}>
      <canvas ref={canvasRef} className="absolute left-0 top-0" aria-label={`第 ${pageNumber} 页`} />
      {children}
    </div>
  )
}

/** 合成分页页（md/txt/html：layout blocks 绝对定位文本行） */
function SyntheticPage({
  pageNumber,
  scale,
  wPt,
  hPt,
  blocks,
  children,
}: {
  pageNumber: number
  scale: number
  wPt: number
  hPt: number
  blocks: LayoutBlock[]
  children?: React.ReactNode
}) {
  const viewport = { width: wPt * scale, height: hPt * scale, scale }
  const pageBlocks = blocks.filter((b) => b.page === pageNumber)
  return (
    <div className="relative" style={{ width: Math.round(wPt * scale), height: Math.round(hPt * scale) }} aria-label={`第 ${pageNumber} 页（合成分页）`}>
      <div className="absolute inset-0 overflow-hidden">
        {pageBlocks.map((b) => {
          const pos = bboxToViewport(b.bbox, viewport, hPt)
          if (b.type === 'image') {
            return (
              <div
                key={b.idx}
                className="absolute flex items-center justify-center rounded-[2px] bg-stone-200 text-stone-400"
                style={{ top: pos.top, left: pos.left, width: pos.width, height: pos.height }}
              >
                <ImageIcon className="h-4 w-4" />
              </div>
            )
          }
          return (
            <div
              key={b.idx}
              className={cn(
                'absolute overflow-hidden whitespace-pre-wrap break-words text-stone-800',
                b.type === 'title' && 'font-bold text-stone-900',
                b.type === 'code' && 'rounded-[2px] bg-stone-100 px-1 font-mono text-[9.5px] leading-[1.4]',
                b.type === 'table' && 'rounded-[2px] border border-stone-300 px-1 py-0.5 text-[9.5px] leading-[1.4]',
                b.type === 'title' ? 'text-[12px] leading-[1.4]' : 'text-[10.5px] leading-[1.42]',
              )}
              style={{ top: pos.top, left: pos.left, width: pos.width, height: pos.height }}
            >
              {b.text || ' '}
            </div>
          )
        })}
      </div>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export interface PdfViewerProps {
  docId: string
  isPdf: boolean
  layout: LayoutBlock[]
  pageSizes: { w: number; h: number }[]
  pageCount: number
  selectedChunk: ChunkItem | null
  /** 与选中 chunk charRange 相交的布局块 idx 集合（联动高亮） */
  highlightBlockIdx: Set<number>
  onBlockClick?: (b: LayoutBlock) => void
}

export function PdfViewer({
  docId,
  isPdf,
  layout,
  pageSizes,
  pageCount,
  selectedChunk,
  highlightBlockIdx,
  onBlockClick,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pdf, setPdf] = useState<PdfDocumentProxy | null>(null)
  const [pdfLoading, setPdfLoading] = useState(isPdf)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [pdfMeta, setPdfMeta] = useState<{ wPt: number; hPt: number; pages: number } | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [renderedCount, setRenderedCount] = useState(0)
  // FE-002：可见页集合（IntersectionObserver 维护）。仅可见页挂载真实 canvas/文本块，
  // 其余页保留占位骨架屏——长文档（100+ 页）不再一次性渲染所有页导致 OOM/卡顿。
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set([1]))
  const handleVisibleChange = useCallback((page: number, vis: boolean) => {
    setVisiblePages((prev) => {
      const cur = prev.has(page)
      if (vis && !cur) {
        const next = new Set(prev)
        next.add(page)
        return next
      }
      if (!vis && cur) {
        // 离开预挂载区卸载，释放 canvas；再次进入时 LazyPdfPage 会重新挂载并重渲染。
        // 保留首页（1）常驻，避免顶部空白与 IntersectionObserver 初次未触发的边界。
        if (page === 1) return prev
        const next = new Set(prev)
        next.delete(page)
        return next
      }
      return prev
    })
  }, [])

  // PDF 加载（仅 PDF 文档）
  useEffect(() => {
    if (!isPdf) return
    let cancelled = false
    setPdfLoading(true)
    setPdfError(null)
    setPdf(null)
    setPdfMeta(null)
    setRenderedCount(0)
    ;(async () => {
      try {
        const pdfjs = (await import('pdfjs-dist')) as unknown as {
          GlobalWorkerOptions: { workerSrc: string }
          getDocument: (opts: Record<string, unknown>) => { promise: Promise<PdfDocumentProxy> }
        }
        if (!workerConfigured) {
          pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC
          workerConfigured = true
        }
        const bytes = await ragApi.fetchDocBytes(docId, 'source')
        if (cancelled) return
        const doc = await pdfjs.getDocument({
          data: bytes,
          cMapUrl: CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: STANDARD_FONTS_URL,
        }).promise
        if (cancelled) return
        const first = await doc.getPage(1)
        const vb = first.getViewport({ scale: 1 }).viewBox
        const wPt = vb[2] - vb[0]
        const hPt = vb[3] - vb[1]
        setPdf(doc)
        setPdfMeta({ wPt, hPt, pages: doc.numPages })
      } catch (e) {
        if (!cancelled) setPdfError((e as Error).message || String(e))
      } finally {
        if (!cancelled) setPdfLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docId, isPdf])

  // 页面度量（PDF 用 pdfjs viewBox；合成用 pageSizes；都缺省时 A4）
  const metrics = useMemo(() => {
    const count = isPdf ? pdfMeta?.pages ?? 0 : Math.max(pageCount, pageSizes.length)
    if (isPdf && pdfMeta) {
      return { count, sizes: Array.from({ length: count }, () => ({ w: pdfMeta.wPt, h: pdfMeta.hPt })) }
    }
    if (pageSizes.length > 0) {
      return { count: Math.max(count, pageSizes.length), sizes: pageSizes }
    }
    return { count: 0, sizes: [] as { w: number; h: number }[] }
  }, [isPdf, pdfMeta, pageCount, pageSizes])

  const totalPages = metrics.count

  // 当前页指示（滚动监听）
  const onScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const center = container.scrollTop + container.clientHeight / 2
    let best = 1
    let bestDist = Infinity
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-page]'))) {
      const page = Number(el.dataset.page)
      const top = el.offsetTop
      const dist = Math.abs(top + el.offsetHeight / 2 - center)
      if (dist < bestDist) {
        bestDist = dist
        best = page
      }
    }
    setCurrentPage(best)
  }, [])

  // 选中 chunk → 滚动到 pageFrom，并强制将其所在页范围标记为可见（确保高亮 overlay 渲染）
  useEffect(() => {
    if (!selectedChunk) return
    setVisiblePages((prev) => {
      const next = new Set(prev)
      for (let p = selectedChunk.pageFrom; p <= selectedChunk.pageTo; p++) next.add(p)
      return next
    })
    const container = containerRef.current
    if (!container) return
    const el = container.querySelector(`[data-page="${selectedChunk.pageFrom}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [selectedChunk])

  const scrollToPage = useCallback((page: number) => {
    const container = containerRef.current
    if (!container) return
    const el = container.querySelector(`[data-page="${page}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // zoom clamp
  const zoomIn = () => setZoom((z) => Math.min(2, +(z + 0.25).toFixed(2)))
  const zoomOut = () => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))

  const scaleFor = (size: { w: number; h: number }) => (BASE_WIDTH * zoom) / (size.w || 595)
  const onRendered = useCallback(() => setRenderedCount((c) => c + 1), [])

  if (isPdf && pdfError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <FileWarning className="h-6 w-6 text-rose-500" />
        <p className="text-xs font-medium text-rose-500">PDF 渲染失败</p>
        <p className="max-w-xs text-[11px] leading-relaxed">{pdfError}</p>
      </div>
    )
  }

  if (isPdf && (pdfLoading || !pdf)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-xs">加载 PDF 原文…</span>
        {pdfMeta && (
          <span className="text-[10px]">
            已渲染 {renderedCount} / {totalPages} 页
          </span>
        )}
      </div>
    )
  }

  if (totalPages === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <FileWarning className="h-6 w-6 text-amber-500" />
        <p className="text-xs font-medium">暂无布局数据</p>
        <p className="max-w-xs text-[11px] leading-relaxed">
          文档尚未完成解析（需要 middle.json 布局产物）。解析完成后即可查看原文渲染与 bbox 高亮。
        </p>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* 工具栏：页码 + 缩放 */}
      <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/60 bg-background/90 px-2 py-1 shadow-sm backdrop-blur">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => scrollToPage(Math.max(1, currentPage - 1))} title="上一页">
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-[64px] text-center text-[11px] font-medium tabular-nums">
            {currentPage} / {totalPages}
          </span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => scrollToPage(Math.min(totalPages, currentPage + 1))} title="下一页">
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <span className="mx-1 h-4 w-px bg-border" />
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={zoomOut} disabled={zoom <= 0.5} title="缩小">
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-[44px] text-center text-[11px] tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={zoomIn} disabled={zoom >= 2} title="放大">
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setZoom(1)} title="重置缩放">
            <RotateCcw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* 页面滚动容器 */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className={cn(
          'pdf-viewer-scroll-root h-full overflow-y-auto bg-muted/40 px-4 py-6 dark:bg-stone-900/40',
          '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/45',
        )}
        role="region"
        aria-label="文档原文渲染区"
      >
        <div className="mx-auto flex min-h-full w-fit flex-col items-center gap-4">
          {metrics.sizes.map((size, i) => {
            const pageNumber = i + 1
            const scale = scaleFor(size)
            const visible = visiblePages.has(pageNumber)
            return (
              <LazyPdfPage
                key={`${docId}-${pageNumber}`}
                pageNumber={pageNumber}
                widthPx={size.w * scale}
                heightPx={size.h * scale}
                visible={visible}
                onVisibleChange={handleVisibleChange}
              >
                {() => {
                  const overlay = (
                    <PageOverlay
                      pageNumber={pageNumber}
                      scale={scale}
                      wPt={size.w}
                      hPt={size.h}
                      blocks={layout}
                      highlightBlockIdx={highlightBlockIdx}
                      selectedChunk={selectedChunk}
                      onBlockClick={onBlockClick}
                    />
                  )
                  if (isPdf && pdf) {
                    return (
                      <PdfCanvasPage
                        pdf={pdf}
                        pageNumber={pageNumber}
                        scale={scale}
                        wPt={size.w}
                        hPt={size.h}
                        onRendered={onRendered}
                      >
                        {overlay}
                      </PdfCanvasPage>
                    )
                  }
                  return (
                    <SyntheticPage pageNumber={pageNumber} scale={scale} wPt={size.w} hPt={size.h} blocks={layout}>
                      {overlay}
                    </SyntheticPage>
                  )
                }}
              </LazyPdfPage>
            )
          })}
          <div className="h-2" />
        </div>
      </div>
    </div>
  )
}
