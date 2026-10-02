// Shared types for the Qdrant KB Manager frontend.

export interface QdrantSettings {
  id: string
  url: string
  apiKey: string
  defaultCollection: string
  // Embedding — OpenAI-compatible
  embedApiBase: string
  embedApiKey: string
  embedModel: string
  // Rerank — OpenAI-compatible (or Cohere-style)
  rerankApiBase: string
  rerankApiKey: string
  rerankModel: string
  updatedAt: string
}

export interface DenseVectorInfo {
  name: string | null
  size: number
  distance: string
}

export interface CollectionSummary {
  name: string
  status: string
  points_count: number
  vectors_count: number
  segments_count: number
  type: string
  dense_vectors: DenseVectorInfo[]
  sparse_vectors: string[]
  on_disk_payload: boolean
  error?: string
}

export interface CollectionDetail extends CollectionSummary {
  optimizer_status: string
  indexed_vectors_count: number
  shard_number: number
  replication_factor: number
  hnsw: any
  quantization: any
  payload_fields: PayloadField[]
  raw: any
}

export interface PayloadField {
  field: string
  type: string
  points: number
  indexed: boolean
}

export interface QdrantPoint {
  id: string | number
  payload: Record<string, any>
  vector?: any
}

export interface ScrollResult {
  points: QdrantPoint[]
  next_page_offset: string | number | null
  total: number
}

export type SearchMode = 'dense' | 'sparse' | 'hybrid' | 'recommend'

export interface SearchHit {
  id: string | number
  score: number
  payload: Record<string, any>
  vector?: any
  original_score?: number
}

export interface SearchResponse {
  results: SearchHit[]
  query_vector: number[] | null
  query_sparse: { indices: number[]; values: number[] } | null
  mode: SearchMode
  reranked: boolean
  took_ms: number
  count: number
  embed_dim?: number
  embed_provider?: string
  error?: string
}

export interface CallLogItem {
  id: string
  source: string
  collection: string
  query: string
  mode: SearchMode
  topK: number
  scoreThreshold: number
  reranked: boolean
  tookMs: number
  resultCount: number
  params: Record<string, any>
  results: {
    id: string | number
    score: number
    payload_summary: string
    file: string | null
  }[]
  createdAt: string
}
