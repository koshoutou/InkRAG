import { NextRequest, NextResponse } from 'next/server'
import { qdrantFetch, summarizeVectorConfig, type QdrantCollectionInfo } from '@/lib/qdrant'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/qdrant/collections/[name] —— 真实 Qdrant 集合详情（保持基座结构）。
 * v1.6：本地向量引擎已移除，未配置/不可达时直接报错引导配置。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params
  try {
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
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
