'use client'

// 向量库浏览（集成基座工作台）
// 复用基座 CollectionOverview / PointsBrowser / RetrievalTest / CallLogsPanel；
// 基座 store 独立使用，不与平台 store 混淆。

import { useEffect, useState } from 'react'
import { Database, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api as qdrantApi } from '@/components/qdrant/api'
import { CallLogsPanelTrigger } from '@/components/qdrant/CallLogsPanel'
import { CollectionOverview } from '@/components/qdrant/CollectionOverview'
import { PointsBrowser } from '@/components/qdrant/PointsBrowser'
import { RetrievalTest } from '@/components/qdrant/RetrievalTest'
import { useQdrantStore } from '@/components/qdrant/store'
import { cn } from '@/lib/utils'
import { usePlatformStore } from '../store'
import { ErrorCard, ViewPage, formatNumber } from '../ui'

export function WorkbenchView() {
  const vectorMode = usePlatformStore((s) => s.vectorMode)
  const collections = useQdrantStore((s) => s.collections)
  const loading = useQdrantStore((s) => s.collectionsLoading)
  const error = useQdrantStore((s) => s.collectionsError)
  const settings = useQdrantStore((s) => s.settings)
  const activeCollection = useQdrantStore((s) => s.activeCollection)
  const setActiveCollection = useQdrantStore((s) => s.setActiveCollection)
  const [tab, setTab] = useState<'overview' | 'chunks' | 'retrieval' | 'logs'>('overview')
  const [refreshFlag, setRefreshFlag] = useState(0)

  // 挂载：加载基座设置与集合列表（与基座 QdrantKBManager 相同的数据流）
  useEffect(() => {
    let cancelled = false
    const store = useQdrantStore.getState()
    ;(async () => {
      try {
        const s = await qdrantApi.getSettings()
        if (!cancelled) store.setSettings(s)
      } catch (e) {
        if (!cancelled) store.setConnection('fail', `读取设置失败：${(e as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // settings 或手动刷新 → 拉集合
  useEffect(() => {
    let cancelled = false
    if (!settings) return
    const store = useQdrantStore.getState()
    ;(async () => {
      store.setCollectionsLoading(true)
      store.setConnection('loading')
      try {
        const data = await qdrantApi.listCollections()
        if (cancelled) return
        store.setCollections(data.collections)
        store.setCollectionsError(null)
        store.setConnection('ok', `Qdrant 已连接 · ${data.total} 个集合`)
      } catch (e) {
        if (cancelled) return
        store.setCollectionsError((e as Error).message)
        store.setConnection('fail', (e as Error).message)
        store.setCollections([])
      } finally {
        if (!cancelled) store.setCollectionsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [settings, refreshFlag])

  return (
    <ViewPage wide>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Database className="h-5 w-5 text-primary" />
            向量库浏览
            <Badge variant="outline" className={cn('text-[10px]', vectorMode === 'qdrant' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300')}>
              {vectorMode === 'qdrant' ? 'Qdrant 模式' : '未配置 Qdrant'}
            </Badge>
          </h2>
          <p className="text-xs text-muted-foreground">
            浏览平台的向量集合（Qdrant）。v1.6 起向量数据统一写入 Qdrant，未配置或不可达时无法浏览/入库（不降级本地存储）。
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" disabled={loading} onClick={() => setRefreshFlag((f) => f + 1)}>
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          刷新集合
        </Button>
      </div>

      {/* 集合选择器 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">集合</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-44 rounded-lg" />
              ))}
            </div>
          ) : error ? (
            <ErrorCard title="集合列表加载失败" message={error} onRetry={() => setRefreshFlag((f) => f + 1)} />
          ) : collections.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              暂无集合 —— 在「知识库」创建库后，平台会自动创建对应向量集合。
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {collections.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => {
                    setActiveCollection(c.name)
                    setTab('overview')
                  }}
                  className={cn(
                    'w-44 rounded-lg border px-3 py-2 text-left transition-colors',
                    activeCollection === c.name
                      ? 'border-primary/40 bg-primary/10 ring-1 ring-primary/20'
                      : 'border-border/60 bg-card hover:border-border hover:bg-muted/40',
                  )}
                >
                  <div className="truncate text-xs font-medium">{c.name}</div>
                  <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="font-mono">{formatNumber(c.points_count)} 点</span>
                    <span className={cn('h-1.5 w-1.5 rounded-full', c.status === 'green' ? 'bg-emerald-500' : 'bg-amber-500')} title={c.status} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 基座面板 */}
      {activeCollection ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-mono text-sm font-semibold">{activeCollection}</h3>
            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
              <TabsList className="h-8">
                <TabsTrigger value="overview" className="text-xs">概览</TabsTrigger>
                <TabsTrigger value="chunks" className="text-xs">分块浏览</TabsTrigger>
                <TabsTrigger value="retrieval" className="text-xs">检索召回</TabsTrigger>
                <TabsTrigger value="logs" className="text-xs">检索测试日志</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {tab === 'overview' && <CollectionOverview key={activeCollection} />}
          {tab === 'chunks' && <PointsBrowser key={activeCollection} />}
          {tab === 'retrieval' && <RetrievalTest key={activeCollection} />}
          {tab === 'logs' && <CallLogsPanelTrigger key={activeCollection} />}
        </div>
      ) : (
        <p className="py-10 text-center text-xs text-muted-foreground">选择上方集合后在此浏览详情</p>
      )}
    </ViewPage>
  )
}
