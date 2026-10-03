/**
 * InkRAG 入库 API（/api/input）薄封装。
 *
 * - 全部请求携带 `Authorization: Bearer <INKRAG_API_KEY>`
 * - 非 2xx 响应按平台约定透传 `{ "error": "<中文说明>" }`
 * - 不做重试 / 不做缓存：流水线状态轮询由调用方（MCP 工具 / Agent）控制节奏
 */

export interface InputClientOptions {
  baseUrl: string
  apiKey: string
  /** 单请求超时（毫秒）。文件上传类默认放宽到 10 分钟。 */
  timeoutMs?: number
}

export class InputApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
    /** 服务端返回的原始 JSON body（通常为 { error } 结构），尽量原样透传给上层 */
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'InputApiError'
  }
}

export class InputClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultTimeoutMs: number

  constructor(opts: InputClientOptions) {
    // 去掉尾部斜杠，避免拼接出 //api/input
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.defaultTimeoutMs = opts.timeoutMs ?? 60_000
  }

  /** JSON GET 请求 */
  async get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
      }
    }
    return this.request<T>(url, { method: 'GET', headers: { Accept: 'application/json' } })
  }

  /** JSON 请求（POST / DELETE 等） */
  async json<T = unknown>(path: string, method: 'POST' | 'DELETE', body?: unknown): Promise<T> {
    return this.request<T>(new URL(this.baseUrl + path), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  /**
   * multipart 上传：POST /api/input/knowledge-bases/{kbId}/documents
   * files = 本地已读取的文件（filename + bytes）；chunkConfig / engine 为可选字段。
   */
  async upload(
    kbId: string,
    files: Array<{ filename: string; bytes: BlobPart; mimeType?: string }>,
    fields?: { chunkConfig?: object; engine?: string },
  ): Promise<unknown> {
    const form = new FormData()
    for (const f of files) {
      const mime = f.mimeType || guessMime(f.filename)
      form.append('files', new Blob([f.bytes as BlobPart], { type: mime }), f.filename)
    }
    if (fields?.chunkConfig) form.append('chunkConfig', JSON.stringify(fields.chunkConfig))
    if (fields?.engine) form.append('engine', fields.engine)
    return this.request<unknown>(new URL(`${this.baseUrl}/api/input/knowledge-bases/${encodeURIComponent(kbId)}/documents`), {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form,
      timeoutMs: 10 * 60_000, // 大文件 / 远端解析接收预留
    })
  }

  private async request<T>(url: URL, init: RequestInit & { timeoutMs?: number }): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.apiKey}`)

    let res: Response
    try {
      res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? this.defaultTimeoutMs) })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      throw new InputApiError(
        `无法连接平台（${url.host}）：${reason}。请检查 INKRAG_BASE_URL 是否正确、平台服务是否在线。`,
        0,
        url.pathname,
        null,
      )
    }

    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (!res.ok) {
      const errMsg =
        (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : null) ?? `HTTP ${res.status} ${res.statusText}`
      throw new InputApiError(errMsg, res.status, url.pathname, parsed)
    }
    return parsed as T
  }
}

/** 常见扩展名 → MIME（仅用于 multipart 元数据；平台按文件名扩展名做白名单与路由） */
export function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  const table: Record<string, string> = {
    pdf: 'application/pdf',
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    html: 'text/html',
    htm: 'text/html',
    json: 'application/json',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    epub: 'application/epub+zip',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
  }
  return table[ext] ?? 'application/octet-stream'
}
