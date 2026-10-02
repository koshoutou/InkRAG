'use client'
import { create } from 'zustand'
import type { QdrantSettings, CollectionSummary } from './types'

interface QdrantStore {
  settings: QdrantSettings | null
  settingsOpen: boolean
  callLogsOpen: boolean
  connectionStatus: 'unknown' | 'ok' | 'fail' | 'loading'
  connectionMessage: string

  collections: CollectionSummary[]
  collectionsLoading: boolean
  collectionsError: string | null
  activeCollection: string | null

  // active tab. 'history' is removed; merged into 'logs'.
  activeTab: 'overview' | 'chunks' | 'retrieval' | 'logs'

  setSettings: (s: QdrantSettings | null) => void
  setSettingsOpen: (v: boolean) => void
  setCallLogsOpen: (v: boolean) => void
  setConnection: (s: 'unknown' | 'ok' | 'fail' | 'loading', msg?: string) => void
  setCollections: (c: CollectionSummary[]) => void
  setCollectionsLoading: (v: boolean) => void
  setCollectionsError: (e: string | null) => void
  setActiveCollection: (name: string | null) => void
  setActiveTab: (t: 'overview' | 'chunks' | 'retrieval' | 'logs') => void
  refreshCollectionsFlag: number
  triggerRefreshCollections: () => void
}

export const useQdrantStore = create<QdrantStore>((set) => ({
  settings: null,
  settingsOpen: false,
  callLogsOpen: false,
  connectionStatus: 'unknown',
  connectionMessage: '',
  collections: [],
  collectionsLoading: false,
  collectionsError: null,
  activeCollection: null,
  activeTab: 'overview',
  refreshCollectionsFlag: 0,

  setSettings: (s) => set({ settings: s }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setCallLogsOpen: (v) => set({ callLogsOpen: v }),
  setConnection: (s, msg = '') => set({ connectionStatus: s, connectionMessage: msg }),
  setCollections: (c) => set({ collections: c }),
  setCollectionsLoading: (v) => set({ collectionsLoading: v }),
  setCollectionsError: (e) => set({ collectionsError: e }),
  setActiveCollection: (name) => set({ activeCollection: name, activeTab: 'overview' }),
  setActiveTab: (t) => set({ activeTab: t }),
  triggerRefreshCollections: () => set((s) => ({ refreshCollectionsFlag: s.refreshCollectionsFlag + 1 })),
}))
