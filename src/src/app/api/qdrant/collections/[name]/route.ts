import { NextRequest, NextResponse } from 'next/server'
import { qdrantFetch, summarizeVectorConfig, type QdrantCollectionInfo } from '@/lib/qdrant'
import { getVectorStore, type LocalVectorStore } from '@/lib/rag/vectorstore'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/qdrant/collections/[name]
 * qdrant 模式：真实详情（保持基座结构）；local 模式：内置引擎合成信息。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params
  try {
    const store = await getVectorStore()
    if (store.mode === 'qdrant') {
      const info = await qdrantFetch<QdrantCollectionInfo>({
        path: `/collections/${encodeURIComponent(name)}`,
      })
      const summary = summarizeVectorConfig(info)
      const payloadSchema = info.payload_schema ?? {}
      const payloadFields = Object.entries(payloadSchema).map(([field, cfgRaw]: [string, any]) => {
        const cfg = cfgRaw?.payload_schema ?? cfgRaw
        return {
          field,
          type: cfg?.data_type ?? 'unknown',
          points: cfg?.points ?? 0,
          indexed: cfg?.index ?? false,
        }
      })
      return NextResponse.json({
        name,
        status: info.status,
        optimizer_status: info.optimizer_status,
        indexed_vectors_count: info.indexed_vectors_count ?? 0,
        points_count: info.points_count ?? 0,
        segments_count: info.segments_count ?? 0,
        type: summary.text,
        dense_vectors: summary.denseVectors,
        sparse_vectors: summary.sparseVectors,
        on_disk_payload: info.config?.params?.on_disk_payload ?? false,
        shard_number: info.config?.params?.shard_number ?? 1,
        replication_factor: info.config?.params?.replication_factor ?? 1,
        hnsw: info.config?.hnsw_config ?? null,
        quantization: info.config?.quantization_config ?? null,
        payload_fields: payloadFields,
        raw: info,
      })
    }

    // ---- local 模式 ----
    const local = store as LocalVectorStore
    const cols = await local.listCollections()
    const c = cols.find((x) => x.name === name)
    const kb = await db.knowledgeBase.findUnique({ where: { collection: name } })
    const pointsCount = c?.pointsCount ?? 0
    const dim = c?.dim ?? kb?.dim ?? 0
    const type = `dense${dim ? `(${dim}, Cosine)` : ''} + sparse(sparse)`
    return NextResponse.json({
      name,
      status: 'green',
      optimizer_status: 'ok',
      indexed_vectors_count: pointsCount,
      points_count: pointsCount,
      segments_count: 1,
      type,
      dense_vectors: dim ? [{ name: 'dense', size: dim, distance: 'Cosine' }] : [],
      sparse_vectors: ['sparse'],
      on_disk_payload: false,
      shard_number: 1,
      replication_factor: 1,
      hnsw: null,
      quantization: null,
      payload_fields: kb
        ? [
            { field: 'kb_id', type: 'keyword', points: pointsCount, indexed: true },
            { field: 'doc_id', type: 'keyword', points: pointsCount, indexed: true },
            { field: 'parent_id', type: 'keyword', points: pointsCount, indexed: true },
            { field: 'page', type: 'integer', points: pointsCount, indexed: true },
          ]
        : [],
      raw: {
        mode: 'local',
        collection: name,
        kb: kb ? { id: kb.id, name: kb.name, dim: kb.dim } : null,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
