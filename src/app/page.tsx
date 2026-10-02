'use client'

import dynamic from 'next/dynamic'

// RAG 知识库平台主入口（单页应用，客户端视图切换）
const PlatformApp = dynamic(() => import('@/components/rag/PlatformApp'), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
          <span className="h-4 w-4 animate-pulse rounded-full bg-primary" />
        </div>
        <span className="text-xs">RAG 知识库平台加载中…</span>
      </div>
    </div>
  ),
})

export default function Home() {
  return <PlatformApp />
}
