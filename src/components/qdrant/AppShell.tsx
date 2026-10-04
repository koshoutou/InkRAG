'use client'

import { useTheme } from 'next-themes'
import { Database, Settings, RefreshCw, Sun, Moon, BookOpen, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useQdrantStore } from './store'
import { Sidebar } from './Sidebar'
import { CollectionOverview } from './CollectionOverview'
import { PointsBrowser } from './PointsBrowser'
import { RetrievalTest } from './RetrievalTest'
import { CallLogsPanelTrigger } from './CallLogsPanel'

function ConnDot({ status }: { status: 'unknown' | 'ok' | 'fail' | 'loading' }) {
  const map: Record<string, string> = {
    unknown: 'bg-muted-foreground/40 ring-muted-foreground/20',
    ok: 'bg-emerald-500 ring-emerald-500/20 animate-pulse',
    fail: 'bg-rose-500 ring-rose-500/20',
    loading: 'bg-amber-500 ring-amber-500/20 animate-pulse',
  }
  return <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ring-2 ${map[status] ?? map.unknown}`} />
}

export function AppShell() {
  const { theme, setTheme } = useTheme()
  const conn = useQdrantStore((s) => s.connectionStatus)
  const connMsg = useQdrantStore((s) => s.connectionMessage)
  const setSettingsOpen = useQdrantStore((s) => s.setSettingsOpen)
  const triggerRefresh = useQdrantStore((s) => s.triggerRefreshCollections)
  const collectionsLoading = useQdrantStore((s) => s.collectionsLoading)
  const activeCollection = useQdrantStore((s) => s.activeCollection)
  const activeTab = useQdrantStore((s) => s.activeTab)
  const setActiveTab = useQdrantStore((s) => s.setActiveTab)
  const settings = useQdrantStore((s) => s.settings)

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/65">
        <div className="flex h-14 items-center gap-3 px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
              <Database className="h-4 w-4" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight">Qdrant 检索工作台</span>
              <span className="text-[10px] text-muted-foreground">Qdrant Workbench · 浏览 · 检索 · 召回测试 · 测试日志</span>
            </div>
          </div>

          <div className="ml-3 hidden items-center gap-2 sm:flex">
            <ConnDot status={conn} />
            <span className="text-xs text-muted-foreground max-w-[360px] truncate">
              {connMsg || (conn === 'unknown' ? '未配置' : '就绪')}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={triggerRefresh}
              disabled={collectionsLoading}
              title="刷新集合列表 (r)"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${collectionsLoading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">刷新</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title="切换主题 (t)"
            >
              <Sun className="h-4 w-4 dark:hidden" />
              <Moon className="hidden h-4 w-4 dark:block" />
            </Button>
            <Button
              variant="default"
              size="sm"
              className="gap-1.5"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="h-3.5 w-3.5" />
              <span>设置</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Body: sidebar + main */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 lg:px-8">
            {!activeCollection ? (
              <EmptyCollectionHint />
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold tracking-tight">
                      <span className="font-mono">{activeCollection}</span>
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      在右侧切换视图：集合概览、分块浏览、检索召回、检索测试日志。
                    </p>
                  </div>
                  <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
                    <TabsList className="h-9">
                      <TabsTrigger value="overview" className="text-xs">概览</TabsTrigger>
                      <TabsTrigger value="chunks" className="text-xs">分块</TabsTrigger>
                      <TabsTrigger value="retrieval" className="text-xs">检索召回</TabsTrigger>
                      <TabsTrigger value="logs" className="text-xs">检索测试日志</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>

                {activeTab === 'overview' && <CollectionOverview key={activeCollection} />}
                {activeTab === 'chunks' && <PointsBrowser key={activeCollection} />}
                {activeTab === 'retrieval' && <RetrievalTest key={activeCollection} />}
                {activeTab === 'logs' && <CallLogsPanelTrigger key={activeCollection} />}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Sticky footer */}
      <footer className="mt-auto border-t border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[11px] text-muted-foreground sm:px-6 lg:px-8">
          <div className="flex items-center gap-1.5">
            <BookOpen className="h-3 w-3" />
            <span>Qdrant 检索工作台 v{process.env.INKRAG_VERSION}</span>
          </div>
          <span className="opacity-40">·</span>
          <span>纯 Next.js 轻量实现</span>
          <span className="opacity-40">·</span>
          <span>Embedding: {settings?.embedModel ? <span className="font-mono">{settings.embedModel}</span> : '未配置'}</span>
          {settings?.rerankModel && (
            <>
              <span className="opacity-40">·</span>
              <span>Rerank: <span className="font-mono">{settings.rerankModel}</span></span>
            </>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <ScrollText className="h-3 w-3" />
            <span>受 Dify 知识库模块启发 · 去掉工作流与上传</span>
          </span>
        </div>
      </footer>
    </div>
  )
}

function EmptyCollectionHint() {
  const setSettingsOpen = useQdrantStore((s) => s.setSettingsOpen)
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 rounded-2xl border border-dashed border-border/70 bg-muted/20 p-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
        <Database className="h-7 w-7" />
      </div>
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold">连接你的 Qdrant 实例</h3>
        <p className="text-sm text-muted-foreground">
          先在「设置」中填写 Qdrant 服务地址（和可选的 API Key），
          连接成功后侧边栏会列出你的所有集合。
        </p>
      </div>
      <Button onClick={() => setSettingsOpen(true)} size="sm">
        <Settings className="h-3.5 w-3.5 mr-1.5" />
        打开设置
      </Button>
      <Skeleton className="hidden" />
    </div>
  )
}
