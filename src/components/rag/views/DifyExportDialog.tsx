'use client'

// Dify 导出对接配置（MinerU 面板「导出到 Dify」· Dify 兼容模式）
// 入口：知识库视图头部「Dify 导出对接」按钮（本组件为配置 + 诊断 + 说明一体的 Dialog）。
//
// 三段式设计：
//   ① 对接配置：平台地址（自动检测）+ 导出专用 API Key（内联创建，仅展示一次）
//   ② 自检三按钮：检查链接（模拟 MinerU 浏览器直连）/ 模拟导出（真实走 create-by-text + 自动清理）/
//      公网可达性检测（mineru.net 服务器转发视角，POST /api/dify/reachability）
//   ③ 说明介绍：MinerU 面板操作步骤 + 导出链路架构（为什么检查链接成功、导出却可能失败）

import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  ArrowRight,
  BookOpen,
  Blocks,
  CheckCircle2,
  Copy,
  CopyPlus,
  Globe,
  KeyRound,
  Loader2,
  PlugZap,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { ApiDocsDialog } from './ApiDocsDialog'

type DiagState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'ok'; message: string }
  | { phase: 'fail'; message: string }

interface DifyKbItem {
  id: string
  name: string
}

function DiagResult({ state }: { state: DiagState }) {
  if (state.phase === 'idle') return null
  if (state.phase === 'running') {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> 探测中…
      </p>
    )
  }
  const ok = state.phase === 'ok'
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-[11px] leading-relaxed',
        ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
      )}
      role="status"
    >
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-all">{state.message}</span>
    </p>
  )
}

export function DifyExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  // ① 配置
  const [baseUrl, setBaseUrl] = useState('')
  const effectiveBase = useMemo(() => {
    const b = (baseUrl || (typeof window !== 'undefined' ? window.location.origin : '')).trim()
    return b.replace(/\/v1\/?$/i, '').replace(/\/+$/, '')
  }, [baseUrl])
  const [apiKey, setApiKey] = useState('')
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)

  // ② 自检
  const [checkState, setCheckState] = useState<DiagState>({ phase: 'idle' })
  const [exportState, setExportState] = useState<DiagState>({ phase: 'idle' })
  const [reachState, setReachState] = useState<DiagState>({ phase: 'idle' })
  const [difyKbs, setDifyKbs] = useState<DifyKbItem[]>([])
  const [targetKbId, setTargetKbId] = useState('')
  const [docsOpen, setDocsOpen] = useState(false)

  const createKeyMutation = useMutation({
    mutationFn: () => ragApi.createKey({ name: newKeyName.trim() || 'MinerU 导出专用', role: 'operator' }),
    onSuccess: (r) => {
      setCreatedKey(r.key.key ?? null)
      setNewKeyName('')
      toast.success('导出专用 Key 已创建（仅此一次展示）')
    },
    onError: (e: Error) => toast.error('创建失败：' + e.message),
  })

  /** ① 检查链接（= MinerU 面板同款浏览器直连 GET /v1/datasets） */
  const runCheck = async () => {
    if (!apiKey.trim()) {
      setCheckState({ phase: 'fail', message: '请先填写 API 密钥（或创建导出专用 Key 后粘贴）' })
      return
    }
    setCheckState({ phase: 'running' })
    try {
      const res = await fetch(`${effectiveBase}/v1/datasets?page=1&limit=100`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      })
      if (res.status === 401) {
        setCheckState({ phase: 'fail', message: '401：API 密钥无效或已删除（readonly 角色的 Key 也会通过本检查，但无法导出）' })
        return
      }
      if (!res.ok) {
        setCheckState({ phase: 'fail', message: `HTTP ${res.status}：地址不可用或平台异常` })
        return
      }
      const j = (await res.json()) as { data?: DifyKbItem[] }
      const kbs = (j.data ?? []).map((d) => ({ id: d.id, name: d.name }))
      setDifyKbs(kbs)
      if (!targetKbId && kbs.length > 0) setTargetKbId(kbs[0].id)
      setCheckState({
        phase: 'ok',
        message: `连接成功 · 可见 ${kbs.length} 个知识库（MinerU「检查链接」走的就是这条浏览器直连路径）`,
      })
    } catch (e) {
      setCheckState({ phase: 'fail', message: `请求失败：${e instanceof Error ? e.message : String(e)}（地址填错或服务未启动）` })
    }
  }

  /** ② 模拟导出：真实 POST create-by-text（MinerU 后端转发时调用的同一端点与载荷形状），成功后自动删除测试文档 */
  const runExport = async () => {
    if (!apiKey.trim()) {
      setExportState({ phase: 'fail', message: '请先填写 API 密钥' })
      return
    }
    if (!targetKbId) {
      setExportState({ phase: 'fail', message: '请先运行「检查链接」并选择目标知识库' })
      return
    }
    setExportState({ phase: 'running' })
    try {
      // 与 mineru.net 后端转发载荷同形状（分析实证：name/text/indexing_technique/process_rule/doc_form/created_from）
      const res = await fetch(`${effectiveBase}/v1/datasets/${targetKbId}/document/create-by-text`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Dify 导出链路自检',
          text: '# 导出链路自检\n\n这是「Dify 导出对接」对话框的模拟导出测试文档，验证 create-by-text 端点与载荷完全兼容，稍后会自动删除。\n\n## 第二段\n\n分段与切分配置同样走平台流水线。',
          indexing_technique: 'high_quality',
          process_rule: { mode: 'automatic' },
          doc_form: 'text_model',
          created_from: 'api',
        }),
      })
      const bodyText = await res.text()
      if (!res.ok) {
        let msg = bodyText.slice(0, 200)
        try {
          msg = JSON.parse(bodyText)?.message ?? msg
        } catch {}
        setExportState({ phase: 'fail', message: `HTTP ${res.status}：${msg}` })
        return
      }
      const docId = JSON.parse(bodyText)?.document?.id as string | undefined
      // 清理测试文档（best-effort；失败提示手动删除）
      let cleanupNote = ''
      if (docId) {
        const del = await fetch(`${effectiveBase}/v1/datasets/${targetKbId}/documents/${docId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${apiKey.trim()}` },
        })
        cleanupNote = del.ok ? '，测试文档已自动清理' : `，测试文档清理失败（HTTP ${del.status}）请在文档中心手动删除「Dify 导出链路自检」`
      }
      setExportState({
        phase: 'ok',
        message: `模拟导出成功——create-by-text 端点与 MinerU 载荷完全兼容（文档 ${docId ? docId.slice(0, 8) + '…' : '已创建'}${cleanupNote}）`,
      })
    } catch (e) {
      setExportState({ phase: 'fail', message: `请求失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }

  /** ③ 公网可达性检测（mineru.net 服务器转发视角） */
  const runReachability = async () => {
    setReachState({ phase: 'running' })
    try {
      const res = await fetch('/api/dify/reachability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: effectiveBase }),
      })
      const j = await res.json()
      if (!res.ok || !j.ok) {
        setReachState({ phase: 'fail', message: j?.error ?? `HTTP ${res.status}` })
        return
      }
      if (j.verdict === 'ok') {
        setReachState({
          phase: 'ok',
          message: `${j.advice}（外部探测 HTTP ${j.external.httpStatus} · ${j.external.ms}ms）`,
        })
      } else {
        setReachState({ phase: 'fail', message: `${j.advice}（direct: ${j.direct.reachable ? 'HTTP ' + j.direct.httpStatus : j.direct.error}；external: ${j.external.reachable ? 'HTTP ' + j.external.httpStatus : j.external.error ?? '不可达'}）` })
      }
    } catch (e) {
      setReachState({ phase: 'fail', message: `探测请求失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success('已复制到剪贴板'),
      () => toast.error('复制失败'),
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-sm">
              <Blocks className="h-4 w-4 text-teal-500" />
              Dify 导出对接
              <Badge variant="outline" className="border-teal-500/40 bg-teal-500/10 text-[10px] text-teal-600 dark:text-teal-300">
                MinerU 面板 · Dify 兼容模式
              </Badge>
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              把 MinerU 面板的解析结果直接导出到本平台知识库——在 MinerU「导出 → Dify」里填本平台地址与 API Key 即可，无需部署 Dify。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {/* ① 对接配置 */}
            <section className="space-y-3" aria-labelledby="dify-cfg">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold" id="dify-cfg">
                <PlugZap className="h-3.5 w-3.5 text-primary" /> 对接配置（填到 MinerU 面板）
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-muted-foreground">API 服务器地址（勿带 /v1）</Label>
                  <div className="flex gap-1.5">
                    <Input
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder={typeof window !== 'undefined' ? window.location.origin : 'https://your-domain'}
                      className="h-8 font-mono text-[11px]"
                      aria-label="API 服务器地址"
                    />
                    <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-[11px]" onClick={() => copy(effectiveBase)}>
                      <Copy className="h-3 w-3" /> 复制
                    </Button>
                  </div>
                  <p className="text-[10px] leading-relaxed text-muted-foreground">默认为当前访问地址；部署到自有域名后改为公网地址。</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-muted-foreground">API 密钥（operator / admin）</Label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="rag-…（粘贴你的 Key）"
                    className="h-8 font-mono text-[11px]"
                    aria-label="API 密钥"
                  />
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    readonly Key 只能读列表，导出会 403。没有 Key？在下面创建专用 Key。
                  </p>
                </div>
              </div>

              {/* 内联创建导出专用 Key */}
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="新建导出专用 Key 名称（默认「MinerU 导出专用」）"
                    className="h-8 flex-1 text-[11px]"
                    aria-label="新 Key 名称"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 text-[11px]"
                    disabled={createKeyMutation.isPending}
                    onClick={() => createKeyMutation.mutate()}
                  >
                    <CopyPlus className="h-3 w-3" />
                    {createKeyMutation.isPending ? '创建中…' : '创建 operator Key'}
                  </Button>
                </div>
                {createdKey && (
                  <div className="mt-2 flex items-center gap-2">
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                    <Input readOnly value={createdKey} className="h-8 font-mono text-[11px]" onFocus={(e) => e.target.select()} aria-label="新创建的 Key（仅显示一次）" />
                    <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-[11px]" onClick={() => copy(createdKey)}>
                      <Copy className="h-3 w-3" /> 复制
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 shrink-0 text-[11px]" onClick={() => { setApiKey(createdKey); setCreatedKey(null) }}>
                      填入左侧
                    </Button>
                  </div>
                )}
                {!createdKey && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                    完整 Key 仅创建后展示一次（平台只存哈希）；建议为 MinerU 导出使用专用 Key，可随时吊销。
                  </p>
                )}
              </div>
            </section>

            {/* ② 自检 */}
            <section className="space-y-3" aria-labelledby="dify-diag">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold" id="dify-diag">
                <Globe className="h-3.5 w-3.5 text-primary" /> 链路自检（三步定位问题）
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Button variant="outline" size="sm" className="h-8 justify-start gap-1.5 text-[11px]" onClick={runCheck}>
                  <ArrowRight className="h-3 w-3" /> ① 检查链接（模拟 MinerU）
                </Button>
                <Button variant="outline" size="sm" className="h-8 justify-start gap-1.5 text-[11px]" onClick={runExport} disabled={!targetKbId && difyKbs.length === 0}>
                  <Blocks className="h-3 w-3" /> ② 模拟导出（写入测试）
                </Button>
                <Button variant="outline" size="sm" className="h-8 justify-start gap-1.5 text-[11px]" onClick={runReachability}>
                  <Globe className="h-3 w-3" /> ③ 公网可达性检测
                </Button>
              </div>

              {difyKbs.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Label className="text-[11px] text-muted-foreground">模拟导出目标：</Label>
                  <Select value={targetKbId} onValueChange={setTargetKbId}>
                    <SelectTrigger className="h-8 w-[240px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {difyKbs.map((kb) => (
                        <SelectItem key={kb.id} value={kb.id} className="text-xs">{kb.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
                <DiagResult state={checkState} />
                <DiagResult state={exportState} />
                <DiagResult state={reachState} />
                {checkState.phase === 'idle' && exportState.phase === 'idle' && reachState.phase === 'idle' && (
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    ①② 验证平台端点与 Key（浏览器视角，MinerU「检查链接」同路径）；③ 验证「mineru.net 服务器 → 平台」的公网链路（导出实际走这条）。
                    ①② 通过而 ③ 失败 = 平台地址对 mineru.net 不可达——这正是「检查链接成功但导出失败」的原因。
                  </p>
                )}
              </div>
            </section>

            {/* ③ 说明介绍 */}
            <section className="space-y-2.5" aria-labelledby="dify-guide">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold" id="dify-guide">
                <BookOpen className="h-3.5 w-3.5 text-primary" /> MinerU 面板操作步骤
              </h3>
              <ol className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
                <li>1. 在 MinerU 面板打开解析结果 → 导出 → Dify；</li>
                <li>2. <b className="text-foreground">API 服务器地址</b>填上方复制的地址（勿带 /v1），<b className="text-foreground">API 密钥</b>填上方 Key；</li>
                <li>3. 点【检查链接】→ 显示验证成功；选择导出位置（已有知识库或新建）；</li>
                <li>4. （可选）高级配置：文档预处理、段落分隔符、每段最大 token 数；点【导出】。</li>
              </ol>
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  <b>为什么检查链接成功、导出却失败？</b>MinerU 的「检查链接」由你的浏览器直连本平台；而「导出」是把地址交给
                  <b> mineru.net 服务器</b>由它转发调用本平台 <code className="rounded bg-muted px-1 font-mono text-[10px]">create-by-text</code>——平台地址必须<b>公网可达</b>。
                  内网地址 / localhost / 临时预览域名都可能出现「检查链接成功但导出失败（糟糕，操作失败）」。用上方 ③ 检测；部署到公网域名（自有服务器 + 反代）后复测。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[11px]" onClick={() => setDocsOpen(true)}>
                  <BookOpen className="h-3 w-3" /> 查看完整对接文档
                </Button>
                <span className="text-[10px] text-muted-foreground">端点总表 · 状态映射 · 高级配置映射 · 故障排查</span>
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>

      <ApiDocsDialog
        open={docsOpen}
        onOpenChange={setDocsOpen}
        title="Dify 兼容数据集 API · 对接文档"
        description="/v1/datasets/** · MinerU 面板「导出到 Dify」直接填本平台地址与 Key"
        src="/api/input/docs?file=dify-compat"
      />
    </>
  )
}
