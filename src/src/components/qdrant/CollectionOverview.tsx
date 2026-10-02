'use client'

import { Database, Layers, Boxes, Sparkles, Hash, FileText, Key, Cpu, AlertCircle, PieChart } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api } from './api'
import { useQdrantStore } from './store'
import { formatNumber } from './format'

export function CollectionOverview() {
  const name = useQdrantStore((s) => s.activeCollection)!
  const { data, isLoading, error } = useQuery({
    queryKey: ['collection', name],
    queryFn: () => api.getCollection(name),
    enabled: !!name,
  })

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
        <Skeleton className="h-64 sm:col-span-2 lg:col-span-4 rounded-xl" />
      </div>
    )
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>加载集合信息失败</AlertTitle>
        <AlertDescription>{String((error as Error).message)}</AlertDescription>
      </Alert>
    )
  }
  if (!data) return null

  // Compute payload field type distribution for the small chart.
  const payloadTypeStats: Record<string, number> = {}
  for (const f of data.payload_fields) {
    const t = f.type || 'unknown'
    payloadTypeStats[t] = (payloadTypeStats[t] || 0) + 1
  }
  const totalPayloadFields = data.payload_fields.length

  return (
    <div className="space-y-4">
      {/* stat cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<Hash className="h-4 w-4" />} label="总点数 (points_count)" value={formatNumber(data.points_count)} hint={`已索引向量: ${formatNumber(data.indexed_vectors_count)}`} accent="primary" />
        <StatCard icon={<Layers className="h-4 w-4" />} label="段数 (segments)" value={formatNumber(data.segments_count)} hint={`分片: ${data.shard_number} · 副本: ${data.replication_factor}`} accent="cyan" />
        <StatCard icon={<Boxes className="h-4 w-4" />} label="向量类型" value={data.type.split(' ')[0]} hint={data.type} accent="amber" />
        <StatCard
          icon={<Sparkles className="h-4 w-4" />}
          label="优化器状态"
          value={data.optimizer_status}
          hint={`集合状态: ${data.status}`}
          accent={data.status === 'green' ? 'emerald' : 'rose'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Vector config — spans 2/3 */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Cpu className="h-4 w-4 text-primary" />
              向量配置
            </CardTitle>
            <CardDescription className="text-xs">
              此集合包含的稠密 / 稀疏向量字段，及其维度与距离度量
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.dense_vectors.map((v, i) => (
              <div key={v.name ?? i} className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono text-[10px]">dense</Badge>
                  <span className="text-xs font-medium">{v.name ?? '(默认)'}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{v.size}d</span>
                  <span>·</span>
                  <span className="font-mono">{v.distance}</span>
                </div>
              </div>
            ))}
            {data.sparse_vectors.map((name) => (
              <div key={name} className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="font-mono text-[10px]">sparse</Badge>
                  <span className="text-xs font-medium">{name}</span>
                </div>
                <span className="text-xs text-muted-foreground">稀疏向量</span>
              </div>
            ))}
            {data.on_disk_payload && (
              <p className="text-[11px] text-muted-foreground">Payload 存储在磁盘 (on_disk_payload)</p>
            )}
          </CardContent>
        </Card>

        {/* Payload schema summary — 1/3 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-primary" />
              Payload 字段
            </CardTitle>
            <CardDescription className="text-xs">
              {totalPayloadFields} 个字段 · 类型分布见下方
            </CardDescription>
          </CardHeader>
          <CardContent>
            {totalPayloadFields === 0 ? (
              <p className="text-xs text-muted-foreground">未发现 payload_schema（可能是较旧版本的 Qdrant）</p>
            ) : (
              <>
                {/* Type distribution mini-chart */}
                <div className="mb-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <PieChart className="h-3 w-3" />
                    字段类型分布
                  </div>
                  <PayloadTypeBar stats={payloadTypeStats} total={totalPayloadFields} />
                </div>
                <ScrollArea className="max-h-56">
                  <div className="space-y-1.5 pr-2">
                    {data.payload_fields.map((f) => (
                      <div key={f.field} className="flex items-center justify-between rounded-md border bg-muted/20 px-2.5 py-1.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <Key className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="truncate font-mono text-xs" title={f.field}>{f.field}</span>
                          {f.indexed && <Badge variant="secondary" className="h-4 px-1 text-[10px]">idx</Badge>}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-mono">{f.type}</span>
                          <span>·</span>
                          <span>{formatNumber(f.points)} pts</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Advanced config */}
      <Accordion type="single" collapsible className="rounded-xl border bg-card">
        <AccordionItem value="adv" className="border-b-0">
          <AccordionTrigger className="px-4 py-3 text-sm font-medium">
            <span className="flex items-center gap-2">
              <Database className="h-4 w-4" />
              高级配置（HNSW · 量化 · 原始响应）
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">HNSW 配置</p>
                <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed font-mono">
{JSON.stringify(data.hnsw ?? {}, null, 2)}
                </pre>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">量化配置</p>
                <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed font-mono">
{JSON.stringify(data.quantization ?? null, null, 2)}
                </pre>
              </div>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                原始 Qdrant 响应
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed font-mono">
{JSON.stringify(data.raw ?? {}, null, 2)}
              </pre>
            </details>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}

function StatCard({ icon, label, value, hint, accent = 'primary' }: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  hint?: string
  accent?: 'primary' | 'cyan' | 'amber' | 'emerald' | 'rose'
}) {
  const accentMap: Record<string, string> = {
    primary: 'bg-primary/10 text-primary ring-primary/15',
    cyan: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 ring-cyan-500/15',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/15',
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/15',
    rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 ring-rose-500/15',
  }
  return (
    <Card className="overflow-hidden transition-colors hover:border-primary/30">
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <div className={`flex h-7 w-7 items-center justify-center rounded-md ring-1 ${accentMap[accent]}`}>
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] text-muted-foreground">{label}</p>
            <p className="truncate text-base font-semibold tracking-tight">{value}</p>
          </div>
        </div>
        {hint && <p className="mt-2 text-[10px] text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}

/** Stacked horizontal bar showing payload field type distribution. */
function PayloadTypeBar({ stats, total }: { stats: Record<string, number>; total: number }) {
  const colors: Record<string, string> = {
    keyword: 'bg-violet-500',
    integer: 'bg-emerald-500',
    float: 'bg-amber-500',
    bool: 'bg-rose-500',
    text: 'bg-primary',
    geo: 'bg-cyan-500',
    object: 'bg-slate-400',
    unknown: 'bg-muted-foreground',
  }
  const entries = Object.entries(stats).sort((a, b) => b[1] - a[1])
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {entries.map(([type, count]) => (
          <div
            key={type}
            className={colors[type] ?? colors.unknown}
            style={{ width: `${(count / total) * 100}%` }}
            title={`${type}: ${count}`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {entries.map(([type, count]) => (
          <div key={type} className="flex items-center gap-1 text-[10px]">
            <span className={`inline-block h-2 w-2 rounded-sm ${colors[type] ?? colors.unknown}`} />
            <span className="font-mono">{type}</span>
            <span className="text-muted-foreground">{count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
