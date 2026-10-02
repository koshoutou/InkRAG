/**
 * 仪表盘检索质量趋势（契约 §14，数据源 QdrantCallLog）
 *
 * 聚合口径：
 *   days        = 请求窗口天数（clamp 1-90，默认 14），UTC 日历日对齐（含今日，共 N 天）
 *   days 序列   = 每日聚合 + **空日补零**（保证前端时间轴连续，升序返回）
 *   p95Ms       = 当日 tookMs 升序后取 95 分位索引（floor(0.95*n) 且 clamp 到 n-1）
 *   zeroRate    = 全期 resultCount=0 次数 / 全期检索次数（0 除保护）
 *   topQueries  = query 非空分组 Top 10（count 降序，并列按最近时间降序）
 *   source      = 该 query 出现次数最多的来源（并列取先出现者）
 */
import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// 契约 §14 类型（服务端版本，与前端 src/components/rag/types.ts 对齐）
// ---------------------------------------------------------------------------

export interface TrendDay {
  /** yyyy-MM-dd */
  date: string
  /** 当日检索次数 */
  searches: number
  /** 平均耗时 ms */
  avgMs: number
  /** P95 耗时 ms */
  p95Ms: number
  /** 平均结果数 */
  avgResults: number
  /** 空结果次数（resultCount=0） */
  zeroResults: number
}

export interface TopQueryItem {
  query: string
  count: number
  avgMs: number
  avgResults: number
  lastAt: string
  /** 主要来源：debug-console | external | web-ui */
  source: string
}

export interface ModeBreakdownItem {
  mode: string
  count: number
  avgMs: number
}

export interface DashboardTrendsResult {
  /** 最近 N 天（含空日补零），升序（旧 → 新） */
  days: TrendDay[]
  topQueries: TopQueryItem[]
  modeBreakdown: ModeBreakdownItem[]
  totals: { searches: number; avgMs: number; p95Ms: number; zeroRate: number }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** UTC yyyy-MM-dd（本地时区按 UTC 计算即可，契约约定） */
function utcDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** P95：升序取 95 分位索引（至少 1 条才算） */
function percentile95(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * 0.95))
  return Math.round(sortedAsc[idx])
}

function avg(values: number[]): number {
  if (values.length === 0) return 0
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}

// ---------------------------------------------------------------------------
// 主聚合
// ---------------------------------------------------------------------------

const MODE_ORDER = ['hybrid', 'dense', 'sparse']

export async function getDashboardTrends(
  rawDays: number,
  opts: { kbId?: string } = {},
): Promise<DashboardTrendsResult> {
  const days = Math.min(90, Math.max(1, Math.floor(Number.isFinite(rawDays) ? rawDays : 14) || 14))

  // KB 维度过滤：kbId → 集合名（查不到 KB 时返回空趋势而非报错）
  let collectionFilter: string | null = null
  if (opts.kbId) {
    const kb = await db.knowledgeBase.findUnique({
      where: { id: opts.kbId },
      select: { collection: true },
    })
    collectionFilter = kb?.collection ?? '__nonexistent__'
  }

  // 窗口：最近 N 个 UTC 日历日（含今日），[start, end)
  const now = new Date()
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const start = new Date(todayStart - (days - 1) * 86_400_000)
  const end = new Date(todayStart + 86_400_000)

  const rows = await db.qdrantCallLog.findMany({
    where: {
      createdAt: { gte: start, lt: end },
      ...(collectionFilter ? { collection: collectionFilter } : {}),
    },
    select: { source: true, query: true, mode: true, tookMs: true, resultCount: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  // ---- 按日聚合（空日补零） ----
  interface DayBucket {
    tookMs: number[]
    resultSum: number
    zero: number
  }
  const buckets = new Map<string, DayBucket>()
  for (const r of rows) {
    const key = utcDateKey(r.createdAt)
    let b = buckets.get(key)
    if (!b) {
      b = { tookMs: [], resultSum: 0, zero: 0 }
      buckets.set(key, b)
    }
    b.tookMs.push(r.tookMs)
    b.resultSum += r.resultCount
    if (r.resultCount === 0) b.zero += 1
  }

  const dayList: TrendDay[] = []
  for (let i = 0; i < days; i++) {
    const date = utcDateKey(new Date(todayStart - (days - 1 - i) * 86_400_000))
    const b = buckets.get(date)
    if (!b) {
      dayList.push({ date, searches: 0, avgMs: 0, p95Ms: 0, avgResults: 0, zeroResults: 0 })
    } else {
      dayList.push({
        date,
        searches: b.tookMs.length,
        avgMs: avg(b.tookMs),
        p95Ms: percentile95([...b.tookMs].sort((a, z) => a - z)),
        avgResults: Math.round(b.resultSum / b.tookMs.length),
        zeroResults: b.zero,
      })
    }
  }

  // ---- 热门查询 Top 10（query 非空） ----
  interface QueryBucket {
    count: number
    tookSum: number
    resultSum: number
    lastAt: Date
    sources: Map<string, number>
  }
  const queryBuckets = new Map<string, QueryBucket>()
  for (const r of rows) {
    const q = r.query?.trim()
    if (!q) continue
    let b = queryBuckets.get(q)
    if (!b) {
      b = { count: 0, tookSum: 0, resultSum: 0, lastAt: r.createdAt, sources: new Map() }
      queryBuckets.set(q, b)
    }
    b.count += 1
    b.tookSum += r.tookMs
    b.resultSum += r.resultCount
    if (r.createdAt > b.lastAt) b.lastAt = r.createdAt
    b.sources.set(r.source, (b.sources.get(r.source) ?? 0) + 1)
  }

  const topQueries: TopQueryItem[] = [...queryBuckets.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].lastAt.getTime() - a[1].lastAt.getTime())
    .slice(0, 10)
    .map(([query, b]) => {
      // 该 query 出现最多的 source（并列取 Map 中先达到最大者）
      let source = ''
      let best = -1
      for (const [src, n] of b.sources) {
        if (n > best) {
          best = n
          source = src
        }
      }
      return {
        query,
        count: b.count,
        avgMs: Math.round(b.tookSum / b.count),
        avgResults: Math.round(b.resultSum / b.count),
        lastAt: b.lastAt.toISOString(),
        source,
      }
    })

  // ---- 模式分布（固定 hybrid/dense/sparse 顺序，其余按 count 降序附加） ----
  const modeAgg = new Map<string, { count: number; tookSum: number }>()
  for (const r of rows) {
    const m = r.mode || 'hybrid'
    let b = modeAgg.get(m)
    if (!b) {
      b = { count: 0, tookSum: 0 }
      modeAgg.set(m, b)
    }
    b.count += 1
    b.tookSum += r.tookMs
  }
  const fixed = MODE_ORDER.filter((m) => modeAgg.has(m)).map((m) => toModeItem(m, modeAgg.get(m)!))
  const extra = [...modeAgg.entries()]
    .filter(([m]) => !MODE_ORDER.includes(m))
    .sort((a, b) => b[1].count - a[1].count)
    .map(([m, b]) => toModeItem(m, b))
  const modeBreakdown: ModeBreakdownItem[] = [...fixed, ...extra]

  // ---- 全期汇总 ----
  const tookAll = rows.map((r) => r.tookMs)
  const searches = rows.length
  const zeroTotal = rows.reduce((acc, r) => acc + (r.resultCount === 0 ? 1 : 0), 0)

  return {
    days: dayList,
    topQueries,
    modeBreakdown,
    totals: {
      searches,
      avgMs: avg(tookAll),
      p95Ms: percentile95([...tookAll].sort((a, z) => a - z)),
      zeroRate: searches > 0 ? Math.round((zeroTotal / searches) * 10000) / 10000 : 0,
    },
  }
}

function toModeItem(mode: string, b: { count: number; tookSum: number }): ModeBreakdownItem {
  return { mode, count: b.count, avgMs: Math.round(b.tookSum / b.count) }
}
