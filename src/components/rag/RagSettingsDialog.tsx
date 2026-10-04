'use client'

// RAG 平台设置弹窗（独立于基座 SettingsDialog）
// 分组：Qdrant 连接 / Embedding / Rerank / MinerU / 平台降级开关
// 每个「测试」调 POST /api/qdrant/test 相应 kind；保存 PUT /api/qdrant/settings 后刷新平台 store
//
// v1.6：
// - 本地向量引擎开关已删除（未配置/不可达 Qdrant 时向量读写硬失败，无本地降级）
// - Mock 嵌入改为醒目警告样式（离线调试专用，向量无语义，生产勿用）
// - 密钥掩码适配：GET 返回 `***尾4位` 时清空输入框并把掩码放到 placeholder，留空提交保持原值

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  FileSearch,
  KeyRound,
  Loader2,
  Plug,
  Save,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
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
  qdrantHnswM: 0,
  embedApiBase: '',
  embedApiKey: '',
  embedModel: '',
  rerankApiBase: '',
  rerankApiKey: '',
  rerankModel: '',
  mineruProvider: 'selfhost',
  mineruApiUrl: '',
  mineruApiKey: '',
  mineruTier: 'standard',
  mineruOcrMode: 'auto',
  mineruPdfAutoSplit: true,
  mineruPdfPartPages: 0,
  useFallbackParser: true,
  useMockEmbedding: false,
  useMockRerank: true,
  updatedAt: '',
}

/** 普通平台开关（Mock 嵌入单独渲染警告样式） */
const SWITCHES: { key: keyof RagSettings; label: string; desc: string }[] = [
  { key: 'useFallbackParser', label: '降级解析器', desc: '未配置 MinerU 时，是否启用内置解析器（md/txt/html 直转；pdf 提取文本+坐标）' },
  { key: 'useMockRerank', label: 'Mock 重排', desc: '未配置 Rerank 服务时，是否启用内置 BM25 词法重排' },
]

/** 密钥字段掩码适配：GET 返回 `***尾4位` 时记录掩码并清空输入框（留空提交 = 保持原值） */
const SECRET_FIELDS = ['apiKey', 'embedApiKey', 'rerankApiKey', 'mineruApiKey'] as const
type SecretField = (typeof SECRET_FIELDS)[number]
type SecretMasks = Partial<Record<SecretField, string>>

// —— 模块级子组件（勿放回 RagSettingsDialog 函数体内：内部定义会使组件身份随 setForm 重渲染而改变，
// React 卸载重挂整个子树导致 SecretInput 内 <Input> 每输入一个字符就失焦）——

/** MinerU 三接入方式展示文案 */
const MINERU_PROVIDER_LABELS: Record<string, string> = {
  selfhost: '自部署 V1',
  cloud: '官方云·精准',
  'cloud-agent': '官方云·Agent',
}

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
          {testResults[kind]!.detail && (
            <span className="mt-1 block text-rose-500/80">{testResults[kind]!.detail}</span>
          )}
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
  const [secretMasks, setSecretMasks] = useState<SecretMasks>({})
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState<TestKind | null>(null)
  const [testResults, setTestResults] = useState<Partial<Record<TestKind, TestResult>>>({})
  const [saving, setSaving] = useState(false)

  // 面板安全：改密表单（独立于连接配置，不参与底部「保存」按钮）
  const panelDefaultPassword = usePlatformStore((s) => s.panelDefaultPassword)
  const setPanelAuth = usePlatformStore((s) => s.setPanelAuth)
  const [pwdCurrent, setPwdCurrent] = useState('')
  const [pwdNext, setPwdNext] = useState('')
  const [pwdConfirm, setPwdConfirm] = useState('')
  const [pwdBusy, setPwdBusy] = useState(false)
  // SEC-008+：上次密钥轮转时间（从 /api/auth/session 读取，改密成功后刷新）
  const [secretRotatedAt, setSecretRotatedAt] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setTestResults({})
      setPwdCurrent('')
      setPwdNext('')
      setPwdConfirm('')
      return
    }
    let cancelled = false
    ragApi
      .getSettings()
      .then((s) => {
        if (cancelled) return
        // 掩码适配：值以 *** 开头 = 后端已保存但仅回显掩码 → 清空输入框，掩码放 placeholder
        const merged = { ...DEFAULT_FORM, ...s }
        const masks: SecretMasks = {}
        for (const k of SECRET_FIELDS) {
          const v = merged[k]
          if (typeof v === 'string' && v.startsWith('***')) {
            masks[k] = v
            merged[k] = ''
          }
        }
        setSecretMasks(masks)
        setForm(merged)
        setLoaded(true)
      })
      .catch((e) => {
        if (!cancelled) toast.error('读取设置失败：' + (e as Error).message)
      })
    // SEC-008+：读取上次密钥轮转时间（与 settings 并行，不阻塞表单加载）
    ragApi
      .getAuthSession()
      .then((s) => {
        if (!cancelled) setSecretRotatedAt(s.secretRotatedAt)
      })
      .catch(() => {
        /* 非关键路径，失败静默 */
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
        // MinerU：按接入方式探测（selfhost 需地址；cloud 需 Token；cloud-agent 免凭据）
        const provider = form.mineruProvider || 'selfhost'
        if (provider === 'selfhost' && !form.mineruApiUrl) {
          toast.error('请填写 MinerU API 地址（自部署 V1 服务根地址）')
          return
        }
        if (provider === 'cloud' && !form.mineruApiKey) {
          toast.error('请填写 MinerU API Token（官方云·精准需要 Token）')
          return
        }
        r = await ragApi.testConnection('mineru', {
          provider,
          url: form.mineruApiUrl,
          apiKey: form.mineruApiKey,
          tier: form.mineruTier,
          ocrMode: form.mineruOcrMode,
        })
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
      // 密钥掩码约定：空值或 *** 开头的值照常提交（后端识别为「保持已存值不变」）
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
            Qdrant / Embedding / Rerank / MinerU 连接配置与平台开关。向量数据统一写入 Qdrant（未配置或不可达时入库/检索将直接失败）；未配置 MinerU 时可启用内置降级解析器。所有配置存储在本地 SQLite。
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
              <TabsTrigger value="panel" className="gap-1.5 text-xs"><ShieldCheck className="h-3.5 w-3.5" /> 面板安全</TabsTrigger>
            </TabsList>

            <TabsContent value="qdrant" className="space-y-4 pb-2 pt-4">
              <div>
                <Label htmlFor="rag-url" className="text-xs text-muted-foreground">Qdrant 服务地址</Label>
                <Input id="rag-url" value={form.url} onChange={(e) => update('url', e.target.value)} placeholder="https://your-qdrant.example.com 或 http://localhost:6333" className="mt-1.5 h-9 text-sm" />
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  填写 Qdrant 服务地址（默认端口 <b>6333</b>，如 <code className="font-mono">http://10.0.0.5:6333</code> 或云端 <code className="font-mono">https</code> 域名）。向量数据统一写入 Qdrant；未配置或不可达时入库/检索将直接失败（不降级本地存储，避免索引断裂）。
                </p>
              </div>
              <div>
                <Label htmlFor="rag-key" className="text-xs text-muted-foreground">API Key（可空）</Label>
                <div className="mt-1.5">
                  <SecretInput id="rag-key" value={form.apiKey} onChange={(v) => update('apiKey', v)} placeholder={secretMasks.apiKey ? `已保存 ${secretMasks.apiKey}，留空保持不变` : '留空表示无鉴权'} k="qdrant" showKeys={showKeys} setShowKeys={setShowKeys} />
                </div>
              </div>
              <div>
                <Label htmlFor="rag-hnsw-m" className="text-xs text-muted-foreground">HNSW 图参数 m（0-64，仅新建知识库生效）</Label>
                <Input
                  id="rag-hnsw-m"
                  type="number"
                  min={0}
                  max={64}
                  value={form.qdrantHnswM ?? 0}
                  onChange={(e) => update('qdrantHnswM', Math.max(0, Math.min(64, Number(e.target.value) || 0)))}
                  className="mt-1.5 h-9 text-sm"
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  0 = 禁用 HNSW 暴力扫描（低内存默认权衡，单库超过 10 万点时检索延迟线性增长）；大库建议 16。已有集合不追溯，仅对之后新建的知识库生效。
                </p>
              </div>
              <TestButton kind="qdrant" label="测试连接" disabled={!form.url} testing={testing} testResults={testResults} onTest={onTest} />
            </TabsContent>

            <TabsContent value="embed" className="space-y-4 pb-2 pt-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                OpenAI 兼容协议：<span className="font-mono">{'{apiBase}/embeddings'}</span>，body <span className="font-mono">{'{ model, input }'}</span>。未配置时嵌入直接失败（建库/入库前需先完成配置）；建库时会实测维度并锁定。
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
                  <SecretInput id="rag-embed-key" value={form.embedApiKey} onChange={(v) => update('embedApiKey', v)} placeholder={secretMasks.embedApiKey ? `已保存 ${secretMasks.embedApiKey}，留空保持不变` : 'sk-…'} k="embed" showKeys={showKeys} setShowKeys={setShowKeys} />
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
                  <SecretInput id="rag-rerank-key" value={form.rerankApiKey} onChange={(v) => update('rerankApiKey', v)} placeholder={secretMasks.rerankApiKey ? `已保存 ${secretMasks.rerankApiKey}，留空保持不变` : '（无鉴权留空）'} k="rerank" showKeys={showKeys} setShowKeys={setShowKeys} />
                </div>
              </div>
              <TestButton kind="rerank" label="测试 Rerank" disabled={!form.rerankApiBase || !form.rerankModel} testing={testing} testResults={testResults} onTest={onTest} />
            </TabsContent>

            <TabsContent value="mineru" className="space-y-4 pb-2 pt-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                MinerU 解析服务支持三种接入方式（协议互不兼容，按部署形态选择）。未配置时按平台开关回退到内置 Node 解析器：
                md/txt/html/csv/docx 等直接转 markdown；pdf 提取文本 + 坐标；图片与旧版 Office（.ppt/.xls）仅 MinerU 支持。
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">接入方式（Provider）</Label>
                <Select value={form.mineruProvider || 'selfhost'} onValueChange={(v) => update('mineruProvider', v)}>
                  <SelectTrigger className="mt-1.5 h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="selfhost" className="text-xs">自部署 V1 — 本地/私有化（六步协议）</SelectItem>
                    <SelectItem value="cloud" className="text-xs">官方云·精准（Token）— 高精度/批量/多格式</SelectItem>
                    <SelectItem value="cloud-agent" className="text-xs">官方云·Agent 轻量（免Token）— IP 限频/单文件/≤10MB</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(form.mineruProvider || 'selfhost') === 'selfhost' && (
                <>
                  <div>
                    <Label htmlFor="rag-mineru-url" className="text-xs text-muted-foreground">MinerU API URL（V1 根地址）</Label>
                    <Input id="rag-mineru-url" value={form.mineruApiUrl} onChange={(e) => update('mineruApiUrl', e.target.value)} placeholder="http://mineru-host:8000（api-server 端口，非 WebUI 面板）" className="mt-1.5 h-9 font-mono text-xs" />
                  </div>
                  <div>
                    <Label htmlFor="rag-mineru-key" className="text-xs text-muted-foreground">API Key（可空，--api-key 启动参数未设则无鉴权）</Label>
                    <div className="mt-1.5">
                      <SecretInput id="rag-mineru-key" value={form.mineruApiKey} onChange={(v) => update('mineruApiKey', v)} placeholder={secretMasks.mineruApiKey ? `已保存 ${secretMasks.mineruApiKey}，留空保持不变` : '（无鉴权留空）'} k="mineru" showKeys={showKeys} setShowKeys={setShowKeys} />
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
                </>
              )}
              {(form.mineruProvider || 'selfhost') === 'cloud' && (
                <>
                  <div>
                    <Label htmlFor="rag-mineru-token" className="text-xs text-muted-foreground">API Token（必填）</Label>
                    <div className="mt-1.5">
                      <SecretInput id="rag-mineru-token" value={form.mineruApiKey} onChange={(v) => update('mineruApiKey', v)} placeholder={secretMasks.mineruApiKey ? `已保存 ${secretMasks.mineruApiKey}，留空保持不变` : '在 mineru.net「API 管理」页面创建'} k="mineru" showKeys={showKeys} setShowKeys={setShowKeys} />
                    </div>
                    <p className="mt-1.5 text-[11px] text-muted-foreground">官方云·精准 API v4（Bearer Token）：支持 pdf/图片/doc/docx/ppt/pptx/xls/xlsx，单文件 ≤ 200MB / 200 页，每账号每天 1000 页最高优先级额度。</p>
                  </div>
                </>
              )}
              {(form.mineruProvider || 'selfhost') === 'cloud-agent' && (
                <div className="rounded-md border border-dashed px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  官方云·Agent 轻量接口无需任何凭据（按 IP 限频防滥用）。限制：单文件 ≤ 10MB / 20 页，仅输出 Markdown，支持
                  PDF/图片/Docx/PPTx/Xlsx。无需配置——保存后即可在上传时选择 MinerU 引擎使用。
                </div>
              )}
              {/* 16-b：超大 PDF 自动拆分（全 Provider 通用） */}
              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  <Switch
                    id="mineru-pdf-split"
                    checked={form.mineruPdfAutoSplit}
                    onCheckedChange={(v) => update('mineruPdfAutoSplit', v)}
                    aria-label="超大 PDF 自动拆分开关"
                  />
                  <label htmlFor="mineru-pdf-split" className="cursor-pointer text-xs font-medium">
                    超大 PDF 自动拆分
                  </label>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Label htmlFor="mineru-pdf-part-pages" className="text-[11px] text-muted-foreground">每段页数</Label>
                    <Input
                      id="mineru-pdf-part-pages"
                      type="number"
                      min={0}
                      max={10000}
                      value={form.mineruPdfPartPages}
                      onChange={(e) => update('mineruPdfPartPages', Math.max(0, Math.min(10000, Number(e.target.value) || 0)))}
                      disabled={!form.mineruPdfAutoSplit}
                      className="h-7 w-20 px-2 font-mono text-xs"
                    />
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  超过限制的 PDF 提交前自动按页拆分成多段，逐段送 MinerU 解析后合并产物（页数/坐标连续，检索无感）。
                  每段页数 0 = 按服务商默认（云·精准 200 页 / 轻量 20 页 / 自部署不拆）；体积超限（200MB / 10MB）时按页密度自动折算更小段。
                  注意：分段各自计入 MinerU 页数额度，多段大文件会成倍消耗每日免费额度。
                </p>
              </div>
              <TestButton
                kind="mineru"
                label={`测试 MinerU（${MINERU_PROVIDER_LABELS[form.mineruProvider || 'selfhost'] ?? '自部署'}）`}
                disabled={(form.mineruProvider || 'selfhost') === 'selfhost' ? !form.mineruApiUrl : (form.mineruProvider || 'selfhost') === 'cloud' ? !form.mineruApiKey : false}
                testing={testing}
                testResults={testResults}
                onTest={onTest}
              />
            </TabsContent>

            <TabsContent value="switches" className="space-y-3 pb-2 pt-4">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                以下开关控制「未配置对应服务时」是否启用内置降级实现。关闭后对应能力将直接报错（便于生产环境暴露配置问题）。
              </p>

              {/* Mock 嵌入：离线调试专用，醒目警告样式（红/橙） */}
              <div
                className={cn(
                  'flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5',
                  form.useMockEmbedding
                    ? 'border-rose-500/50 bg-rose-500/10'
                    : 'border-border/60 bg-muted/20'
                )}
              >
                <div className="min-w-0">
                  <div className={cn('flex items-center gap-1.5 text-xs font-medium', form.useMockEmbedding && 'text-rose-600 dark:text-rose-400')}>
                    <AlertTriangle className={cn('h-3.5 w-3.5', form.useMockEmbedding ? 'text-rose-500' : 'text-muted-foreground')} />
                    Mock 嵌入（离线调试专用）
                  </div>
                  <p className={cn('mt-0.5 text-[11px] leading-relaxed', form.useMockEmbedding ? 'text-rose-600/90 dark:text-rose-400/90' : 'text-muted-foreground')}>
                    启用后用确定性哈希特征向量代替真实 Embedding——<span className="font-semibold">向量无语义，生产环境勿用</span>。仅用于无外网环境的链路调试；未配置真实 Embedding 时建库会被拒绝。
                  </p>
                </div>
                <Switch
                  checked={!!form.useMockEmbedding}
                  onCheckedChange={(v) => update('useMockEmbedding', v)}
                  aria-label="Mock 嵌入（离线调试专用）"
                  className={cn(form.useMockEmbedding && 'data-[state=checked]:bg-rose-600')}
                />
              </div>

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

            {/* 面板安全：访问密码修改（独立保存，不参与底部保存按钮） */}
            <TabsContent value="panel" className="space-y-4 pb-2 pt-4">
              {panelDefaultPassword && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <b>当前仍在使用初始口令</b>——首次部署后请立即修改，否则任何取得该口令者（如查看服务端日志者）都可访问与操作本面板（含删除知识库、读取 API Key）。
                  </span>
                </div>
              )}
              <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                面板访问密码用于登录本管理面板（Cookie 会话 12 小时，连续失败 5 次锁定 30 秒）；与
                <span className="font-mono"> /api/input </span>入库 API Key、Dify 导出密钥相互独立。密码以 scrypt 哈希存储，平台不保存明文。
              </div>
              {/* SEC-008+：上次密钥轮转时间（改密时同步轮转 HMAC 密钥，使旧会话/API Key 签名失效） */}
              {(() => {
                const daysAgo = secretRotatedAt
                  ? Math.floor((Date.now() - new Date(secretRotatedAt).getTime()) / 86_400_000)
                  : null
                const stale = daysAgo !== null && daysAgo > 90
                return (
                  <div className={cn('flex items-center justify-between rounded-md border px-3 py-2 text-[11px]', stale ? 'border-amber-300/60 bg-amber-50/50 dark:border-amber-500/30 dark:bg-amber-950/20' : 'bg-muted/20')}>
                    <span className="text-muted-foreground">上次密钥轮转</span>
                    <span className={cn(
                      'font-mono tabular-nums',
                      !secretRotatedAt ? 'text-amber-600 dark:text-amber-400'
                        : stale ? 'text-amber-600 dark:text-amber-400'
                        : 'text-emerald-600 dark:text-emerald-400',
                    )}>
                      {secretRotatedAt
                        ? `${new Date(secretRotatedAt).toLocaleString('zh-CN', { hour12: false })}${daysAgo !== null ? `（${daysAgo} 天前` : '（'}，改密时自动轮转）`
                        : '从未轮转（改密后将自动轮转密钥，使旧会话失效）'}
                    </span>
                    {stale && (
                      <span className="ml-2 shrink-0 text-amber-600 dark:text-amber-400">⚠ 超过 90 天未轮转，建议改密</span>
                    )}
                  </div>
                )
              })()}
              <div>
                <Label htmlFor="panel-pwd-current" className="text-xs text-muted-foreground">当前密码</Label>
                <Input
                  id="panel-pwd-current"
                  type="password"
                  value={pwdCurrent}
                  onChange={(e) => setPwdCurrent(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="mt-1.5 h-9 text-sm"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="panel-pwd-next" className="text-xs text-muted-foreground">新密码（6-64 位）</Label>
                  <Input
                    id="panel-pwd-next"
                    type="password"
                    value={pwdNext}
                    onChange={(e) => setPwdNext(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="new-password"
                    className="mt-1.5 h-9 text-sm"
                  />
                </div>
                <div>
                  <Label htmlFor="panel-pwd-confirm" className="text-xs text-muted-foreground">确认新密码</Label>
                  <Input
                    id="panel-pwd-confirm"
                    type="password"
                    value={pwdConfirm}
                    onChange={(e) => setPwdConfirm(e.target.value)}
                    placeholder="再次输入新密码"
                    autoComplete="new-password"
                    className="mt-1.5 h-9 text-sm"
                  />
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={pwdBusy || !pwdCurrent || !pwdNext || pwdNext !== pwdConfirm}
                onClick={async () => {
                  if (pwdBusy) return
                  if (pwdNext.length < 6 || pwdNext.length > 64) {
                    toast.error('新密码长度需在 6-64 位之间')
                    return
                  }
                  if (pwdNext !== pwdConfirm) {
                    toast.error('两次输入的新密码不一致')
                    return
                  }
                  setPwdBusy(true)
                  try {
                    const r = await ragApi.changePanelPassword(pwdCurrent, pwdNext)
                    // SEC-008：密钥轮转后所有旧会话/API Key 签名失效——提示用户其他设备需重新登录
                    if (r.secretRotated) {
                      toast.success('面板密码已修改，密钥已轮转（其他设备的会话已失效，需重新登录）')
                    } else if (r.rotateError) {
                      toast.warning(
                        `面板密码已修改，但密钥轮转失败：${r.rotateError}（旧会话可能仍有效，建议重启服务后再次改密）`,
                      )
                    } else {
                      toast.success('面板密码已修改（新会话已签发）')
                    }
                    setPwdCurrent('')
                    setPwdNext('')
                    setPwdConfirm('')
                    setPanelAuth(true, false)
                    // SEC-008+：改密成功后刷新「上次密钥轮转」时间展示
                    if (r.secretRotated) {
                      setSecretRotatedAt(new Date().toISOString())
                    }
                  } catch (e) {
                    toast.error('修改失败：' + (e as Error).message)
                  } finally {
                    setPwdBusy(false)
                  }
                }}
              >
                {pwdBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                修改面板密码
              </Button>
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
