/**
 * SSRF 防护共享模块（SEC-002：从 /api/kb/[id]/import-url 抽取，供 settings 等路由复用）
 *
 * 提供 assertPublicHttpUrl(u: URL)：校验目标 URL 可安全访问——
 *   1. 协议白名单 http/https；禁止 userinfo（http://user:pass@host）
 *   2. 主机名后缀黑名单（localhost/.local/.internal）
 *   3. IP 直连 → 私网/保留段判定；域名 → DNS lookup({all:true}) 解析全部 IP 逐一校验
 *      （DNS rebinding 缓解：至少校验解析结果；fetch 时的二次解析窗口为本方案的已知边界）
 *
 * 抛出 SsrfError 表示请求本身不合法（调用方应回 400）；
 * 抛出普通 Error 表示 DNS 解析失败等非安全类错误（调用方按需处理）。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** SSRF 拒绝（调用方应回 400）；其它抓取错误（DNS 失败等）走普通 Error */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

/** 点分十进制 → 无符号 32 位整数（非法返回 null） */
function ipv4ToLong(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n >>> 0
}

function inCidr4(ipLong: number, cidr: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipLong & mask) === (ipv4ToLong(cidr)! & mask)
}

/** IPv4 私网/保留段黑名单 */
function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToLong(ip)
  if (n === null) return true // 解析失败按私网处理（保守拒绝）
  return (
    inCidr4(n, '0.0.0.0', 8) || // 0.0.0.0/8（"任意地址"，常被解析到本机）
    inCidr4(n, '10.0.0.0', 8) || // 10/8 私网
    inCidr4(n, '100.64.0.0', 10) || // 100.64/10 CGNAT（云商内部网络）
    inCidr4(n, '127.0.0.0', 8) || // 127/8 环回
    inCidr4(n, '169.254.0.0', 16) || // 169.254/16 链路本地（含云元数据 169.254.169.254）
    inCidr4(n, '172.16.0.0', 12) || // 172.16/12 私网
    inCidr4(n, '192.168.0.0', 16) || // 192.168/16 私网
    inCidr4(n, '192.0.2.0', 24) || // 192.0.2/24 TEST-NET（文档示例段）
    inCidr4(n, '198.18.0.0', 15) || // 198.18/15 基准测试段
    inCidr4(n, '224.0.0.0', 4) || // 224/4 组播
    inCidr4(n, '240.0.0.0', 4) // 240/4 保留（含 255.255.255.255 广播）
  )
}

/** IPv6 私网/保留段（含 IPv4-mapped ::ffff:a.b.c.d 透传校验） */
function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase()
  if (addr === '::' || addr === '::1') return true // 未指定 / 环回
  // IPv4-mapped：::ffff:a.b.c.d 或 ::ffff:hex 形式 → 按 IPv4 再判
  const mapped =
    addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/) ||
    addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mapped) {
    if (mapped[0].includes('.')) return isPrivateIPv4(mapped[1])
    // hex 形式：低 32 位按 IPv4 展开
    const hi = Number.parseInt(mapped[1], 16)
    const lo = Number.parseInt(mapped[2], 16)
    return isPrivateIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)
  }
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true // fc00::/7 唯一本地（ULA）
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true // fe80::/10 链路本地
  if (/^::ffff:0:0/.test(addr)) return true // ::ffff:0:0/96 兼容映射段
  return false
}

function isPrivateIpLiteral(ip: string): boolean {
  const t = isIP(ip)
  if (t === 4) return isPrivateIPv4(ip)
  if (t === 6) return isPrivateIPv6(ip)
  return true // 不是合法 IP 字面量 → 保守拒绝
}

/**
 * 校验目标 URL 可安全访问。抛 SsrfError 表示 SSRF 拒绝（调用方回 400）。
 *
 * 用于：
 *   - /api/kb/[id]/import-url 抓取外链文档
 *   - /api/qdrant/settings PUT 保存管理员配置的 qdrant.url / mineruApiUrl / embedApiBase / rerankApiBase
 */
export async function assertPublicHttpUrl(u: URL): Promise<void> {
  if (!/^https?:$/.test(u.protocol)) {
    throw new SsrfError('仅支持 http/https 协议的 URL')
  }
  if (u.username || u.password) {
    throw new SsrfError('不允许携带用户名/密码的 URL（userinfo 形式）')
  }
  // URL.hostname 对 IPv6 自带 [] 括号，统一剥离
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new SsrfError(`目标主机 ${u.hostname} 属于本地/内网域名，已拒绝（SSRF 防护）`)
  }

  const ipType = isIP(host)
  if (ipType !== 0) {
    if (isPrivateIpLiteral(host)) {
      throw new SsrfError(`目标地址 ${u.hostname} 是内网/保留 IP，已拒绝（SSRF 防护）`)
    }
    return
  }

  // 域名：解析全部 A/AAAA 记录逐一校验（任一命中私网即拒绝）
  let addrs: { address: string; family: number }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new Error(`目标域名 ${u.hostname} DNS 解析失败`)
  }
  if (addrs.length === 0) {
    throw new Error(`目标域名 ${u.hostname} 未解析到任何 IP`)
  }
  const bad = addrs.find((a) => isPrivateIpLiteral(a.address))
  if (bad) {
    throw new SsrfError(`目标域名 ${u.hostname} 解析到内网/保留 IP ${bad.address}，已拒绝（SSRF 防护）`)
  }
}

/** 便捷封装：校验字符串形态的 URL，返回解析后的 URL 或抛 SsrfError/Error */
export async function parsePublicHttpUrl(raw: string): Promise<URL> {
  const target = new URL(raw)
  await assertPublicHttpUrl(target)
  return target
}
