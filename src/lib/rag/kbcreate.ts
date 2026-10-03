/**
 * 建库核心（Task 17-2/17-3 共享层）
 *
 * 从 POST /api/kb 抽取的单一实现，供三条链路复用：
 *   - POST /api/kb（平台 UI）
 *   - POST /api/input/knowledge-bases（入库 API，Agent 调用）
 *   - POST /v1/datasets（Dify 兼容数据集 API，MinerU 面板导出对接）
 *
 * 校验与语义与 v1.6 建库强校验完全一致：
 *   - 名称唯一（409）｜未配置 Qdrant / Embedding（400，引导设置页）
 *   - probeEmbedding 实测锁定 dim / sparseScheme / embeddingModel；显式 dim 不一致 → 400
 *   - Qdrant 不可达 → 硬失败（不落库行，避免孤儿记录）
 *
 * retrievalMode（hybrid/dense/sparse）为库级检索模式元数据（供外部检索平台读取），
 * 本平台不再执行检索（§32）；建库时锁定并随 KbSummary 暴露。
 */
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import type { KnowledgeBase } from '@prisma/client'
import { getRagSettings } from './settings'
import { getVectorStore, StoreError } from './vectorstore'
import { parseChunkConfig } from './serialize'
import { DEFAULT_CHUNK_CONFIG } from './chunking'
import { probeEmbedding } from './embed'
import { recordOp } from './oplog'

export type RetrievalMode = 'hybrid' | 'dense' | 'sparse'
export const RETRIEVAL_MODES: RetrievalMode[] = ['hybrid', 'dense', 'sparse']

export interface CreateKbInput {
  name: string
  description?: string
  /** 一次性切分配置（size/overlap/parentSize/strategy/protects）；缺省用平台默认 */
  chunkConfig?: Record<string, unknown>
  /** 库级 Rerank 开关（元数据，供外部检索平台使用） */
  rerankEnabled?: boolean
  /** 库级检索模式（hybrid/dense/sparse；缺省 hybrid） */
  retrievalMode?: string
  /** 显式维度（与实测不一致 → 400，v1.6 语义） */
  dim?: number
}

export type CreateKbResult =
  | { ok: true; kb: KnowledgeBase }
  | { ok: false; status: number; error: string }

export function isValidRetrievalMode(v: unknown): v is RetrievalMode {
  return typeof v === 'string' && RETRIEVAL_MODES.includes(v as RetrievalMode)
}

/** 建库核心：校验 → 建集合 → 落库行。失败返回 { ok:false, status, error }（路由层映射 HTTP） */
async function createKnowledgeBaseCoreImpl(input: CreateKbInput): Promise<CreateKbResult> {
  const name = String(input.name ?? '').trim()
  if (!name) return { ok: false, status: 400, error: '知识库名称不能为空' }

  const exists = await db.knowledgeBase.findUnique({ where: { name } })
  if (exists) return { ok: false, status: 409, error: `知识库名称已存在：${name}` }

  const settings = await getRagSettings()
  if (settings.vectorMode !== 'qdrant' || !settings.qdrant.url) {
    return {
      ok: false,
      status: 400,
      error: '未配置 Qdrant 连接，无法创建知识库（请先到「设置 → Qdrant」配置并测试连通）',
    }
  }
  if (settings.embedMode !== 'real') {
    return {
      ok: false,
      status: 400,
      error: '未配置 Embedding API，无法创建知识库（请先到「设置 → Embedding」配置）',
    }
  }

  // 实测探测：dim + sparse 方案（写入库行锁定，中途换模型会被入库断言拦截）
  const probe = await probeEmbedding()
  if (!probe.ok) {
    return {
      ok: false,
      status: 400,
      error: `嵌入 API 探测失败：${probe.error ?? '未知错误'}（请检查「设置 → Embedding」配置）`,
    }
  }
  const dim = probe.dim
  const bodyDim = Number(input.dim) > 0 ? Math.floor(Number(input.dim)) : 0
  if (bodyDim > 0 && bodyDim !== dim) {
    return {
      ok: false,
      status: 400,
      error: `指定维度 ${bodyDim} 与嵌入模型实测维度 ${dim} 不一致（模型 ${settings.embed.model}），请以实测维度为准`,
    }
  }

  const embeddingModel = settings.embed.model
  const sparseScheme = probe.sparseScheme
  let chunkConfig
  try {
    chunkConfig = input.chunkConfig
      ? parseChunkConfig(JSON.stringify(input.chunkConfig))
      : { ...DEFAULT_CHUNK_CONFIG }
  } catch (e: any) {
    return { ok: false, status: 400, error: `chunkConfig 不合法：${e?.message ?? String(e)}` }
  }
  const rerankEnabled = input.rerankEnabled === true
  const retrievalMode = isValidRetrievalMode(input.retrievalMode) ? input.retrievalMode : 'hybrid'

  const id = randomUUID()
  const collection = `kb_${id.replace(/-/g, '').slice(0, 12)}`

  // 先建集合（Qdrant 不可达 → 硬失败，不落库行避免孤儿记录）
  try {
    const store = await getVectorStore()
    await store.ensureCollection(collection, dim)
  } catch (e: any) {
    const status = e instanceof StoreError ? (e.status ?? 503) : 500
    return { ok: false, status, error: e?.message ?? String(e) }
  }

  const kb = await db.knowledgeBase.create({
    data: {
      id,
      name,
      description: String(input.description ?? ''),
      collection,
      embeddingModel,
      dim,
      chunkConfig: JSON.stringify(chunkConfig),
      vectorMode: 'qdrant',
      sparseScheme,
      rerankEnabled,
      retrievalMode,
    },
  })
  return { ok: true, kb }
}

/**
 * 对外入口（带程序日志）：成功 info / 失败 warn（Task 17-5）。
 * 三条链路（/api/kb、/api/input、/v1/datasets）共用，一处埋点全覆盖。
 */
export async function createKnowledgeBaseCore(input: CreateKbInput): Promise<CreateKbResult> {
  const t0 = Date.now()
  const r = await createKnowledgeBaseCoreImpl(input)
  if (r.ok) {
    recordOp({
      level: 'info',
      category: 'kb',
      action: 'kb.create',
      message: `创建知识库「${r.kb.name}」（集合 ${r.kb.collection}，dim ${r.kb.dim}，retrievalMode ${r.kb.retrievalMode}）`,
      durationMs: Date.now() - t0,
      kbId: r.kb.id,
    })
  } else {
    recordOp({
      level: 'warn',
      category: 'kb',
      action: 'kb.create_failed',
      message: `创建知识库失败（${input.name}）：${r.error}`,
      detail: { status: r.status },
      statusCode: r.status,
    })
  }
  return r
}
