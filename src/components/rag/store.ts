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
  | 'testsets'
  | 'apikeys'
  | 'ops'
  | 'compare'
  | 'workbench'
  | 'activity'

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
  /** 面板登录态：null=检测中 / false=未登录（显示登录遮罩）/ true=已登录 */
  panelAuthed: boolean | null
  /** 是否仍在使用默认密码（已登录时有效，用于修改引导） */
  panelDefaultPassword: boolean

  setView: (v: ViewId) => void
  setKb: (id: string | null) => void
  setDoc: (id: string | null) => void
  setSettingsOpen: (v: boolean) => void
  setSettings: (s: RagSettings | null) => void
  setConnection: (s: ConnectionState, msg?: string) => void
  setVectorMode: (m: VectorMode | null) => void
  setPanelAuth: (authed: boolean, defaultPassword?: boolean) => void
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
  panelAuthed: null,
  panelDefaultPassword: false,

  setView: (v) => set({ activeView: v }),
  setKb: (id) => set({ activeKbId: id }),
  setDoc: (id) => set({ activeDocId: id }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setSettings: (s) => set({ settings: s }),
  setConnection: (s, msg = '') => set({ connectionStatus: s, connectionMessage: msg }),
  setVectorMode: (m) => set({ vectorMode: m }),
  setPanelAuth: (authed, defaultPassword = false) =>
    set({ panelAuthed: authed, ...(authed ? { panelDefaultPassword: defaultPassword } : {}) }),
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
