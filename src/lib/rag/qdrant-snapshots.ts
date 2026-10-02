/**
 * Qdrant 快照管理（契约 §23，扩展 §11 备份体系）
 *
 * qdrant 模式下向量数据的独立备份通道：
 * - local 模式全链路抛 QdrantSnapshotError(400)（消息见 LOCAL_MODE_SNAPSHOT_MESSAGE，UI 呈现引导空态）；
 * - 备份卡 §11 仅覆盖 SQLite + artifacts，qdrant 集合的向量数据须走本模块快照。
 *
 * qdrant 1.9.7 实测 API 差异（2026-10-02，本沙箱实例）：
 * - 列表：GET /collections/{c}/snapshots → { result: [...] }（直接数组；部分版本为
 *   { result: { snapshot: [...], next_page_offset } } 分页结构，两者兼容解析）；
 * - 创建：POST /collections/{c}/snapshots?wait=true → result 为单条快照描述；
 * - 删除：DELETE /collections/{c}/snapshots/{name}?wait=true；
 * - 下载：GET /collections/{c}/snapshots/{name}（1.9.7 裸资源路径即 octet-stream；1.10+
 *   为 /download 后缀，本模块先试 /download、404 空响应体（路由不存在）时回退裸路径）；
 * - 恢复：1.9.7 无 /restore 路由（404 空响应体 = actix 路由未注册；真实 not-found 带
 *   JSON error 响应体）——先试新版 POST /collections/{c}/snapshots/{name}/restore，
 *   路由不存在时回退 1.9.7 语义：PUT /collections/{c}/snapshots/recover?priority=snapshot，
 *   body { location: <快照自下载 URL> }（qdrant 自行回拉并覆盖同名集合，集合不存在则新建）。
 *
 * fetch 封装参照 QdrantVectorStore.fetchJson（vectorstore.ts）：
 * headers Content-Type + api-key；AbortSignal.timeout(30s)（下载流放宽至 120s）；
 * 错误解析 json.error / json.message / json.status.error；400/404 视为 NonRetryable。
 */
import { promises as fsPromises } from 'node:fs'
import { getRagSettings } from './settings'

/** local 模式统一友好提示（契约 §23；前端据此展示引导空态，勿改文案） */
export const LOCAL_MODE_SNAPSHOT_MESSAGE = 'local 模式无 Qdrant 快照，请先在设置中切换 qdrant 模式'

const SNAPSHOT_TIMEOUT_MS = 30_000
/** 下载流超时：慢速外网链路实测 ~107KB/s，15MB 快照 ≈143s → 放宽至 10 分钟 */
const DOWNLOAD_TIMEOUT_MS = 600_000
/** 分页快照列表安全上限（next_page_offset 循环防失控） */
const MAX_SNAPSHOT_PAGES = 50

// ---------------------------------------------------------------------------
// 类型（服务端版，形状与 components/rag/types.ts §23 一致）
// ---------------------------------------------------------------------------

export interface QdrantSnapshotItem {
  name: string
  collection: string
  /** epoch 毫秒（qdrant creation_time：unix 秒 或 ISO 字符串，统一转换） */
  createdAt: number
  sizeBytes: number
  /** 下载直链（经平台代理的相对路径，可直接 <a download>） */
  downloadUrl: string
}

export interface QdrantSnapshotCollectionGroup {
  collection: string
  snapshots: QdrantSnapshotItem[]
}

export interface QdrantSnapshotListResult {
  vectorMode: string
  collections: QdrantSnapshotCollectionGroup[]
  totalSnapshots: number
}

/** qdrant 原始快照描述（REST 返回） */
interface QdrantRawSnapshot {
  name?: string
  creation_time?: number | string
  size?: number | string
  checksum?: string
}

// ---------------------------------------------------------------------------
// 错误类型（路由层 → HTTP 状态映射的唯一依据）
// ---------------------------------------------------------------------------

export class QdrantSnapshotError extends Error {
  /** 映射到平台 API 的 HTTP 状态：400 参数/local 模式 · 404 不存在 · 502 不可达/上游失败 */
  readonly status: number
  /** 404 且上游返回空响应体（actix 路由未注册的特征）；restore/download 用于版本兼容回退 */
  readonly routeMiss: boolean

  constructor(message: string, status: number, routeMiss = false) {
    super(message)
    this.name = 'QdrantSnapshotError'
    this.status = status
    this.routeMiss = routeMiss
  }
}

/** 路由层统一错误载荷：QdrantSnapshotError → {status,message}；其他异常 → 500 */
export function toSnapshotErrorPayload(e: unknown): { status: number; message: string } {
  if (e instanceof QdrantSnapshotError) return { status: e.status, message: e.message }
  const message = e instanceof Error ? e.message : String(e)
  return { status: 500, message: `快照操作内部错误: ${message}` }
}

// ---------------------------------------------------------------------------
// 连接与 fetch 封装（参照 QdrantVectorStore.fetchJson）
// ---------------------------------------------------------------------------

interface SnapshotConn {
  base: string
  apiKey: string
}

/** 读取设置；local 模式（未配置 qdrant url）→ 400 友好提示 */
async function requireQdrant(): Promise<{ conn: SnapshotConn; vectorMode: string }> {
  const settings = await getRagSettings()
  if (settings.vectorMode !== 'qdrant' || !settings.qdrant.url) {
    throw new QdrantSnapshotError(LOCAL_MODE_SNAPSHOT_MESSAGE, 400)
  }
  return {
    conn: { base: settings.qdrant.url.replace(/\/+$/, ''), apiKey: settings.qdrant.apiKey },
    vectorMode: settings.vectorMode,
  }
}

async function snapshotFetch(
  conn: SnapshotConn,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> {
  let url = conn.base + path
  if (init.query && Object.keys(init.query).length) {
    url += (url.includes('?') ? '&' : '?') + new URLSearchParams(init.query).toString()
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (conn.apiKey) headers['api-key'] = conn.apiKey
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(init.timeoutMs ?? SNAPSHOT_TIMEOUT_MS),
    })
  } catch (e) {
    // 网络层失败（连接拒绝 / DNS / 超时中止）→ 上游不可达
    throw new QdrantSnapshotError(`Qdrant 不可达: ${(e as Error).message}`, 502)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = `HTTP ${res.status}`
    if (text) {
      try {
        const json = JSON.parse(text)
        msg = String(json?.error ?? json?.message ?? json?.status?.error ?? `HTTP ${res.status}`)
      } catch {
        msg = `HTTP ${res.status}: ${text.slice(0, 200)}`
      }
    }
    // 404 + 空响应体 = actix 路由未注册（版本差异特征）；带 JSON body 的 404 = 真实不存在
    const routeMiss = res.status === 404 && !text
    const status = res.status === 404 ? 404 : res.status === 400 ? 400 : 502
    throw new QdrantSnapshotError(
      `Qdrant 快照接口错误 (${res.status}): ${routeMiss ? '路由不存在' : String(msg).slice(0, 300)}`,
      status,
      routeMiss,
    )
  }
  return res
}

/** 快照 JSON 调用：统一解包 json.result（无 result 键时原样返回） */
async function snapshotJson<T>(
  conn: SnapshotConn,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const res = await snapshotFetch(conn, path, init)
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new QdrantSnapshotError(`Qdrant 返回非 JSON：${text.slice(0, 200)}`, 502)
  }
  if (json && typeof json === 'object' && 'result' in (json as Record<string, unknown>)) {
    return (json as Record<string, unknown>).result as T
  }
  return json as T
}

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------

/** creation_time 兼容解析：unix 秒（数值）或无时区 ISO 串（1.9.7 实测格式）→ epoch 毫秒 */
function toEpochMs(t: number | string | undefined | null): number {
  if (t === undefined || t === null) return 0
  if (typeof t === 'number') return t >= 1e12 ? t : t * 1000
  const n = Number(t)
  if (Number.isFinite(n) && n > 0) return n >= 1e12 ? n : n * 1000
  const ms = Date.parse(t) // 无时区标记时按本地时区解释（沙箱 qdrant 与平台同机同 UTC）
  return Number.isFinite(ms) ? ms : 0
}

function toSnapshotItem(collection: string, raw: QdrantRawSnapshot): QdrantSnapshotItem {
  const name = String(raw?.name ?? '')
  return {
    name,
    collection,
    createdAt: toEpochMs(raw?.creation_time),
    sizeBytes: typeof raw?.size === 'number' ? raw.size : Number(raw?.size) || 0,
    downloadUrl: `/api/qdrant/snapshots/${encodeURIComponent(name)}/download?collection=${encodeURIComponent(collection)}`,
  }
}

/** 单集合快照列表（1.9.7 直接数组 / 新版分页 { snapshot, next_page_offset } 兼容） */
async function listRawSnapshots(conn: SnapshotConn, collection: string): Promise<QdrantRawSnapshot[]> {
  const out: QdrantRawSnapshot[] = []
  let offset: number | undefined = undefined // undefined = 首页（不带 offset 参数）
  for (let page = 0; page < MAX_SNAPSHOT_PAGES; page++) {
    const query = offset === undefined ? undefined : { offset: String(offset) }
    const result = await snapshotJson<unknown>(
      conn,
      `/collections/${encodeURIComponent(collection)}/snapshots`,
      { query },
    )
    if (Array.isArray(result)) {
      out.push(...(result as QdrantRawSnapshot[]))
      return out
    }
    if (result && typeof result === 'object') {
      const obj = result as { snapshot?: unknown[]; snapshots?: unknown[]; next_page_offset?: unknown }
      const items = Array.isArray(obj.snapshot)
        ? obj.snapshot
        : Array.isArray(obj.snapshots)
          ? obj.snapshots
          : []
      out.push(...(items as QdrantRawSnapshot[]))
      if (typeof obj.next_page_offset === 'number') {
        offset = obj.next_page_offset
        continue
      }
    }
    return out // 非分页对象 / 异常结构：按已收集内容返回
  }
  return out
}

// ---------------------------------------------------------------------------
// 公开 API（契约 §23）
// ---------------------------------------------------------------------------

/** GET /api/qdrant/snapshots 数据源：各集合快照汇总（只含有快照的集合，集合名字母序） */
export async function listQdrantSnapshots(): Promise<QdrantSnapshotListResult> {
  const { conn, vectorMode } = await requireQdrant()
  const list = await snapshotJson<{ collections?: { name?: string }[] }>(conn, '/collections')
  const names = (list?.collections ?? []).map((c) => String(c?.name ?? '')).filter(Boolean)
  const groups: QdrantSnapshotCollectionGroup[] = []
  let total = 0
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const raw = await listRawSnapshots(conn, name)
    if (!raw.length) continue
    const snapshots = raw
      .map((r) => toSnapshotItem(name, r))
      .sort((a, b) => b.createdAt - a.createdAt)
    total += snapshots.length
    groups.push({ collection: name, snapshots })
  }
  return { vectorMode, collections: groups, totalSnapshots: total }
}

/** POST /api/qdrant/snapshots 数据源：同步创建单集合快照（wait=true） */
export async function createQdrantSnapshot(collection: string): Promise<QdrantSnapshotItem> {
  if (!collection?.trim()) throw new QdrantSnapshotError('collection 参数必填', 400)
  const { conn } = await requireQdrant()
  const raw = await snapshotJson<QdrantRawSnapshot>(conn, `/collections/${encodeURIComponent(collection)}/snapshots`, {
    method: 'POST',
    query: { wait: 'true' },
    body: {},
  })
  if (!raw?.name) throw new QdrantSnapshotError('Qdrant 未返回快照信息', 502)
  return toSnapshotItem(collection, raw)
}

/** DELETE /api/qdrant/snapshots/{name} 数据源：删除快照（wait=true） */
export async function deleteQdrantSnapshot(collection: string, name: string): Promise<{ ok: true }> {
  if (!collection?.trim() || !name) throw new QdrantSnapshotError('collection / name 参数必填', 400)
  const { conn } = await requireQdrant()
  await snapshotJson<unknown>(
    conn,
    `/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(name)}`,
    { method: 'DELETE', query: { wait: 'true' } },
  )
  return { ok: true }
}

/**
 * POST /api/qdrant/snapshots/{name}/restore 数据源。
 * 语义（契约 §23）：同名集合被快照内容覆盖（不存在则新建），priority=snapshot 快照优先。
 *
 * 实现分层（版本兼容）：
 * ① 新版 qdrant（1.10+）：POST /collections/{c}/snapshots/{name}/restore?priority=snapshot&wait=true
 * ② 1.9.7（本沙箱实例）：路由不存在（404 空响应体）→ PUT /collections/{c}/snapshots/recover
 *    ?priority=snapshot&wait=true，body { location: <快照自下载 URL> }——qdrant 回拉快照并
 *    覆盖/重建集合。location URL 必须是 qdrant 自身可达地址，这里取配置的 base 拼接。
 * 恢复前预检集合快照列表：collection / 快照不存在 → 404（契约错误语义）。
 */
export async function restoreQdrantSnapshot(collection: string, name: string): Promise<{ ok: true; message: string }> {
  if (!collection?.trim() || !name) throw new QdrantSnapshotError('collection / name 参数必填', 400)
  const { conn } = await requireQdrant()

  // 预检（404 语义校验 + 为 1.9.7 recover 自下载构造 URL）
  const raws = await listRawSnapshots(conn, collection)
  const target = raws.find((r) => String(r?.name ?? '') === name)
  if (!target) {
    throw new QdrantSnapshotError(`快照不存在: ${collection} / ${name}（列表 ${raws.length} 条内未找到）`, 404)
  }

  // ① 新版 restore 路由
  try {
    await snapshotJson<unknown>(
      conn,
      `/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(name)}/restore`,
      { method: 'POST', query: { priority: 'snapshot', wait: 'true' }, body: {} },
    )
    return {
      ok: true,
      message: `集合 ${collection} 已从快照恢复（快照内容已覆盖现有数据，集合不存在时已重建）`,
    }
  } catch (e) {
    if (!(e instanceof QdrantSnapshotError) || !e.routeMiss) throw e
  }

  // ② 1.9.7：recover + location 自下载（裸资源路径即下载端点）
  const enc = encodeURIComponent
  const downloadUrl = `${conn.base}/collections/${enc(collection)}/snapshots/${enc(name)}`
  await snapshotJson<unknown>(conn, `/collections/${enc(collection)}/snapshots/recover`, {
    method: 'PUT',
    query: { priority: 'snapshot', wait: 'true' },
    body: { location: downloadUrl },
  })
  return {
    ok: true,
    message: `集合 ${collection} 已从快照恢复（快照内容已覆盖现有数据，集合不存在时已重建）`,
  }
}

// ---------------------------------------------------------------------------
// 快照文件恢复（契约 §29：备份一体化 · 上传/备份内嵌 .snapshot 文件 → 恢复到指定集合）
// ---------------------------------------------------------------------------

/** 大文件恢复（上传/回拉）超时：67MB 级快照实测可达数十秒 */
const RECOVER_TIMEOUT_MS = 180_000

/**
 * 用本地 .snapshot 文件恢复（覆盖/重建）指定 qdrant 集合（契约 §29.5）。
 *
 * 实现分层（版本兼容，2026-10-02 实测远端 1.19.1 与本沙箱 1.9.7 路由面差异）：
 * ① 标准路径：PUT /collections/{c}/snapshots/upload/recover?priority=snapshot&wait=true，
 *    body = 快照文件字节流（Content-Type: application/octet-stream）；
 * ② 路由缺失回退（404/405）：PUT /collections/{c}/snapshots/recover?priority=snapshot&wait=true，
 *    body { location }——qdrant 自行回拉 location URL 指向的快照文件（1.9.7 / 1.19.1 实测该
 *    路由存在；location 须为 qdrant 可达的平台文件服务地址，由调用方传入）；
 *    PUT 也路由缺失时再试 POST /collections/{c}/snapshots/recover（同一 body）。
 * local 模式 → 400（与 §23 语义一致）。
 */
export async function recoverQdrantWithSnapshotFile(
  filePath: string,
  collection: string,
  opts: { locationUrl?: string } = {},
): Promise<{ ok: true; message: string }> {
  if (!collection?.trim()) throw new QdrantSnapshotError('collection 参数必填', 400)
  const { conn } = await requireQdrant()
  const bytes = await fsPromises.readFile(filePath)
  const enc = encodeURIComponent
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
  if (conn.apiKey) headers['api-key'] = conn.apiKey

  // ① 标准上传恢复（文件流直传）
  let routeMissed = false
  let uploadError = ''
  try {
    const res = await fetch(
      `${conn.base}/collections/${enc(collection)}/snapshots/upload/recover?priority=snapshot&wait=true`,
      {
        method: 'PUT',
        headers,
        body: new Uint8Array(bytes),
        cache: 'no-store',
        signal: AbortSignal.timeout(RECOVER_TIMEOUT_MS),
      },
    )
    if (res.ok) {
      return { ok: true, message: `集合 ${collection} 已从快照文件恢复（覆盖现有数据，集合不存在时重建）` }
    }
    const text = await res.text().catch(() => '')
    if (res.status === 404 || res.status === 405) {
      routeMissed = true // 路由未注册（actix 404 空响应体特征）→ 走 location 回退
    } else {
      throw new QdrantSnapshotError(
        `Qdrant 上传恢复失败 (${res.status}): ${text.slice(0, 300)}`,
        res.status === 400 ? 400 : 502,
      )
    }
  } catch (e) {
    if (e instanceof QdrantSnapshotError) throw e
    throw new QdrantSnapshotError(`Qdrant 不可达: ${(e as Error).message}`, 502)
  }

  // ② location 回退（1.9.x / 1.19.1 实测路由面）：PUT 优先，路由缺失再试 POST
  if (routeMissed && !opts.locationUrl) {
    throw new QdrantSnapshotError(
      '当前 Qdrant 不支持 upload/recover 直传，且未提供可回拉的快照文件 URL（location）',
      502,
    )
  }
  const locationBody = JSON.stringify({ location: opts.locationUrl })
  const recoverHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  if (conn.apiKey) recoverHeaders['api-key'] = conn.apiKey
  const tryRecover = async (method: 'PUT' | 'POST'): Promise<{ ok: boolean; err: string; miss: boolean }> => {
    let res: Response
    try {
      res = await fetch(
        `${conn.base}/collections/${enc(collection)}/snapshots/recover?priority=snapshot&wait=true`,
        {
          method,
          headers: recoverHeaders,
          body: locationBody,
          cache: 'no-store',
          signal: AbortSignal.timeout(RECOVER_TIMEOUT_MS),
        },
      )
    } catch (e) {
      return { ok: false, err: `Qdrant 不可达: ${(e as Error).message}`, miss: false }
    }
    if (res.ok) return { ok: true, err: '', miss: false }
    const text = await res.text().catch(() => '')
    const miss = (res.status === 404 || res.status === 405) && !text
    let msg = `HTTP ${res.status}`
    if (text) {
      try {
        const json = JSON.parse(text)
        msg = String(json?.status?.error ?? json?.error ?? json?.message ?? msg)
      } catch {
        msg = text.slice(0, 300)
      }
    }
    return { ok: false, err: msg, miss }
  }

  const putResult = await tryRecover('PUT')
  if (putResult.ok) {
    return { ok: true, message: `集合 ${collection} 已从快照文件恢复（location 回拉，覆盖现有数据）` }
  }
  uploadError = putResult.err
  if (putResult.miss) {
    const postResult = await tryRecover('POST')
    if (postResult.ok) {
      return { ok: true, message: `集合 ${collection} 已从快照文件恢复（location 回拉，覆盖现有数据）` }
    }
    uploadError = postResult.err
  }
  throw new QdrantSnapshotError(
    `Qdrant 快照文件恢复失败（集合 ${collection}）: upload/recover 路由缺失，location 回退亦失败 —— ${uploadError.slice(0, 300)}`,
    502,
  )
}

/**
 * GET /api/qdrant/snapshots/{name}/download 数据源：返回原始 Response（流式转发，不读 body）。
 * 版本兼容：先试 /download 后缀（1.10+ 文档路径），路由不存在（404 空响应体）时回退
 * 1.9.7 裸资源路径（GET /collections/{c}/snapshots/{name} 即 octet-stream）。
 */
export async function downloadSnapshotStream(collection: string, name: string): Promise<Response> {
  if (!collection?.trim() || !name) throw new QdrantSnapshotError('collection / name 参数必填', 400)
  const { conn } = await requireQdrant()
  const enc = encodeURIComponent
  try {
    return await snapshotFetch(
      conn,
      `/collections/${enc(collection)}/snapshots/${enc(name)}/download`,
      { timeoutMs: DOWNLOAD_TIMEOUT_MS },
    )
  } catch (e) {
    if (!(e instanceof QdrantSnapshotError) || !e.routeMiss) throw e
  }
  return snapshotFetch(conn, `/collections/${enc(collection)}/snapshots/${enc(name)}`, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  })
}
