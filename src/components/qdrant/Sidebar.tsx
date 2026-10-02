'use client'

import { useState } from 'react'
import { Database, Search, Inbox, Layers, RefreshCw, Settings } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { api } from './api'
import { useQdrantStore } from './store'

export function Sidebar() {
  const collections = useQdrantStore((s) => s.collections)
  const loading = useQdrantStore((s) => s.collectionsLoading)
  const error = useQdrantStore((s) => s.collectionsError)
  const conn = useQdrantStore((s) => s.connectionStatus)
  const settings = useQdrantStore((s) => s.settings)
  const active = useQdrantStore((s) => s.activeCollection)
  const setActive = useQdrantStore((s) => s.setActiveCollection)
  const triggerRefresh = useQdrantStore((s) => s.triggerRefreshCollections)
  const setSettingsOpen = useQdrantStore((s) => s.setSettingsOpen)
  const [filter, setFilter] = useState('')

  // Also keep a fresh copy via react-query so we have finer-grained refetch in the future.
  useQuery({
    queryKey: ['qdrant-collections'],
    queryFn: () => api.listCollections(),
    enabled: false,
  })

  const filtered = collections.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
  const notConfigured = !settings?.url && conn !== 'loading'

  return (
    <aside className="hidden w-[260px] shrink-0 border-r border-border/60 bg-muted/20 md:flex md:flex-col">
      <div className="flex h-12 items-center gap-2 px-4 pb-1 pt-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          集合列表
        </span>
        <Badge variant="secondary" className="ml-auto text-[10px] font-mono">
          {collections.length}
        </Badge>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤集合名..."
            className="h-8 pl-7 text-xs"
            disabled={notConfigured || collections.length === 0}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25">
        {loading ? (
          <div className="space-y-2 px-1 pt-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : notConfigured ? (
          <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/20">
              <Database className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium">尚未配置 Qdrant</p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                请先在「设置」中填写 Qdrant 服务地址与密钥
              </p>
            </div>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-3 w-3 mr-1" />
              打开设置
            </Button>
          </div>
        ) : error ? (
          <div className="px-3 py-6 text-center text-xs text-rose-500">
            <p className="font-medium">加载失败</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" className="mt-3 h-7 text-xs" onClick={triggerRefresh}>
              <RefreshCw className="h-3 w-3 mr-1" />
              重试
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-muted-foreground">
            <Inbox className="h-6 w-6 opacity-60" />
            <p className="text-xs">{collections.length === 0 ? '没有集合' : '没有匹配的集合'}</p>
          </div>
        ) : (
          <ul className="space-y-1 px-1">
            {filtered.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  onClick={() => setActive(c.name)}
                  className={cn(
                    'group w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                    active === c.name
                      ? 'border-primary/40 bg-primary/10 ring-1 ring-primary/20'
                      : 'border-transparent hover:border-border/60 hover:bg-background'
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Database
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        active === c.name ? 'text-primary' : 'text-muted-foreground'
                      )}
                    />
                    <span className="truncate text-xs font-medium">{c.name}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-1.5">
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-mono">
                      {c.points_count?.toLocaleString?.() ?? 0}
                    </Badge>
                    <Badge variant="secondary" className="h-4 truncate px-1.5 text-[10px]">
                      {c.type?.split(' ')[0] ?? '—'}
                    </Badge>
                  </div>
                  {c.status && c.status !== 'green' && (
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                      <Layers className="h-2.5 w-2.5" />
                      <span>状态: {c.status}</span>
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
