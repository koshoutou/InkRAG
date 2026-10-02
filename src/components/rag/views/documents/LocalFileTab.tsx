'use client'

// 批量上传 ·「本地文件」Tab：两段式确认（用户要求「上传后增加确认按钮，可继续添加文件，而不是一下子就跑」）
// 阶段一（待上传队列）：选文件/拖拽 → 本地队列（不自动上传），逐行选择解析引擎（受 MinerU 开关约束），
//                       可继续追加 / 单个移除 / 清空；汇总条「共 N · MinerU x · Node y」
// 阶段二（确认执行）：点「开始上传（N）」才交由容器走既有批量管线（并发 2 + XHR 进度 + socket stepper）
// 顶部 MinerU 开关：useMineruStatus 探测（容器注入）；开=可 MinerU 类型默认 MinerU，关=全部 Node；
//                   仅 MinerU 类型（图片/doc/ppt/xls）关闭时行内提示「需开启 MinerU」且不计入可上传数

import { useCallback, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Cpu,
  Loader2,
  Minus,
  RotateCcw,
  Sparkles,
  Timer,
  TriangleAlert,
  UploadCloud,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { formatBytes } from '../../ui'
import {
  ACCEPT_ATTR,
  EngineBadge,
  FileTypeIcon,
  StageStepper,
  engineOf,
  extOf,
  humanDuration,
  isSupportedFile,
  type FileTask,
  type MineruStatus,
  type ParseEngine,
} from './shared'

// ---------------------------------------------------------------------------
// 模块级类型与工具（组件全部模块级定义，不在函数体内）
// ---------------------------------------------------------------------------

/** 待上传队列行（未确认前仅存本地 state） */
interface PendingItem {
  id: string
  file: File
  /** 用户手动指定的引擎；null=未指定（按开关 + 类型推荐在渲染时解析） */
  engine: ParseEngine | null
}

function newPendingId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 行引擎解析（渲染时求值，开关/探测状态变化自动生效）：
 * - 未手动指定：开=按 ENGINE_MATRIX.recommend；关=Node
 * - 手动指定：校验该类型是否支持该引擎（不支持的期望引擎自动落到可行侧）
 * - 返回 null：仅 MinerU 类型且开关关闭 → 整行禁用提示、不计入「开始上传」
 */
function effectiveEngine(item: PendingItem, mineruOn: boolean): ParseEngine | null {
  const entry = engineOf(extOf(item.file.name))
  const wanted: ParseEngine = item.engine ?? (mineruOn ? entry.recommend : 'node')
  if (wanted === 'mineru') {
    if (entry.mineru && mineruOn) return 'mineru'
    return entry.node ? 'node' : null
  }
  if (entry.node) return 'node'
  return entry.mineru && mineruOn ? 'mineru' : null
}

// ---------------------------------------------------------------------------
// MinerU 开关卡（探测状态 + 说明 + 重新检测）
// ---------------------------------------------------------------------------

function MineruSwitchCard({
  status,
  prefer,
  onToggle,
}: {
  status: MineruStatus
  prefer: boolean
  onToggle: (v: boolean) => void
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Switch
          id="mineru-engine-switch"
          checked={status.available && prefer}
          onCheckedChange={onToggle}
          disabled={!status.available || status.probing}
          aria-label="MinerU 高精度解析开关"
        />
        <label htmlFor="mineru-engine-switch" className="cursor-pointer text-xs font-medium">
          MinerU 高精度解析
        </label>
        {status.probing ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            正在检测 MinerU 服务…
          </span>
        ) : status.available ? (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-300"
            title={status.message ?? undefined}
          >
            <CheckCircle2 className="h-3 w-3" />
            可用
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-300"
            title={status.message ?? undefined}
          >
            <TriangleAlert className="h-3 w-3" />
            不可用
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-[11px]"
          onClick={status.reprobe}
          disabled={status.probing}
          title="重新探测 MinerU 服务状态"
        >
          <RotateCcw className="h-3 w-3" />
          重新检测
        </Button>
      </div>
      {status.probing ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          正在检测 MinerU 接口状态，检测结果不影响 Node 解析的使用。
        </p>
      ) : status.available ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          开启后 PDF / 图片 / Office 等类型默认用 MinerU（OCR 高精度）；关闭则本批全部 Node 本地解析（更快）。
          仅 MinerU 支持的类型（图片 / doc / ppt / xls）需开启后才可上传。
        </p>
      ) : (
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-300" title={status.message ?? undefined}>
          MinerU 不可用（未配置或探测失败），可在「设置 → MinerU」中配置；当前仅 Node 解析。
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 待上传队列行：图标 + 文件名 + 移除 / 第二行：扩展名 + 大小 + 引擎槽位
// ---------------------------------------------------------------------------

function EngineSlot({
  item,
  engine,
  mineruOn,
  onEngine,
}: {
  item: PendingItem
  engine: ParseEngine | null
  mineruOn: boolean
  onEngine: (id: string, engine: ParseEngine) => void
}) {
  const entry = engineOf(extOf(item.file.name))
  const canMineru = entry.mineru && mineruOn
  const canNode = entry.node

  // 阻塞：仅 MinerU 类型且开关关闭
  if (engine === null) {
    return (
      <span className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 text-[11px] font-medium text-amber-600 dark:text-amber-300">
        <TriangleAlert className="h-3 w-3" />
        需开启 MinerU
      </span>
    )
  }

  // 双引擎可选：Select（默认=推荐/手动值）
  if (canMineru && canNode) {
    return (
      <Select value={engine} onValueChange={(v) => onEngine(item.id, v as ParseEngine)}>
        <SelectTrigger
          className="h-7 w-[128px] gap-1 rounded-md px-2 text-[11px]"
          aria-label="选择解析引擎"
          title="该类型双引擎均可，可按需切换"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="node" className="gap-1.5 text-xs">
            <Cpu className="h-3 w-3 text-teal-500" />
            Node 解析（快）
          </SelectItem>
          <SelectItem value="mineru" className="gap-1.5 text-xs">
            <Sparkles className="h-3 w-3 text-violet-500" />
            MinerU 解析（高精度）
          </SelectItem>
        </SelectContent>
      </Select>
    )
  }

  // 单引擎：静态徽标（title 说明唯一性）
  return (
    <span
      className="inline-flex h-7 items-center rounded-md border border-border/70 bg-muted/30 px-2"
      title={canMineru ? '该类型仅支持 MinerU 解析（OCR）' : '该类型仅支持 Node 本地解析'}
    >
      <EngineBadge engine={engine} className="border-0 bg-transparent px-0 dark:bg-transparent" />
    </span>
  )
}

function PendingRow({
  item,
  mineruOn,
  onRemove,
  onEngine,
}: {
  item: PendingItem
  mineruOn: boolean
  onRemove: (id: string) => void
  onEngine: (id: string, engine: ParseEngine) => void
}) {
  const engine = effectiveEngine(item, mineruOn)
  const name = item.file.name
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.15 }}
      className={cn(
        'rounded-lg border bg-card p-2.5',
        engine === null ? 'border-amber-500/40' : 'border-border/60',
      )}
    >
      <div className="flex items-center gap-2">
        <FileTypeIcon filename={name} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>
          {name}
        </span>
        <button
          type="button"
          aria-label={`移除 ${name}`}
          onClick={() => onRemove(item.id)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-500"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-8">
        <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{extOf(name)}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatBytes(item.file.size)}</span>
        <span className="ml-auto flex min-w-0 justify-end">
          <EngineSlot item={item} engine={engine} mineruOn={mineruOn} onEngine={onEngine} />
        </span>
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// 说明区：类型推荐矩阵（折叠 details + 紧凑表格）
// ---------------------------------------------------------------------------

const HELP_ROWS: { label: string; exts: string; mineru: 'rec' | 'ok' | 'no'; node: 'ok' | 'rec' | 'no' }[] = [
  { label: 'PDF / 演示 / 表格', exts: 'pdf · pptx · xlsx', mineru: 'rec', node: 'ok' },
  { label: '图片 / 老版 Office', exts: 'png jpg jpeg jp2 webp gif bmp · doc · ppt · xls', mineru: 'rec', node: 'no' },
  { label: 'Word 文档', exts: 'docx', mineru: 'ok', node: 'rec' },
  { label: '文本 / 网页 / 数据', exts: 'md markdown txt html htm shtml mhtml mht csv tsv', mineru: 'no', node: 'rec' },
  { label: '电子书 / 开放格式', exts: 'epub ofd rtf odt ods odp', mineru: 'no', node: 'rec' },
]

function HelpCell({ kind, state }: { kind: ParseEngine; state: 'rec' | 'ok' | 'no' }) {
  if (state === 'no') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground/60">
        <Minus className="h-3 w-3" />—
      </span>
    )
  }
  const rec = state === 'rec'
  const cls = kind === 'mineru' ? 'text-violet-600 dark:text-violet-300' : 'text-teal-600 dark:text-teal-300'
  return (
    <span className={cn('inline-flex items-center gap-1', rec ? cls : 'text-muted-foreground')}>
      <CheckCircle2 className={cn('h-3 w-3', rec && cls)} />
      {rec ? (kind === 'mineru' ? '推荐（高精度）' : '推荐（快）') : '可用'}
    </span>
  )
}

function EngineHelpCard() {
  return (
    <details className="group rounded-lg border border-border/60 bg-muted/20">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
        <CircleHelp className="h-3.5 w-3.5" />
        解析引擎与类型推荐说明
        <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-2 px-3 pb-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          PDF 扫描件 / 图片 / Office 老格式推荐 MinerU（高精度 OCR）；纯文本 / Markdown / HTML / CSV 等用 Node 本地解析更快。
        </p>
        <table className="w-full table-fixed border-collapse text-[10px] leading-relaxed">
          <thead>
            <tr className="border-b border-border/60 text-left text-muted-foreground">
              <th className="w-[40%] py-1 pr-2 font-medium">类型</th>
              <th className="py-1 pr-2 font-medium">MinerU</th>
              <th className="py-1 font-medium">Node（本地）</th>
            </tr>
          </thead>
          <tbody>
            {HELP_ROWS.map((r) => (
              <tr key={r.label} className="border-b border-border/40 align-top last:border-0">
                <td className="py-1.5 pr-2">
                  <div className="font-medium text-foreground/90">{r.label}</div>
                  <div className="mt-0.5 break-words text-muted-foreground">{r.exts}</div>
                </td>
                <td className="py-1.5 pr-2">
                  <HelpCell kind="mineru" state={r.mineru} />
                </td>
                <td className="py-1.5">
                  <HelpCell kind="node" state={r.node} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] leading-relaxed text-muted-foreground/80">
          共支持 30 种扩展名；相同内容（SHA-256）自动秒传，无需重复解析。引擎可在每行上传前按需切换。
        </p>
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// 主组件（纯展示 + 待上传队列交互；任务编排仍在容器）
// ---------------------------------------------------------------------------

export function LocalFileTab({
  tasks,
  busy,
  mineru,
  onAddFiles,
  onRetry,
  onClear,
}: {
  tasks: FileTask[]
  busy: boolean
  /** MinerU 探测状态（容器注入，两 Tab 共享） */
  mineru: MineruStatus
  /** 确认执行：把待上传队列连同引擎选择交给容器批量管线 */
  onAddFiles: (items: { file: File; engine: ParseEngine }[]) => void
  onRetry: (taskId: string) => void
  onClear: () => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const [pending, setPending] = useState<PendingItem[]>([])
  /** MinerU 开关（默认倾向开；探测不可用时强制关） */
  const [preferMineru, setPreferMineru] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  const mineruOn = mineru.available && preferMineru

  const collectFiles = useCallback(
    (list: File[]) => {
      const valid = list.filter((f) => isSupportedFile(f.name))
      const rejected = list.length - valid.length
      if (rejected > 0) {
        toast.warning(`${rejected} 个文件类型不支持（支持 PDF / Office / 图片 / 网页 / 文本等 30 种，见下方说明）`)
      }
      if (valid.length === 0) return
      setPending((prev) => [
        ...prev,
        ...valid.map((file) => ({ id: newPendingId(), file, engine: null }) satisfies PendingItem),
      ])
    },
    [],
  )

  const toggleMineru = useCallback(
    (next: boolean) => {
      setPreferMineru(next)
      // 引擎在渲染时按 mineruOn 求值，切换开关自动生效（手动指定项会被 effectiveEngine 校验）
    },
    [],
  )

  const removePending = useCallback((id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id))
  }, [])

  const setPendingEngine = useCallback((id: string, engine: ParseEngine) => {
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, engine } : p)))
  }, [])

  const confirmUpload = useCallback(() => {
    if (busy) return
    const ready = pending
      .map((p) => ({ item: p, engine: effectiveEngine(p, mineruOn) }))
      .filter((x): x is { item: PendingItem; engine: ParseEngine } => x.engine !== null)
    if (ready.length === 0) {
      toast.warning('没有可上传的文件（仅 MinerU 类型需先开启 MinerU 开关）')
      return
    }
    onAddFiles(ready.map(({ item, engine }) => ({ file: item.file, engine })))
    setPending([])
  }, [busy, mineruOn, onAddFiles, pending])

  // 待上传队列派生统计
  const resolved = pending.map((p) => effectiveEngine(p, mineruOn))
  const mineruCount = resolved.filter((e) => e === 'mineru').length
  const nodeCount = resolved.filter((e) => e === 'node').length
  const blockedCount = resolved.filter((e) => e === null).length
  const readyCount = mineruCount + nodeCount

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
      {/* MinerU 开关 + 状态检测 */}
      <MineruSwitchCard status={mineru} prefer={preferMineru} onToggle={toggleMineru} />

      {/* 拖拽 / 选择区（上传进行中禁用追加） */}
      <div
        role="button"
        tabIndex={0}
        aria-label="选择或拖拽上传文件"
        aria-disabled={busy}
        onClick={() => {
          if (!busy) inputRef.current?.click()
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !busy) {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (busy) return
          const files = Array.from(e.dataTransfer.files ?? [])
          if (files.length > 0) collectFiles(files)
        }}
        className={cn(
          'flex min-h-[88px] flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-3 text-center transition-colors',
          busy
            ? 'cursor-not-allowed border-border/50 bg-muted/10 opacity-60'
            : dragOver
              ? 'cursor-pointer border-primary bg-primary/5'
              : 'cursor-pointer border-border/70 bg-muted/20 hover:border-primary/50 hover:bg-muted/40',
        )}
      >
        <UploadCloud className={cn('h-6 w-6', dragOver ? 'text-primary' : 'text-muted-foreground')} />
        <p className="text-xs font-medium">{busy ? '上传进行中，暂不能追加文件…' : '拖拽文件到此处，或点击选择（可多选）'}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          支持 PDF / Office / 图片 / Markdown / 网页 / CSV 等 30 种类型；相同内容（SHA-256）自动秒传
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          disabled={busy}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            if (files.length > 0) collectFiles(files)
            e.target.value = ''
          }}
        />
      </div>

      {/* 待上传队列（两段式：确认前不自动跑） */}
      {pending.length > 0 && (
        <div className="space-y-2">
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/45 [&::-webkit-scrollbar-track]:bg-transparent">
            <AnimatePresence initial={false}>
              {pending.map((p) => (
                <PendingRow
                  key={p.id}
                  item={p}
                  mineruOn={mineruOn}
                  onRemove={removePending}
                  onEngine={setPendingEngine}
                />
              ))}
            </AnimatePresence>
          </div>
          {/* 队列汇总条 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[11px]">
            <span className="font-medium">共 {pending.length} 个文件</span>
            {mineruCount > 0 && (
              <span className="inline-flex items-center gap-1 text-violet-600 dark:text-violet-300">
                <Sparkles className="h-3 w-3" />
                MinerU {mineruCount}
              </span>
            )}
            {nodeCount > 0 && (
              <span className="inline-flex items-center gap-1 text-teal-600 dark:text-teal-300">
                <Cpu className="h-3 w-3" />
                Node {nodeCount}
              </span>
            )}
            {blockedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-300" title="开启顶部 MinerU 开关后可上传">
                <TriangleAlert className="h-3 w-3" />
                待开启 MinerU {blockedCount}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-8 gap-1 px-2 text-[11px]"
              onClick={() => setPending([])}
              disabled={busy}
              title="移除全部待上传文件"
            >
              <X className="h-3 w-3" />
              移除全部
            </Button>
          </div>
          {/* 确认按钮 */}
          <Button
            size="sm"
            className="h-10 w-full gap-1.5 text-xs"
            onClick={confirmUpload}
            disabled={busy || readyCount === 0}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
            {busy ? '上传进行中…' : `开始上传（${readyCount}）`}
          </Button>
          {blockedCount > 0 && (
            <p className="px-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-300">
              {blockedCount} 个文件为仅 MinerU 支持的类型（图片 / doc / ppt / xls），开启顶部开关后才会计入上传；也可先从队列移除。
            </p>
          )}
        </div>
      )}

      {/* 批量汇总条（已执行任务） */}
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
                {/* 行 1：类型 + 文件名 + 大小 + 引擎 + 状态角标 */}
                <div className="flex flex-wrap items-center gap-2">
                  <FileTypeIcon filename={t.file.name} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium" title={t.file.name}>
                    {t.file.name}
                  </span>
                  {t.engine && <EngineBadge engine={t.engine} className="order-last sm:order-none" />}
                  <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{extOf(t.file.name)}</span>
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
          选择文件后进入待上传队列（不会立刻上传），可继续追加并逐行选择解析引擎；点击「开始上传」后并发 2 路上传并实时推送六阶段进度。
        </p>
      )}

      {/* 说明区：类型推荐矩阵 */}
      <EngineHelpCard />
    </div>
  )
}
