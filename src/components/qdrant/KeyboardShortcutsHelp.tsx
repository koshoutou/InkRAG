'use client'

import { useEffect, useState } from 'react'
import { Keyboard, X } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { useQdrantStore } from './store'

interface Shortcut {
  keys: string[]
  desc: string
}

const SHORTCUTS: { group: string; items: Shortcut[] }[] = [
  {
    group: '检索召回',
    items: [
      { keys: ['⌘/Ctrl', 'Enter'], desc: '在查询框内触发检索' },
      { keys: ['Esc'], desc: '关闭弹窗 / 抽屉' },
    ],
  },
  {
    group: '导航',
    items: [
      { keys: ['1'], desc: '切换到「概览」tab' },
      { keys: ['2'], desc: '切换到「分块」tab' },
      { keys: ['3'], desc: '切换到「检索召回」tab' },
      { keys: ['4'], desc: '切换到「检索测试日志」tab' },
      { keys: ['g'], desc: '聚焦「过滤集合名」输入框' },
    ],
  },
  {
    group: '视图',
    items: [
      { keys: ['t'], desc: '切换浅色 / 暗色主题' },
      { keys: ['s'], desc: '打开「设置」弹窗' },
      { keys: ['r'], desc: '刷新集合列表' },
      { keys: ['?'], desc: '显示本快捷键面板' },
    ],
  },
]

export function KeyboardShortcutsHelp() {
  const [open, setOpen] = useState(false)
  const setActiveTab = useQdrantStore((s) => s.setActiveTab)
  const setSettingsOpen = useQdrantStore((s) => s.setSettingsOpen)
  const triggerRefresh = useQdrantStore((s) => s.triggerRefreshCollections)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore when typing in form fields, unless modifier is pressed.
      const target = e.target as HTMLElement
      const isFormField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable ||
        target?.getAttribute('role') === 'combobox' ||
        target?.closest('[role="combobox"]')

      // ⌘/Ctrl + Enter always works inside textarea (handled separately).
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return

      if (e.key === '?' && !isFormField) {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      if (isFormField || e.metaKey || e.ctrlKey || e.altKey) return

      switch (e.key.toLowerCase()) {
        case 'escape':
          setOpen(false)
          setSettingsOpen(false)
          break
        case 't':
          e.preventDefault()
          document.documentElement.classList.toggle('dark')
          break
        case 's':
          e.preventDefault()
          setSettingsOpen(true)
          break
        case 'r':
          e.preventDefault()
          triggerRefresh()
          break
        case '1':
          e.preventDefault()
          setActiveTab('overview')
          break
        case '2':
          e.preventDefault()
          setActiveTab('chunks')
          break
        case '3':
          e.preventDefault()
          setActiveTab('retrieval')
          break
        case '4':
          e.preventDefault()
          setActiveTab('logs')
          break
        case 'g': {
          e.preventDefault()
          const el = document.querySelector<HTMLInputElement>('input[placeholder*="过滤集合"]')
          el?.focus()
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setActiveTab, setSettingsOpen, triggerRefresh])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 hidden h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-background/85 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground md:flex"
        title="快捷键 (?)"
      >
        <Keyboard className="h-4 w-4" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg p-0">
          <DialogHeader className="border-b px-5 py-3">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Keyboard className="h-4 w-4 text-primary" />
              键盘快捷键
            </DialogTitle>
            <DialogDescription className="text-xs">
              在任意位置按下对应按键即可触发；输入框内会忽略单字符快捷键。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-5 py-4">
            {SHORTCUTS.map((group) => (
              <div key={group.group}>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {group.group}
                </p>
                <ul className="space-y-1.5">
                  {group.items.map((item) => (
                    <li key={item.desc} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-foreground/90">{item.desc}</span>
                      <div className="flex items-center gap-1">
                        {item.keys.map((k, i) => (
                          <span key={i} className="flex items-center gap-1">
                            <kbd className="rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground shadow-sm">
                              {k}
                            </kbd>
                            {i < item.keys.length - 1 && (
                              <span className="text-[10px] text-muted-foreground">+</span>
                            )}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="rounded-md border bg-muted/20 p-2 text-[11px] text-muted-foreground">
              <Badge variant="secondary" className="mr-1.5 text-[10px]">提示</Badge>
              这些快捷键只在激活了主界面时生效；弹窗内的输入框不会被劫持。
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
