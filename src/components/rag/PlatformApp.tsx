'use client'

// RAG 知识库平台 · 应用入口
// QueryClientProvider + next-themes + 全局 socket + 视图路由
// 各视图 dynamic import，避免首屏打包过重（按需加载独立 chunk）

import { useEffect } from 'react'
import dynamic from 'next/dynamic'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { ThemeProvider } from 'next-themes'
import { Toaster } from '@/components/ui/sonner'
import { ragApi } from './api'
import { PlatformShell } from './PlatformShell'
import { RagSettingsDialog } from './RagSettingsDialog'
import { usePlatformStore } from './store'
import { useRealtime } from './useRealtime'

function ViewLoading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center gap-2 text-muted-foreground" role="status" aria-label="视图加载中">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-xs">视图加载中…</span>
    </div>
  )
}

// 视图懒加载（独立 chunk，首次切换时按需拉取）
const DashboardView = dynamic(() => import('./views/DashboardView').then((m) => m.DashboardView), { loading: ViewLoading })
const KnowledgeBasesView = dynamic(() => import('./views/KnowledgeBasesView').then((m) => m.KnowledgeBasesView), { loading: ViewLoading })
const DocumentsView = dynamic(() => import('./views/DocumentsView').then((m) => m.DocumentsView), { loading: ViewLoading })
const ViewerView = dynamic(() => import('./views/ViewerView').then((m) => m.ViewerView), { loading: ViewLoading })
const SandboxView = dynamic(() => import('./views/SandboxView').then((m) => m.SandboxView), { loading: ViewLoading })
const RetrievalDebugView = dynamic(() => import('./views/RetrievalDebugView').then((m) => m.RetrievalDebugView), { loading: ViewLoading })
const TestSetsView = dynamic(() => import('./views/TestSetsView').then((m) => m.TestSetsView), { loading: ViewLoading })
const ApiKeysView = dynamic(() => import('./views/ApiKeysView').then((m) => m.ApiKeysView), { loading: ViewLoading })
const OpsView = dynamic(() => import('./views/OpsView').then((m) => m.OpsView), { loading: ViewLoading })
const DocCompareView = dynamic(() => import('./views/DocCompareView').then((m) => m.DocCompareView), { loading: ViewLoading })
const WorkbenchView = dynamic(() => import('./views/WorkbenchView').then((m) => m.WorkbenchView), { loading: ViewLoading })
const TaskCenterView = dynamic(() => import('./views/TaskCenterView').then((m) => m.TaskCenterView), { loading: ViewLoading })

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 15_000 },
  },
})

/** 初始化：拉取设置与健康状态，判定连接模式；订阅全局 socket 事件做级联刷新 */
function Inner() {
  const setSettings = usePlatformStore((s) => s.setSettings)
  const setConnection = usePlatformStore((s) => s.setConnection)
  const setVectorMode = usePlatformStore((s) => s.setVectorMode)
  const queryCtl = useQueryClient()
  const { subscribeRooms, on } = useRealtime()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await ragApi.getSettings()
        if (!cancelled) setSettings(s)
      } catch {
        /* 设置读取失败不阻塞 UI */
      }
      try {
        const r = await ragApi.getHealth()
        if (cancelled) return
        const mode = r.health.vectorStore?.mode
        // v1.6：两态 qdrant | unconfigured（本地引擎已移除；未配置时提示引导配置）
        setVectorMode(mode === 'qdrant' ? 'qdrant' : 'unconfigured')
        setConnection('ok', mode === 'qdrant' ? 'Qdrant 已连接' : '未配置 Qdrant（请到「设置 → Qdrant」配置）')
      } catch (e) {
        if (!cancelled) setConnection('fail', `健康检查失败：${(e as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setSettings, setConnection, setVectorMode])

  // 全局 socket：文档状态变化 → 刷新仪表盘 / 知识库统计
  useEffect(() => {
    subscribeRooms(['global'])
    const refreshStats = () => {
      queryCtl.invalidateQueries({ queryKey: ['dashboard'] })
      queryCtl.invalidateQueries({ queryKey: ['kbs'] })
    }
    const un1 = on('document:status', refreshStats)
    const un2 = on('document:done', refreshStats)
    const un3 = on('kb:stats', refreshStats)
    return () => {
      un1()
      un2()
      un3()
    }
  }, [subscribeRooms, on, queryCtl])

  const activeView = usePlatformStore((s) => s.activeView)

  return (
    <>
      <PlatformShell>
        {/* key 让视图切换时重置内部滚动 */}
        {activeView === 'dashboard' && <DashboardView key="dashboard" />}
        {activeView === 'kbs' && <KnowledgeBasesView key="kbs" />}
        {activeView === 'docs' && <DocumentsView key="docs" />}
        {activeView === 'viewer' && <ViewerView key="viewer" />}
        {activeView === 'sandbox' && <SandboxView key="sandbox" />}
        {activeView === 'retrieval' && <RetrievalDebugView key="retrieval" />}
        {activeView === 'testsets' && <TestSetsView key="testsets" />}
        {activeView === 'apikeys' && <ApiKeysView key="apikeys" />}
        {activeView === 'ops' && <OpsView key="ops" />}
        {activeView === 'compare' && <DocCompareView key="compare" />}
        {activeView === 'workbench' && <WorkbenchView key="workbench" />}
        {activeView === 'activity' && <TaskCenterView key="activity" />}
      </PlatformShell>
      <RagSettingsDialog />
    </>
  )
}

export default function PlatformApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <Inner />
        <Toaster richColors position="top-right" />
      </ThemeProvider>
    </QueryClientProvider>
  )
}
