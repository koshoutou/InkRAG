'use client'

// 批量上传 ·「URL 导入」Tab：URL 输入 + chip 管理 + 逐 URL 导入进度卡
// sitemap 响应 → 展开子链接入队继续导入（会话总数 ≤30）
// 状态与编排在 BatchUploadDialog 容器（本组件纯展示 + 输入交互）

import { useCallback, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BadgeCheck,
  CheckCircle2,
  Globe,
  ListTree,
  Loader2,
  Plus,
  Timer,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { FileTypeIcon, StageStepper, humanDuration, type UrlTask } from './shared'

export const MAX_URLS = 30

/** 多行输入解析：按行/空白切分，校验 http(s) 与去重 */
export function parseUrlInput(raw: string): { urls: string[]; invalid: number } {
  const seen = new Set<string>()
  const urls: string[] = []
  let invalid = 0
  for (const line of raw.split(/[\s,;]+/)) {
    const t = line.trim()
    if (!t) continue
    if (!/^https?:\/\/\S+$/i.test(t)) {
      invalid++
      continue
    }
    if (!seen.has(t)) {
      seen.add(t)
      urls.push(t)
    }
  }
  return { urls, invalid }
}

export function UrlImportTab({
  tasks,
  running,
  pendingCount,
  onStart,
  onClear,
}: {
  tasks: UrlTask[]
  running: boolean
  /** 会话已入队总数（含 sitemap 展开） */
  pendingCount: number
  onStart: (urls: string[]) => void
  onClear: () => void
}) {
  const [input, setInput] = useState('')
  const [chips, setChips] = useState<string[]>([])
  const [invalidHint, setInvalidHint] = useState<string | null>(null)

  const addFromInput = useCallback(
    (raw?: string) => {
      const source = raw ?? input
      const { urls, invalid } = parseUrlInput(source)
      if (invalid > 0) setInvalidHint(`${invalid} 条不是合法的 http(s) 链接，已忽略`)
      else setInvalidHint(null)
      if (urls.length === 0) return
      setChips((prev) => {
        const merged = [...prev]
        for (const u of urls) {
          if (!merged.includes(u) && merged.length < MAX_URLS) merged.push(u)
        }
        return merged
      })
      if (raw === undefined) setInput('')
    },
    [input],
  )

  const remaining = MAX_URLS - pendingCount - chips.length
  const canStart = chips.length > 0 && !running

  const terminal = tasks.filter((t) => t.phase === 'ready' || t.phase === 'failed' || t.phase === 'dedup')
  const okCount = terminal.filter((t) => t.phase === 'ready').length
  const failCount = terminal.filter((t) => t.phase === 'failed').length
  const dedupCount = terminal.filter((t) => t.phase === 'dedup').length
  const firstStart = tasks.length > 0 ? Math.min(...tasks.map((t) => t.startedAt)) : 0
  const lastEnd = terminal.reduce((acc, t) => Math.max(acc, t.endedAt ?? 0), 0)
  const totalMs = firstStart && lastEnd ? lastEnd - firstStart : 0

  return (
    <div className="space-y-3">
      {/* 输入区 */}
      <div className="space-y-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              addFromInput()
            }
          }}
          placeholder={'粘贴 URL（支持一次粘贴多行，回车或点击「添加」入列）\n例：https://example.com/wiki/page'}
          className="min-h-[72px] resize-y text-xs"
          aria-label="URL 输入"
        />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 px-3 text-xs"
            onClick={() => addFromInput()}
            disabled={input.trim().length === 0}
          >
            <Plus className="h-3.5 w-3.5" />
            添加
          </Button>
          <span className={cn('text-[11px] tabular-nums', remaining <= 5 ? 'text-amber-600 dark:text-amber-300' : 'text-muted-foreground')}>
            会话配额 {chips.length + pendingCount} / {MAX_URLS}
          </span>
          {invalidHint && <span className="ml-auto text-[11px] text-rose-500">{invalidHint}</span>}
        </div>
      </div>

      {/* 待导入 chips */}
      {chips.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">待导入 {chips.length} 个链接</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-[11px]"
              onClick={() => setChips([])}
              disabled={running}
            >
              <X className="h-3 w-3" />
              清空
            </Button>
          </div>
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
            {chips.map((u) => (
              <span
                key={u}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background py-0.5 pl-2 pr-1 text-[11px]"
              >
                <Globe className="h-3 w-3 shrink-0 text-emerald-500" />
                <span className="max-w-[220px] truncate" title={u}>
                  {u}
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${u}`}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-500"
                  onClick={() => setChips((prev) => prev.filter((x) => x !== u))}
                  disabled={running}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <Button
            size="sm"
            className="h-10 w-full gap-1.5 text-xs"
            onClick={() => {
              const batch = chips
              setChips([])
              onStart(batch)
            }}
            disabled={!canStart}
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
            {running ? '导入进行中…' : `开始导入 ${chips.length} 个链接`}
          </Button>
        </div>
      )}

      {/* 批量汇总条 */}
      {tasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[11px]">
          <span className="font-medium">共 {tasks.length} 个任务</span>
          {okCount > 0 && (
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-300">
              <CheckCircle2 className="h-3 w-3" />
              成功 {okCount}
            </span>
          )}
          {dedupCount > 0 && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-300">
              <BadgeCheck className="h-3 w-3" />
              秒传 {dedupCount}
            </span>
          )}
          {failCount > 0 && (
            <span className="flex items-center gap-1 text-rose-600 dark:text-rose-300">
              <XCircle className="h-3 w-3" />
              失败 {failCount}
            </span>
          )}
          {totalMs > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Timer className="h-3 w-3" />
              总耗时 {humanDuration(totalMs)}
            </span>
          )}
          {!running && (
            <Button variant="ghost" size="sm" className="ml-auto h-8 gap-1 px-2 text-[11px]" onClick={onClear} title="清空任务列表">
              <X className="h-3 w-3" />
              清空
            </Button>
          )}
        </div>
      )}

      {/* 任务卡列表 */}
      {tasks.length > 0 ? (
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/45 [&::-webkit-scrollbar-track]:bg-transparent">
          <AnimatePresence initial={false}>
            {tasks.map((t) => (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.15 }}
                className="rounded-lg border border-border/60 bg-card p-3"
              >
                {/* 行 1：URL */}
                <div className="flex items-center gap-2">
                  <FileTypeIcon filename="imported.md" isUrl />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium" title={t.url}>
                    {t.url}
                  </span>
                  {t.filename && (
                    <span className="max-w-[120px] shrink-0 truncate text-[10px] text-muted-foreground" title={t.filename}>
                      {t.filename}
                    </span>
                  )}
                </div>

                {/* 排队 / 抓取中 */}
                {t.phase === 'waiting' && (
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin opacity-60" />
                    排队等待调度…
                  </div>
                )}
                {t.phase === 'fetching' && (
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin text-teal-500" />
                    抓取页面并抽取正文…
                  </div>
                )}

                {/* 流水线 */}
                {t.phase === 'pipeline' && (
                  <div className="mt-2.5">
                    <StageStepper status={t.status} stageProgress={t.stageProgress} />
                  </div>
                )}

                {/* sitemap 展开 */}
                {t.phase === 'sitemap' && (
                  <div className="mt-2 flex items-start gap-1.5 text-[11px] text-teal-600 dark:text-teal-300">
                    <ListTree className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      站点地图展开 {t.expandedCount ?? 0} 个子链接
                      {t.note ? `（${t.note}）` : ''}，已自动入队导入
                    </span>
                  </div>
                )}

                {/* 终态 */}
                {t.phase === 'dedup' && (
                  <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                    <BadgeCheck className="h-3.5 w-3.5 shrink-0" />
                    秒传命中：该页面内容已存在于知识库
                  </div>
                )}
                {t.phase === 'ready' && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-emerald-600 dark:text-emerald-300">
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      导入就绪
                    </span>
                    {typeof t.chunkCount === 'number' && <span className="tabular-nums">{t.chunkCount} chunks</span>}
                    {typeof t.tookMs === 'number' && <span className="tabular-nums">耗时 {humanDuration(t.tookMs)}</span>}
                  </div>
                )}
                {t.phase === 'failed' && (
                  <div className="mt-2 flex items-start gap-1.5 text-[11px] text-rose-600 dark:text-rose-300">
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-all">导入失败{t.error ? `：${t.error}` : ''}</span>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <p className="px-1 py-2 text-center text-[11px] leading-relaxed text-muted-foreground">
          输入外部 wiki / 文档站链接，服务端抓取页面并抽取主内容为 Markdown 入库；
          sitemap.xml 链接会自动展开子页面（单次会话最多 {MAX_URLS} 个）。
        </p>
      )}
    </div>
  )
}
