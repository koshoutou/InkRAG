'use client'

// 批量上传 / URL 导入对话框（契约 §26 UI 端）
//
// 容器持有全部任务状态（对话框关闭仅卸载 DOM，上传/流水线/事件在后台继续，重开可见进度）：
//   - 本地文件：XHR 字节级上传进度（并发 2）→ socket 六状态机阶段进度 → ready/failed/dedup 终态
//   - URL 导入：逐 URL 调 POST /import-url（并发 2）；sitemap 响应 → 展开子链接自动入队（会话 ≤30）
// 事件源：socket.io kb:{kbId} 房间 document:status / document:progress / document:done

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ragApi, uploadDocument } from '../../api'
import { useRealtime } from '../../useRealtime'
import type { DocumentDoneEvent, DocumentProgressEvent, DocumentStatusEvent, DocStatus } from '../../types'
import { LocalFileTab } from './LocalFileTab'
import { UrlImportTab, MAX_URLS } from './UrlImportTab'
import type { FileTask, UrlTask } from './shared'

const UPLOAD_CONCURRENCY = 2
const URL_CONCURRENCY = 2
const VALID_DOC_STATUSES = new Set<DocStatus>([
  'queued', 'parsing', 'chunking', 'embedding', 'upserting', 'ready', 'failed',
])

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function BatchUploadDialog({
  kbId,
  open,
  onOpenChange,
}: {
  kbId: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { subscribeRooms, on } = useRealtime()

  const [tab, setTab] = useState<'local' | 'url'>('local')
  const [fileTasks, setFileTasks] = useState<FileTask[]>([])
  const [urlTasks, setUrlTasks] = useState<UrlTask[]>([])

  // ref 镜像（异步闭包内始终读最新任务表；所有变更经 update*Task 单点写穿）
  const fileTasksRef = useRef<FileTask[]>([])
  const urlTasksRef = useRef<UrlTask[]>([])
  const kbIdRef = useRef<string | null>(kbId)
  const fileQueueRef = useRef<string[]>([])
  const fileActiveRef = useRef(0)
  const urlQueueRef = useRef<string[]>([])
  const urlActiveRef = useRef(0)
  const urlSessionCountRef = useRef(0)

  useEffect(() => {
    kbIdRef.current = kbId
  }, [kbId])

  const updateFileTask = useCallback((id: string, patch: Partial<FileTask>) => {
    fileTasksRef.current = fileTasksRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t))
    setFileTasks(fileTasksRef.current)
  }, [])

  const updateUrlTask = useCallback((id: string, patch: Partial<UrlTask>) => {
    urlTasksRef.current = urlTasksRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t))
    setUrlTasks(urlTasksRef.current)
  }, [])

  const invalidate = useCallback(() => {
    const kb = kbIdRef.current
    if (!kb) return
    queryClient.invalidateQueries({ queryKey: ['docs', kb] })
    queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    queryClient.invalidateQueries({ queryKey: ['kbs'] })
  }, [queryClient])

  // -------------------------------------------------------------------------
  // 本地文件：上传队列（并发 2）。普通函数 + ref 读写（无 memo，避免 pump↔run 循环依赖）
  // -------------------------------------------------------------------------

  async function pumpFiles(): Promise<void> {
    while (fileQueueRef.current.length > 0 && fileActiveRef.current < UPLOAD_CONCURRENCY) {
      const id = fileQueueRef.current.shift()!
      fileActiveRef.current++
      void runFileUpload(id).finally(() => {
        fileActiveRef.current--
        void pumpFiles()
      })
    }
  }

  async function runFileUpload(id: string): Promise<void> {
    const task = fileTasksRef.current.find((t) => t.id === id)
    const kb = kbIdRef.current
    if (!task || !kb) {
      updateFileTask(id, { phase: 'failed', errorCode: 'UPLOAD_FAILED', errorMessage: '知识库未选择', endedAt: Date.now() })
      return
    }
    updateFileTask(id, {
      phase: 'uploading',
      startedAt: Date.now(),
      uploadPct: 0,
      status: undefined,
      stageProgress: 0,
      errorCode: undefined,
      errorMessage: undefined,
      chunkCount: undefined,
      tookMs: undefined,
      endedAt: undefined,
    })
    try {
      const r = await uploadDocument(kb, task.file, (p) => {
        updateFileTask(id, { uploadPct: Math.round(p * 100) })
      })
      if (r.deduplicated) {
        updateFileTask(id, { phase: 'dedup', uploadPct: 100, docId: r.doc?.id, endedAt: Date.now() })
        toast.info(`「${task.file.name}」秒传命中：同内容文档已存在`)
      } else {
        updateFileTask(id, {
          phase: 'pipeline',
          uploadPct: 100,
          status: 'queued',
          stageProgress: 0,
          docId: r.doc?.id,
        })
      }
      invalidate()
    } catch (e) {
      updateFileTask(id, {
        phase: 'failed',
        errorCode: 'UPLOAD_FAILED',
        errorMessage: (e as Error).message,
        uploadPct: 0,
        endedAt: Date.now(),
      })
    }
  }

  const addFiles = useCallback((files: File[]) => {
    const kb = kbIdRef.current
    if (!kb) {
      toast.error('请先选择知识库')
      return
    }
    const tasks: FileTask[] = files.map((file) => ({
      id: newId(),
      file,
      uploadPct: 0,
      phase: 'waiting',
      stageProgress: 0,
    }))
    fileTasksRef.current = [...tasks, ...fileTasksRef.current]
    setFileTasks(fileTasksRef.current)
    fileQueueRef.current.push(...tasks.map((t) => t.id))
    void pumpFiles()
    // pumpFiles 为组件内普通函数（每次渲染重建，读 ref 无闭包过期问题）
  }, [])

  const retryFile = useCallback((taskId: string) => {
    fileQueueRef.current.push(taskId)
    void pumpFiles()
  }, [])

  const clearFileTasks = useCallback(() => {
    const busy = fileTasksRef.current.some((t) => t.phase === 'uploading')
    if (busy) {
      toast.warning('有文件正在上传，稍后再清空')
      return
    }
    fileTasksRef.current = []
    setFileTasks([])
    fileQueueRef.current = []
  }, [])

  // -------------------------------------------------------------------------
  // URL 导入：逐 URL 调度（并发 2）+ sitemap 展开。普通函数 + ref 读写
  // -------------------------------------------------------------------------

  async function pumpUrls(): Promise<void> {
    while (urlQueueRef.current.length > 0 && urlActiveRef.current < URL_CONCURRENCY) {
      const id = urlQueueRef.current.shift()!
      urlActiveRef.current++
      void runUrlImport(id).finally(() => {
        urlActiveRef.current--
        void pumpUrls()
      })
    }
  }

  async function runUrlImport(id: string): Promise<void> {
    const task = urlTasksRef.current.find((t) => t.id === id)
    const kb = kbIdRef.current
    if (!task || !kb) {
      updateUrlTask(id, { phase: 'failed', error: '知识库未选择', endedAt: Date.now() })
      return
    }
    updateUrlTask(id, { phase: 'fetching', startedAt: Date.now(), error: undefined })
    try {
      const r = await ragApi.importUrl(kb, task.url)
      if (r.sitemap && Array.isArray(r.urls)) {
        updateUrlTask(id, { phase: 'sitemap', expandedCount: r.urls.length, endedAt: Date.now() })
        // 展开子链接入队（会话配额）
        const budget = MAX_URLS - urlSessionCountRef.current
        const children = r.urls.slice(0, Math.max(0, budget))
        if (children.length > 0) {
          const childTasks: UrlTask[] = children.map((url) => ({
            id: newId(),
            url,
            phase: 'waiting',
            stageProgress: 0,
            startedAt: Date.now(),
          }))
          urlTasksRef.current = [...urlTasksRef.current, ...childTasks]
          setUrlTasks(urlTasksRef.current)
          urlSessionCountRef.current += children.length
          urlQueueRef.current.push(...childTasks.map((t) => t.id))
          toast.info(`站点地图展开 ${children.length} 个子链接，已入队导入`)
          void pumpUrls()
        }
        return
      }
      if (r.deduplicated) {
        updateUrlTask(id, { phase: 'dedup', docId: r.doc?.id, filename: r.doc?.filename, endedAt: Date.now() })
        toast.info('该页面内容已存在（秒传命中）')
      } else if (r.doc) {
        updateUrlTask(id, {
          phase: 'pipeline',
          status: 'queued',
          stageProgress: 0,
          docId: r.doc.id,
          filename: r.doc.filename,
        })
        invalidate()
      } else {
        updateUrlTask(id, { phase: 'failed', error: '响应中缺少文档数据', endedAt: Date.now() })
      }
    } catch (e) {
      updateUrlTask(id, { phase: 'failed', error: (e as Error).message, endedAt: Date.now() })
    }
  }

  const startUrlImport = useCallback((urls: string[]) => {
    const kb = kbIdRef.current
    if (!kb) {
      toast.error('请先选择知识库')
      return
    }
    const budget = MAX_URLS - urlSessionCountRef.current
    if (budget <= 0) {
      toast.warning(`本会话已达 ${MAX_URLS} 个 URL 上限，请清空任务列表后继续`)
      return
    }
    const batch = urls.slice(0, budget)
    if (batch.length < urls.length) {
      toast.warning(`会话配额不足，仅导入前 ${batch.length} 个链接`)
    }
    const tasks: UrlTask[] = batch.map((url) => ({
      id: newId(),
      url,
      phase: 'waiting',
      stageProgress: 0,
      startedAt: Date.now(),
    }))
    urlTasksRef.current = [...urlTasksRef.current, ...tasks]
    setUrlTasks(urlTasksRef.current)
    urlSessionCountRef.current += batch.length
    urlQueueRef.current.push(...tasks.map((t) => t.id))
    void pumpUrls()
  }, [])

  const clearUrlTasks = useCallback(() => {
    if (urlTasksRef.current.some((t) => t.phase === 'fetching' || t.phase === 'pipeline')) {
      toast.warning('有链接正在导入，稍后再清空')
      return
    }
    urlTasksRef.current = []
    setUrlTasks([])
    urlQueueRef.current = []
    urlSessionCountRef.current = 0
  }, [])

  // -------------------------------------------------------------------------
  // socket：kb 房间六状态机事件（对话框关闭也持续更新容器状态）
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (open && kbId) subscribeRooms([`kb:${kbId}`])
  }, [open, kbId, subscribeRooms])

  useEffect(() => {
    const applyToDoc = (docId: unknown, fn: (t: FileTask | UrlTask) => FileTask | UrlTask) => {
      if (typeof docId !== 'string' || !docId) return
      let touched = false
      fileTasksRef.current = fileTasksRef.current.map((t) => {
        if (t.docId === docId) {
          touched = true
          return fn(t)
        }
        return t
      })
      if (touched) setFileTasks(fileTasksRef.current)
      let touchedUrl = false
      urlTasksRef.current = urlTasksRef.current.map((t) => {
        if (t.docId === docId) {
          touchedUrl = true
          return fn(t)
        }
        return t
      })
      if (touchedUrl) setUrlTasks(urlTasksRef.current)
    }

    const un1 = on('document:status', (e: DocumentStatusEvent) => {
      applyToDoc(e.docId, (t) => {
        const status = (VALID_DOC_STATUSES.has(e.status) ? e.status : t.status) as DocStatus | undefined
        let phase = t.phase
        if (t.phase === 'pipeline') {
          if (e.status === 'ready') phase = 'ready'
          else if (e.status === 'failed') phase = 'failed'
        }
        return {
          ...t,
          status,
          phase,
          stageProgress: typeof e.stageProgress === 'number' ? e.stageProgress : t.stageProgress,
          ...(e.errorCode ? { errorCode: e.errorCode } : {}),
          ...(e.errorMessage ? { errorMessage: e.errorMessage } : {}),
          ...(phase === 'ready' || phase === 'failed' ? { endedAt: Date.now() } : {}),
        } as FileTask & UrlTask
      })
    })

    const un2 = on('document:progress', (e: DocumentProgressEvent) => {
      applyToDoc(e.docId, (t) => {
        if (t.phase !== 'pipeline') return t
        const stageStatus = VALID_DOC_STATUSES.has(e.stage as DocStatus) ? (e.stage as DocStatus) : t.status
        return {
          ...t,
          status: stageStatus ?? t.status,
          stageProgress: typeof e.progress === 'number' ? e.progress : t.stageProgress,
        } as FileTask & UrlTask
      })
    })

    const un3 = on('document:done', (e: DocumentDoneEvent) => {
      applyToDoc(e.docId, (t) => {
        if (t.phase === 'ready' || t.phase === 'failed' || t.phase === 'dedup') {
          // 终态补全 chunk 数与耗时（status 事件先到的场景）
          if (e.status === 'ready') {
            return { ...t, chunkCount: e.chunkCount, tookMs: e.tookMs } as FileTask & UrlTask
          }
          return t
        }
        return {
          ...t,
          phase: e.status === 'ready' ? 'ready' : e.status === 'failed' ? 'failed' : t.phase,
          status: e.status,
          chunkCount: e.chunkCount,
          tookMs: e.tookMs,
          endedAt: Date.now(),
        } as FileTask & UrlTask
      })
      invalidate()
    })

    return () => {
      un1()
      un2()
      un3()
    }
  }, [on, invalidate])

  // -------------------------------------------------------------------------
  // 派生态
  // -------------------------------------------------------------------------

  const fileBusy =
    fileTasks.some((t) => t.phase === 'waiting' || t.phase === 'uploading' || t.phase === 'pipeline')
  const urlRunning = urlTasks.some((t) => t.phase === 'waiting' || t.phase === 'fetching' || t.phase === 'pipeline')
  const urlScheduled = urlTasks.filter((t) => t.phase !== 'sitemap').length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[calc(100vw-1.5rem)] max-w-2xl flex-col gap-3 overflow-hidden p-4 sm:p-6">
        <DialogHeader className="flex-none space-y-1 text-left">
          <DialogTitle className="flex items-center gap-2 text-sm">
            批量上传与导入
            {(fileBusy || urlRunning) && (
              <span className="inline-flex items-center gap-1 rounded-full border border-teal-500/40 bg-teal-500/10 px-2 py-0.5 text-[10px] font-medium text-teal-600 dark:text-teal-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-500" />
                进行中
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            多文件并发上传（2 路，字节级进度）与外部 URL 导入；解析进度经 socket 实时推送，关闭对话框后任务继续。
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'local' | 'url')} className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList className="grid h-10 w-full flex-none grid-cols-2">
            <TabsTrigger value="local" className="gap-1.5 text-xs">
              本地文件
              {fileTasks.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-px text-[10px] tabular-nums">{fileTasks.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="url" className="gap-1.5 text-xs">
              URL 导入
              {urlTasks.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-px text-[10px] tabular-nums">{urlTasks.length}</span>
              )}
            </TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto pr-0.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/45 [&::-webkit-scrollbar-track]:bg-transparent">
            <TabsContent value="local" className="mt-0">
              <LocalFileTab tasks={fileTasks} busy={fileBusy} onAddFiles={addFiles} onRetry={retryFile} onClear={clearFileTasks} />
            </TabsContent>
            <TabsContent value="url" className="mt-0">
              <UrlImportTab
                tasks={urlTasks}
                running={urlRunning}
                pendingCount={urlScheduled}
                onStart={startUrlImport}
                onClear={clearUrlTasks}
              />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
