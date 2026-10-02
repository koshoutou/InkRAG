'use client'

// RAG 知识库平台 · 全局状态（zustand）
// 平台级 store（视图路由 / 上下文 / 连接状态）+ 三屏联动 viewer store
import { create } from 'zustand'
import type { RagSettings, VectorMode } from './types'

export type ViewId =
  | 'dashboard'
  | 'kbs'
  | 'docs'
  | 'viewer'
  | 'sandbox'
  | 'retrieval'
  | 'testsets'
  | 'apikeys'
  | 'ops'
  | 'compare'
  | 'workbench'

export type ConnectionState = 'unknown' | 'ok' | 'fail' | 'loading'

interface PlatformStore {
  activeView: ViewId
  activeKbId: string | null
  activeDocId: string | null
  settingsOpen: boolean
  settings: RagSettings | null
  connectionStatus: ConnectionState
  connectionMessage: string
  vectorMode: VectorMode | null
  /** 跨视图下钻：趋势图点击某天 → 检索调试台按日期过滤历史（'YYYY-MM-DD'，消费后由目标视图清除） */
  retrievalDateFilter: string | null

  setView: (v: ViewId) => void
  setKb: (id: string | null) => void
  setDoc: (id: string | null) => void
  setSettingsOpen: (v: boolean) => void
  setSettings: (s: RagSettings | null) => void
  setConnection: (s: ConnectionState, msg?: string) => void
  setVectorMode: (m: VectorMode | null) => void
  setRetrievalDateFilter: (d: string | null) => void
}

export const usePlatformStore = create<PlatformStore>((set) => ({
  activeView: 'dashboard',
  activeKbId: null,
  activeDocId: null,
  settingsOpen: false,
  settings: null,
  connectionStatus: 'unknown',
  connectionMessage: '',
  vectorMode: null,
  retrievalDateFilter: null,

  setView: (v) => set({ activeView: v }),
  setKb: (id) => set({ activeKbId: id }),
  setDoc: (id) => set({ activeDocId: id }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setSettings: (s) => set({ settings: s }),
  setConnection: (s, msg = '') => set({ connectionStatus: s, connectionMessage: msg }),
  setVectorMode: (m) => set({ vectorMode: m }),
  setRetrievalDateFilter: (d) => set({ retrievalDateFilter: d }),
}))

/** 跨视图快捷跳转：进入某知识库的文档中心 */
export function gotoDocs(kbId: string) {
  const st = usePlatformStore.getState()
  st.setKb(kbId)
  st.setView('docs')
}

/** 跨视图快捷跳转：进入某文档的三屏联动视图（可选预选 chunk） */
export function gotoViewer(docId: string, chunkId?: string) {
  const st = usePlatformStore.getState()
  st.setDoc(docId)
  useViewerStore.getState().selectChunk(chunkId ?? null)
  st.setView('viewer')
}

// ---------------------------------------------------------------------------
// 三屏联动 viewer store
// ---------------------------------------------------------------------------

interface ViewerStore {
  docId: string | null
  selectedChunkId: string | null
  /** 选中 chunk 的父 chunk 字符范围（用于中屏虚线描边），由 ViewerView 数据推导写入 */
  selectedParentRange: { charStart: number; charEnd: number } | null
  setDocId: (id: string | null) => void
  selectChunk: (id: string | null) => void
  setParentRange: (r: { charStart: number; charEnd: number } | null) => void
}

export const useViewerStore = create<ViewerStore>((set) => ({
  docId: null,
  selectedChunkId: null,
  selectedParentRange: null,
  setDocId: (id) => set({ docId: id, selectedChunkId: null, selectedParentRange: null }),
  selectChunk: (id) => set({ selectedChunkId: id, selectedParentRange: null }),
  setParentRange: (r) => set({ selectedParentRange: r }),
}))
