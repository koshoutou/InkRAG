import { NextResponse } from 'next/server'
import { qdrantFetch, summarizeVectorConfig, type QdrantCollectionInfo } from '@/lib/qdrant'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/qdrant/collections —— 真实 Qdrant 集合列表（保持基座响应结构）。
 * v1.6：本地向量引擎已移除，未配置/不可达时直接报错引导配置。
 */
export async function GET() {
  try {
    const list = await qdrantFetch<{ collections: { name: string }[] }>({ path: '/collections' })
    const names = list?.collections ?? []
    const slice = names.slice(0, 50)
    const infos = await Promise.allSettled(
      slice.map((c) =>
        qdrantFetch<QdrantCollectionInfo>({ path: `/collections/${encodeURIComponent(c.name)}` })
      )
    )
    const collections = slice.map((c, i) => {
      const r = infos[i]
      if (r.status === 'fulfilled' && r.value) {
        const info = r.value
        const summary = summarizeVectorConfig(info)
        return {
          name: c.name,
          status: info.status,
          points_count: info.points_count ?? 0,
          vectors_count: info.indexed_vectors_count ?? 0,
          segments_count: info.segments_count ?? 0,
          type: summary.text,
          dense_vectors: summary.denseVectors,
          sparse_vectors: summary.sparseVectors,
          on_disk_payload: info.config?.params?.on_disk_payload ?? false,
        }
      }
      return {
        name: c.name,
        status: 'unknown',
        points_count: 0,
        vectors_count: 0,
        segments_count: 0,
        type: 'unknown',
        dense_vectors: [],
        sparse_vectors: [],
        on_disk_payload: false,
        error: r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : undefined,
      }
    })
    return NextResponse.json({ collections, total: names.length })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
