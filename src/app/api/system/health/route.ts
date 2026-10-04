import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getRagSettings } from '@/lib/rag/settings'
import { getVectorStore, isQdrantReachable } from '@/lib/rag/vectorstore'
import { pipelineStats } from '@/lib/rag/pipeline'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/system/health —— 聚合健康检查
 * { qdrant, vectorStore, embedding, mineru, rerank, events, pipeline }
 */
export async function GET() {
  try {
    const settings = await getRagSettings()

    // ---- Qdrant 探测 ----
    let qdrant: { mode: string; ok: boolean; version?: string; message: string }
    if (!settings.qdrant.url) {
      // F-E2E-02：文案与实际行为一致（v1.6 起本地引擎已移除，未配置时向量读写硬失败）
      qdrant = { mode: 'unconfigured', ok: false, message: '未配置 Qdrant——向量写入将硬失败，请到「设置 → Qdrant」配置' }
    } else {
      const probe = await isQdrantReachable(settings.qdrant, { noCache: true })
      qdrant = {
        mode: probe.ok ? 'qdrant' : 'unconfigured',
        ok: probe.ok,
        ...(probe.version ? { version: probe.version } : {}),
        message: probe.ok
          ? `连接成功${probe.version ? ` · ${probe.version}` : ''}`
          : `${probe.message}（向量读写将硬失败，不降级本地存储）`,
      }
    }

    // ---- VectorStore 聚合 ----
    let vectorStore: { mode: string; ok: boolean; collections: number; points: number }
    try {
      const store = await getVectorStore()
      const cols = await store.listCollections()
      vectorStore = {
        mode: store.mode,
        ok: true,
        collections: cols.length,
        points: cols.reduce((s, c) => s + c.pointsCount, 0),
      }
    } catch (e: any) {
      vectorStore = { mode: settings.vectorMode, ok: false, collections: 0, points: 0 }
      console.warn('[health] vectorStore 聚合失败:', e?.message ?? e)
    }

    // ---- Embedding ----
    let embedding: { mode: string; ok: boolean; dim?: number; model: string; message: string }
    if (settings.embedMode === 'real') {
      const dim = (await db.knowledgeBase.findFirst({ orderBy: { createdAt: 'desc' } }))?.dim
      embedding = {
        mode: 'real',
        ok: true,
        ...(dim ? { dim } : {}),
        model: settings.embed.model,
        message: 'OpenAI 兼容 /embeddings',
      }
    } else if (settings.embedMode === 'mock') {
      embedding = {
        mode: 'mock',
        ok: true,
        dim: 1024,
        model: 'mock-deterministic',
        message: '确定性哈希特征向量（沙箱演示）',
      }
    } else {
      embedding = {
        mode: 'none',
        ok: false,
        model: '',
        message: '未配置 Embedding 且未启用 Mock',
      }
    }

    // ---- MinerU（Task 15-b：按 provider 判定，直接读原始设置行，不依赖 getRagSettings 形状）----
    // selfhost → url 非空且探测可达；cloud → Token 配置即「已配置·云服务」；cloud-agent → 恒「已配置·Agent 免 Token」
    const settingRow = await db.qdrantSetting.findUnique({ where: { id: 'default' } })
    const rawProvider = settingRow?.mineruProvider ?? 'selfhost'
    const mineruProvider = (['selfhost', 'cloud', 'cloud-agent'].includes(rawProvider)
      ? rawProvider
      : 'selfhost') as 'selfhost' | 'cloud' | 'cloud-agent'
    const mineruUrl = (settingRow?.mineruApiUrl ?? '').trim()
    const mineruKey = (settingRow?.mineruApiKey ?? '').trim()

    let mineru: { mode: string; ok: boolean; message: string }
    if (mineruProvider === 'cloud-agent') {
      mineru = { mode: 'mineru', ok: true, message: '已配置 · MinerU 官方云（Agent 免 Token）' }
    } else if (mineruProvider === 'cloud') {
      mineru = mineruKey
        ? { mode: 'mineru', ok: true, message: '已配置 · MinerU 官方云（Token 鉴权）' }
        : {
            mode: 'fallback',
            ok: true,
            message: 'MinerU 云服务缺少 API Token（未生效），当前使用内置降级解析器',
          }
    } else if (!mineruUrl) {
      mineru = { mode: 'fallback', ok: true, message: '未配置 MinerU，使用内置降级解析器（md/txt/html/pdf）' }
    } else {
      try {
        const base = mineruUrl.replace(/\/+$/, '')
        const res = await fetch(base + '/v1/health', {
          headers: mineruKey ? { Authorization: `Bearer ${mineruKey}` } : {},
          signal: AbortSignal.timeout(3_000),
        })
        mineru = res.ok
          ? { mode: 'mineru', ok: true, message: `MinerU 连接成功（HTTP ${res.status}）` }
          : { mode: 'mineru', ok: false, message: `MinerU 健康检查失败：HTTP ${res.status}` }
      } catch (e: any) {
        mineru = { mode: 'mineru', ok: false, message: `MinerU 不可达：${e?.message ?? e}` }
      }
    }

    // ---- Rerank ----
    const rerank: { mode: string; ok: boolean; model: string }
      = settings.rerankMode === 'real'
        ? { mode: 'real', ok: true, model: settings.rerank.model }
        : settings.rerankMode === 'mock'
          ? { mode: 'mock', ok: true, model: 'mock-bm25' }
          : { mode: 'none', ok: false, model: '' }

    // ---- 实时事件服务探活（F-EXT-15：事件服务独立进程无守护，停摆时进度事件全丢且难以发现）----
    let events: { mode: string; ok: boolean; clients?: number; message: string }
    try {
      const emitBase = process.env.RAG_EVENTS_EMIT_URL?.replace(/\/emit$/, '').trim() || 'http://127.0.0.1:2609'
      const res = await fetch(`${emitBase}/healthz`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) {
        const j = (await res.json()) as { clients?: number; socketPort?: number; emitPort?: number }
        events = {
          mode: 'socket.io',
          ok: true,
          clients: j.clients ?? 0,
          message: `事件服务在线（socket ${j.socketPort ?? '?'} / emit ${j.emitPort ?? '?'} · 当前客户端 ${j.clients ?? 0}）`,
        }
      } else {
        events = { mode: 'down', ok: false, message: `事件服务异常响应：HTTP ${res.status}（实时进度将不可见，入库不受影响）` }
      }
    } catch (e) {
      events = {
        mode: 'down',
        ok: false,
        message: `事件服务不可达：${(e as Error).message}——实时进度将不可见（入库不受影响），请在 mini-services/pipeline-events 启动`,
      }
    }

    // ---- Pipeline ----
    const stats = await pipelineStats()
    // BE-011：draining 时 health 整体返回 503（k8s readiness probe 据此摘流）；
    // paused 仅告警不摘流（备份/恢复期间服务仍正常响应）
    const pipeline = {
      mode: 'engine',
      ok: !stats.draining,
      message: stats.draining
        ? `服务正在关闭（draining）：排空 ${stats.active} 个活跃任务，不再接收新任务`
        : stats.paused
          ? `流水线已暂停（${stats.pausedReason}）：活跃任务继续，新任务暂停认领 · pending ${stats.pending} / active ${stats.active}`
          : `队列运行中 · pending ${stats.pending} / active ${stats.active} / failed ${stats.failed}`,
      pending: stats.pending,
      active: stats.active,
      waiting: stats.waiting,
      completed: stats.completed,
      failed: stats.failed,
      uptimeSec: stats.uptimeSec,
      concurrency: stats.concurrency,
      paused: stats.paused,
      pausedReason: stats.pausedReason,
      pausedAt: stats.pausedAt,
      draining: stats.draining,
      drainingAt: stats.drainingAt,
    }

    return NextResponse.json(
      {
        health: {
          qdrant,
          vectorStore,
          embedding,
          mineru,
          rerank,
          events,
          pipeline,
        },
      },
      // draining → 503 让 k8s readiness / 网关探活摘流（liveness 仍走 /api/system/health/live 200）
      { status: stats.draining ? 503 : 200 },
    )
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
