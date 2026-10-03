'use client'

// 批量上传 / URL 导入（契约 §26）· 共享 UI 原子件
// StageStepper：六状态机阶段步进器（queued→parsing→chunking→embedding→upserting→ready|failed）
// 引擎支持矩阵（14-e 契约）：ENGINE_MATRIX + EngineBadge + useMineruStatus（探测 POST /api/qdrant/test {kind:'mineru'}）

import { useCallback, useEffect, useState } from 'react'
import {
  BookOpen,
  CheckCircle2,
  Clock,
  Cpu,
  FileCode2,
  FileImage,
  FileSearch,
  FileSpreadsheet,
  FileText,
  FileType2,
  Globe,
  Presentation,
  Scissors,
  Sparkles,
  Table,
  UploadCloud,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DocStatus } from '../../types'

/** 流水线五个过程阶段（终态另算） */
export const PROCESS_STAGE_ORDER: DocStatus[] = ['queued', 'parsing', 'chunking', 'embedding', 'upserting']

export const STAGE_ICON: Record<string, LucideIcon> = {
  queued: Clock,
  parsing: FileSearch,
  chunking: Scissors,
  embedding: Sparkles,
  upserting: UploadCloud,
  ready: CheckCircle2,
  failed: XCircle,
}

export const STAGE_LABEL: Record<string, string> = {
  queued: '排队',
  parsing: '解析',
  chunking: '切分',
  embedding: '向量化',
  upserting: '入库',
  ready: '就绪',
  failed: '失败',
}

/**
 * 六阶段步进器：完成阶段 emerald、当前阶段 teal 高亮 + 阶段内进度%、未到 muted。
 * 375px 下五段横排（图标 + 9px 标签），无横向溢出。
 */
export function StageStepper({
  status,
  stageProgress,
  className,
}: {
  status: DocStatus | undefined
  stageProgress: number
  className?: string
}) {
  const terminalReady = status === 'ready'
  const terminalFailed = status === 'failed'
  const currentIdx = PROCESS_STAGE_ORDER.indexOf(status as DocStatus)
  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)} role="status" aria-label={`流水线阶段：${STAGE_LABEL[status ?? 'queued']}`}>
      {PROCESS_STAGE_ORDER.map((stage, i) => {
        const Icon = STAGE_ICON[stage]
        const done = terminalReady || (currentIdx >= 0 && i < currentIdx)
        const active = !terminalReady && !terminalFailed && currentIdx === i
        const failedHere = terminalFailed && currentIdx === i
        return (
          <div key={stage} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border',
                done && 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
                active && 'border-teal-500/60 bg-teal-500/15 text-teal-600 animate-pulse dark:text-teal-300',
                failedHere && 'border-rose-500/60 bg-rose-500/10 text-rose-600 dark:text-rose-300',
                !done && !active && !failedHere && 'border-border text-muted-foreground/40',
              )}
              title={STAGE_LABEL[stage]}
            >
              <Icon className="h-3 w-3" />
            </span>
            <span
              className={cn(
                'max-w-full truncate text-[9px] leading-none',
                done && 'text-emerald-600 dark:text-emerald-300',
                active && 'font-medium text-teal-600 dark:text-teal-300',
                failedHere && 'text-rose-600 dark:text-rose-300',
                !done && !active && !failedHere && 'text-muted-foreground/50',
              )}
            >
              {STAGE_LABEL[stage]}
            </span>
          </div>
        )
      })}
      {!terminalReady && !terminalFailed && (
        <span className="w-8 shrink-0 text-right text-[10px] font-medium tabular-nums text-teal-600 dark:text-teal-300">
          {Math.max(0, Math.min(100, Math.round(stageProgress)))}%
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 解析引擎（14-e 契约：engine='mineru'|'node'，上传 FormData / URL body 可选字段）
// ---------------------------------------------------------------------------

export type ParseEngine = 'mineru' | 'node'

export interface EngineSupport {
  /** MinerU 引擎是否支持该类型 */
  mineru: boolean
  /** Node 本地引擎是否支持该类型 */
  node: boolean
  /** 推荐引擎（扫描件/复杂版式→MinerU 高精度；纯文本/网页/数据→Node 快） */
  recommend: ParseEngine
}

/**
 * 类型 × 引擎支持矩阵（权威，14-e 契约）：
 * - MinerU 推荐：pdf（扫描件/复杂版式）、图片（png/jpg/jpeg/jp2/webp/gif/bmp）、doc、ppt/pptx、xls/xlsx
 * - Node 推荐（快）：md/markdown、txt、html/htm/shtml、mhtml/mht、csv/tsv、rtf、docx、epub
 * - 仅 MinerU：ppt、xls、全部图片类型、doc
 * - 仅 Node：md、markdown、txt、rtf、csv、tsv、epub、ofd、odt、ods、odp、shtml、mhtml、mht
 */
export const ENGINE_MATRIX: Record<string, EngineSupport> = {
  pdf: { mineru: true, node: true, recommend: 'mineru' },
  doc: { mineru: true, node: false, recommend: 'mineru' },
  docx: { mineru: true, node: true, recommend: 'node' },
  ppt: { mineru: true, node: false, recommend: 'mineru' },
  pptx: { mineru: true, node: true, recommend: 'mineru' },
  xls: { mineru: true, node: false, recommend: 'mineru' },
  xlsx: { mineru: true, node: true, recommend: 'mineru' },
  png: { mineru: true, node: false, recommend: 'mineru' },
  jpg: { mineru: true, node: false, recommend: 'mineru' },
  jpeg: { mineru: true, node: false, recommend: 'mineru' },
  jp2: { mineru: true, node: false, recommend: 'mineru' },
  webp: { mineru: true, node: false, recommend: 'mineru' },
  gif: { mineru: true, node: false, recommend: 'mineru' },
  bmp: { mineru: true, node: false, recommend: 'mineru' },
  md: { mineru: false, node: true, recommend: 'node' },
  markdown: { mineru: false, node: true, recommend: 'node' },
  txt: { mineru: false, node: true, recommend: 'node' },
  html: { mineru: false, node: true, recommend: 'node' },
  htm: { mineru: false, node: true, recommend: 'node' },
  shtml: { mineru: false, node: true, recommend: 'node' },
  mhtml: { mineru: false, node: true, recommend: 'node' },
  mht: { mineru: false, node: true, recommend: 'node' },
  csv: { mineru: false, node: true, recommend: 'node' },
  tsv: { mineru: false, node: true, recommend: 'node' },
  rtf: { mineru: false, node: true, recommend: 'node' },
  epub: { mineru: false, node: true, recommend: 'node' },
  ofd: { mineru: false, node: true, recommend: 'node' },
  odt: { mineru: false, node: true, recommend: 'node' },
  ods: { mineru: false, node: true, recommend: 'node' },
  odp: { mineru: false, node: true, recommend: 'node' },
}

const ENGINE_FALLBACK: EngineSupport = { mineru: false, node: true, recommend: 'node' }

/** 按扩展名（无点小写）查引擎支持；未知类型按「仅 Node」兜底 */
export function engineOf(ext: string): EngineSupport {
  return ENGINE_MATRIX[ext.toLowerCase()] ?? ENGINE_FALLBACK
}

/** 文件扩展名（小写，无点）——engineOf 的配套小工具 */
export function extOf(name: string): string {
  return fileExt(name)
}

/** 引擎小徽标（violet=MinerU / teal=Node） */
export function EngineBadge({ engine, className }: { engine: ParseEngine; className?: string }) {
  if (engine === 'mineru') {
    return (
      <span
        className={cn(
          'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-violet-500/40 bg-violet-500/10 px-1.5 text-[10px] font-medium text-violet-600 dark:text-violet-300',
          className,
        )}
      >
        <Sparkles className="h-3 w-3" />
        MinerU
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-teal-500/40 bg-teal-500/10 px-1.5 text-[10px] font-medium text-teal-600 dark:text-teal-300',
        className,
      )}
    >
      <Cpu className="h-3 w-3" />
      Node
    </span>
  )
}

// ---------------------------------------------------------------------------
// MinerU 状态探测（容器调用一次，两个 Tab 共享；失败静默降级不阻塞 UI）
// ---------------------------------------------------------------------------

export interface MineruStatus {
  /** 探测进行中（初始 true，开关禁用） */
  probing: boolean
  /** 探测通过：MinerU 服务可用 */
  available: boolean
  /** 探测详情（成功说明 / 失败原因），探测中为 null */
  message: string | null
  /** 重新检测 */
  reprobe: () => void
}

export function useMineruStatus(): MineruStatus {
  const [probing, setProbing] = useState(true)
  const [available, setAvailable] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // 16-a 探测同源：只传 {kind:'mineru'}，后端回退读 DB 已存设置（provider/真实密钥/地址），
        // 与「设置 → MinerU → 测试连接」同源同果。此前实现把 GET 设置返回的掩码密钥（***xxxx）
        // 当真实 Key 传给探测接口，且不传 provider（默认 selfhost）→ 设置里 200、上传时却「未连接」。
        const res = await fetch('/api/qdrant/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'mineru' }),
          signal: AbortSignal.timeout(10_000),
          cache: 'no-store',
        })
        const j: { ok?: boolean; message?: string } = await res.json().catch(() => ({}))
        if (cancelled) return
        const ok = res.ok && j.ok === true
        setAvailable(ok)
        setMessage(ok ? `探测成功${j.message ? `：${j.message}` : ''}` : `探测失败${j.message ? `：${j.message}` : `（HTTP ${res.status}）`}`)
      } catch (e) {
        if (cancelled) return
        setAvailable(false)
        setMessage(`探测失败：${(e as Error).message}`)
      } finally {
        if (!cancelled) setProbing(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [nonce])

  const reprobe = useCallback(() => {
    setProbing(true)
    setNonce((n) => n + 1)
  }, [])

  return { probing, available, message, reprobe }
}

// ---------------------------------------------------------------------------
// 文件类型徽标
// ---------------------------------------------------------------------------

const TYPE_STYLE: { match: RegExp; icon: LucideIcon; cls: string }[] = [
  { match: /\.pdf$/i, icon: FileText, cls: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300' },
  { match: /\.(doc|docx)$/i, icon: FileText, cls: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300' },
  { match: /\.(ppt|pptx)$/i, icon: Presentation, cls: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300' },
  { match: /\.(xls|xlsx)$/i, icon: FileSpreadsheet, cls: 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-300' },
  { match: /\.(csv|tsv)$/i, icon: Table, cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' },
  { match: /\.(png|jpe?g|jp2|webp|gif|bmp)$/i, icon: FileImage, cls: 'border-purple-500/40 bg-purple-500/10 text-purple-600 dark:text-purple-300' },
  { match: /\.(md|markdown)$/i, icon: FileCode2, cls: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300' },
  { match: /\.(html|htm|shtml|mhtml|mht)$/i, icon: FileType2, cls: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300' },
  { match: /\.epub$/i, icon: BookOpen, cls: 'border-stone-500/40 bg-stone-500/10 text-stone-600 dark:text-stone-300' },
  { match: /\.(rtf|ofd|odt|ods|odp)$/i, icon: FileType2, cls: 'border-stone-500/40 bg-stone-500/10 text-stone-600 dark:text-stone-300' },
  { match: /\.txt$/i, icon: FileText, cls: 'border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300' },
]

const FALLBACK_STYLE = { icon: FileText, cls: 'border-border bg-muted/40 text-muted-foreground' }

/** URL 导入徽标（emerald Globe） */
const URL_STYLE = { icon: Globe, cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' }

export function FileTypeIcon({
  filename,
  isUrl = false,
  className,
}: {
  filename: string
  isUrl?: boolean
  className?: string
}) {
  if (isUrl) {
    const Icon = URL_STYLE.icon
    return (
      <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md border', URL_STYLE.cls, className)}>
        <Icon className="h-3 w-3" />
      </span>
    )
  }
  const hit = TYPE_STYLE.find((t) => t.match.test(filename)) ?? FALLBACK_STYLE
  const Icon = hit.icon
  return (
    <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md border', hit.cls, className)}>
      <Icon className="h-3 w-3" />
    </span>
  )
}

/** 文件扩展名（小写，无点） */
export function fileExt(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim())
  return m ? m[1].toLowerCase() : '?'
}

/** 支持的本地文件类型（14-e 契约全集：30 种扩展名） */
export const ACCEPT_EXTS = [
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
  '.rtf', '.odt', '.ods', '.odp', '.csv', '.tsv', '.epub', '.ofd',
  '.html', '.htm', '.shtml', '.mhtml', '.mht', '.md', '.markdown', '.txt',
  '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp',
]
export const ACCEPT_ATTR = ACCEPT_EXTS.join(',')

export function isSupportedFile(name: string): boolean {
  return ACCEPT_EXTS.some((e) => name.toLowerCase().endsWith(e))
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`
}

// ---------------------------------------------------------------------------
// 任务模型（BatchUploadDialog 容器持有，Tabs 子组件纯展示）
// ---------------------------------------------------------------------------

export type FilePhase = 'waiting' | 'uploading' | 'pipeline' | 'ready' | 'failed' | 'dedup'

export interface FileTask {
  id: string
  file: File
  /** 解析引擎（两段式确认时由待上传队列带入；重试沿用） */
  engine?: ParseEngine
  uploadPct: number
  phase: FilePhase
  status?: DocStatus
  stageProgress: number
  errorCode?: string
  errorMessage?: string
  docId?: string
  chunkCount?: number
  tookMs?: number
  startedAt?: number
  endedAt?: number
}

export type UrlPhase = 'waiting' | 'fetching' | 'pipeline' | 'ready' | 'failed' | 'dedup'

export interface UrlTask {
  id: string
  url: string
  /** 解析引擎（提交批次时带入） */
  engine?: ParseEngine
  phase: UrlPhase
  note?: string
  filename?: string
  docId?: string
  status?: DocStatus
  stageProgress: number
  error?: string
  chunkCount?: number
  tookMs?: number
  startedAt: number
  endedAt?: number
}

export function isFileTerminal(t: FileTask): boolean {
  return t.phase === 'ready' || t.phase === 'failed' || t.phase === 'dedup'
}

export function isUrlTerminal(t: UrlTask): boolean {
  return t.phase === 'ready' || t.phase === 'failed' || t.phase === 'dedup'
}
