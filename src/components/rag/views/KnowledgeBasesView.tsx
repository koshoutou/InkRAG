'use client'

// 知识库管理：网格卡片 + 新建/编辑 Dialog + 删除确认 + 首次使用引导

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Blocks,
  ChevronRight,
  Database,
  FileText,
  Library,
  Layers,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ragApi } from '../api'
import { gotoDocs, usePlatformStore } from '../store'
import { useQuickAction } from '../useQuickAction'
import { useRealtime } from '../useRealtime'
import type { ChunkConfig, ChunkStrategy, KbSummary } from '../types'
import { BoolBadge, ErrorCard, VectorModeBadge, ViewPage, formatNumber, timeAgo } from '../ui'
import { DifyExportDialog } from './DifyExportDialog'

const PROTECT_OPTIONS = [
  { value: 'code', label: '代码块 code' },
  { value: 'table', label: '表格 table' },
  { value: 'image', label: '图片 image' },
]

interface KbFormState {
  name: string
  description: string
  embeddingModel: string
  dim: number
  chunkConfig: ChunkConfig
  rerankEnabled: boolean
}

const EMPTY_FORM: KbFormState = {
  name: '',
  description: '',
  embeddingModel: '',
  dim: 1024,
  chunkConfig: { size: 512, overlap: 0, parentSize: 2000, strategy: 'token', protects: ['code', 'table'] },
  rerankEnabled: true,
}

export function KnowledgeBasesView() {
  const queryClient = useQueryClient()
  const { subscribeRooms, on } = useRealtime()
  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editKb, setEditKb] = useState<KbSummary | null>(null)
  const [deleteKb, setDeleteKb] = useState<KbSummary | null>(null)
  const [difyOpen, setDifyOpen] = useState(false)

  // 命令面板快捷动作（契约 §19）：rag:quick-create-kb → 自动打开「新建知识库」Dialog
  // （Dialog 已开则忽略；跨视图派发时由 useQuickAction 桥回放）
  useQuickAction('rag:quick-create-kb', () => {
    if (createOpen || !!editKb) return
    setCreateOpen(true)
  })

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['kbs'],
    queryFn: () => ragApi.listKbs(),
  })

  // kb:stats 事件 → 刷新知识库卡片统计
  useEffect(() => {
    subscribeRooms(['global'])
    const un = on('kb:stats', () => queryClient.invalidateQueries({ queryKey: ['kbs'] }))
    const un2 = on('document:done', () => queryClient.invalidateQueries({ queryKey: ['kbs'] }))
    return () => {
      un()
      un2()
    }
  }, [subscribeRooms, on, queryClient])

  const kbs = useMemo(() => {
    const list = data?.kbs ?? []
    if (!q.trim()) return list
    const kw = q.trim().toLowerCase()
    return list.filter((k) => k.name.toLowerCase().includes(kw) || k.description.toLowerCase().includes(kw))
  }, [data, q])

  const removeMutation = useMutation({
    mutationFn: (id: string) => ragApi.deleteKb(id),
    onSuccess: (r) => {
      toast.success(`知识库已删除（文档 ${r.deleted?.docs ?? '?'} / chunk ${r.deleted?.chunks ?? '?'}）`)
      setDeleteKb(null)
      queryClient.invalidateQueries({ queryKey: ['kbs'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (e: Error) => toast.error('删除失败：' + e.message),
  })

  return (
    <ViewPage wide>
      {/* 顶部操作行 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">知识库</h2>
          <p className="text-xs text-muted-foreground">
            管理共享知识库：Embedding 模型、切分配置、向量集合。删除将级联清理文档 / chunk / 向量点 / 磁盘产物。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索知识库…" className="h-8 w-44 pl-7 text-xs" />
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDifyOpen(true)}>
                  <Blocks className="h-3.5 w-3.5 text-teal-500" />
                  Dify 导出对接
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                MinerU 面板「导出到 Dify」直接对接本平台（Dify 兼容模式）：地址 / Key 配置与链路自检
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            新建知识库
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-52 rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <ErrorCard title="知识库列表加载失败" message={error instanceof Error ? error.message : String(error)} onRetry={() => refetch()} />
      ) : (data?.kbs ?? []).length === 0 ? (
        <FirstUseHint onCreate={() => setCreateOpen(true)} />
      ) : kbs.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground">没有匹配的知识库</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {kbs.map((kb) => (
            <KbCard
              key={kb.id}
              kb={kb}
              onOpen={() => gotoDocs(kb.id)}
              onEdit={() => setEditKb(kb)}
              onDelete={() => setDeleteKb(kb)}
            />
          ))}
        </div>
      )}

      {/* 新建 / 编辑弹窗 */}
      <KbFormDialog
        open={createOpen || !!editKb}
        editing={editKb}
        onClose={() => {
          setCreateOpen(false)
          setEditKb(null)
        }}
      />

      {/* 删除确认 */}
      <AlertDialog open={!!deleteKb} onOpenChange={(v) => !v && setDeleteKb(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除知识库「{deleteKb?.name}」？</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              此操作不可撤销，将级联删除：
              <br />· 该库全部文档（{deleteKb?.docCount ?? 0} 个）与 chunk（{deleteKb?.chunkCount ?? 0} 条）
              <br />· 向量集合 <span className="font-mono text-[11px]">{deleteKb?.collection}</span>（{formatNumber(deleteKb?.pointCount ?? 0)} 点）
              <br />· 磁盘产物（原始文件 / markdown / middle.json）
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
              onClick={(e) => {
                if (deleteKb) removeMutation.mutate(deleteKb.id)
                e.preventDefault()
              }}
            >
              {removeMutation.isPending ? '删除中…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dify 导出对接配置（MinerU 面板「导出到 Dify」· Dify 兼容模式） */}
      <DifyExportDialog open={difyOpen} onOpenChange={setDifyOpen} />
    </ViewPage>
  )
}

function KbCard({ kb, onOpen, onEdit, onDelete }: { kb: KbSummary; onOpen: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="group flex flex-col rounded-xl border border-border/60 bg-card p-4 shadow-xs transition-all hover:border-primary/40 hover:shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
            <Library className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <button type="button" onClick={onOpen} className="truncate text-left text-sm font-semibold hover:underline" title={kb.name}>
              {kb.name}
            </button>
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
              {kb.description || '暂无描述'}
            </p>
          </div>
        </div>
        <VectorModeBadge mode={kb.vectorMode} />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="max-w-[200px] truncate text-[10px] font-mono">
                {kb.embeddingModel || '未锁定'}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Embedding 模型 · dim={kb.dim} · 稀疏方案 {kb.sparseScheme === 'native' ? 'native（原生稀疏）' : 'none（强制 dense）'}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Badge variant="secondary" className="text-[10px] font-mono">{kb.dim}d</Badge>
        <BoolBadge value={kb.rerankEnabled} trueLabel="Rerank" falseLabel="无 Rerank" />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3 text-center">
        <div>
          <div className="text-sm font-semibold tabular-nums">{formatNumber(kb.docCount)}</div>
          <div className="flex items-center justify-center gap-0.5 text-[10px] text-muted-foreground">
            <FileText className="h-2.5 w-2.5" /> 文档
          </div>
        </div>
        <div>
          <div className="text-sm font-semibold tabular-nums">{formatNumber(kb.chunkCount)}</div>
          <div className="flex items-center justify-center gap-0.5 text-[10px] text-muted-foreground">
            <Layers className="h-2.5 w-2.5" /> Chunk
          </div>
        </div>
        <div>
          <div className="text-sm font-semibold tabular-nums">{formatNumber(kb.pointCount)}</div>
          <div className="flex items-center justify-center gap-0.5 text-[10px] text-muted-foreground">
            <Database className="h-2.5 w-2.5" /> 向量点
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-3">
        <span className="text-[10px] text-muted-foreground">创建于 {timeAgo(kb.createdAt)}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} title="编辑配置">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-500 hover:text-rose-600" onClick={onDelete} title="删除">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" className="ml-1 h-7 gap-1 text-xs" onClick={onOpen}>
            文档中心
            <ChevronRight className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function FirstUseHint({ onCreate }: { onCreate: () => void }) {
  const setView = usePlatformStore((s) => s.setView)
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/70 bg-muted/20 p-10 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
          <Library className="h-7 w-7" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-base font-semibold">欢迎使用 RAG 知识库平台</h3>
          <p className="text-sm text-muted-foreground">还没有知识库。三步开始构建你的知识库：</p>
        </div>
        <Button onClick={onCreate} size="sm" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          创建第一个知识库
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[
          { icon: <Library className="h-5 w-5" />, step: '①', title: '建库', desc: '先在设置中配置 Qdrant 与 Embedding，建库时自动实测维度并锁定，再设置父子切分配置。' },
          { icon: <FileText className="h-5 w-5" />, step: '②', title: '传文档', desc: '拖入 PDF / Markdown / TXT / HTML，MinerU 或降级解析器完成解析与切分。' },
          { icon: <Search className="h-5 w-5" />, step: '③', title: '检索', desc: '三屏联动查看切分效果，在调试台白盒验证召回质量，再接入 Agent API。' },
        ].map((s) => (
          <div key={s.title} className="rounded-xl border border-border/60 bg-card p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">{s.icon}</span>
              <div>
                <div className="text-xs font-semibold">{s.step} {s.title}</div>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{s.desc}</p>
          </div>
        ))}
      </div>
      <div className="text-center">
        <Button variant="link" size="sm" className="text-xs" onClick={() => setView('dashboard')}>
          先看看仪表盘 →
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 新建 / 编辑 Dialog
// ---------------------------------------------------------------------------

function KbFormDialog({ open, editing, onClose }: { open: boolean; editing: KbSummary | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<KbFormState>(EMPTY_FORM)
  const [advanced, setAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!open) {
      setLoaded(false)
      return
    }
    if (editing) {
      setForm({
        name: editing.name,
        description: editing.description,
        embeddingModel: editing.embeddingModel,
        dim: editing.dim,
        chunkConfig: { ...editing.chunkConfig },
        rerankEnabled: editing.rerankEnabled,
      })
      setAdvanced(true)
    } else {
      setForm(EMPTY_FORM)
      setAdvanced(false)
    }
    setLoaded(true)
  }, [open, editing?.id])

  const update = (patch: Partial<KbFormState>) => setForm((f) => ({ ...f, ...patch }))
  const updateChunk = (patch: Partial<ChunkConfig>) => setForm((f) => ({ ...f, chunkConfig: { ...f.chunkConfig, ...patch } }))

  const onSave = async () => {
    if (!form.name.trim()) {
      toast.error('请填写知识库名称')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await ragApi.updateKb(editing.id, {
          name: form.name.trim(),
          description: form.description,
          chunkConfig: form.chunkConfig,
          rerankEnabled: form.rerankEnabled,
        })
        toast.success('知识库已更新')
      } else {
        // v1.6：建库时后端实测当前配置的 Embedding 维度并锁定（embeddingModel/dim 不再由前端指定）。
        // 未配置 Qdrant / Embedding 时后端返回 400，toast 展示引导文案
        await ragApi.createKb({
          name: form.name.trim(),
          description: form.description,
          chunkConfig: form.chunkConfig,
          rerankEnabled: form.rerankEnabled,
        })
        toast.success(`知识库「${form.name.trim()}」已创建`)
      }
      queryClient.invalidateQueries({ queryKey: ['kbs'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      onClose()
    } catch (e) {
      toast.error((editing ? '保存失败：' : '创建失败：') + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Settings2 className="h-4 w-4 text-primary" />
            {editing ? `编辑知识库 · ${editing.name}` : '新建知识库'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {editing
              ? 'Embedding 模型与维度建库后不可修改（向量集合已按该维度创建）。'
              : '建库时会实测「设置 → Embedding」中配置的模型维度并锁定；需先配置 Qdrant 与 Embedding（未配置时创建将被拒绝并提示）。'}
          </DialogDescription>
        </DialogHeader>

        {!loaded ? (
          <div className="flex h-32 items-center justify-center">
            <Skeleton className="h-full w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label htmlFor="kb-name" className="text-xs text-muted-foreground">名称 *</Label>
              <Input
                id="kb-name"
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="例：产品手册知识库"
                className="mt-1.5 h-9 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="kb-desc" className="text-xs text-muted-foreground">描述</Label>
              <Textarea
                id="kb-desc"
                value={form.description}
                onChange={(e) => update({ description: e.target.value })}
                placeholder="知识库用途说明（可选）"
                className="mt-1.5 min-h-[64px] text-sm"
              />
            </div>
            {editing ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="kb-model" className="text-xs text-muted-foreground">Embedding 模型</Label>
                  <Input
                    id="kb-model"
                    value={form.embeddingModel}
                    onChange={(e) => update({ embeddingModel: e.target.value })}
                    disabled
                    className="mt-1.5 h-9 font-mono text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="kb-dim" className="text-xs text-muted-foreground">向量维度</Label>
                  <Input
                    id="kb-dim"
                    type="number"
                    value={form.dim}
                    onChange={(e) => update({ dim: Number(e.target.value) || 0 })}
                    disabled
                    className="mt-1.5 h-9 text-xs"
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                建库时自动使用「设置 → Embedding」当前配置的模型，并实测维度、稀疏方案一并锁定
                （中途更换模型会被入库断言拦截，需新建知识库重导）。若未配置 Qdrant / Embedding，
                创建会被拒绝并提示引导配置。
              </div>
            )}

            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
              <div>
                <div className="text-xs font-medium">Rerank 重排</div>
                <div className="text-[10px] text-muted-foreground">检索时对召回结果做二级重排（需在设置中配置 Rerank 服务）</div>
              </div>
              <Switch checked={form.rerankEnabled} onCheckedChange={(v) => update({ rerankEnabled: v })} />
            </div>

            {/* 高级：切分配置 */}
            <Collapsible open={advanced} onOpenChange={setAdvanced}>
              <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border/60 px-3 py-2 text-xs font-medium hover:bg-muted/30">
                <span>切分配置（父子 chunk）</span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  size={form.chunkConfig.size} overlap={form.chunkConfig.overlap} parent={form.chunkConfig.parentSize} · {form.chunkConfig.strategy}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 px-1 pt-3">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-[11px] text-muted-foreground">子块 size (token)</Label>
                    <Input
                      type="number"
                      value={form.chunkConfig.size}
                      onChange={(e) => updateChunk({ size: Number(e.target.value) || 0 })}
                      className="mt-1 h-8 text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">overlap (token)</Label>
                    <Input
                      type="number"
                      value={form.chunkConfig.overlap}
                      onChange={(e) => updateChunk({ overlap: Number(e.target.value) || 0 })}
                      className="mt-1 h-8 text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">父块上限 (token)</Label>
                    <Input
                      type="number"
                      value={form.chunkConfig.parentSize}
                      onChange={(e) => updateChunk({ parentSize: Number(e.target.value) || 0 })}
                      className="mt-1 h-8 text-xs"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground">切分策略</Label>
                  <Select value={form.chunkConfig.strategy} onValueChange={(v) => updateChunk({ strategy: v as ChunkStrategy })}>
                    <SelectTrigger className="mt-1 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="token" className="text-xs">token — 按固定 token 窗口切分</SelectItem>
                      <SelectItem value="title" className="text-xs">title — 按标题层级切分</SelectItem>
                      <SelectItem value="hybrid" className="text-xs">hybrid — 标题优先 + token 兜底</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground">原子保护块（不参与切分）</Label>
                  <div className="mt-1.5 flex flex-wrap gap-3">
                    {PROTECT_OPTIONS.map((opt) => (
                      <label key={opt.value} className="flex cursor-pointer items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={form.chunkConfig.protects.includes(opt.value)}
                          onCheckedChange={(checked) => {
                            const set = new Set(form.chunkConfig.protects)
                            if (checked) set.add(opt.value)
                            else set.delete(opt.value)
                            updateChunk({ protects: Array.from(set) })
                          }}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={onSave} disabled={saving || !loaded} className="gap-1.5">
            {saving ? '保存中…' : editing ? '保存修改' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
