'use client'

// 面板登录遮罩（审计 F-E2E-01 前端侧）
// 未登录 / 会话过期时全屏接管：密码输入 → POST /api/auth/login → 成功后整页刷新
// （刷新让全部 query 重拉、socket 以新票据重连，避免逐个失效状态修补）。

import { useEffect, useRef, useState } from 'react'
import { Database, KeyRound, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ragApi } from './api'

export function LoginOverlay({ reason }: { reason?: 'expired' }) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!password.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await ragApi.panelLogin(password)
      toast.success('登录成功，正在进入面板…')
      window.location.reload()
    } catch (err) {
      setError((err as Error).message || '登录失败')
      setPassword('')
      inputRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-background to-muted/40 px-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="panel-login-title"
    >
      <div className="w-full max-w-sm">
        {/* 品牌区 */}
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
            <Database className="h-6 w-6" />
          </div>
          <div>
            <h1 id="panel-login-title" className="text-base font-semibold tracking-tight">
              InkRAG 知识库管理平台
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">请输入面板访问密码继续</p>
          </div>
        </div>

        {/* 登录卡片 */}
        <form
          onSubmit={submit}
          className="space-y-4 rounded-xl border border-border/60 bg-background p-5 shadow-sm"
        >
          <div className="space-y-1.5">
            <Label htmlFor="panel-password" className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <KeyRound className="h-3.5 w-3.5" /> 面板密码
            </Label>
            <Input
              id="panel-password"
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              disabled={submitting}
              className="h-9"
              aria-invalid={Boolean(error)}
            />
          </div>

          {reason === 'expired' && (
            <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              会话已过期或已在其他位置登出，请重新登录。
            </p>
          )}
          {error && (
            <p className="flex items-start gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-rose-600 dark:text-rose-400" role="alert">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}

          <Button type="submit" className="h-9 w-full gap-1.5 text-xs" disabled={submitting || !password.trim()}>
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在验证…
              </>
            ) : (
              <>
                <ShieldCheck className="h-3.5 w-3.5" /> 登录面板
              </>
            )}
          </Button>

          <p className="text-center text-[10px] leading-relaxed text-muted-foreground">
            面板密码在「设置 → 面板安全」中修改；连续失败 5 次将锁定 30 秒。
          </p>
        </form>
      </div>
    </div>
  )
}
