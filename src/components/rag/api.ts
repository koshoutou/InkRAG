// RAG 知识库平台 · API 封装
// 覆盖 docs/api-contract.md 全部端点；错误统一抛 Error(message)
import type {
  ApiKeyItem,
  BackupItem,
  BackupSchedule,
  BackupUploadResult,
  ChunkBatchResult,
  ChunkConfig,
  ChunkFull,
  ChunkItem,
  ChunkPreview,
  DashboardData,
  DocVersionInfo,
  ActivityResponse,
  ResourceUsage,
  RestoreVersionResult,
  UploadedQdrantSnapshot,
  VersionCompareResult,
  DocDetail,
  DocSummary,
  HealthInfo,
  JobItem,
  JobsStats,
  KbSummary,
  LayoutData,
  MetricsSummary,
  RagSettings,
  RestoreResult,
  TestCaseItem,
  TestCaseParams,
  QdrantSnapshotItem,
  QdrantSnapshotListResult,
  TestKind,
  TestResult,
  TestRunHistoryItem,
  TestRunReport,
  TestRunState,
} from './types'

async function asJson<T = any>(res: Response): Promise<T> {
  const txt = await res.text()
  let json: any
  try {
    json = txt ? JSON.parse(txt) : {}
  } catch {
    throw new Error(`Non-JSON response: ${res.status} ${txt.slice(0, 160)}`)
  }
  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`
    throw new Error(String(msg))
  }
  return json as T
}

/**
 * 【Task 16-a】fetch 包装：dev server 重启 / 网关闪断窗口的瞬态失败自动重试。
 * 判定「瞬态」：网络异常（fetch 抛错），或响应状态 404/502/503/504 且 body 非 JSON
 * （Next.js 404 HTML 页 / 网关错误页特征——正常 API 错误返回 JSON 4xx/5xx 不重试）。
 * 重试 2 次（600ms / 1500ms 退避）后仍瞬态 → 抛友好错误（此前表现为
 * 「调度状态加载失败：Non-JSON response: 404 <!DOCTYPE html>…」）。
 */
async function req(url: string, init?: RequestInit): Promise<Response> {
  const isTransient = (r: Response | null): boolean => {
    if (!r) return true
    if (![404, 502, 503, 504].includes(r.status)) return false
    return !(r.headers.get('content-type') ?? '').includes('application/json')
  }
  let res: Response | null = null
  try {
    res = await fetch(url, init)
  } catch {
    res = null
  }
  if (isTransient(res)) {
    for (const delay of [600, 1500]) {
      await new Promise((r) => setTimeout(r, delay))
      try {
        res = await fetch(url, init)
      } catch {
        res = null
      }
      if (!isTransient(res)) break
    }
  }
  if (!res) throw new Error('网络请求失败（服务可能正在重启，请稍后刷新重试）')
  // 面板鉴权全局拦截（middleware 401 PANEL_AUTH_REQUIRED）→ 通知应用层弹出登录遮罩。
  // clone 读 body 不影响原 Response 的后续消费；仅拦管理面 401（/api/auth 自身不在此列）。
  if (res.status === 401 && !url.startsWith('/api/auth')) {
    res
      .clone()
      .json()
      .then((j) => {
        if (j?.code === 'PANEL_AUTH_REQUIRED') {
          window.dispatchEvent(new CustomEvent('panel:unauthorized'))
        }
      })
      .catch(() => {})
  }
  return res
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export interface UploadTask {
  file: File
  progress: number
  status: 'uploading' | 'error' | 'done'
  error?: string
  deduplicated?: boolean
  docId?: string
}

/** XHR 上传（fetch 无上传进度回调，这里用 xhr.upload.onprogress 获得真实进度）；engine 可选（14-e 契约，缺省=跟随全局设置） */
export function uploadDocument(
  kbId: string,
  file: File,
  onProgress?: (fraction: number) => void,
  engine?: 'mineru' | 'node',
): Promise<{ doc: DocSummary; deduplicated: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/kb/${encodeURIComponent(kbId)}/documents`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      let json: any = null
      try {
        json = xhr.responseText ? JSON.parse(xhr.responseText) : {}
      } catch {
        json = null
      }
      if (xhr.status >= 200 && xhr.status < 300 && json) {
        resolve(json)
      } else {
        reject(new Error(json?.error || `上传失败 (HTTP ${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('网络错误（上传中断）'))
    xhr.ontimeout = () => reject(new Error('上传超时'))
    const fd = new FormData()
    fd.append('file', file)
    if (engine) fd.append('engine', engine)
    xhr.send(fd)
  })
}

export const ragApi = {
  // -- §1 知识库 ------------------------------------------------------------
  async listKbs(): Promise<{ kbs: KbSummary[] }> {
    return asJson(await req('/api/kb', { cache: 'no-store' }))
  },
  async createKb(body: {
    name: string
    description?: string
    embeddingModel?: string
    dim?: number
    chunkConfig?: ChunkConfig
    rerankEnabled?: boolean
  }): Promise<{ kb: KbSummary }> {
    return asJson(
      await req('/api/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },
  async getKb(id: string): Promise<{ kb: KbSummary }> {
    return asJson(await req(`/api/kb/${encodeURIComponent(id)}`, { cache: 'no-store' }))
  },
  async updateKb(
    id: string,
    body: { name?: string; description?: string; chunkConfig?: ChunkConfig; rerankEnabled?: boolean },
  ): Promise<{ kb: KbSummary }> {
    return asJson(
      await req(`/api/kb/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },
  async deleteKb(id: string): Promise<{ ok: true; deleted: Record<string, unknown> }> {
    return asJson(await req(`/api/kb/${encodeURIComponent(id)}`, { method: 'DELETE' }))
  },

  // -- §2 文档 --------------------------------------------------------------
  async listDocs(
    kbId: string,
    opts: { status?: string; q?: string; limit?: number; offset?: number } = {},
  ): Promise<{ docs: DocSummary[]; total: number }> {
    return asJson(await req(`/api/kb/${encodeURIComponent(kbId)}/documents${qs(opts)}`, { cache: 'no-store' }))
  },
  async getDoc(id: string): Promise<{ doc: DocDetail }> {
    return asJson(await req(`/api/documents/${encodeURIComponent(id)}`, { cache: 'no-store' }))
  },
  async docAction(
    id: string,
    action: 'reparse' | 'rechunk' | 'retry',
    chunkConfig?: ChunkConfig,
  ): Promise<{ ok: true }> {
    return asJson(
      await req(`/api/documents/${encodeURIComponent(id)}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(chunkConfig ? { chunkConfig } : {}) }),
      }),
    )
  },
  async deleteDoc(id: string): Promise<{ ok: true; deletedChunks: number }> {
    return asJson(await req(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }))
  },
  /** 原始字节（PDF 等） */
  async fetchDocBytes(id: string, kind: 'source' | 'markdown' = 'source'): Promise<ArrayBuffer> {
    const res = await req(`/api/documents/${encodeURIComponent(id)}/file${qs({ kind })}`, { cache: 'force-cache' })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = await res.json()
        msg = j?.error || msg
      } catch {}
      throw new Error(String(msg))
    }
    return res.arrayBuffer()
  },
  async fetchDocText(id: string, kind: 'source' | 'markdown' = 'markdown'): Promise<string> {
    const res = await req(`/api/documents/${encodeURIComponent(id)}/file${qs({ kind })}`, { cache: 'force-cache' })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = await res.json()
        msg = j?.error || msg
      } catch {}
      throw new Error(String(msg))
    }
    return res.text()
  },
  async getLayout(id: string): Promise<LayoutData> {
    return asJson(await req(`/api/documents/${encodeURIComponent(id)}/layout`, { cache: 'no-store' }))
  },
  async listChunks(
    id: string,
    opts: { limit?: number; offset?: number; parentOnly?: boolean; q?: string } = {},
  ): Promise<{ chunks: ChunkItem[]; total: number }> {
    return asJson(
      await req(`/api/documents/${encodeURIComponent(id)}/chunks${qs({
        limit: opts.limit,
        offset: opts.offset,
        parentOnly: opts.parentOnly ? 1 : undefined,
        q: opts.q,
      })}`, { cache: 'no-store' }),
    )
  },
  async getChunk(docId: string, chunkId: string, full = false): Promise<{ chunk: ChunkFull }> {
    return asJson(
      await req(`/api/documents/${encodeURIComponent(docId)}/chunk/${encodeURIComponent(chunkId)}${qs({ full: full ? 1 : undefined })}`, {
        cache: 'no-store',
      }),
    )
  },
  async patchChunk(
    docId: string,
    chunkId: string,
    body: { enabled?: boolean; text?: string; revert?: boolean },
  ): Promise<{ chunk: ChunkItem; result?: { chunkId: string; oldTokens: number; newTokens: number; embedMode: string; tookMs: number } }> {
    return asJson(
      await req(`/api/documents/${encodeURIComponent(docId)}/chunk/${encodeURIComponent(chunkId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },
  async deleteChunk(docId: string, chunkId: string): Promise<{ ok: true }> {
    return asJson(
      await req(`/api/documents/${encodeURIComponent(docId)}/chunk/${encodeURIComponent(chunkId)}`, { method: 'DELETE' }),
    )
  },
  async chunkPreview(id: string, chunkConfig: ChunkConfig): Promise<{ preview: ChunkPreview }> {
    return asJson(
      await req(`/api/documents/${encodeURIComponent(id)}/chunk-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunkConfig }),
      }),
    )
  },

  // -- §26 URL 导入（14-e：可选 engine；sitemap 展开已下线） ------------------
  async importUrl(
    kbId: string,
    url: string,
    opts?: { filename?: string; engine?: 'mineru' | 'node' },
  ): Promise<{ doc?: DocSummary; deduplicated?: boolean }> {
    return asJson(
      await req(`/api/kb/${encodeURIComponent(kbId)}/import-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          ...(opts?.filename ? { filename: opts.filename } : {}),
          ...(opts?.engine ? { engine: opts.engine } : {}),
        }),
      }),
    )
  },

  // -- 面板鉴权（/api/auth）------------------------------------------------
  async getAuthSession(): Promise<{ authenticated: boolean; defaultPassword: boolean }> {
    return asJson(await req('/api/auth/session', { cache: 'no-store' }))
  },
  async panelLogin(password: string): Promise<{ ok: true }> {
    return asJson(
      await req('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      }),
    )
  },
  async panelLogout(): Promise<{ ok: true }> {
    return asJson(
      await req('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  },
  async changePanelPassword(current: string, next: string): Promise<{ ok: true }> {
    return asJson(
      await req('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
      }),
    )
  },

  // -- §4 API Keys ----------------------------------------------------------
  async listKeys(): Promise<{ keys: ApiKeyItem[] }> {
    return asJson(await req('/api/apikeys', { cache: 'no-store' }))
  },
  async createKey(body: { name: string; role?: string }): Promise<{ key: ApiKeyItem }> {
    return asJson(
      await req('/api/apikeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },
  async patchKey(id: string, body: { enabled?: boolean }): Promise<{ key: ApiKeyItem }> {
    return asJson(
      await req(`/api/apikeys/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },
  async deleteKey(id: string): Promise<{ ok: true }> {
    return asJson(await req(`/api/apikeys/${encodeURIComponent(id)}`, { method: 'DELETE' }))
  },

  // -- §5 系统 --------------------------------------------------------------
  async getHealth(): Promise<{ health: HealthInfo }> {
    return asJson(await req('/api/system/health', { cache: 'no-store' }))
  },
  async getMetricsSummary(): Promise<{ summary: MetricsSummary }> {
    return asJson(await req('/api/system/metrics-summary', { cache: 'no-store' }))
  },
  async getPrometheusText(): Promise<string> {
    return await (await req('/api/metrics', { cache: 'no-store' })).text()
  },
  /** §29-A 平台资源占用（进程 / 系统 / 磁盘，OpsView 资源卡 5s 轮询） */
  async getResources(): Promise<ResourceUsage> {
    return asJson(await req('/api/system/resources', { cache: 'no-store' }))
  },
  async listJobs(
    opts: { status?: string; type?: string; limit?: number } = {},
  ): Promise<{ jobs: JobItem[]; stats: JobsStats }> {
    return asJson(await req(`/api/system/jobs${qs(opts)}`, { cache: 'no-store' }))
  },
  async retryJob(id: string): Promise<{ ok: true }> {
    return asJson(await req(`/api/system/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }))
  },
  async cleanJobs(body: { status?: string; olderThanHours?: number }): Promise<{ cleaned: number }> {
    return asJson(
      await req('/api/system/jobs/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },

  // -- §10 备份与恢复 --------------------------------------------------------
  async listBackups(): Promise<{ backups: BackupItem[] }> {
    return asJson(await req('/api/system/backups', { cache: 'no-store' }))
  },
  /** §29：includeQdrantSnapshot 缺省 true（qdrant 模式连同 Qdrant 快照；local 模式自动跳过） */
  async createBackup(
    opts: { includeArtifacts?: boolean; includeQdrantSnapshot?: boolean } = {},
  ): Promise<{ backup: BackupItem }> {
    return asJson(
      await req('/api/system/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      }),
    )
  },
  async deleteBackup(id: string): Promise<{ ok: true }> {
    return asJson(await req(`/api/system/backups/${encodeURIComponent(id)}`, { method: 'DELETE' }))
  },
  /** §29：includeQdrant 缺省 true（备份含快照时面板数据恢复后逐个上传恢复 Qdrant 集合） */
  async restoreBackup(
    id: string,
    opts: { includeQdrant?: boolean } = {},
  ): Promise<{ result: RestoreResult }> {
    return asJson(
      await req(`/api/system/backups/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      }),
    )
  },
  /** 备份下载直链（浏览器 window.open / <a download>；tar 含面板数据 + Qdrant 快照） */
  backupDownloadUrl(id: string): string {
    return `/api/system/backups/${encodeURIComponent(id)}/download`
  },
  async getBackupSchedule(): Promise<{ schedule: BackupSchedule }> {
    return asJson(await req('/api/system/backups/schedule', { cache: 'no-store' }))
  },
  async saveBackupSchedule(
    body: { enabled?: boolean; intervalHours?: number; keep?: number },
  ): Promise<{ schedule: BackupSchedule }> {
    return asJson(
      await req('/api/system/backups/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },

  // -- §29 备份一体化：上传 / 已上传快照恢复 --------------------------------
  /** 上传完整备份包（.tar.gz/.tgz → 导入备份列表）或 Qdrant 快照（.snapshot → 单独恢复） */
  async uploadBackupArchive(file: File): Promise<BackupUploadResult> {
    const fd = new FormData()
    fd.append('file', file)
    return asJson(await req('/api/system/backups/upload', { method: 'POST', body: fd }))
  },
  /** 已上传 Qdrant 快照清单（含从文件名推断的目标集合） */
  async listUploadedQdrantSnapshots(): Promise<{ uploads: UploadedQdrantSnapshot[] }> {
    return asJson(await req('/api/system/backups/upload', { cache: 'no-store' }))
  },
  async deleteUploadedQdrantSnapshot(fileName: string): Promise<{ ok: true }> {
    return asJson(
      await req(`/api/system/backups/upload${qs({ fileName })}`, { method: 'DELETE' }),
    )
  },
  /** 上传的 .snapshot → 恢复到指定集合（collection 缺省由服务端从文件名推断） */
  async restoreQdrantSnapshotUpload(
    fileName: string,
    collection?: string,
  ): Promise<{ ok: boolean; message: string; collection: string }> {
    return asJson(
      await req('/api/system/backups/qdrant-restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, ...(collection ? { collection } : {}) }),
      }),
    )
  },

  // -- §11 检索测试集 --------------------------------------------------------
  async listTestCases(kbId: string): Promise<{ cases: TestCaseItem[]; docs: DocSummary[] }> {
    return asJson(await req(`/api/kb/${encodeURIComponent(kbId)}/testcases`, { cache: 'no-store' }))
  },
  async createTestCase(
    kbId: string,
    body: { name: string; query: string; expectDocIds: string[]; params?: TestCaseParams },
  ): Promise<{ testCase: TestCaseItem }> {
    return asJson(
      await req(`/api/kb/${encodeURIComponent(kbId)}/testcases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },
  async patchTestCase(
    id: string,
    body: { name?: string; query?: string; expectDocIds?: string[]; params?: TestCaseParams; enabled?: boolean },
  ): Promise<{ testCase: TestCaseItem }> {
    return asJson(
      await req(`/api/testcases/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },
  async deleteTestCase(id: string): Promise<{ ok: true }> {
    return asJson(await req(`/api/testcases/${encodeURIComponent(id)}`, { method: 'DELETE' }))
  },
  async runTestCases(
    kbId: string,
    body: { caseIds?: string[]; onlyEnabled?: boolean; async?: boolean } = {},
  ): Promise<{ report?: TestRunReport; run?: TestRunState; note?: string }> {
    return asJson(
      await req(`/api/kb/${encodeURIComponent(kbId)}/testcases/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },
  /** 异步运行状态查询（404 = 不存在或已清理） */
  async getTestRun(kbId: string, runId: string): Promise<{ run: TestRunState }> {
    return asJson(
      await req(
        `/api/kb/${encodeURIComponent(kbId)}/testcases/run/${encodeURIComponent(runId)}`,
        { cache: 'no-store' },
      ),
    )
  },

  // -- §12 chunk 批量操作与导出 ----------------------------------------------
  async batchChunks(
    docId: string,
    body: { action: 'enable' | 'disable'; chunkIds?: string[]; scope?: 'children' | 'all' },
  ): Promise<ChunkBatchResult> {
    return asJson(
      await req(`/api/documents/${encodeURIComponent(docId)}/chunks/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },
  /** chunk 导出下载直链（浏览器 <a download>） */
  chunksExportUrl(docId: string, format: 'json' | 'csv' | 'md', includeParents = false): string {
    return `/api/documents/${encodeURIComponent(docId)}/chunks/export${qs({
      format,
      includeParents: includeParents ? 1 : undefined,
    })}`
  },

  // -- §7 仪表盘 ------------------------------------------------------------
  async getDashboard(): Promise<{ dashboard: DashboardData }> {
    return asJson(await req('/api/dashboard', { cache: 'no-store' }))
  },

  // -- §35 程序日志（/api/system/oplogs） ------------------------------------
  async listOpLogs(params: { level?: string; category?: string; hours?: string | number; q?: string; limit?: number; offset?: number }): Promise<{ logs: import('./views/OpLogsCard').OpLogItem[]; total: number; stats?: { totalAll: number; estBytes: number } }> {
    return asJson(
      await req(`/api/system/oplogs${qs({
        level: params.level && params.level !== 'all' ? params.level : undefined,
        category: params.category && params.category !== 'all' ? params.category : undefined,
        hours: params.hours ?? 24,
        q: params.q || undefined,
        limit: params.limit ?? 60,
        offset: params.offset ?? 0,
      })}`, { cache: 'no-store' }),
    )
  },
  async cleanOplogs(olderThanHours: number): Promise<{ deleted: number }> {
    return asJson(
      await req(`/api/system/oplogs?olderThanHours=${olderThanHours}`, { method: 'DELETE' }),
    )
  },

  // -- §35 扩展 程序日志定时清理（/api/system/oplogs/schedule） ----------------
  async getOplogCleanSchedule(): Promise<{ schedule: import('./types').OplogCleanSchedule }> {
    return asJson(await req('/api/system/oplogs/schedule', { cache: 'no-store' }))
  },

  async updateOplogCleanSchedule(body: { enabled?: boolean; olderThanHours?: number; maxLevel?: string }): Promise<{ schedule: import('./types').OplogCleanSchedule }> {
    return asJson(
      await req('/api/system/oplogs/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },

  // -- §16 文档文档版本管理（契约 §17） ---------------------------------------
  async listDocVersions(docId: string): Promise<{ versions: DocVersionInfo[] }> {
    return asJson(await req(`/api/documents/${encodeURIComponent(docId)}/versions`, { cache: 'no-store' }))
  },
  /** §28 任务中心：进行中 + 失败文档（完成任务不返回） */
  async getActivity(): Promise<ActivityResponse> {
    return asJson(await req('/api/activity', { cache: 'no-store' }))
  },
  /** §27 恢复历史版本（归档当前 → 版本号+1 → 重建 chunks → 入队重嵌入） */
  async restoreDocVersion(docId: string, version: string): Promise<RestoreVersionResult> {
    return asJson(
      await req(
        `/api/documents/${encodeURIComponent(docId)}/versions/${encodeURIComponent(version)}/restore`,
        { method: 'POST' },
      ),
    )
  },
  /** §27 删除历史版本快照 */
  async deleteDocVersion(docId: string, version: string): Promise<{ ok: true }> {
    return asJson(
      await req(
        `/api/documents/${encodeURIComponent(docId)}/versions/${encodeURIComponent(version)}`,
        { method: 'DELETE' },
      ),
    )
  },
  async compareDocVersions(docId: string, v1: string, v2: string): Promise<{ compare: VersionCompareResult }> {
    return asJson(
      await req(
        `/api/documents/${encodeURIComponent(docId)}/versions/compare${qs({ v1, v2 })}`,
        { cache: 'no-store' },
      ),
    )
  },
  /** 文档版本管理报告下载直链（浏览器 <a download>） */
  compareExportUrl(docId: string, v1: string, v2: string, format: 'json' | 'md'): string {
    return `/api/documents/${encodeURIComponent(docId)}/versions/compare/export${qs({
      v1,
      v2,
      format,
    })}`
  },

  // -- §23 Qdrant 快照（契约 §23；qdrant 模式专用） -------------------------
  async listQdrantSnapshots(): Promise<QdrantSnapshotListResult> {
    return asJson(await req('/api/qdrant/snapshots', { cache: 'no-store' }))
  },
  async createQdrantSnapshot(collection: string): Promise<{ snapshot: QdrantSnapshotItem }> {
    return asJson(
      await req('/api/qdrant/snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection }),
      }),
    )
  },
  async deleteQdrantSnapshot(collection: string, name: string): Promise<{ ok: boolean }> {
    return asJson(
      await req(
        `/api/qdrant/snapshots/${encodeURIComponent(name)}${qs({ collection })}`,
        { method: 'DELETE' },
      ),
    )
  },
  async restoreQdrantSnapshot(collection: string, name: string): Promise<{ ok: boolean; message: string }> {
    return asJson(
      await req(
        `/api/qdrant/snapshots/${encodeURIComponent(name)}/restore${qs({ collection })}`,
        { method: 'POST' },
      ),
    )
  },

  // -- §24 测试集运行历史（契约 §24；进程内注册表） --------------------------
  async listTestRuns(kbId: string): Promise<{ runs: TestRunHistoryItem[] }> {
    return asJson(await req(`/api/kb/${encodeURIComponent(kbId)}/testruns`, { cache: 'no-store' }))
  },

  // -- §6 设置（基座路由扩展） ----------------------------------------------
  async getSettings(): Promise<RagSettings> {
    return asJson(await req('/api/qdrant/settings', { cache: 'no-store' }))
  },
  async saveSettings(payload: Partial<RagSettings>): Promise<{ settings: RagSettings }> {
    return asJson(
      await req('/api/qdrant/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
  },
  async testConnection(kind: TestKind, body: Record<string, unknown>): Promise<TestResult> {
    return asJson(
      await req('/api/qdrant/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, ...body }),
      }),
    )
  },
}
