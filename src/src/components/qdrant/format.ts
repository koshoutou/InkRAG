/** Small formatting helpers shared by components. */
export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—'
  return n.toLocaleString('en-US')
}

export function formatBytes(n: number | undefined | null): string {
  if (!n) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`
}

export function truncate(s: string, n: number): string {
  if (!s) return ''
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

export function shortId(id: string | number): string {
  const s = String(id)
  if (s.length <= 12) return s
  return s.slice(0, 6) + '…' + s.slice(-4)
}
