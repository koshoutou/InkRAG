'use client'

// RAG 知识库平台 · 全局命令面板（Ctrl+K / Cmd+K）
// 快速导航（视图跳转）+ 资源跳转（知识库 / 最近文档 / 文档搜索）+ 快捷动作（CustomEvent 契约）
// 内置前缀：输入「>」仅匹配快捷动作；输入「#」仅匹配资源（知识库 / 文档）
// 数据懒加载：仅在面板 open 时发起请求（react-query enabled 门控），关闭时零请求

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { Archive, FileSearch, FileText, FolderPlus, KeyRound, Library, PlayCircle } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { ragApi } from './api'
import { NAV_ITEMS } from './PlatformShell'
import { gotoDocs, gotoViewer, usePlatformStore } from './store'
import { STATUS_META, useDebouncedValue } from './ui'
import type { DocSummary } from './types'

/** 顶栏入口按钮派发的「打开命令面板」全局事件（CommandPalette 监听） */
export const OPEN_COMMAND_PALETTE_EVENT = 'rag:open-command-palette'

/** 触发文档搜索的最小字符数（> 2 字符） */
const DOC_SEARCH_MIN_CHARS = 3

type PaletteMode = 'all' | 'action' | 'doc'

interface QuickAction {
  label: string
  desc: string
  view: 'kbs' | 'testsets' | 'ops' | 'apikeys'
  /** 派发的自定义事件（由对应视图 useQuickAction 监听，跳转后自动执行） */
  event: string
  icon: ComponentType<{ className?: string }>
  iconClass: string
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    label: '新建知识库',
    desc: '跳转并自动执行',
    view: 'kbs',
    event: 'rag:quick-create-kb',
    icon: FolderPlus,
    iconClass: 'text-emerald-500',
  },
  {
    label: '一键回归',
    desc: '跳转并自动执行',
    view: 'testsets',
    event: 'rag:quick-run-tests',
    icon: PlayCircle,
    iconClass: 'text-teal-500',
  },
  {
    label: '创建备份',
    desc: '跳转并自动执行',
    view: 'ops',
    event: 'rag:quick-backup',
    icon: Archive,
    iconClass: 'text-amber-500',
  },
  {
    label: '新建 API Key',
    desc: '跳转并自动执行',
    view: 'apikeys',
    event: 'rag:quick-create-key',
    icon: KeyRound,
    iconClass: 'text-violet-500',
  },
]

function statusLabel(status: DocSummary['status']): string {
  return STATUS_META[status]?.label ?? status
}

function StatusText({ status }: { status: DocSummary['status'] }) {
  const meta = STATUS_META[status] ?? STATUS_META.queued
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        meta.badge,
      )}
    >
      {meta.label}
    </span>
  )
}

/** 紧凑 kbd 徽标（与顶栏入口一致的全局样式契约） */
function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  /** 输入内容（内置前缀已在输入层剥离，keyword = raw.trim()） */
  const [raw, setRaw] = useState('')
  const [mode, setMode] = useState<PaletteMode>('all')
  const setView = usePlatformStore((s) => s.setView)
  const activeKbId = usePlatformStore((s) => s.activeKbId)

  // 全局快捷键：Ctrl+K / Cmd+K 切换面板；Esc 关闭由 Dialog 自带
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // 顶栏入口按钮派发的打开事件
  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setRaw('')
    setMode('all')
  }, [])

  // -- 数据懒加载：仅 open 时请求（复用全局 ['kbs']/['dashboard'] 缓存键） ------------------
  const kbsQuery = useQuery({
    queryKey: ['kbs'],
    queryFn: () => ragApi.listKbs(),
    enabled: open,
  })
  const dashboardQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => ragApi.getDashboard(),
    enabled: open,
  })

  const kbs = useMemo(() => kbsQuery.data?.kbs ?? [], [kbsQuery.data])
  const recentDocs = useMemo(
    () => (dashboardQuery.data?.dashboard.recentDocs ?? []).slice(0, 8),
    [dashboardQuery.data],
  )

  // 文档搜索：关键词 > 2 字符时，在「当前选中 KB 或第一个 KB」内搜索
  const keyword = useMemo(() => raw.trim(), [raw])
  const debouncedKeyword = useDebouncedValue(keyword, 300)
  const searchKbId = useMemo(
    () => kbs.find((k) => k.id === activeKbId)?.id ?? kbs[0]?.id,
    [kbs, activeKbId],
  )
  const docSearchEnabled = open && mode !== 'action' && debouncedKeyword.length >= DOC_SEARCH_MIN_CHARS && !!searchKbId
  const docSearchQuery = useQuery({
    queryKey: ['palette-docs', searchKbId, debouncedKeyword],
    queryFn: () => ragApi.listDocs(searchKbId!, { q: debouncedKeyword, limit: 8 }),
    enabled: docSearchEnabled,
    staleTime: 30_000,
  })
  const searchedDocs = useMemo(() => docSearchQuery.data?.docs ?? [], [docSearchQuery.data])

  // 加载中不展示「未找到匹配项」（避免请求未返回时误报空态）
  const suppressEmpty =
    kbsQuery.isPending || dashboardQuery.isPending || (docSearchEnabled && docSearchQuery.isFetching)

  // -- 输入处理：识别内置前缀（> 动作 / # 文档），剥离后进入对应模式 ------------------------
  const handleSearchChange = useCallback(
    (next: string) => {
      if (mode === 'all') {
        if (next.startsWith('>')) {
          setMode('action')
          setRaw(next.slice(1))
          return
        }
        if (next.startsWith('#')) {
          setMode('doc')
          setRaw(next.slice(1))
          return
        }
      }
      setRaw(next)
    },
    [mode],
  )

  const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && raw === '' && mode !== 'all') setMode('all')
  }

  // 快捷动作：视图切换 → 派发事件（目标视图 useQuickAction 监听自动执行）→ 关闭面板
  const runAction = useCallback(
    (a: QuickAction) => {
      setView(a.view)
      window.dispatchEvent(new CustomEvent(a.event, { detail: { from: 'command-palette' } }))
      close()
    },
    [setView, close],
  )

  const showNav = mode === 'all'
  const showResources = mode !== 'action' // 知识库 / 最近文档 / 文档搜索结果
  const showActions = mode !== 'doc'
  const showDocSearch = showResources && debouncedKeyword.length >= DOC_SEARCH_MIN_CHARS

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => (v ? setOpen(true) : close())}
      className="sm:max-w-[520px]"
      title="命令面板"
      description="搜索视图、知识库、文档或动作并快速跳转"
    >
      {/* 搜索行：内置前缀以模式徽标呈现（点击或空输入退格退出） */}
      <div className="relative flex items-center">
        {mode !== 'all' && (
          <button
            type="button"
            onClick={() => setMode('all')}
            title="退出模式"
            className="absolute left-10 z-10 inline-flex h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground"
          >
            {mode === 'action' ? '动作' : '文档'}
            <span aria-hidden="true" className="text-muted-foreground/60">×</span>
          </button>
        )}
        <CommandInput
          value={raw}
          onValueChange={handleSearchChange}
          onKeyDown={handleSearchKeyDown}
          placeholder="搜索视图、知识库、文档或动作…"
          aria-label="命令面板搜索"
          className={cn('flex-1', mode !== 'all' && 'pl-12')}
        />
      </div>

      <CommandList className="max-h-[420px]">
        {!suppressEmpty && <CommandEmpty>未找到匹配项</CommandEmpty>}

        {/* 1. 快速跳转：10 个视图（复用 PlatformShell 导出的 NAV_ITEMS） */}
        {showNav && (
          <CommandGroup heading="快速跳转">
            {NAV_ITEMS.map((item) => (
              <CommandItem
                key={item.id}
                value={`${item.label} ${item.hint} ${item.id}`}
                onSelect={() => {
                  setView(item.id)
                  close()
                }}
                className="text-xs"
              >
                <item.icon className="shrink-0" />
                <span className="truncate font-medium">{item.label}</span>
                <CommandShortcut className="hidden font-mono text-[10px] sm:inline-flex">{item.id}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* 2. 知识库：gotoDocs(kb.id)；空态不显示该组 */}
        {showResources && (kbs.length > 0 || kbsQuery.isPending) && (
          <CommandGroup heading="知识库">
            {kbs.length > 0 ? (
              kbs.map((kb) => (
                <CommandItem
                  key={kb.id}
                  value={`库 ${kb.name} ${kb.description ?? ''} ${kb.id}`}
                  onSelect={() => {
                    gotoDocs(kb.id)
                    close()
                  }}
                  className="text-xs"
                >
                  <Library className="shrink-0 text-emerald-500" />
                  <span className="truncate font-medium">{kb.name}</span>
                  <CommandShortcut className="hidden sm:inline-flex">
                    <span className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-normal leading-none text-muted-foreground">
                      {kb.docCount} 文档 · {kb.chunkCount} chunk
                    </span>
                  </CommandShortcut>
                </CommandItem>
              ))
            ) : (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">知识库加载中…</div>
            )}
          </CommandGroup>
        )}

        {/* 3. 最近文档：dashboard.recentDocs 前 8 条 → gotoViewer(doc.id) */}
        {showResources && recentDocs.length > 0 && (
          <CommandGroup heading="最近文档">
            {recentDocs.map((doc) => (
              <CommandItem
                key={`recent-${doc.id}`}
                value={`最近 ${doc.filename} ${doc.kbName} ${statusLabel(doc.status)}`}
                onSelect={() => {
                  gotoViewer(doc.id)
                  close()
                }}
                className="text-xs"
              >
                <FileText className="shrink-0 text-teal-500" />
                <span className="truncate font-medium">{doc.filename}</span>
                <CommandShortcut className="hidden gap-1.5 sm:inline-flex">
                  <StatusText status={doc.status} />
                  <span className="hidden max-w-[120px] truncate text-[10px] text-muted-foreground/70 md:inline">
                    {doc.kbName}
                  </span>
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* 4. 快捷动作：视图切换 + 派发 CustomEvent（目标视图 useQuickAction 监听自动执行） */}
        {showActions && (
          <CommandGroup heading="快捷动作">
            {QUICK_ACTIONS.map((a) => (
              <CommandItem
                key={a.event}
                value={`${a.label} ${a.desc} ${a.view} ${a.event}`}
                onSelect={() => runAction(a)}
                className="text-xs"
              >
                <a.icon className={cn('shrink-0', a.iconClass)} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-medium">{a.label}</span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {a.desc} · 事件 {a.event}
                  </span>
                </span>
                <CommandShortcut className="hidden font-mono text-[10px] sm:inline-flex">{a.view}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* 5. 文档搜索结果：关键词 > 2 字符时在选定 KB 内 listDocs(q) */}
        {showDocSearch && (
          <CommandGroup heading="文档搜索结果">
            {docSearchQuery.isFetching ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                正在搜索「{debouncedKeyword}」…
              </div>
            ) : docSearchQuery.isError ? (
              <div className="px-2 py-1.5 text-xs text-rose-500">搜索失败：{(docSearchQuery.error as Error)?.message}</div>
            ) : searchedDocs.length > 0 ? (
              searchedDocs.map((doc) => (
                <CommandItem
                  key={`search-${doc.id}`}
                  value={`搜索 ${doc.filename} ${statusLabel(doc.status)}`}
                  onSelect={() => {
                    gotoViewer(doc.id)
                    close()
                  }}
                  className="text-xs"
                >
                  <FileSearch className="shrink-0 text-violet-500" />
                  <span className="truncate font-medium">{doc.filename}</span>
                  <CommandShortcut className="hidden gap-1.5 sm:inline-flex">
                    <StatusText status={doc.status} />
                    <span className="font-mono text-[10px]">{doc.chunkCount} chunk</span>
                  </CommandShortcut>
                </CommandItem>
              ))
            ) : (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">当前知识库无匹配文档</div>
            )}
          </CommandGroup>
        )}
      </CommandList>

      {/* 底部快捷键提示 */}
      <div className="flex shrink-0 select-none items-center gap-3 border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>↑↓</Kbd>选择
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd>跳转
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd>关闭
        </span>
        <span className="ml-auto hidden items-center gap-2 sm:flex">
          <span className="flex items-center gap-1">
            <Kbd>&gt;</Kbd>动作
          </span>
          <span className="flex items-center gap-1">
            <Kbd>#</Kbd>文档
          </span>
        </span>
      </div>
    </CommandDialog>
  )
}

export default CommandPalette
