'use client'

// 三屏联动 · 中屏：Markdown 结构化渲染
// - GET file?kind=markdown 拿源文本；按 layout blocks 拆段（charStart/charEnd 切片）逐块 react-markdown 渲染
// - 选中 chunk 的 charRange 与块相交 → 高亮背景；父 chunk 范围 → 虚线描边
// - 点击块 → 反查覆盖该范围的 chunk（右屏联动）
// - 标题块锚点导航侧条

import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileWarning, Hash, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ragApi } from '../../api'
import type { ChunkItem, LayoutBlock } from '../../types'
import { ErrorCard } from '../../ui'

export interface MarkdownPaneProps {
  docId: string
  layout: LayoutBlock[]
  selectedChunk: ChunkItem | null
  parentRange: { charStart: number; charEnd: number } | null
  onBlockClick?: (b: LayoutBlock) => void
}

const mdComponents = {
  h1: (p: any) => <h1 className="mb-2 mt-3 text-base font-bold leading-snug" {...p} />,
  h2: (p: any) => <h2 className="mb-2 mt-3 text-sm font-bold leading-snug" {...p} />,
  h3: (p: any) => <h3 className="mb-1.5 mt-2.5 text-[13px] font-semibold leading-snug" {...p} />,
  h4: (p: any) => <h4 className="mb-1.5 mt-2 text-xs font-semibold leading-snug" {...p} />,
  h5: (p: any) => <h5 className="mb-1 mt-2 text-xs font-semibold" {...p} />,
  h6: (p: any) => <h6 className="mb-1 mt-2 text-[11px] font-semibold text-muted-foreground" {...p} />,
  p: (p: any) => <p className="my-1.5 text-[13px] leading-relaxed" {...p} />,
  ul: (p: any) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 text-[13px] leading-relaxed" {...p} />,
  ol: (p: any) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 text-[13px] leading-relaxed" {...p} />,
  li: (p: any) => <li className="text-[13px] leading-relaxed" {...p} />,
  blockquote: (p: any) => <blockquote className="my-2 border-l-2 border-primary/40 bg-muted/30 px-3 py-1 text-[13px]" {...p} />,
  pre: (p: any) => (
    <pre
      className="my-2 overflow-x-auto rounded-md border border-border/60 bg-muted/50 p-3 font-mono text-[11.5px] leading-relaxed [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25"
      {...p}
    />
  ),
  code: (p: any) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px]" {...p} />,
  table: (p: any) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12px]" {...p} />
    </div>
  ),
  th: (p: any) => <th className="border border-border/70 bg-muted/60 px-2 py-1 text-left font-semibold" {...p} />,
  td: (p: any) => <td className="border border-border/60 px-2 py-1 align-top" {...p} />,
  a: (p: any) => <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />,
  hr: () => <hr className="my-3 border-border/60" />,
  img: (p: any) => <img className="my-2 max-w-full rounded-md border border-border/60" alt={p?.alt ?? ''} loading="lazy" {...p} />,
}

export function MarkdownPane({ docId, layout, selectedChunk, parentRange, onBlockClick }: MarkdownPaneProps) {
  const { data: md, isLoading, error, refetch } = useQuery({
    queryKey: ['markdown', docId],
    queryFn: () => ragApi.fetchDocText(docId, 'markdown'),
    staleTime: 10 * 60_000,
    retry: 1,
  })

  const containerRef = useRef<HTMLDivElement>(null)

  // 块源文本切片（完整渲染 markdown，而不是用截断的 block.text）
  const blocks = useMemo(() => {
    if (!md) return []
    const list = layout.map((b) => ({ block: b, source: md.slice(b.charStart, b.charEnd) }))
    if (list.length > 0) return list
    // 无布局数据时整篇按 4000 字符分块渲染兜底
    const size = 4000
    const n = Math.ceil(md.length / size)
    return Array.from({ length: n }, (_, i) => ({
      block: { idx: i, type: 'text' as const, page: 1, bbox: [0, 0, 0, 0], charStart: i * size, charEnd: (i + 1) * size, text: '' },
      source: md.slice(i * size, (i + 1) * size),
    }))
  }, [md, layout])

  // 高亮判定
  const chunkRange = selectedChunk ? { s: selectedChunk.charStart, e: selectedChunk.charEnd } : null
  const overlap = (a: { s: number; e: number }, b: { s: number; e: number }) => a.s < b.e && b.s < a.e

  // 选中变化 → 滚动到第一个命中块
  useEffect(() => {
    if (!selectedChunk || !containerRef.current) return
    const el = containerRef.current.querySelector('[data-hit="1"]')
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [selectedChunk])

  const headings = useMemo(() => blocks.filter((b) => b.block.type === 'title'), [blocks])

  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-xs">加载 Markdown…</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-4">
        <ErrorCard
          title="Markdown 加载失败"
          message={error instanceof Error ? error.message : String(error)}
          onRetry={() => refetch()}
        />
      </div>
    )
  }

  const scrollToBlock = (idx: number) => {
    containerRef.current?.querySelector(`[data-block-idx="${idx}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="flex h-full">
      <div
        ref={containerRef}
        className={cn(
          // 内容不足一屏时底部呈现淡渐变底，避免大面积空白塌陷感
          'h-full flex-1 overflow-y-auto bg-background bg-gradient-to-b from-transparent to-muted/20 px-4 py-4',
          '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/45',
        )}
        role="region"
        aria-label="Markdown 结构化渲染"
      >
        <div className="mx-auto max-w-3xl">
          {blocks.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <FileWarning className="h-6 w-6 text-amber-500" />
              <p className="text-xs">暂无 Markdown 产物（文档尚未完成解析）</p>
            </div>
          ) : (
            blocks.map(({ block, source }) => {
              const isHit = !!chunkRange && overlap({ s: block.charStart, e: block.charEnd }, chunkRange)
              const isParent = !!parentRange && overlap({ s: block.charStart, e: block.charEnd }, parentRange)
              return (
                <div
                  key={block.idx}
                  data-block-idx={block.idx}
                  data-hit={isHit ? '1' : undefined}
                  onClick={() => onBlockClick?.(block)}
                  className={cn(
                    'cursor-pointer rounded-md px-2 py-0.5 -mx-2 transition-colors',
                    isHit && 'bg-emerald-500/15 ring-1 ring-emerald-500/40',
                    !isHit && isParent && 'border border-dashed border-amber-500/60 bg-amber-500/[0.06]',
                    !isHit && !isParent && 'hover:bg-muted/50',
                  )}
                >
                  <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {source || ' '}
                  </Markdown>
                </div>
              )
            })
          )}
          <div className="h-8" />
        </div>
      </div>

      {/* 标题锚点导航侧条 */}
      {headings.length > 0 && (
        <nav
          aria-label="标题导航"
          className="hidden w-40 shrink-0 overflow-y-auto border-l border-border/60 bg-muted/20 px-2 py-3 lg:block [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25"
        >
          <div className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">大纲</div>
          <ul className="space-y-0.5">
            {headings.map(({ block }) => (
              <li key={block.idx}>
                <button
                  type="button"
                  onClick={() => scrollToBlock(block.idx)}
                  className="w-full truncate rounded px-1.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  title={block.text}
                >
                  <Hash className="mr-0.5 inline h-2.5 w-2.5 opacity-50" />
                  {block.text || `块 ${block.idx}`}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  )
}
