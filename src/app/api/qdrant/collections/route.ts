import { NextResponse } from 'next/server'
import { qdrantFetch, summarizeVectorConfig, type QdrantCollectionInfo } from '@/lib/qdrant'
import { getVectorStore, type LocalVectorStore } from '@/lib/rag/vectorstore'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/qdrant/collections
 * qdrant 模式：真实 Qdrant（保持基座响应结构）；
 * local 模式：内置向量引擎（KnowledgeBase 聚合），基座工作台可浏览平台数据。
 */
export async function GET() {
  try {
    const store = await getVectorStore()
    if (store.mode === 'qdrant') {
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
    }

    // ---- local 模式：内置引擎聚合 ----
    const local = store as LocalVectorStore
    const cols = await local.listCollections()
    const collections = cols.map((c) => ({
      name: c.name,
      status: 'green',
      points_count: c.pointsCount,
      vectors_count: c.pointsCount,
      segments_count: 1,
      type: `dense${c.dim ? `(${c.dim}, Cosine)` : ''} + sparse(sparse)`,
      dense_vectors: c.dim ? [{ name: 'dense', size: c.dim, distance: 'Cosine' }] : [],
      sparse_vectors: ['sparse'],
      on_disk_payload: false,
    }))
    return NextResponse.json({ collections, total: collections.length })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
