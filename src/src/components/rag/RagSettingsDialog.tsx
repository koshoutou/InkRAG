'use client'

// RAG 平台设置弹窗（独立于基座 SettingsDialog）
// 分组：Qdrant 连接 / Embedding / Rerank / MinerU / 平台降级开关
// 每个「测试」调 POST /api/qdrant/test 相应 kind；保存 PUT /api/qdrant/settings 后刷新平台 store

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import {
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  FileSearch,
  Loader2,
  Plug,
  Save,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  ToggleLeft,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { ragApi } from './api'
import { usePlatformStore } from './store'
import type { RagSettings, TestKind, TestResult } from './types'

const DEFAULT_FORM: RagSettings = {
  id: 'default',
  url: '',
  apiKey: '',
  defaultCollection: '',
  embedApiBase: '',
  embedApiKey: '',
  embedModel: '',
  rerankApiBase: '',
  rerankApiKey: '',
  rerankModel: '',
  mineruApiUrl: '',
  mineruApiKey: '',
  mineruTier: 'standard',
  mineruOcrMode: 'auto',
  useLocalVectorStore: false,
  useFallbackParser: true,
  useMockEmbedding: true,
  useMockRerank: true,
  updatedAt: '',
}

const SWITCHES: { key: keyof RagSettings; label: string; desc: string }[] = [
  { key: 'useLocalVectorStore', label: '本地向量引擎', desc: '未配置 Qdrant 或不可达时，是否启用内置 SQLite 向量引擎（演示模式）' },
  { key: 'useFallbackParser', label: '降级解析器', desc: '未配置 MinerU 时，是否启用内置解析器（md/txt/html 直转；pdf 提取文本+坐标）' },
  { key: 'useMockEmbedding', label: 'Mock 嵌入', desc: '未配置 Embedding 服务时，是否启用确定性哈希特征向量（含词法 sparse）' },
  { key: 'useMockRerank', label: 'Mock 重排', desc: '未配置 Rerank 服务时，是否启用内置 BM25 词法重排' },
]

// —— 模块级子组件（勿放回 RagSettingsDialog 函数体内：内部定义会使组件身份随 setForm 重渲染而改变，
// React 卸载重挂整个子树导致 SecretInput 内 <Input> 每输入一个字符就失焦）——

function TestButton({
  kind,
  label,
  disabled,
  testing,
  testResults,
  onTest,
}: {
  kind: TestKind
  label: string
  disabled?: boolean
  testing: TestKind | null
  testResults: Partial<Record<TestKind, TestResult>>
  onTest: (kind: TestKind) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Button variant="outline" size="sm" onClick={() => onTest(kind)} disabled={testing === kind || disabled} className="gap-1.5">
        {testing === kind ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
        {label}
      </Button>
      {testResults[kind] && (
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
            testResults[kind]!.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300',
          )}
        >
          {testResults[kind]!.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {testResults[kind]!.ok
            ? `成功${testResults[kind]!.dim ? ` · ${testResults[kind]!.dim}d` : ''}${testResults[kind]!.version ? ` · v${testResults[kind]!.version}` : ''}`
            : '失败'}
        </span>
      )}
      {testResults[kind] && !testResults[kind]!.ok && (
        <p className="w-full rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-1.5 text-[11px] text-rose-600 dark:text-rose-400">
          {testResults[kind]!.message}
        </p>
      )}
    </div>
  )
}

function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  k,
  showKeys,
  setShowKeys,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  k: string
  showKeys: Record<string, boolean>
  setShowKeys: Dispatch<SetStateAction<Record<string, boolean>>>
}) {
  return (
    <div className="flex gap-2">
      <Input
        id={id}
        type={showKeys[k] ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 font-mono text-xs"
      />
      <Button size="icon" variant="outline" className="h-9 w-9 shrink-0" onClick={() => setShowKeys((s) => ({ ...s, [k]: !s[k] }))} aria-label="显示/隐藏密钥">
        {showKeys[k] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  )
}

export function RagSettingsDialog() {
  const open = usePlatformStore((s) => s.settingsOpen)
  const setOpen = usePlatformStore((s) => s.setSettingsOpen)
  const setSettingsStore = usePlatformStore((s) => s.setSettings)

  const [form, setForm] = useState<RagSettings>(DEFAULT_FORM)
  const [loaded, setLoaded] = useState(false)
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState<TestKind | null>(null)
  const [testResults, setTestResults] = useState<Partial<Record<TestKind, TestResult>>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      setTestResults({})
      return
    }
    let cancelled = false
    ragApi
      .getSettings()
      .then((s) => {
        if (!cancelled) {
          setForm({ ...DEFAULT_FORM, ...s })
          setLoaded(true)
        }
      })
      .catch((e) => {
        if (!cancelled) toast.error('读取设置失败：' + (e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  if (!open) return null

  const update = <K extends keyof RagSettings>(k: K, v: RagSettings[K]) => setForm((f) => ({ ...f, [k]: v }))

  const onTest = async (kind: TestKind) => {
    setTesting(kind)
    try {
      let r: TestResult
      if (kind === 'qdrant') {
        if (!form.url) {
          toast.error('请填写 Qdrant 服务地址')
          return
        }
        r = await ragApi.testConnection('qdrant', { url: form.url, apiKey: form.apiKey })
      } else if (kind === 'embed') {
        if (!form.embedApiBase || !form.embedModel) {
          toast.error('请填写 Embedding API Base 与模型 ID')
          return
        }
        r = await ragApi.testConnection('embed', { url: form.embedApiBase, apiKey: form.embedApiKey, model: form.embedModel })
      } else if (kind === 'rerank') {
        if (!form.rerankApiBase || !form.rerankModel) {
          toast.error('请填写 Rerank API Base 与模型 ID')
          return
        }
        r = await ragApi.testConnection('rerank', { url: form.rerankApiBase, apiKey: form.rerankApiKey, model: form.rerankModel })
      } else {
        if (!form.mineruApiUrl) {
          toast.error('请填写 MinerU API URL')
          return
        }
        r = await ragApi.testConnection('mineru', { url: form.mineruApiUrl, apiKey: form.mineruApiKey, tier: form.mineruTier, ocrMode: form.mineruOcrMode })
      }
      setTestResults((prev) => ({ ...prev, [kind]: r }))
      if (r.ok) toast.success(r.message)
      else toast.error(r.message)
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [kind]: { ok: false, message: (e as Error).message } }))
      toast.error((e as Error).message)
    } finally {
      setTesting(null)
    }
  }

  const onSave = async () => {
    setSaving(true)
    try {
      const r = await ragApi.saveSettings(form)
      setSettingsStore(r.settings)
      toast.success('设置已保存，连接状态已刷新')
      setOpen(false)
    } catch (e) {
      toast.error('保存失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto p-0">
        <DialogHeader className="border-b px-6 py-3.5">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <SettingsIcon className="h-4 w-4 text-primary" />
            平台设置
          </DialogTitle>
          <DialogDescription className="text-xs">
            Qdrant / Embedding / Rerank / MinerU 连接配置与平台降级开关。未配置对应服务时可启用内置降级实现（演示模式）。所有配置存储在本地 SQLite。
          </DialogDescription>
        </DialogHeader>

        {!loaded ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <Tabs defaultValue="qdrant" className="px-6 pt-4">
            <TabsList className="h-9 flex-wrap">
              <TabsTrigger value="qdrant" className="gap-1.5 text-xs"><Server className="h-3.5 w-3.5" /> Qdrant</TabsTrigger>
              <TabsTrigger value="embed" className="gap-1.5 text-xs"><Cpu className="h-3.5 w-3.5" /> Embedding</TabsTrigger>
              <TabsTrigger value="rerank" className="gap-1.5 text-xs"><Sparkles className="h-3.5 w-3.5" /> Rerank</TabsTrigger>
              <TabsTrigger value="mineru" className="gap-1.5 text-xs"><FileSearch className="h-3.5 w-3.5" /> MinerU</TabsTrigger>
              <TabsTrigger value="switches" className="gap-1.5 text-xs"><ToggleLeft className="h-3.5 w-3.5" /> 平台开关</TabsTrigger>
            </TabsList>

            <TabsContent value="qdrant" className="space-y-4 pb-2 pt-4">
              <div>
                <Label htmlFor="rag-url" className="text-xs text-muted-foreground">Qdrant 服务地址</Label>
                <Input id="rag-url" value={form.url} onChange={(e) => update('url', e.target.value)} placeholder="https://your-qdrant.example.com 或 http://localhost:6333" className="mt-1.5 h-9 text-sm" />
                <p className="mt-1.5 text-[11px] text-muted-foreground">留空或不可达时，平台按开关回退到内置本地向量引擎（SQLite）。</p>
              </div>
              <div>
                <Label htmlFor="rag-key" className="text-xs text-muted-foreground">API Key（可空）</Label>
                <div className="mt-1.5">
                  <SecretInput id="rag-key" value={form.apiKey} onChange={(v) => update('apiKey', v)} placeholder="留空表示无鉴权" k="qdrant" showKeys={showKeys} setShowKeys={setShowKeys} />
                </div>
              </div>
              <TestButton kind="qdrant" label="测试连接" disabled={!form.url} testing={testing} testResults={testResults} onTest={onTest} />
            </TabsContent>

            <TabsContent value="embed" className="space-y-4 pb-2 pt-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                OpenAI 兼容协议：<span className="font-mono">{'{apiBase}/embeddings'}</span>，body <span className="font-mono">{'{ model, input }'}</span>。未配置且 Mock 开关开启时，使用确定性哈希特征向量。
              </div>
              <div>
                <Label htmlFor="rag-embed-base" className="text-xs text-muted-foreground">API Base</Label>
                <Input id="rag-embed-base" value={form.embedApiBase} onChange={(e) => update('embedApiBase', e.target.value)} placeholder="https://api.openai.com/v1" className="mt-1.5 h-9 font-mono text-xs" />
              </div>
              <div>
                <Label htmlFor="rag-embed-model" className="text-xs text-muted-foreground">模型 ID</Label>
                <Input id="rag-embed-model" value={form.embedModel} onChange={(e) => update('embedModel', e.target.value)} placeholder="BAAI/bge-m3 (1024d) / text-embedding-3-small (1536d)" className="mt-1.5 h-9 font-mono text-xs" />
              </div>
              <div>
                <Label htmlFor="rag-embed-key" className="text-xs text-muted-foreground">API Key（可空）</Label>
                <div className="mt-1.5">
                  <SecretInput id="rag-embed-key" value={form.embedApiKey} onChange={(v) => update('embedApiKey', v)} placeholder="sk-…" k="embed" showKeys={showKeys} setShowKeys={setShowKeys} />
                </div>
              </div>
              <TestButton kind="embed" label="测试 Embedding" disabled={!form.embedApiBase || !form.embedModel} testing={testing} testResults={testResults} onTest={onTest} />
            </TabsContent>

            <TabsContent value="rerank" className="space-y-4 pb-2 pt-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                OpenAI 风格 rerank 端点：<span className="font-mono">{'{apiBase}/rerank'}</span>，body <span className="font-mono">{'{ model, query, documents, top_n }'}</span>。留空且 Mock 开关开启时使用 BM25 词法重排。
              </div>
              <div>
                <Label htmlFor="rag-rerank-base" className="text-xs text-muted-foreground">API Base（可空）</Label>
                <Input id="rag-rerank-base" value={form.rerankApiBase} onChange={(e) => update('rerankApiBase', e.target.value)} placeholder="https://api.jina.ai/v1" className="mt-1.5 h-9 font-mono text-xs" />
              </div>
              <div>
                <Label htmlFor="rag-rerank-model" className="text-xs text-muted-foreground">模型 ID</Label>
                <Input id="rag-rerank-model" value={form.rerankModel} onChange={(e) => update('rerankModel', e.target.value)} placeholder="BAAI/bge-reranker-base" className="mt-1.5 h-9 font-mono text-xs" />
              </div>
              <div>
                <Label htmlFor="rag-rerank-key" className="text-xs text-muted-foreground">API Key（可空）</Label>
                <div className="mt-1.5">
                  <SecretInput id="rag-rerank-key" value={form.rerankApiKey} onChange={(v) => update('rerankApiKey', v)} placeholder="（无鉴权留空）" k="rerank" showKeys={showKeys} setShowKeys={setShowKeys} />
                </div>
              </div>
              <TestButton kind="rerank" label="测试 Rerank" disabled={!form.rerankApiBase || !form.rerankModel} testing={testing} testResults={testResults} onTest={onTest} />
            </TabsContent>

            <TabsContent value="mineru" className="space-y-4 pb-2 pt-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                MinerU 解析服务（六步协议）。未配置时按平台开关回退到内置降级解析器：md/txt/html 直接转 markdown；pdf 提取文本 + 坐标生成布局。
              </div>
              <div>
                <Label htmlFor="rag-mineru-url" className="text-xs text-muted-foreground">MinerU API URL</Label>
                <Input id="rag-mineru-url" value={form.mineruApiUrl} onChange={(e) => update('mineruApiUrl', e.target.value)} placeholder="http://mineru-server:8080" className="mt-1.5 h-9 font-mono text-xs" />
              </div>
              <div>
                <Label htmlFor="rag-mineru-key" className="text-xs text-muted-foreground">API Key（可空）</Label>
                <div className="mt-1.5">
                  <SecretInput id="rag-mineru-key" value={form.mineruApiKey} onChange={(v) => update('mineruApiKey', v)} placeholder="（无鉴权留空）" k="mineru" showKeys={showKeys} setShowKeys={setShowKeys} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">解析档位（tier）</Label>
                  <Select value={form.mineruTier || 'standard'} onValueChange={(v) => update('mineruTier', v)}>
                    <SelectTrigger className="mt-1.5 h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="flash" className="text-xs">flash — 极速（限 200 页/300MB）</SelectItem>
                      <SelectItem value="basic" className="text-xs">basic — 基础</SelectItem>
                      <SelectItem value="standard" className="text-xs">standard — 标准</SelectItem>
                      <SelectItem value="advanced" className="text-xs">advanced — 高精度</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">OCR 模式</Label>
                  <Select value={form.mineruOcrMode || 'auto'} onValueChange={(v) => update('mineruOcrMode', v)}>
                    <SelectTrigger className="mt-1.5 h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto" className="text-xs">auto — 自动</SelectItem>
                      <SelectItem value="txt" className="text-xs">txt — 优先文本层</SelectItem>
                      <SelectItem value="ocr" className="text-xs">ocr — 强制 OCR</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <TestButton kind="mineru" label="测试 MinerU" disabled={!form.mineruApiUrl} testing={testing} testResults={testResults} onTest={onTest} />
            </TabsContent>

            <TabsContent value="switches" className="space-y-3 pb-2 pt-4">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                以下开关控制「未配置对应服务时」是否启用内置降级实现。关闭后对应能力将直接报错（便于生产环境暴露配置问题）。
              </p>
              {SWITCHES.map((s) => (
                <div key={s.key} className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                  <div>
                    <div className="text-xs font-medium">{s.label}</div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{s.desc}</p>
                  </div>
                  <Switch
                    checked={!!form[s.key]}
                    onCheckedChange={(v) => update(s.key, v)}
                    aria-label={s.label}
                  />
                </div>
              ))}
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter className="border-t px-6 py-3.5">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving || !loaded} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
