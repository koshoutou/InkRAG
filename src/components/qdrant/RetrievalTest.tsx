'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Search, Sparkles, Sliders, Wand2, Copy, Loader2,
  Frown, MapPin, Hash, Crosshair, X, Download, Keyboard, AlertTriangle,
  ChevronUp, ChevronDown, FileJson,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { toast } from 'sonner'
import { api, payloadContent, payloadFileRef } from './api'
import { useQdrantStore } from './store'
import { truncate, shortId } from './format'
import type { SearchMode, SearchHit, SearchResponse } from './types'

const MODELS_HINTS: Record<SearchMode, string> = {
  dense: '用 query 文本求稠密向量，做标准 ANN 召回',
  sparse: '用 query 文本求稀疏向量（BGE-M3 或基于稠密派生），走 Qdrant 的 sparse 索引',
  hybrid: '稠密 + 稀疏多路召回，Qdrant 内部 RRF/Dists 融合后排序',
  recommend: '不依赖 query 文本，按已有分块 ID 做相似推荐',
}

export function RetrievalTest() {
  const name = useQdrantStore((s) => s.activeCollection)!
  const { data: coll } = useQuery({
    queryKey: ['collection', name],
    queryFn: () => api.getCollection(name),
    enabled: !!name,
  })

  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('dense')
  const [vectorName, setVectorName] = useState<string>('')
  const [sparseName, setSparseName] = useState<string>('')
  const [topK, setTopK] = useState(10)
  const [scoreThreshold, setScoreThreshold] = useState(0)
  const [rerank, setRerank] = useState(false)
  const [fusion, setFusion] = useState<'rrf' | 'dists'>('rrf')
  const [filterJson, setFilterJson] = useState('')
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [recommendId, setRecommendId] = useState('')

  // Derived: collection capabilities
  const hasSparse = !!coll?.sparse_vectors?.length
  const hasDense = !!coll?.dense_vectors?.length

  // When collection loads, auto-pick sensible vector/sparse names.
  useEffect(() => {
    if (!coll) return
    if (coll.dense_vectors.length) {
      setVectorName(coll.dense_vectors[0]?.name ?? '')
    }
    if (coll.sparse_vectors.length) {
      setSparseName(coll.sparse_vectors[0] ?? '')
    }
    if (coll.dense_vectors.length > 0 && coll.sparse_vectors.length > 0) {
      setMode('hybrid')
    } else {
      setMode('dense')
    }
  }, [coll])

  // Guard: if user switches to a collection without sparse, force mode back to dense.
  useEffect(() => {
    if ((mode === 'sparse' || mode === 'hybrid') && !hasSparse) {
      setMode('dense')
      toast.info('当前集合没有 sparse_vectors 字段，已切换为 Dense 模式')
    }
  }, [mode, hasSparse])

  const canSearch = useMemo(() => {
    if (mode === 'recommend') return !!recommendId.trim()
    return query.trim().length > 0
  }, [mode, query, recommendId])

  const onSearch = async () => {
    if (!canSearch) {
      toast.error(mode === 'recommend' ? '请填写参考分块 ID' : '请输入查询文本')
      return
    }
    // Pre-flight sanity checks (avoids 400 from Qdrant)
    if ((mode === 'sparse' || mode === 'hybrid') && !hasSparse) {
      const msg = '当前集合没有 sparse_vectors 字段，无法使用此模式'
      setErr(msg)
      toast.error(msg)
      return
    }
    if (!hasDense) {
      const msg = '当前集合没有 dense 向量字段'
      setErr(msg)
      toast.error(msg)
      return
    }
    setSearching(true)
    setErr(null)
    try {
      let parsedFilter: any = null
      if (filterJson.trim()) {
        try {
          parsedFilter = JSON.parse(filterJson)
        } catch (e: any) {
          toast.error('过滤器 JSON 解析失败：' + e.message)
          setSearching(false)
          return
        }
      }
      const res = await api.search(name, {
        query,
        mode,
        vector_name: vectorName || null,
        sparse_name: sparseName || null,
        recommend_point_id: mode === 'recommend' ? recommendId : null,
        limit: topK,
        score_threshold: scoreThreshold,
        filter: parsedFilter,
        with_payload: true,
        with_vector: false,
        rerank,
        rerank_top_n: topK,
        fusion,
        save_history: true,
      })
      setResult(res)
      toast.success(`已召回 ${res.count} 条 · ${res.took_ms}ms${res.reranked ? ' · 已重排' : ''}`)
    } catch (e: any) {
      setErr(e?.message ?? String(e))
      toast.error('检索失败：' + (e?.message ?? String(e)))
    } finally {
      setSearching(false)
    }
  }

  const onExport = () => {
    if (!result) return
    const payload = {
      collection: name,
      query,
      mode: result.mode,
      reranked: result.reranked,
      took_ms: result.took_ms,
      count: result.count,
      exported_at: new Date().toISOString(),
      results: result.results.map((r) => ({
        id: r.id,
        score: r.score,
        original_score: r.original_score,
        payload: r.payload,
      })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `recall_${name}_${result.mode}_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('已导出 JSON')
  }

  return (
    <div className="space-y-3">
      {/* Query card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Search className="h-4 w-4 text-primary" />
            召回测试
          </CardTitle>
          <CardDescription className="text-xs">
            输入查询文本，选择检索方式与参数；后端会用 Python BGE 模型求向量，
            再调用 Qdrant 的 /points/search 或 /points/query 完成召回，可选重排。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label className="text-xs text-muted-foreground">检索方式</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as SearchMode)}>
                <SelectTrigger className="mt-1 h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dense" className="text-xs">Dense — 稠密向量召回</SelectItem>
                  <SelectItem value="sparse" className="text-xs" disabled={!hasSparse}>
                    Sparse — 稀疏关键词召回 {!hasSparse && '(集合无 sparse 字段)'}
                  </SelectItem>
                  <SelectItem value="hybrid" className="text-xs" disabled={!hasSparse}>
                    Hybrid — 稠密+稀疏融合 {!hasSparse && '(集合无 sparse 字段)'}
                  </SelectItem>
                  <SelectItem value="recommend" className="text-xs">Recommend — 按分块 ID 推荐</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">{MODELS_HINTS[mode]}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Top K</Label>
              <div className="mt-1 flex items-center gap-2">
                <Slider
                  value={[topK]}
                  onValueChange={(v) => setTopK(v[0])}
                  min={1}
                  max={50}
                  step={1}
                  className="flex-1"
                />
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={topK}
                  onChange={(e) => setTopK(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                  className="h-9 w-20 text-xs"
                />
              </div>
            </div>
          </div>

          {mode === 'recommend' ? (
            <div>
              <Label className="text-xs text-muted-foreground">参考分块 ID</Label>
              <Input
                value={recommendId}
                onChange={(e) => setRecommendId(e.target.value)}
                placeholder="例：1 或 UUID"
                className="mt-1 h-9 text-xs font-mono"
              />
            </div>
          ) : (
            <div>
              <Label className="text-xs text-muted-foreground">查询文本</Label>
              <Textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="例如：什么是机器学习中的反向传播？"
                className="mt-1 min-h-[80px] text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    onSearch()
                  }
                }}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                快捷键 ⌘/Ctrl + Enter 触发检索
              </p>
            </div>
          )}

          <Accordion type="single" collapsible value={advancedOpen ? 'adv' : ''} onValueChange={(v) => setAdvancedOpen(v === 'adv')}>
            <AccordionItem value="adv" className="border-b-0">
              <AccordionTrigger className="py-2 text-xs font-medium">
                <span className="flex items-center gap-2">
                  <Sliders className="h-3.5 w-3.5" />
                  高级参数（向量名 / 稀疏名 / 阈值 / 过滤 / 重排 / 融合）
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-3 pt-2">
                <div className="grid gap-3 md:grid-cols-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">稠密向量名 (using)</Label>
                    <Select value={vectorName || '__default__'} onValueChange={(v) => setVectorName(v === '__default__' ? '' : v)}>
                      <SelectTrigger className="mt-1 h-9 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default__" className="text-xs">(默认)</SelectItem>
                        {coll?.dense_vectors?.filter((v) => v.name).map((v) => (
                          <SelectItem key={v.name ?? 'def'} value={v.name ?? '__default__'} className="text-xs font-mono">
                            {v.name ?? '(默认)'} · {v.size}d
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">稀疏向量名</Label>
                    <Select value={sparseName || '__none__'} onValueChange={(v) => setSparseName(v === '__none__' ? '' : v)} disabled={!hasSparse}>
                      <SelectTrigger className="mt-1 h-9 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__" className="text-xs">(无)</SelectItem>
                        {coll?.sparse_vectors?.map((n) => (
                          <SelectItem key={n} value={n} className="text-xs font-mono">{n}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!hasSparse && (
                      <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                        当前集合未配置 sparse_vectors
                      </p>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">分数阈值 (score_threshold)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      max={1}
                      value={scoreThreshold}
                      onChange={(e) => setScoreThreshold(parseFloat(e.target.value) || 0)}
                      className="mt-1 h-9 text-xs"
                    />
                  </div>
                </div>

                {(mode === 'sparse' || mode === 'hybrid') && (
                  <div>
                    <Label className="text-xs text-muted-foreground">Hybrid 融合方式 (fusion)</Label>
                    <Select value={fusion} onValueChange={(v) => setFusion(v as any)}>
                      <SelectTrigger className="mt-1 h-9 w-40 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="rrf" className="text-xs">RRF (Reciprocal Rank Fusion)</SelectItem>
                        <SelectItem value="dists" className="text-xs">Dists (基于距离归一)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div>
                  <Label className="text-xs text-muted-foreground">Qdrant 过滤器 (JSON, 可空)</Label>
                  <Textarea
                    value={filterJson}
                    onChange={(e) => setFilterJson(e.target.value)}
                    placeholder='{"must":[{"key":"source","match":{"value":"report.pdf"}}]}'
                    className="mt-1 min-h-[60px] font-mono text-[11px]"
                  />
                </div>

                <div className="flex items-center gap-3 rounded-md border bg-muted/20 px-3 py-2">
                  <Switch id="rerank" checked={rerank} onCheckedChange={setRerank} />
                  <Label htmlFor="rerank" className="text-xs font-medium">召回后用 Reranker 重排</Label>
                  <Badge variant="secondary" className="ml-auto max-w-[60%] truncate text-[10px] font-mono" title={useQdrantStore.getState().settings?.rerankModel}>
                    {useQdrantStore.getState().settings?.rerankModel || '未配置'}
                  </Badge>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={onSearch} disabled={searching || !canSearch} className="gap-1.5">
              {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              {searching ? '检索中…' : '开始检索'}
            </Button>
            {result && (
              <>
                <Button variant="outline" onClick={() => { setResult(null); setErr(null) }} className="gap-1.5">
                  <X className="h-3.5 w-3.5" />
                  清空
                </Button>
                <Button variant="outline" onClick={onExport} className="gap-1.5" title="导出为 JSON 文件">
                  <Download className="h-3.5 w-3.5" />
                  导出
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      <AnimatePresence>
        {err && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
          >
            <Card className="border-rose-500/40 bg-rose-500/5">
              <CardContent className="flex items-start gap-2 p-3 text-sm text-rose-600 dark:text-rose-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">检索失败</p>
                  <p className="mt-0.5 break-words text-[12px] opacity-90">{err}</p>
                </div>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-rose-500" onClick={() => setErr(null)}>
                  <X className="h-3 w-3" />
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results */}
      {result && <ResultPanel result={result} query={query} />}
    </div>
  )
}

function ResultPanel({ result, query }: { result: SearchResponse; query: string }) {
  const [showVector, setShowVector] = useState(false)
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Wand2 className="h-4 w-4 text-primary" />
          召回结果
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="text-[10px]">{result.count} 条</Badge>
          <Badge variant="outline" className="text-[10px]">{result.mode}</Badge>
          {result.reranked && <Badge variant="secondary" className="text-[10px] gap-1"><Sparkles className="h-2.5 w-2.5" /> reranked</Badge>}
          <Badge variant="outline" className="text-[10px] font-mono">{result.took_ms}ms</Badge>
          {result.query_vector && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setShowVector(!showVector)}
                    className="rounded-full border px-1.5 py-0.5 text-[10px] font-mono hover:bg-muted"
                  >
                    query_vec {result.query_vector?.length ?? 0}d
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {showVector ? '点击隐藏' : '点击展开'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </CardDescription>
        {showVector && result.query_vector && (
          <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-muted/40 p-2 text-[10px] leading-relaxed font-mono">
            [{result.query_vector.slice(0, 8).map((v) => v.toFixed(4)).join(', ')}, ... ({result.query_vector.length}d)]
          </pre>
        )}
      </CardHeader>
      <CardContent>
        {result.results.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Frown className="h-6 w-6 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">没有命中，尝试调高 topK 或降低阈值。</p>
          </div>
        ) : (
          <ol className="space-y-2">
            <AnimatePresence initial={false}>
              {result.results.map((hit, i) => (
                <motion.li
                  key={String(hit.id)}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, delay: Math.min(i * 0.025, 0.4) }}
                  className="list-none"
                >
                  <HitRow hit={hit} rank={i + 1} query={query} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

function HitRow({ hit, rank, query }: { hit: SearchHit; rank: number; query: string }) {
  const content = payloadContent(hit.payload)
  const fileRef = payloadFileRef(hit.payload)
  const score = hit.score ?? 0
  const barPct = Math.max(2, Math.min(100, Math.abs(score) * 100))
  return (
    <div className="group rounded-lg border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-muted/20">
      <div className="flex items-start gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary ring-1 ring-primary/15 transition-transform group-hover:scale-105">
          {rank}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="font-mono text-[10px]" title={String(hit.id)}>
              <Hash className="mr-1 h-2.5 w-2.5" />
              {shortId(hit.id)}
            </Badge>
            {fileRef && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary" className="gap-1 text-[10px]">
                      <MapPin className="h-2.5 w-2.5" />
                      {truncate(fileRef.value, 28)}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-md">
                    <p className="font-mono text-[11px]">{fileRef.label}: {fileRef.value}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {hit.original_score !== undefined && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="text-[10px] line-through opacity-60">
                      orig {hit.original_score.toFixed(4)}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>重排前的原始分数</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed">
            {content ? highlightQuery(content, query) : '(无文本内容)'}
          </p>
        </div>
        <div className="flex w-28 shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5">
            <Crosshair className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono text-xs font-semibold">{score.toFixed(4)}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" title={`score: ${score.toFixed(4)}`}>
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={{ width: 0 }}
              animate={{ width: `${barPct}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-[11px] text-muted-foreground"
            onClick={() => {
              navigator.clipboard?.writeText(content).then(
                () => toast.success('已复制片段'),
                () => toast.error('复制失败')
              )
            }}
          >
            <Copy className="h-3 w-3" />
            复制
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Highlight query keywords in content text.
 *  Chinese queries are not space-separated, so we additionally extract
 *  2-4 char ngrams and any ASCII words (length >= 2).
 */
function highlightQuery(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text
  const tokens = extractQueryTokens(query)
  if (tokens.length === 0) return text
  // De-dup, escape, build single global regex.
  const unique = Array.from(new Set(tokens.map((t) => t.toLowerCase())))
  const escaped = unique.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = text.split(re)
  const tokenSet = new Set(unique)
  return parts.map((part, i) =>
    tokenSet.has(part.toLowerCase()) ? (
      <mark key={i} className="rounded bg-amber-300/50 px-0.5 text-foreground dark:bg-amber-400/40">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  )
}

/** Extract highlight tokens from a (possibly Chinese) query. */
function extractQueryTokens(query: string): string[] {
  const q = query.trim()
  if (!q) return []
  const tokens: string[] = []
  // 1. ASCII words (length >= 2), e.g. "RAG", "Transformer"
  const asciiWords = q.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) || []
  for (const w of asciiWords) if (w.length >= 2) tokens.push(w)
  // 2. CJK continuous runs — extract 2,3,4-char ngrams so that "知识库召回"
  //    produces "知识", "识库", "库召", "召回", "知识库", "识库召", "库召回",
  //    "知识库召", "识库召回", "知识库召回". We keep unique ones; longer matches
  //    win because regex alternation tries left-to-right by source order,
  //    so we put longer tokens first.
  const cjkRuns = q.match(/[\u4e00-\u9fa5]{2,}/g) || []
  const seen = new Set<string>()
  for (const run of cjkRuns) {
    // Also push the whole run as a token.
    if (!seen.has(run)) { tokens.push(run); seen.add(run) }
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const ng = run.slice(i, i + n)
        if (!seen.has(ng)) { tokens.push(ng); seen.add(ng) }
      }
    }
  }
  // Sort by length desc so longer matches win in regex alternation.
  tokens.sort((a, b) => b.length - a.length)
  return tokens
}
