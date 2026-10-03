'use client'

// RAG 知识库平台 · 应用骨架
// 顶栏（logo + 连接状态 + 主题 + 设置）+ 可折叠左侧导航（窄屏 Sheet）+ 主内容区 + sticky footer

import { useState } from 'react'
import { useTheme } from 'next-themes'
import {
  Activity,
  BookOpenCheck,
  Crosshair,
  Database,
  Files,
  FlaskConical,
  GitCompareArrows,
  LayoutDashboard,
  Library,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Radio,
  Scissors,
  Search,
  Settings,
  Sun,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CommandPalette, OPEN_COMMAND_PALETTE_EVENT } from './CommandPalette'
import { usePlatformStore, type ViewId } from './store'
import { useRealtime } from './useRealtime'

export const NAV_ITEMS: { id: ViewId; label: string; icon: React.ComponentType<{ className?: string }>; hint: string }[] = [
  { id: 'dashboard', label: '仪表盘', icon: LayoutDashboard, hint: '平台总览与队列状态' },
  { id: 'kbs', label: '知识库', icon: Library, hint: '知识库与切分配置' },
  { id: 'docs', label: '文档中心', icon: Files, hint: '上传与文档流水线' },
  { id: 'viewer', label: '三屏联动', icon: BookOpenCheck, hint: '原文 / Markdown / chunk 联动' },
  { id: 'sandbox', label: '切分沙盒', icon: Scissors, hint: '无损切分参数试验' },
  { id: 'testsets', label: '测试集回归', icon: FlaskConical, hint: '金标准用例与命中率回归' },
  { id: 'apikeys', label: 'Agent API', icon: Plug, hint: '入库 API 与 Key 管理' },
  { id: 'ops', label: '系统运维', icon: Activity, hint: '健康矩阵与流水线' },
  { id: 'compare', label: '文档版本管理', icon: GitCompareArrows, hint: '版本快照 / 对比 / 恢复 / 删除' },
  { id: 'activity', label: '实时活动', icon: Radio, hint: '任务中心：解析 / 向量化进度与失败重试' },
  { id: 'workbench', label: '向量库浏览', icon: Database, hint: '基座工作台（集合/点/召回）' },
]

function RealtimeStatus() {
  const { connected } = useRealtime()
  return (
    <span className="flex items-center gap-1" role="status" aria-live="polite">
      <Radio className={cn('h-3 w-3', connected ? 'text-emerald-500' : 'text-muted-foreground')} />
      {connected ? '实时事件通道已连接' : '实时通道连接中…'}
      <span
        className={cn(
          'ml-0.5 inline-block h-1.5 w-1.5 rounded-full',
          connected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500 animate-pulse',
        )}
      />
    </span>
  )
}

function ConnDot() {
  const conn = usePlatformStore((s) => s.connectionStatus)
  const msg = usePlatformStore((s) => s.connectionMessage)
  const vectorMode = usePlatformStore((s) => s.vectorMode)
  const map: Record<string, string> = {
    unknown: 'bg-muted-foreground/40 ring-muted-foreground/20',
    ok: vectorMode === 'qdrant' ? 'bg-emerald-500 ring-emerald-500/20 animate-pulse' : 'bg-amber-500 ring-amber-500/20 animate-pulse',
    fail: 'bg-rose-500 ring-rose-500/20',
    loading: 'bg-amber-500 ring-amber-500/20 animate-pulse',
  }
  const text =
    conn === 'ok'
      ? vectorMode === 'qdrant'
        ? 'Qdrant 已连接'
        : '未配置 Qdrant（请到设置中配置）'
      : conn === 'fail'
        ? msg || '连接失败'
        : conn === 'loading'
          ? '检测连接中…'
          : '未配置'
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full ring-2', map[conn] ?? map.unknown)} />
            <span className="hidden max-w-[280px] truncate sm:inline">{text}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="text-xs">{msg || text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function NavList({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const activeView = usePlatformStore((s) => s.activeView)
  const setView = usePlatformStore((s) => s.setView)
  return (
    <nav aria-label="主导航" className="flex flex-col gap-0.5 px-2 py-2">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon
        const active = activeView === item.id
        const btn = (
          <button
            type="button"
            onClick={() => {
              setView(item.id)
              onNavigate?.()
            }}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors',
              active
                ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              collapsed && 'justify-center px-0',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </button>
        )
        return collapsed ? (
          <TooltipProvider key={item.id}>
            <Tooltip>
              <TooltipTrigger asChild>{btn}</TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                <div className="font-medium">{item.label}</div>
                <div className="text-muted-foreground">{item.hint}</div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <div key={item.id}>{btn}</div>
        )
      })}
    </nav>
  )
}

function ThemeToggleButton() {
  const { theme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      title="切换主题"
      aria-label="切换深浅主题"
    >
      <Sun className="h-4 w-4 dark:hidden" />
      <Moon className="hidden h-4 w-4 dark:block" />
    </Button>
  )
}

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const setSettingsOpen = usePlatformStore((s) => s.setSettingsOpen)
  const settings = usePlatformStore((s) => s.settings)
  const vectorMode = usePlatformStore((s) => s.vectorMode)
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {/* 顶栏 */}
      <header className="sticky top-0 z-30 shrink-0 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/65">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
          {/* 移动端菜单 */}
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" aria-label="打开导航">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetTitle className="sr-only">导航菜单</SheetTitle>
              <div className="flex h-12 items-center gap-2 border-b border-border/60 px-4">
                <div className="flex h-6 w-6 items-center justify-center rounded bg-primary/10 text-primary ring-1 ring-primary/20">
                  <Database className="h-3.5 w-3.5" />
                </div>
                <span className="text-sm font-semibold">InkRAG 知识库管理平台</span>
              </div>
              <NavList onNavigate={() => setMobileNavOpen(false)} />
            </SheetContent>
          </Sheet>

          {/* logo */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
              <Database className="h-4 w-4" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight">InkRAG 知识库管理平台</span>
              <span className="hidden text-[10px] text-muted-foreground sm:block">Lightweight RAG Knowledge Base</span>
            </div>
          </div>

          <div className="ml-3 hidden sm:block">
            <ConnDot />
          </div>

          {/* 命令面板入口（Ctrl+K）：插在 ConnDot 之后、主题按钮之前 */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))}
                  aria-label="打开命令面板（Ctrl+K）"
                  className="ml-2 flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                >
                  <Search className="h-3.5 w-3.5" />
                  <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:inline-flex">
                    Ctrl K
                  </kbd>
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">命令面板 Ctrl+K</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="hidden h-8 w-8 md:inline-flex"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? '展开导航' : '折叠导航'}
              aria-label="折叠/展开导航"
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
            <ThemeToggleButton />
            <Button variant="default" size="sm" className="h-8 gap-1.5" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">设置</span>
            </Button>
          </div>
        </div>
        {/* 移动端连接状态 */}
        <div className="flex items-center gap-2 border-t border-border/40 px-4 py-1 sm:hidden">
          <ConnDot />
        </div>
      </header>

      {/* 主体：侧边导航 + 内容 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className={cn(
            'hidden shrink-0 flex-col border-r border-border/60 bg-muted/20 transition-all md:flex',
            collapsed ? 'w-14' : 'w-52',
          )}
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/40 px-4 pt-2">
            {!collapsed && <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">功能导航</span>}
          </div>
          <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
            <NavList collapsed={collapsed} />
          </div>
          {!collapsed && (
            <div className="shrink-0 border-t border-border/40 px-3 py-2.5 text-[10px] leading-relaxed text-muted-foreground">
              <RealtimeStatus />
              <span className="mt-0.5 block opacity-70">上传 / 切分 / 检索全程可观测</span>
            </div>
          )}
        </aside>

        {/* 主内容区：原生滚动（修复 ScrollArea 与 flex 布局交互异常，滚动统一收敛到 main） */}
        <main className="min-w-0 flex-1 overflow-y-auto" aria-label="主内容区">
          {children}
        </main>
      </div>

      {/* Sticky footer */}
      <footer className="mt-auto shrink-0 border-t border-border/60 bg-background/85 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[11px] text-muted-foreground">
          <span className="font-medium">InkRAG 知识库管理平台 v1.0</span>
          <span className="opacity-40">·</span>
          {vectorMode === 'qdrant' ? (
            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-300">
              Qdrant 模式
            </Badge>
          ) : vectorMode === 'unconfigured' ? (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-300">
              未配置 Qdrant
            </Badge>
          ) : (
            <span>向量引擎未检测</span>
          )}
          <span className="opacity-40">·</span>
          <span>
            Embedding:{' '}
            <span className="font-mono">
              {settings?.embedModel || (settings?.useMockEmbedding === false ? '未配置（未启用 Mock）' : 'Mock 嵌入')}
            </span>
          </span>
          <span className="ml-auto hidden items-center gap-1 sm:flex">
            <BookOpenCheck className="h-3 w-3" />
            对标 RAGFlow 可视化体验
          </span>
          <span className="ml-1 hidden items-center gap-1 sm:flex">
            <span className="opacity-40">·</span>
            <a
              href="https://github.com/Koshoutou"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-foreground hover:underline"
              title="GitHub 开源地址"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3 fill-current">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              Koshoutou
            </a>
          </span>
        </div>
      </footer>

      {/* 全局命令面板（Ctrl+K）：快速导航 + 资源跳转 + 快捷动作 */}
      <CommandPalette />
    </div>
  )
}
