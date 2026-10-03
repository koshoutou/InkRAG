/**
 * Prometheus 指标（计划书 §14 运维观测）
 *
 * 两类指标来源：
 * 1. 进程内计数器（globalThis 单例，dev/prod 均随进程重启清零）：
 *    检索请求数 / 耗时直方图（sum+count） / 错误数 —— recordSearch() 在检索路径埋点
 * 2. DB 聚合（持久）：KB/文档（按状态）/chunk/向量点/流水线任务（按状态与类型）/ApiKey 调用
 *
 * 输出 Prometheus 文本格式（text/plain; version=0.0.4），GET /api/metrics 供抓取。
 */

import { db } from '@/lib/db'
import { getRagSettings } from './settings'
import { pipelineStats } from './pipeline'

export interface RagCounters {
  startedAt: number
  searchTotal: number
  searchErrors: number
  searchDurSumMs: number
  searchDurCount: number
  searchByMode: Record<string, number>
  searchMaxMs: number
}

const g = globalThis as unknown as { __ragMetrics?: RagCounters }

function counters(): RagCounters {
  if (!g.__ragMetrics) {
    g.__ragMetrics = {
      startedAt: Date.now(),
      searchTotal: 0,
      searchErrors: 0,
      searchDurSumMs: 0,
      searchDurCount: 0,
      searchByMode: {},
      searchMaxMs: 0,
    }
  }
  return g.__ragMetrics
}

/** 检索埋点：search/debug 与 v1 search 均调用（含失败，tookMs 尽力提供） */
export function recordSearch(mode: string, tookMs: number | null, ok: boolean): void {
  const c = counters()
  c.searchTotal++
  c.searchByMode[mode] = (c.searchByMode[mode] ?? 0) + 1
  if (!ok) c.searchErrors++
  if (tookMs != null && tookMs >= 0) {
    c.searchDurSumMs += tookMs
    c.searchDurCount++
    if (tookMs > c.searchMaxMs) c.searchMaxMs = tookMs
  }
}

export function getCounters(): RagCounters {
  return { ...counters(), searchByMode: { ...counters().searchByMode } }
}

const DOC_STATUSES = ['queued', 'parsing', 'chunking', 'embedding', 'upserting', 'ready', 'failed'] as const
const JOB_TYPES = ['parse', 'chunk', 'embed', 'upsert'] as const

/** 聚合并渲染 Prometheus 文本（供 GET /api/metrics） */
export async function renderPrometheus(): Promise<string> {
  const c = counters()
  const lines: string[] = []

  // ---- 进程级 ----
  lines.push('# HELP rag_process_uptime_seconds 平台进程运行时长（计数器归属进程，重启清零）')
  lines.push('# TYPE rag_process_uptime_seconds gauge')
  lines.push(`rag_process_uptime_seconds ${Math.floor((Date.now() - c.startedAt) / 1000)}`)

  // ---- 检索（进程内计数器）----
  lines.push('# HELP rag_search_requests_total 检索请求总数（进程内计数）')
  lines.push('# TYPE rag_search_requests_total counter')
  for (const [mode, n] of Object.entries(c.searchByMode)) {
    lines.push(`rag_search_requests_total{mode="${mode}"} ${n}`)
  }
  if (Object.keys(c.searchByMode).length === 0) lines.push('rag_search_requests_total 0')
  lines.push('# HELP rag_search_errors_total 检索失败总数')
  lines.push('# TYPE rag_search_errors_total counter')
  lines.push(`rag_search_errors_total ${c.searchErrors}`)
  lines.push('# HELP rag_search_duration_ms 检索耗时（sum/count/max，毫秒）')
  lines.push('# TYPE rag_search_duration_ms summary')
  lines.push(`rag_search_duration_ms_sum ${c.searchDurSumMs}`)
  lines.push(`rag_search_duration_ms_count ${c.searchDurCount}`)
  lines.push(`rag_search_duration_ms_max ${c.searchMaxMs}`)

  // ---- DB 聚合 ----
  const [kbs, docsByStatus, chunks, enabledChunks, pointAgg, apiCalls, jobsByStatusType, pipe, settings] =
    await Promise.all([
      db.knowledgeBase.count(),
      db.document.groupBy({ by: ['status'], _count: { _all: true } }),
      db.chunk.count({ where: { isParent: false } }),
      db.chunk.count({ where: { isParent: false, enabled: true } }),
      // v1.6：向量点存于 Qdrant，计数用库行快照 pointCount（pipeline 回写）
      db.knowledgeBase.aggregate({ _sum: { pointCount: true } }),
      db.apiKey.aggregate({ _sum: { callCount: true } }),
      db.pipelineJob.groupBy({ by: ['status', 'type'], _count: { _all: true } }),
      pipelineStats(),
      getRagSettings(),
    ])
  const points = pointAgg._sum.pointCount ?? 0

  lines.push('# HELP rag_kbs_total 知识库总数')
  lines.push('# TYPE rag_kbs_total gauge')
  lines.push(`rag_kbs_total ${kbs}`)

  lines.push('# HELP rag_documents_total 文档数（按状态机状态）')
  lines.push('# TYPE rag_documents_total gauge')
  const statusMap = new Map(docsByStatus.map((r) => [r.status, r._count._all]))
  for (const s of DOC_STATUSES) lines.push(`rag_documents_total{status="${s}"} ${statusMap.get(s) ?? 0}`)

  lines.push('# HELP rag_chunks_total 子 chunk 总数')
  lines.push('# TYPE rag_chunks_total gauge')
  lines.push(`rag_chunks_total ${chunks}`)
  lines.push('# HELP rag_chunks_enabled_total 启用中的子 chunk 数（参与检索）')
  lines.push('# TYPE rag_chunks_enabled_total gauge')
  lines.push(`rag_chunks_enabled_total ${enabledChunks}`)
  lines.push('# HELP rag_vector_points_total 向量点总数')
  lines.push('# TYPE rag_vector_points_total gauge')
  lines.push(`rag_vector_points_total ${points}`)

  lines.push('# HELP rag_apikey_calls_total Agent API 累计调用次数（持久，ApiKey.callCount 汇总）')
  lines.push('# TYPE rag_apikey_calls_total counter')
  lines.push(`rag_apikey_calls_total ${apiCalls._sum.callCount ?? 0}`)

  lines.push('# HELP rag_pipeline_jobs_total 流水线任务数（按状态与类型，持久）')
  lines.push('# TYPE rag_pipeline_jobs_total gauge')
  const jobSet = new Set(jobsByStatusType.map((r) => `${r.status}|${r.type}`))
  for (const status of ['pending', 'active', 'completed', 'failed']) {
    for (const type of JOB_TYPES) {
      const key = `${status}|${type}`
      if (jobSet.has(key)) {
        const row = jobsByStatusType.find((r) => `${r.status}|${r.type}` === key)!
        lines.push(`rag_pipeline_jobs_total{status="${status}",type="${type}"} ${row._count._all}`)
      }
    }
  }

  lines.push('# HELP rag_pipeline_queue_depth 流水线当前队列深度')
  lines.push('# TYPE rag_pipeline_queue_depth gauge')
  lines.push(`rag_pipeline_queue_depth{status="pending"} ${pipe.pending}`)
  lines.push(`rag_pipeline_queue_depth{status="active"} ${pipe.active}`)
  lines.push(`rag_pipeline_queue_depth{status="failed"} ${pipe.failed}`)
  lines.push('# HELP rag_pipeline_uptime_seconds 流水线引擎运行时长')
  lines.push('# TYPE rag_pipeline_uptime_seconds gauge')
  lines.push(`rag_pipeline_uptime_seconds ${pipe.uptimeSec}`)

  // ---- 组件模式（info gauge：1 = 当前生效模式）----
  lines.push('# HELP rag_component_mode 组件运行模式（当前生效模式恒为 1）')
  lines.push('# TYPE rag_component_mode gauge')
  const modes: [string, string][] = [
    ['qdrant', settings.vectorMode],
    ['embedding', settings.embedMode],
    ['rerank', settings.rerankMode],
    ['mineru', settings.parseMode],
  ]
  for (const [component, mode] of modes) {
    if (mode) lines.push(`rag_component_mode{component="${component}",mode="${mode}"} 1`)
  }

  return lines.join('\n') + '\n'
}

/** 摘要（OpsView 指标卡用，JSON 友好格式） */
export async function metricsSummary(): Promise<{
  process: { uptimeSec: number }
  search: { total: number; errors: number; avgMs: number | null; maxMs: number; byMode: Record<string, number> }
  store: { kbs: number; documents: Record<string, number>; chunks: number; enabledChunks: number; points: number }
  api: { calls: number }
  pipeline: { pending: number; active: number; failed: number; completed: number; uptimeSec: number }
  modes: Record<string, string>
}> {
  const c = counters()
  const [kbs, docsByStatus, chunks, enabledChunks, pointAgg, apiCalls, pipe, settings] = await Promise.all([
    db.knowledgeBase.count(),
    db.document.groupBy({ by: ['status'], _count: { _all: true } }),
    db.chunk.count({ where: { isParent: false } }),
    db.chunk.count({ where: { isParent: false, enabled: true } }),
    db.knowledgeBase.aggregate({ _sum: { pointCount: true } }),
    db.apiKey.aggregate({ _sum: { callCount: true } }),
    pipelineStats(),
    getRagSettings(),
  ])
  const points = pointAgg._sum.pointCount ?? 0
  const documents: Record<string, number> = {}
  for (const r of docsByStatus) documents[r.status] = r._count._all
  return {
    process: { uptimeSec: Math.floor((Date.now() - c.startedAt) / 1000) },
    search: {
      total: c.searchTotal,
      errors: c.searchErrors,
      avgMs: c.searchDurCount > 0 ? Math.round(c.searchDurSumMs / c.searchDurCount) : null,
      maxMs: c.searchMaxMs,
      byMode: { ...c.searchByMode },
    },
    store: { kbs, documents, chunks, enabledChunks, points },
    api: { calls: apiCalls._sum.callCount ?? 0 },
    pipeline: {
      pending: pipe.pending,
      active: pipe.active,
      failed: pipe.failed,
      completed: pipe.completed,
      uptimeSec: pipe.uptimeSec,
    },
    modes: {
      qdrant: settings.vectorMode,
      embedding: settings.embedMode,
      rerank: settings.rerankMode,
      mineru: settings.parseMode,
    },
  }
}
