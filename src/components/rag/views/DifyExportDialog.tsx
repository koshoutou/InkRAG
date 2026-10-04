'use client'

// Dify 导出对接配置（MinerU 面板「导出到 Dify」· Dify 兼容模式）
// 入口：知识库视图头部「Dify 导出对接」按钮。
//
// 三段式（v1.10 瘦身后）：
//   ① 对接配置：平台地址（自动检测 + 复制）
//   ② API Key 管理：列表 / 创建导出专用 Key（仅展示一次）/ 启停 / 删除
//   ③ 说明介绍：MinerU 面板四步操作 + 导出链路架构警示 + 完整文档入口

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  Blocks,
  Copy,
  CopyPlus,
  KeyRound,
  Loader2,
  PlugZap,
  Power,
  ShieldAlert,
  Trash2,
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { ApiDocsDialog } from './ApiDocsDialog'

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  operator: '操作者',
  readonly: '只读',
}

export function DifyExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryCtl = useQueryClient()

  // ① 配置
  const [baseUrl, setBaseUrl] = useState('')
  const effectiveBase = useMemo(() => {
    const b = (baseUrl || (typeof window !== 'undefined' ? window.location.origin : '')).trim()
    return b.replace(/\/v1\/?$/i, '').replace(/\/+$/, '')
  }, [baseUrl])

  // ② Key 管理
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [docsOpen, setDocsOpen] = useState(false)

  const keysQuery = useQuery({
    queryKey: ['dify-export-keys'],
    queryFn: () => ragApi.listKeys(),
    enabled: open,
  })

  useEffect(() => {
    if (open) void queryCtl.invalidateQueries({ queryKey: ['dify-export-keys'] })
  }, [open, queryCtl])

  const createKeyMutation = useMutation({
    mutationFn: () => ragApi.createKey({ name: newKeyName.trim() || 'MinerU 导出专用', role: 'operator' }),
    onSuccess: (r) => {
      setCreatedKey(r.key.key ?? null)
      setNewKeyName('')
      void queryCtl.invalidateQueries({ queryKey: ['dify-export-keys'] })
      toast.success('导出专用 Key 已创建（仅此一次展示）')
    },
    onError: (e: Error) => toast.error('创建失败：' + e.message),
  })

  const deleteKeyMutation = useMutation({
    mutationFn: (id: string) => ragApi.deleteKey(id),
    onSuccess: () => {
      toast.success('API Key 已删除，使用该 Key 的导出将立即失效')
      setDeleteTarget(null)
      void queryCtl.invalidateQueries({ queryKey: ['dify-export-keys'] })
    },
    onError: (e: Error) => toast.error('删除失败：' + e.message),
  })

  const toggleKeyMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => ragApi.patchKey(id, { enabled }),
    onSuccess: (_r, v) => {
      toast.success(v.enabled ? 'Key 已启用' : 'Key 已停用（调用将返回 401）')
      void queryCtl.invalidateQueries({ queryKey: ['dify-export-keys'] })
    },
    onError: (e: Error) => toast.error('操作失败：' + e.message),
  })

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success('已复制到剪贴板'),
      () => toast.error('复制失败'),
    )
  }

  const keys = keysQuery.data?.keys ?? []

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
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  默认为当前访问地址；部署到自有域名后改为公网地址（导出由 mineru.net 服务器转发，平台地址需公网可达）。
                </p>
              </div>
            </section>

            {/* ② API Key 管理 */}
            <section className="space-y-3" aria-labelledby="dify-keys">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold" id="dify-keys">
                <KeyRound className="h-3.5 w-3.5 text-primary" /> API Key 管理
              </h3>

              {/* 内联创建导出专用 Key */}
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <div className="flex flex-wrap items-center gap-2">
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
                  </div>
                )}
                {!createdKey && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                    完整 Key 仅创建后展示一次（平台只存哈希）；建议为 MinerU 导出使用专用 Key，可随时停用或删除。
                  </p>
                )}
              </div>

              {/* Key 列表 */}
              <div className="overflow-hidden rounded-lg border border-border/60">
                <div className="grid grid-cols-[1.4fr_0.7fr_0.9fr_0.9fr_auto] gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-[10px] font-medium text-muted-foreground">
                  <span>名称 / 前缀</span>
                  <span>角色</span>
                  <span>状态</span>
                  <span>最近使用 / 调用</span>
                  <span className="text-right">操作</span>
                </div>
                {keysQuery.isLoading ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-6 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中…
                  </div>
                ) : keys.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                    暂无 API Key——创建一个导出专用 Key 即可开始对接
                  </div>
                ) : (
                  <ul className="max-h-56 overflow-y-auto" aria-label="API Key 列表">
                    {keys.map((k) => (
                      <li
                        key={k.id}
                        className="grid grid-cols-[1.4fr_0.7fr_0.9fr_0.9fr_auto] items-center gap-2 border-b border-border/40 px-3 py-2 text-[11px] last:border-b-0 hover:bg-muted/20"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">{k.name}</div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">{k.keyPreview}</div>
                        </div>
                        <span className="text-muted-foreground">{ROLE_LABEL[k.role] ?? k.role}</span>
                        <span>
                          <span
                            className={cn(
                              'inline-flex items-center gap-1',
                              k.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
                            )}
                          >
                            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', k.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
                            {k.enabled ? '启用' : '停用'}
                          </span>
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {fmtTime(k.lastUsedAt)} · {k.callCount} 次
                        </span>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title={k.enabled ? '停用（调用将 401）' : '启用'}
                            aria-label={k.enabled ? `停用 ${k.name}` : `启用 ${k.name}`}
                            disabled={toggleKeyMutation.isPending}
                            onClick={() => toggleKeyMutation.mutate({ id: k.id, enabled: !k.enabled })}
                          >
                            <Power className={cn('h-3.5 w-3.5', k.enabled ? 'text-muted-foreground' : 'text-emerald-500')} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-rose-500 hover:text-rose-600"
                            title="删除此 Key（不可恢复）"
                            aria-label={`删除 ${k.name}`}
                            onClick={() => setDeleteTarget({ id: k.id, name: k.name })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                readonly 角色的 Key 只能读列表、无法导出（403）；导出请使用 operator / admin。Key 的完整管理（角色编辑等）在「Agent API」视图。
              </p>
            </section>

            {/* ③ 说明介绍 */}
            <section className="space-y-2.5" aria-labelledby="dify-guide">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold" id="dify-guide">
                <BookOpen className="h-3.5 w-3.5 text-primary" /> MinerU 面板操作步骤
              </h3>
              <ol className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
                <li>1. 在 MinerU 面板打开解析结果 → 导出 → Dify；</li>
                <li>2. <b className="text-foreground">API 服务器地址</b>填上方复制的地址（勿带 /v1），<b className="text-foreground">API 密钥</b>填上方创建的 Key；</li>
                <li>3. 点【检查链接】→ 显示验证成功；选择导出位置（已有知识库或新建）；</li>
                <li>4. （可选）高级配置：文档预处理、段落分隔符、每段最大 token 数；点【导出】。</li>
              </ol>
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  <b>为什么检查链接成功、导出却失败？</b>MinerU 的「检查链接」由你的浏览器直连本平台；而「导出」是把地址交给
                  <b> mineru.net 服务器</b>由它转发调用本平台 <code className="rounded bg-muted px-1 font-mono text-[10px]">create-by-text</code>——平台地址必须<b>公网可达</b>。
                  内网地址 / localhost / 临时预览域名都可能出现「检查链接成功但导出失败（糟糕，操作失败）」。部署到公网域名（自有服务器 + 反代）即可解决。
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

      {/* 删除 Key 二次确认 */}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">删除 API Key「{deleteTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              删除后使用该 Key 的 MinerU 导出与 /api/input 调用将立即返回 401，且不可恢复。如只是暂时停用，请选择「停用」。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs">取消</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 gap-1 bg-rose-600 text-xs hover:bg-rose-700"
              disabled={deleteKeyMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (deleteTarget) deleteKeyMutation.mutate(deleteTarget.id)
              }}
            >
              {deleteKeyMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
