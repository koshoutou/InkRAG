'use client'

import { useEffect, useState } from 'react'
import { Loader2, Plug, Save, Eye, EyeOff, Settings as SettingsIcon, Server, Cpu, Sparkles, CheckCircle2, XCircle } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { api } from './api'
import { useQdrantStore } from './store'
import type { QdrantSettings } from './types'

const DEFAULT_FORM: QdrantSettings = {
  id: 'default',
  url: '', apiKey: '', defaultCollection: '',
  embedApiBase: '', embedApiKey: '', embedModel: '',
  rerankApiBase: '', rerankApiKey: '', rerankModel: '',
  updatedAt: '',
}

export function SettingsDialog() {
  const open = useQdrantStore((s) => s.settingsOpen)
  const setOpen = useQdrantStore((s) => s.setSettingsOpen)
  const triggerRefresh = useQdrantStore((s) => s.triggerRefreshCollections)

  const [form, setForm] = useState<QdrantSettings>(DEFAULT_FORM)
  const [loaded, setLoaded] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [showEmbedKey, setShowEmbedKey] = useState(false)
  const [showRerankKey, setShowRerankKey] = useState(false)
  const [testing, setTesting] = useState<'qdrant' | 'embed' | 'rerank' | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string; dim?: number; version?: string }>>({})
  const [saving, setSaving] = useState(false)

  // Load settings when dialog opens. Note: hooks run unconditionally;
  // we render the Dialog only when open, but useState/useEffect always run.
  useEffect(() => {
    if (!open) {
      setTestResults({})
      return
    }
    let cancelled = false
    api.getSettings().then((s) => {
      if (!cancelled) {
        setForm(s)
        setLoaded(true)
      }
    }).catch((e) => {
      if (!cancelled) toast.error('读取设置失败：' + e.message)
    })
    return () => { cancelled = true }
  }, [open])

  if (!open) return null

  const update = <K extends keyof QdrantSettings>(k: K, v: QdrantSettings[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const onTest = async (kind: 'qdrant' | 'embed' | 'rerank') => {
    setTesting(kind)
    try {
      let r: { ok: boolean; message: string; dim?: number; version?: string }
      if (kind === 'qdrant') {
        if (!form.url) { toast.error('请填写 Qdrant 服务地址'); return }
        r = await api.testConnection('qdrant', { url: form.url, apiKey: form.apiKey })
      } else if (kind === 'embed') {
        if (!form.embedApiBase) { toast.error('请填写 Embedding API Base'); return }
        if (!form.embedModel) { toast.error('请填写 Embedding 模型 ID'); return }
        r = await api.testConnection('embed', { url: form.embedApiBase, apiKey: form.embedApiKey, model: form.embedModel })
      } else {
        if (!form.rerankApiBase) { toast.error('请填写 Rerank API Base'); return }
        if (!form.rerankModel) { toast.error('请填写 Rerank 模型 ID'); return }
        r = await api.testConnection('rerank', { url: form.rerankApiBase, apiKey: form.rerankApiKey, model: form.rerankModel })
      }
      setTestResults(prev => ({ ...prev, [kind]: r }))
      if (r.ok) toast.success(r.message)
      else toast.error(r.message)
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [kind]: { ok: false, message: e?.message ?? String(e) } }))
      toast.error(e?.message ?? String(e))
    } finally {
      setTesting(null)
    }
  }

  const onSave = async (alsoTestQdrant = false) => {
    setSaving(true)
    try {
      const r = await api.saveSettings({ ...form, test: alsoTestQdrant })
      toast.success('设置已保存')
      if (r.test) {
        setTestResults(prev => ({ ...prev, qdrant: r.test }))
      }
      useQdrantStore.getState().setSettings(r.settings)
      triggerRefresh()
    } catch (e: any) {
      toast.error('保存失败：' + (e?.message ?? String(e)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="border-b px-6 py-3.5">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <SettingsIcon className="h-4 w-4 text-primary" />
            连接设置
          </DialogTitle>
          <DialogDescription className="text-xs">
            配置 Qdrant 实例地址 / 密钥、Embedding 与 Rerank API（均使用 OpenAI 兼容协议）。所有字段保存在本地 SQLite，不会上传到任何服务器。
          </DialogDescription>
        </DialogHeader>

        {!loaded ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <Tabs defaultValue="conn" className="px-6 pt-4">
            <TabsList className="h-9">
              <TabsTrigger value="conn" className="text-xs gap-1.5"><Server className="h-3.5 w-3.5" /> Qdrant 连接</TabsTrigger>
              <TabsTrigger value="embed" className="text-xs gap-1.5"><Cpu className="h-3.5 w-3.5" /> Embedding</TabsTrigger>
              <TabsTrigger value="rerank" className="text-xs gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Rerank</TabsTrigger>
            </TabsList>

            {/* Qdrant connection tab */}
            <TabsContent value="conn" className="space-y-4 pb-2 pt-4">
              <div>
                <Label htmlFor="url" className="text-xs text-muted-foreground">Qdrant 服务地址</Label>
                <Input
                  id="url"
                  value={form.url}
                  onChange={(e) => update('url', e.target.value)}
                  placeholder="https://your-qdrant.example.com  或  http://localhost:6333"
                  className="mt-1.5 h-10 text-sm"
                />
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  支持 cloud / 自建 / 本地。不带尾斜杠。兼容 Qdrant v1.7+。可填 IPv6 地址。
                </p>
              </div>
              <div>
                <Label htmlFor="key" className="text-xs text-muted-foreground">API Key（可空，本地无鉴权留空）</Label>
                <div className="mt-1.5 flex gap-2">
                  <Input
                    id="key"
                    type={showKey ? 'text' : 'password'}
                    value={form.apiKey}
                    onChange={(e) => update('apiKey', e.target.value)}
                    placeholder="留空表示无鉴权"
                    className="h-10 text-sm font-mono"
                  />
                  <Button size="icon" variant="outline" className="h-10 w-10 shrink-0" onClick={() => setShowKey(!showKey)}>
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div>
                <Label htmlFor="defcol" className="text-xs text-muted-foreground">默认集合（可空，连接后自动选中）</Label>
                <Input
                  id="defcol"
                  value={form.defaultCollection}
                  onChange={(e) => update('defaultCollection', e.target.value)}
                  placeholder="例：dify_knowledge_1 或 llama_docs"
                  className="mt-1.5 h-10 text-sm font-mono"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => onTest('qdrant')} disabled={testing === 'qdrant' || !form.url} className="gap-1.5">
                  {testing === 'qdrant' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
                  测试连接
                </Button>
                {testResults.qdrant && (
                  <Badge variant={testResults.qdrant.ok ? 'default' : 'destructive'} className="gap-1 text-[10px]">
                    {testResults.qdrant.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                    {testResults.qdrant.ok ? '连接成功' : '连接失败'}
                    {testResults.qdrant.version && ` · v${testResults.qdrant.version}`}
                  </Badge>
                )}
              </div>
              {testResults.qdrant && !testResults.qdrant.ok && (
                <p className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-600 dark:text-rose-400">
                  {testResults.qdrant.message}
                </p>
              )}
            </TabsContent>

            {/* Embedding tab */}
            <TabsContent value="embed" className="space-y-4 pb-2 pt-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                <p className="font-medium text-foreground">说明</p>
                Embedding 使用 <span className="font-mono">OpenAI 兼容协议</span>：向 <span className="font-mono">{'{apiBase}/embeddings'}</span> 发 POST 请求，
                body 为 <span className="font-mono">{'{ model, input }'}</span>，返回 <span className="font-mono">{'{ data: [{ embedding: [...] }] }'}</span>。
                支持任何 OpenAI 兼容服务（OpenAI 官方 / Azure / Ollama / vLLM / LocalAI 等）。
                向量维度会从 API 响应自动推断，<b>不需要手动填写</b>。
              </div>
              <div>
                <Label htmlFor="embed-base" className="text-xs text-muted-foreground">Embedding API Base</Label>
                <Input
                  id="embed-base"
                  value={form.embedApiBase}
                  onChange={(e) => update('embedApiBase', e.target.value)}
                  placeholder="https://api.openai.com/v1  或  http://localhost:11434/v1"
                  className="mt-1.5 h-10 text-sm font-mono"
                />
              </div>
              <div>
                <Label htmlFor="embed-model" className="text-xs text-muted-foreground">Embedding 模型 ID（自行填写）</Label>
                <Input
                  id="embed-model"
                  value={form.embedModel}
                  onChange={(e) => update('embedModel', e.target.value)}
                  placeholder="text-embedding-3-small  /  BAAI/bge-m3  /  bge-large-zh-v1.5  /  ..."
                  className="mt-1.5 h-10 text-sm font-mono"
                />
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  填写服务商的模型标识。例：OpenAI 用 <span className="font-mono">text-embedding-3-small</span>（1536d），
                  兼容服务常用 <span className="font-mono">BAAI/bge-m3</span>（1024d），
                  本地 Ollama 用 <span className="font-mono">bge-m3</span>。
                </p>
              </div>
              <div>
                <Label htmlFor="embed-key" className="text-xs text-muted-foreground">Embedding API Key（可空）</Label>
                <div className="mt-1.5 flex gap-2">
                  <Input
                    id="embed-key"
                    type={showEmbedKey ? 'text' : 'password'}
                    value={form.embedApiKey}
                    onChange={(e) => update('embedApiKey', e.target.value)}
                    placeholder="sk-...（无鉴权留空）"
                    className="h-10 text-sm font-mono"
                  />
                  <Button size="icon" variant="outline" className="h-10 w-10 shrink-0" onClick={() => setShowEmbedKey(!showEmbedKey)}>
                    {showEmbedKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => onTest('embed')} disabled={testing === 'embed' || !form.embedApiBase || !form.embedModel} className="gap-1.5">
                  {testing === 'embed' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
                  测试 Embedding
                </Button>
                {testResults.embed && (
                  <Badge variant={testResults.embed.ok ? 'default' : 'destructive'} className="gap-1 text-[10px]">
                    {testResults.embed.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                    {testResults.embed.ok ? `可用 · ${testResults.embed.dim}d` : '失败'}
                  </Badge>
                )}
              </div>
              {testResults.embed && !testResults.embed.ok && (
                <p className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-600 dark:text-rose-400">
                  {testResults.embed.message}
                </p>
              )}
            </TabsContent>

            {/* Rerank tab */}
            <TabsContent value="rerank" className="space-y-4 pb-2 pt-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                <p className="font-medium text-foreground">说明</p>
                Rerank 使用 OpenAI 风格的 rerank 端点：向 <span className="font-mono">{'{apiBase}/rerank'}</span> 发 POST 请求，
                body 为 <span className="font-mono">{'{ model, query, documents, top_n }'}</span>，
                返回 <span className="font-mono">{'{ results: [{ index, relevance_score }] }'}</span>。
                支持 Cohere、Jina、SiliconFlow、bge-reranker 等兼容服务。可留空禁用重排。
              </div>
              <div>
                <Label htmlFor="rerank-base" className="text-xs text-muted-foreground">Rerank API Base（可空，留空则禁用重排）</Label>
                <Input
                  id="rerank-base"
                  value={form.rerankApiBase}
                  onChange={(e) => update('rerankApiBase', e.target.value)}
                  placeholder="https://api.jina.ai/v1  或  https://api.cohere.ai/v1"
                  className="mt-1.5 h-10 text-sm font-mono"
                />
              </div>
              <div>
                <Label htmlFor="rerank-model" className="text-xs text-muted-foreground">Rerank 模型 ID（自行填写）</Label>
                <Input
                  id="rerank-model"
                  value={form.rerankModel}
                  onChange={(e) => update('rerankModel', e.target.value)}
                  placeholder="BAAI/bge-reranker-base  /  rerank-multilingual-v3.0  /  jina-reranker-v2-base-multilingual"
                  className="mt-1.5 h-10 text-sm font-mono"
                />
              </div>
              <div>
                <Label htmlFor="rerank-key" className="text-xs text-muted-foreground">Rerank API Key（可空）</Label>
                <div className="mt-1.5 flex gap-2">
                  <Input
                    id="rerank-key"
                    type={showRerankKey ? 'text' : 'password'}
                    value={form.rerankApiKey}
                    onChange={(e) => update('rerankApiKey', e.target.value)}
                    placeholder="（无鉴权留空）"
                    className="h-10 text-sm font-mono"
                  />
                  <Button size="icon" variant="outline" className="h-10 w-10 shrink-0" onClick={() => setShowRerankKey(!showRerankKey)}>
                    {showRerankKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => onTest('rerank')} disabled={testing === 'rerank' || !form.rerankApiBase || !form.rerankModel} className="gap-1.5">
                  {testing === 'rerank' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
                  测试 Rerank
                </Button>
                {testResults.rerank && (
                  <Badge variant={testResults.rerank.ok ? 'default' : 'destructive'} className="gap-1 text-[10px]">
                    {testResults.rerank.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                    {testResults.rerank.ok ? '可用' : '失败'}
                  </Badge>
                )}
              </div>
              {testResults.rerank && !testResults.rerank.ok && (
                <p className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-600 dark:text-rose-400">
                  {testResults.rerank.message}
                </p>
              )}
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter className="border-t px-6 py-3.5">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button size="sm" onClick={() => onSave(false)} disabled={saving || !loaded} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
