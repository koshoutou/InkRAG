'use client'

// 批量上传 ·「本地文件」Tab：拖拽区 + 多选 + 逐文件进度卡
// 卡片：类型徽标/文件名/大小 + XHR 上传百分比条 + 六阶段 stepper + 终态（ready/failed/dedup）
// 状态与编排在 BatchUploadDialog 容器（本组件纯展示 + 文件收集交互）

import { useCallback, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BadgeCheck,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Timer,
  UploadCloud,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { formatBytes } from '../../ui'
import {
  ACCEPT_ATTR,
  ACCEPT_EXTS,
  FileTypeIcon,
  StageStepper,
  fileExt,
  humanDuration,
  isSupportedFile,
  type FileTask,
} from './shared'

export function LocalFileTab({
  tasks,
  busy,
  onAddFiles,
  onRetry,
  onClear,
}: {
  tasks: FileTask[]
  busy: boolean
  onAddFiles: (files: File[]) => void
  onRetry: (taskId: string) => void
  onClear: () => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    (list: File[]) => {
      const valid = list.filter((f) => isSupportedFile(f.name))
      const rejected = list.length - valid.length
      if (rejected > 0) {
        toast.warning(`${rejected} 个文件类型不支持（支持 ${ACCEPT_EXTS.join(' / ')}）`)
      }
      if (valid.length > 0) onAddFiles(valid)
    },
    [onAddFiles],
  )

  const terminal = tasks.filter((t) => t.phase === 'ready' || t.phase === 'failed' || t.phase === 'dedup')
  const okCount = terminal.filter((t) => t.phase === 'ready').length
  const failCount = terminal.filter((t) => t.phase === 'failed').length
  const dedupCount = terminal.filter((t) => t.phase === 'dedup').length
  const firstStart = tasks.reduce<number | null>(
    (acc, t) => (t.startedAt && (acc === null || t.startedAt < acc) ? t.startedAt : acc),
    null,
  )
  const lastEnd = terminal.reduce<number>((acc, t) => Math.max(acc, t.endedAt ?? 0), 0)
  const totalMs = firstStart && lastEnd ? lastEnd - firstStart : 0

  return (
    <div className="space-y-3">
      {/* 拖拽 / 选择区 */}
      <div
        role="button"
        tabIndex={0}
        aria-label="选择或拖拽上传文件"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const files = Array.from(e.dataTransfer.files ?? [])
          if (files.length > 0) handleFiles(files)
        }}
        className={cn(
          'flex min-h-[96px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-4 text-center transition-colors',
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border/70 bg-muted/20 hover:border-primary/50 hover:bg-muted/40',
        )}
      >
        <UploadCloud className={cn('h-6 w-6', dragOver ? 'text-primary' : 'text-muted-foreground')} />
        <p className="text-xs font-medium">拖拽文件到此处，或点击选择（可多选）</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          支持 .pdf / .docx / .md / .markdown / .txt / .html；相同内容（SHA-256）自动秒传
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            if (files.length > 0) handleFiles(files)
            e.target.value = ''
          }}
        />
      </div>

      {/* 批量汇总条 */}
      {tasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[11px]">
          <span className="font-medium">共 {tasks.length} 个文件</span>
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
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-8 gap-1 px-2 text-[11px]"
            onClick={onClear}
            disabled={busy && tasks.some((t) => t.phase === 'uploading')}
            title="清空任务列表"
          >
            <X className="h-3 w-3" />
            清空
          </Button>
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
                {/* 行 1：类型 + 文件名 + 大小 + 状态角标 */}
                <div className="flex items-center gap-2">
                  <FileTypeIcon filename={t.file.name} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium" title={t.file.name}>
                    {t.file.name}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{fileExt(t.file.name)}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {formatBytes(t.file.size)}
                  </span>
                </div>

                {/* 行 2：上传进度条 */}
                {t.phase === 'waiting' && (
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin opacity-60" />
                    等待上传…
                  </div>
                )}
                {t.phase === 'uploading' && (
                  <div className="mt-2 flex items-center gap-2">
                    <Progress value={t.uploadPct} className="h-1.5 flex-1" />
                    <span className="w-10 shrink-0 text-right text-[10px] font-medium tabular-nums text-primary">
                      {t.uploadPct}%
                    </span>
                  </div>
                )}

                {/* 行 3：流水线六阶段 stepper */}
                {t.phase === 'pipeline' && (
                  <div className="mt-2.5">
                    <StageStepper status={t.status} stageProgress={t.stageProgress} />
                  </div>
                )}

                {/* 终态 */}
                {t.phase === 'dedup' && (
                  <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                    <BadgeCheck className="h-3.5 w-3.5 shrink-0" />
                    秒传命中：相同内容文档已存在，无需重复解析
                  </div>
                )}
                {t.phase === 'ready' && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-emerald-600 dark:text-emerald-300">
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      解析就绪
                    </span>
                    {typeof t.chunkCount === 'number' && <span className="tabular-nums">{t.chunkCount} chunks</span>}
                    {typeof t.tookMs === 'number' && <span className="tabular-nums">耗时 {humanDuration(t.tookMs)}</span>}
                  </div>
                )}
                {t.phase === 'failed' && (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-start gap-1.5 text-[11px] text-rose-600 dark:text-rose-300">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 break-all">
                        {t.errorCode === 'UPLOAD_FAILED' ? '上传失败' : '流水线失败'}
                        {t.errorMessage ? `：${t.errorMessage}` : ''}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 gap-1.5 px-3 text-[11px]"
                      onClick={() => onRetry(t.id)}
                      disabled={busy}
                    >
                      <RotateCcw className="h-3 w-3" />
                      重试上传
                    </Button>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <p className="px-1 py-2 text-center text-[11px] leading-relaxed text-muted-foreground">
          选择文件后自动开始上传（并发 2），上传完成自动进入解析流水线并实时推送六阶段进度。
        </p>
      )}
    </div>
  )
}
