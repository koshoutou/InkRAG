'use client'

// Agent API：入库 API 文档卡 + Dify 兼容占位卡 + Key 管理（创建一次性展示 / 启停 / 删除）
// §32（Task 17-1）：对外检索 API 已移除——本平台定位为知识库管理（入库 / 切分 / 版本 / 备份），
// 检索由外部平台承担；/api/input（契约 §33）为对外唯一入库入口。

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Blocks,
  BookOpen,
  Copy,
  KeyRound,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UploadCloud,
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
import { ApiDocsDialog } from './ApiDocsDialog'

const ROLE_META: Record<ApiKeyRole, { label: string; badge: string; desc: string }> = {
  admin: { label: 'admin', badge: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300', desc: '全部权限：入库 / 管理 / 高级参数' },
  operator: { label: 'operator', badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300', desc: '入库 + 高级参数' },
  readonly: { label: 'readonly', badge: 'border-stone-400/40 bg-stone-500/10 text-stone-600 dark:text-stone-300', desc: '只读（不允许写入操作）' },
}

/** 路径徽标（等宽字体） */
function PathBadge({ children, className }: { children: string; className?: string }) {
  return (
    <code
      className={cn(
        'inline-flex max-w-full items-center overflow-hidden rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground',
        className,
      )}
    >
      {children}
    </code>
  )
}

export function ApiKeysView() {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<ApiKeyRole>('readonly')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [deleteKey, setDeleteKey] = useState<ApiKeyItem | null>(null)
  const [docsOpen, setDocsOpen] = useState(false)
  const [difyDocsOpen, setDifyDocsOpen] = useState(false)

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
            入库 API 入口与 API Key 管理；本平台定位为知识库管理（入库 / 切分 / 版本 / 备份），检索由外部平台承担（§32）。
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          新建 API Key
        </Button>
      </div>

      {/* 入库 API 文档卡 + Dify 兼容占位卡（§33；Dify 卡由 17-3 接管） */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="border-border/60 lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              <UploadCloud className="h-4 w-4 text-emerald-500" />
              入库 API
              <PathBadge>/api/input</PathBadge>
              <Badge variant="secondary" className="ml-auto text-[10px]">供 AI Agent 调用</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <div className="mb-1 font-medium">鉴权 Bearer</div>
                <p className="leading-relaxed text-muted-foreground">
                  所有端点（除文档）需 <code className="rounded bg-muted px-1 font-mono text-[10.5px]">Authorization: Bearer &lt;ApiKey&gt;</code>；readonly 角色仅可读，写入 403。
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <div className="mb-1 font-medium">并发语义</div>
                <p className="leading-relaxed text-muted-foreground">
                  多文件并发入库互不影响；流水线并发 2、MinerU 等待不占槽；同内容（sha256）秒传去重；失败自动重试 3 次。
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <div className="mb-1 font-medium">引擎与文件类型</div>
                <p className="leading-relaxed text-muted-foreground">
                  <code className="rounded bg-muted px-1 font-mono text-[10.5px]">engine</code> 可选 mineru / node / 智能路由；30 种扩展名（pdf · docx · md · 图片…），单文件 200MB。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" className="gap-1.5" onClick={() => setDocsOpen(true)}>
                <BookOpen className="h-3.5 w-3.5" />
                查看完整 API 文档
              </Button>
              <PathBadge className="text-[10.5px]">GET /api/input/docs</PathBadge>
              <span className="text-[11px] text-muted-foreground">建库 · 上传 · 文本入库 · 状态轮询 · 重试 · 删除</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60 lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              <Blocks className="h-4 w-4 text-teal-500" />
              Dify 兼容数据集 API
              <PathBadge>/v1/datasets</PathBadge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              对接 MinerU 面板「导出到 Dify」：API 服务器地址填本平台根地址（勿带 /v1）、API 密钥填平台 API Key——检查链接 / 选择导出位置 / 高级配置（段落分隔符 + 每段最大 token）全部原生兼容。
            </p>
            <div className="mt-auto flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDifyDocsOpen(true)}>
                <BookOpen className="h-3.5 w-3.5" />
                查看对接文档
              </Button>
              <Badge variant="outline" className="border-teal-500/40 bg-teal-500/10 text-[10px] text-teal-600 dark:text-teal-300">
                MinerU 面板可用
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Key 管理表 */}
      <Card className="border-border/60">
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

      {/* 入库 API 完整文档（数据源 /api/input/docs） */}
      <ApiDocsDialog
        open={docsOpen}
        onOpenChange={setDocsOpen}
        title="入库 API 文档"
        description="POST /api/input/** · 鉴权 Bearer · 建库 / 上传 / 轮询 / 重试 / 删除"
        src="/api/input/docs"
      />

      {/* Dify 兼容层对接文档（数据源 /api/input/docs?file=dify-compat，Task 17-3） */}
      <ApiDocsDialog
        open={difyDocsOpen}
        onOpenChange={setDifyDocsOpen}
        title="Dify 兼容数据集 API · 对接文档"
        description="/v1/datasets/** · MinerU 面板「导出到 Dify」直接填本平台地址与 Key"
        src="/api/input/docs?file=dify-compat"
      />

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
