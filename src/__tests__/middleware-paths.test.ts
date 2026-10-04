/**
 * 中间件公开豁免前缀单元测试（A08）
 *
 * 覆盖回归：v1.10 引入面板鉴权后，/api/metrics 与 /api/system/health 曾被 401 拦截
 * （A03/A04）。本测试固化豁免清单，防止未来重构再次漏配运维端点。
 */
import { test, expect } from 'bun:test'
import { isPublicApiPath } from '@/middleware'

const PUBLIC_EXACT = ['/api/auth', '/api/input', '/api/system/health', '/api/metrics']
const PROTECTED_SAMPLES = [
  '/api/kb',
  '/api/documents',
  '/api/apikeys',
  '/api/system/resources',
  '/api/system/oplogs',
  '/api/system/backups',
  '/api/system/jobs',
  '/api/dashboard',
  '/api/qdrant',
  '/api/activity',
]

test('豁免清单内的精确路径应放行（A03/A04 回归保护）', () => {
  for (const p of PUBLIC_EXACT) {
    expect(isPublicApiPath(p)).toBe(true)
  }
})

test('豁免前缀的子路径应放行（带尾斜杠或段）', () => {
  expect(isPublicApiPath('/api/auth/login')).toBe(true)
  expect(isPublicApiPath('/api/auth/session')).toBe(true)
  expect(isPublicApiPath('/api/input/docs')).toBe(true)
  expect(isPublicApiPath('/api/input/')).toBe(true)
})

test('前缀匹配不应误判：/api/authx 不应被 /api/auth 豁免', () => {
  // startsWith(p + '/') 的设计正防止「前缀字符串恰好是另一路径前缀段」的误判
  expect(isPublicApiPath('/api/authx')).toBe(false)
  expect(isPublicApiPath('/api/input-thing')).toBe(false)
  expect(isPublicApiPath('/api/metrics-summary')).toBe(false)
  // /api/system/healthz 不应被 /api/system/health 豁免（精确 + 子段）
  expect(isPublicApiPath('/api/system/healthz')).toBe(false)
})

test('管理端点应被拦截（需面板会话）', () => {
  for (const p of PROTECTED_SAMPLES) {
    expect(isPublicApiPath(p)).toBe(false)
  }
})

test('非 /api/ 路径不属中间件管辖（isPublicApiPath 仅判前缀，外层另有 startsWith 判定）', () => {
  // 中间件实际逻辑先判 !pathname.startsWith('/api/') → next，此处仅验证前缀函数本身
  expect(isPublicApiPath('/')).toBe(false)
  expect(isPublicApiPath('/kb/123')).toBe(false)
})
