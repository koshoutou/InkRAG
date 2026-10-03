'use client'

// Agent API：Key 管理（创建一次性展示 / 启停 / 删除）+ API 入口说明
// §32（Task 17-1）：对外检索 API 文档卡已随检索 API 一并移除；
// 入库 API（/api/input，供 AI 上传文件入库）与 Dify 兼容层文档将在后续版本内嵌到本视图

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Copy,
  KeyRound,
  Plug,
  Plus,
  ShieldAlert,
  ShieldCheck,
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { ragApi } from '../api'
import { useQuickAction } from '../useQuickAction'
import type { ApiKeyItem, ApiKeyRole } from '../types'
import { ErrorCard, ViewPage, formatDateTime, timeAgo } from '../ui'

const ROLE_META: Record<ApiKeyRole, { label: string; badge: string; desc: string }> = {
  admin: { label: 'admin', badge: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300', desc: '全部权限：入库 / 管理 / 高级参数' },
  operator: { label: 'operator', badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300', desc: '入库 + 高级参数' },
  readonly: { label: 'readonly', badge: 'border-stone-400/40 bg-stone-500/10 text-stone-600 dark:text-stone-300', desc: '只读（不允许写入操作）' },
}

export function ApiKeysView() {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<ApiKeyRole>('readonly')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [deleteKey, setDeleteKey] = useState<ApiKeyItem | null>(null)

  const keysQuery = useQuery({ queryKey: ['keys'], queryFn: () => ragApi.listKeys() })

  // 命令面板快捷动作（契约 §19）：rag:quick-create-key → 自动打开「新建 API Key」Dialog
  // （Dialog 已开则忽略；跨视图派发时由 useQuickAction 桥回放）
  useQuickAction('rag:quick-create-key', () => {
    if (createOpen) return
    setCreateOpen(true)
  })

  const createMutation = useMutation({
    mutationFn: () => ragApi.createKey({ name: newName.trim(), role: newRole }),
    onSuccess: (r) => {
      setCreatedKey(r.key.key ?? null)
      setCreateOpen(false)
      setNewName('')
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      toast.success('API Key 已创建')
    },
    onError: (e: Error) => toast.error('创建失败：' + e.message),
  })

  const patchMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => ragApi.patchKey(id, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['keys'] }),
    onError: (e: Error) => toast.error('更新失败：' + e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => ragApi.deleteKey(id),
    onSuccess: () => {
      toast.success('Key 已删除')
      setDeleteKey(null)
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
    onError: (e: Error) => toast.error('删除失败：' + e.message),
  })

  const keys = keysQuery.data?.keys ?? []

  return (
    <ViewPage wide>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Agent API</h2>
          <p className="text-xs text-muted-foreground">
            API Key 管理与对外接口入口；本平台定位为知识库管理（入库 / 切分 / 版本 / 备份）。
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          新建 API Key
        </Button>
      </div>

      {/* API 入口说明（§32：检索 API 已移除；入库 API / Dify 兼容层文档即将内嵌） */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Plug className="h-4 w-4 text-primary" />
            对外接口
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 text-xs md:grid-cols-3">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="mb-1 font-medium text-emerald-700 dark:text-emerald-300">入库 API（规划中）</div>
              <code className="font-mono text-[11px] text-muted-foreground">POST /api/input/…</code>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">供 AI / Agent 上传文件入库：建库、多模式解析、切分配置、并发处理。详细文档即将内嵌到本视图。</p>
            </div>
            <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 p-3">
              <div className="mb-1 font-medium text-teal-700 dark:text-teal-300">Dify 兼容数据集 API（规划中）</div>
              <code className="font-mono text-[11px] text-muted-foreground">/v1/datasets/…</code>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">对接 MinerU 面板「导出到 Dify」：填本平台地址与 API Key 即可直接导出。</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="mb-1 font-medium">检索 API（已移除）</div>
              <code className="font-mono text-[11px] text-muted-foreground line-through">/api/v1/knowledge-bases/…/search</code>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">检索调用与审计已由独立的 API 审计平台承担（§32）；本平台不再提供对外检索。</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Key 管理表 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4 text-primary" />
            API Keys
            <Badge variant="secondary" className="ml-auto text-[10px]">{keys.length} 个</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {keysQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-lg" />
              ))}
            </div>
          ) : keysQuery.error ? (
            <ErrorCard
              title="Key 列表加载失败"
              message={keysQuery.error instanceof Error ? keysQuery.error.message : String(keysQuery.error)}
              onRetry={() => keysQuery.refetch()}
            />
          ) : keys.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              还没有 API Key —— 点击右上角「新建 API Key」为你的 Agent 生成凭证。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-9 text-[11px]">名称</TableHead>
                    <TableHead className="h-9 text-[11px]">Key</TableHead>
                    <TableHead className="h-9 text-[11px]">角色</TableHead>
                    <TableHead className="h-9 text-[11px] text-right">调用次数</TableHead>
                    <TableHead className="h-9 text-[11px]">最后使用</TableHead>
                    <TableHead className="h-9 text-[11px]">创建时间</TableHead>
                    <TableHead className="h-9 text-[11px] text-center">启用</TableHead>
                    <TableHead className="h-9 text-[11px] text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k) => (
                    <TableRow key={k.id} className={cn(!k.enabled && 'opacity-55')}>
                      <TableCell className="py-2 text-xs font-medium">{k.name}</TableCell>
                      <TableCell className="py-2 font-mono text-[11px] text-muted-foreground">{k.keyPreview}</TableCell>
                      <TableCell className="py-2">
                        <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium', ROLE_META[k.role]?.badge)}>
                          {ROLE_META[k.role]?.label ?? k.role}
                        </span>
                      </TableCell>
                      <TableCell className="py-2 text-right text-xs tabular-nums">{k.callCount}</TableCell>
                      <TableCell className="py-2 text-[11px] text-muted-foreground">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : '从未使用'}</TableCell>
                      <TableCell className="py-2 text-[11px] text-muted-foreground">{formatDateTime(k.createdAt)}</TableCell>
                      <TableCell className="py-2 text-center">
                        <Switch
                          checked={k.enabled}
                          disabled={patchMutation.isPending}
                          onCheckedChange={(v) => patchMutation.mutate({ id: k.id, enabled: v })}
                          aria-label={`启用 ${k.name}`}
                        />
                      </TableCell>
                      <TableCell className="py-2 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-rose-500 hover:text-rose-600"
                          onClick={() => setDeleteKey(k)}
                          title="删除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 新建 Key Dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <KeyRound className="h-4 w-4 text-primary" />
              新建 API Key
            </DialogTitle>
            <DialogDescription className="text-xs">
              完整 Key 仅在创建后展示一次，请立即复制保存。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="key-name" className="text-xs text-muted-foreground">名称 *</Label>
              <Input
                id="key-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例：客服机器人 Agent"
                className="mt-1.5 h-9 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">角色</Label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as ApiKeyRole)}>
                <SelectTrigger className="mt-1.5 h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ROLE_META) as ApiKeyRole[]).map((r) => (
                    <SelectItem key={r} value={r} className="text-xs">
                      {ROLE_META[r].label} — {ROLE_META[r].desc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button size="sm" disabled={!newName.trim() || createMutation.isPending} onClick={() => createMutation.mutate()}>
              {createMutation.isPending ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一次性 Key 展示 */}
      <Dialog open={!!createdKey} onOpenChange={(v) => !v && setCreatedKey(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              API Key 创建成功
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              <ShieldAlert className="mr-1 inline h-3.5 w-3.5 text-amber-500" />
              此 Key 仅显示一次，关闭弹窗后无法再次查看。请立即复制并妥善保管。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={createdKey ?? ''} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1"
              onClick={() => {
                navigator.clipboard.writeText(createdKey ?? '').then(
                  () => toast.success('已复制到剪贴板'),
                  () => toast.error('复制失败'),
                )
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              复制
            </Button>
          </div>
          <DialogFooter>
            <Button size="sm" onClick={() => setCreatedKey(null)}>我已保存，关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={!!deleteKey} onOpenChange={(v) => !v && setDeleteKey(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 Key「{deleteKey?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后使用该 Key 的 Agent 将立即收到 401。累计调用 {deleteKey?.callCount ?? 0} 次。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
              onClick={() => {
                if (deleteKey) deleteMutation.mutate(deleteKey.id)
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ViewPage>
  )
}
