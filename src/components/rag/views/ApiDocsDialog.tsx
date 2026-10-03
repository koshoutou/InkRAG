'use client'

// 通用 API 文档查看 Dialog（Task 17-2）
// - 数据源：任意 GET → text/markdown 的 URL（如 /api/input/docs；Dify 兼容层文档可复用）
// - 渲染：react-markdown + remark-gfm；按一二级标题分段渲染 + 左侧 TOC 锚点导航（点击滚动）
// - 顶部：标题 + 复制全文按钮；内容区原生 overflow-y 滚动（不使用 ScrollArea）
// - 状态：loading / error（含 404 提示文案）齐全；深浅主题自适应；窄屏 TOC 自动隐藏

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BookOpen, Check, Copy, FileQuestion, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { ErrorCard, ragScrollbar } from '../ui'

export interface ApiDocsDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** Dialog 标题（如「入库 API 文档」） */
  title: string
  /** 副标题说明（可选） */
  description?: string
  /** 文档源 URL（GET → text/markdown 纯文本） */
  src: string
}

// ---- markdown 渲染样式（等宽代码块；与 ViewerView MarkdownPane 同基调，无需高亮库） ----
const mdComponents = {
  h3: (p: any) => <h3 className="mb-1.5 mt-4 text-sm font-bold leading-snug" {...p} />,
  h4: (p: any) => <h4 className="mb-1.5 mt-3 text-xs font-semibold leading-snug" {...p} />,
  h5: (p: any) => <h5 className="mb-1 mt-2.5 text-xs font-semibold" {...p} />,
  h6: (p: any) => <h6 className="mb-1 mt-2 text-[11px] font-semibold text-muted-foreground" {...p} />,
  p: (p: any) => <p className="my-2 text-[13px] leading-relaxed" {...p} />,
  ul: (p: any) => <ul className="my-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed" {...p} />,
  ol: (p: any) => <ol className="my-2 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed" {...p} />,
  li: (p: any) => <li className="text-[13px] leading-relaxed" {...p} />,
  blockquote: (p: any) => (
    <blockquote className="my-2.5 border-l-2 border-primary/40 bg-muted/30 px-3 py-1.5 text-[13px] leading-relaxed" {...p} />
  ),
  pre: (p: any) => (
    <pre
      className={cn(
        'my-2.5 overflow-x-auto rounded-md border border-border/60 bg-muted/50 p-3 font-mono text-[11.5px] leading-relaxed',
        ragScrollbar,
      )}
      {...p}
    />
  ),
  code: (p: any) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px]" {...p} />,
  table: (p: any) => (
    <div className={cn('my-2.5 overflow-x-auto', ragScrollbar)}>
      <table className="w-full border-collapse text-[12px]" {...p} />
    </div>
  ),
  th: (p: any) => <th className="border border-border/70 bg-muted/60 px-2 py-1 text-left font-semibold" {...p} />,
  td: (p: any) => <td className="border border-border/60 px-2 py-1 align-top" {...p} />,
  a: (p: any) => <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />,
  hr: () => <hr className="my-4 border-border/60" />,
  strong: (p: any) => <strong className="font-semibold" {...p} />,
}

interface TocEntry {
  id: string
  level: 1 | 2
  text: string
}

interface Segment {
  id: string
  toc: TocEntry | null
  body: string
}

/** 按一二级标题切段（锚点 id 按出现顺序编号，稳定且不依赖中文 slug；跳过 ``` 围栏代码块内的 # 行） */
function splitSegments(md: string): { segments: Segment[]; toc: TocEntry[] } {
  const lines = md.split('\n')
  const segments: Segment[] = []
  const toc: TocEntry[] = []
  let current: Segment = { id: 'sec-intro', toc: null, body: '' }
  let inCode = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode
      current.body += (current.body ? '\n' : '') + line
      continue
    }
    const m = !inCode ? /^(#{1,2})\s+(.+)$/.exec(line) : null
    if (m) {
      if (current.body.trim() || current.toc) segments.push(current)
      const entry: TocEntry = {
        id: `sec-${toc.length}`,
        level: m[1] === '#' ? 1 : 2,
        text: m[2].trim(),
      }
      toc.push(entry)
      current = { id: entry.id, toc: entry, body: '' }
    } else {
      current.body += (current.body ? '\n' : '') + line
    }
  }
  if (current.body.trim() || current.toc) segments.push(current)
  return { segments, toc }
}

export function ApiDocsDialog({ open, onOpenChange, title, description, src }: ApiDocsDialogProps) {
  const [md, setMd] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [activeId, setActiveId] = useState<string>('')
  const contentRef = useRef<HTMLDivElement>(null)
  const loadedSrc = useRef<string>('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(src)
      if (!res.ok) {
        // 错误响应为 JSON { error }（如 404「文档尚未部署」）
        let msg = `HTTP ${res.status}`
        try {
          const j = await res.json()
          if (j?.error) msg = j.error
        } catch {}
        throw new Error(msg)
      }
      const text = await res.text()
      loadedSrc.current = src
      setMd(text)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [src])

  // 打开时拉取（同一 src 已缓存则跳过）；错误重试时置空 loadedSrc 强制重拉
  useEffect(() => {
    if (!open) return
    if (loadedSrc.current === src && md !== null) return
    void load()
  }, [open])

  const { segments, toc } = useMemo(() => (md ? splitSegments(md) : { segments: [], toc: [] }), [md])

  // 内容区滚动 → TOC 当前节高亮
  const onContentScroll = () => {
    const el = contentRef.current
    if (!el || toc.length === 0) return
    const top = el.scrollTop + 96
    let active = toc[0].id
    for (const t of toc) {
      const sec = el.querySelector(`#${t.id}`) as HTMLElement | null
      if (sec && sec.offsetTop <= top) active = t.id
    }
    setActiveId(active)
  }

  const scrollTo = (id: string) => {
    contentRef.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const copyAll = () => {
    if (!md) return
    navigator.clipboard.writeText(md).then(
      () => {
        setCopied(true)
        toast.success('文档全文已复制到剪贴板')
        setTimeout(() => setCopied(false), 2000)
      },
      () => toast.error('复制失败'),
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[calc(100%-2rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        {/* 顶部：标题 + 复制全文（默认关闭按钮在右上角，标题区预留空间） */}
        <DialogHeader className="flex-row items-center gap-2 space-y-0 border-b border-border/60 px-5 py-3.5 pr-14">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <DialogTitle className="truncate text-sm">{title}</DialogTitle>
              {description && (
                <DialogDescription className="mt-0.5 truncate text-[11px]">{description}</DialogDescription>
              )}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 shrink-0 gap-1.5 text-xs"
            disabled={!md}
            onClick={copyAll}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? '已复制' : '复制全文'}
          </Button>
        </DialogHeader>

        {/* 主体：左 TOC + 右内容（原生滚动） */}
        <div className="flex min-h-0 flex-1">
          {toc.length > 0 && (
            <nav
              aria-label="文档目录"
              className={cn(
                'hidden w-52 shrink-0 overflow-y-auto border-r border-border/60 bg-muted/20 py-3 md:block',
                ragScrollbar,
              )}
            >
              <div className="mb-1.5 px-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                目录
              </div>
              <ul className="space-y-0.5 px-1.5">
                {toc.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => scrollTo(t.id)}
                      title={t.text}
                      className={cn(
                        'w-full truncate rounded px-2 py-1 text-left text-[11.5px] leading-snug transition-colors',
                        t.level === 1 ? 'font-medium' : 'pl-4',
                        activeId === t.id
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-background hover:text-foreground',
                      )}
                    >
                      {t.text}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <div
            ref={contentRef}
            onScroll={onContentScroll}
            role="region"
            aria-label="文档内容"
            className={cn('min-w-0 flex-1 overflow-y-auto px-5 py-4', ragScrollbar)}
          >
            {loading ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-xs">加载文档…</span>
              </div>
            ) : error ? (
              <div className="p-1">
                <ErrorCard
                  title="文档加载失败"
                  message={error}
                  onRetry={() => {
                    loadedSrc.current = ''
                    void load()
                  }}
                />
              </div>
            ) : md === null ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <FileQuestion className="h-6 w-6" />
                <p className="text-xs">暂无文档内容</p>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl pb-10">
                {segments.map((seg) => (
                  <section key={seg.id} id={seg.id} className="scroll-mt-4">
                    {seg.toc ? (
                      seg.toc.level === 1 ? (
                        <h2 className="mb-2 mt-6 border-b border-border/60 pb-1.5 text-base font-bold leading-snug first:mt-0">
                          {seg.toc.text}
                        </h2>
                      ) : (
                        <h3 className="mb-2 mt-5 text-sm font-bold leading-snug">{seg.toc.text}</h3>
                      )
                    ) : null}
                    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                      {seg.body.trim() || ' '}
                    </Markdown>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
