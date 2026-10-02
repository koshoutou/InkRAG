'use client'

import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster as SonnerToaster } from 'sonner'
import { useQdrantStore } from './store'
import { api } from './api'
import { AppShell } from './AppShell'
import { SettingsDialog } from './SettingsDialog'
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } },
})

function Inner() {
  const setSettings = useQdrantStore((s) => s.setSettings)
  const setConnection = useQdrantStore((s) => s.setConnection)
  const setCollections = useQdrantStore((s) => s.setCollections)
  const setCollectionsLoading = useQdrantStore((s) => s.setCollectionsLoading)
  const setCollectionsError = useQdrantStore((s) => s.setCollectionsError)
  const setActiveCollection = useQdrantStore((s) => s.setActiveCollection)
  const settings = useQdrantStore((s) => s.settings)
  const refreshFlag = useQdrantStore((s) => s.refreshCollectionsFlag)

  // Load settings once on mount.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await api.getSettings()
        if (cancelled) return
        setSettings(s)
      } catch (e) {
        setConnection('fail', `读取设置失败：${(e as Error).message}`)
      }
    })()
    return () => { cancelled = true }
  }, [setSettings, setConnection])

  // When settings become available (or refresh triggered), fetch collections.
  useEffect(() => {
    if (!settings) return
    let cancelled = false
    ;(async () => {
      setCollectionsLoading(true)
      setConnection('loading')
      try {
        const data = await api.listCollections()
        if (cancelled) return
        setCollections(data.collections)
        setCollectionsError(null)
        setConnection('ok', `已连接 · ${data.total} 个集合`)
        const cur = useQdrantStore.getState().activeCollection
        if (!cur && settings.defaultCollection) {
          const exists = data.collections.find((c) => c.name === settings.defaultCollection)
          if (exists) setActiveCollection(settings.defaultCollection)
        }
      } catch (e: any) {
        if (cancelled) return
        if (!settings.url) {
          setConnection('unknown', '尚未配置 Qdrant 地址')
          setCollectionsError(null)
        } else {
          setCollectionsError(e?.message ?? String(e))
          setConnection('fail', e?.message ?? String(e))
        }
        setCollections([])
      } finally {
        if (!cancelled) setCollectionsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [settings, refreshFlag, setCollections, setCollectionsLoading, setCollectionsError, setConnection, setActiveCollection])

  return (
    <>
      <AppShell />
      <SettingsDialog />
      <KeyboardShortcutsHelp />
      <SonnerToaster richColors position="top-right" />
    </>
  )
}

export default function QdrantKBManager() {
  return (
    <QueryClientProvider client={queryClient}>
      <Inner />
    </QueryClientProvider>
  )
}
