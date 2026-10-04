/**
 * 中间件公开豁免前缀单元测试（A08）
 *
 * 覆盖回归：v1.10 引入面板鉴权后，/api/metrics 与 /api/system/health 曾被 401 拦截
 * （A03/A04）。SEC-002 进一步拆分：/api/system/health 改需鉴权（暴露内部状态），
 * 公开探活迁到 /api/system/health/live（仅 {ok:true}）。本测试固化豁免清单。
 */
import { test, expect } from 'bun:test'
import { isPublicApiPath } from '@/middleware'

const PUBLIC_EXACT = ['/api/auth', '/api/input', '/api/system/health/live', '/api/metrics']
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
  // /api/system/healthz 不应被 /api/system/health/live 豁免（精确 + 子段）
  expect(isPublicApiPath('/api/system/healthz')).toBe(false)
  // SEC-002：/api/system/health（详细聚合）现需鉴权，不应被豁免
  expect(isPublicApiPath('/api/system/health')).toBe(false)
})

test('SEC-002：/api/system/health/live 公开探针应放行', () => {
  expect(isPublicApiPath('/api/system/health/live')).toBe(true)
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
