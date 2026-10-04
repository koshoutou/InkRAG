/**
 * API Key 工具函数单元测试（A08）
 *
 * 覆盖纯函数：createKeyHash（sha256 定长 64 hex）、apiKeyColumns（占位符不落明文）、
 * apiKeyPreview（掩码展示）。verifyApiKey 因依赖 Prisma 不在此测试（需集成环境）。
 *
 * 历史问题（审计 #5）：早期明文存储 + 非恒定时间比对；v1.10 改 sha256 + 索引直查，
 * 本测试固化「明文不落库、hash 定长、前缀掩码」契约。
 */
import { test, expect } from 'bun:test'
import { createKeyHash, apiKeyColumns, apiKeyPreview } from '@/lib/rag/apikey'
import { createHash } from 'node:crypto'

test('createKeyHash 返回 sha256 定长 64 位 hex', () => {
  const key = 'rag-test-key-1234567890abcdef'
  const hash = createKeyHash(key)
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
  // 与 node:crypto 直接计算一致
  expect(hash).toBe(createHash('sha256').update(key, 'utf-8').digest('hex'))
})

test('createKeyHash 同输入确定性输出（哈希稳定）', () => {
  const key = 'same-key'
  expect(createKeyHash(key)).toBe(createKeyHash(key))
})

test('createKeyHash 不同输入产生不同哈希', () => {
  expect(createKeyHash('key-a')).not.toBe(createKeyHash('key-b'))
})

test('apiKeyColumns: key 列存占位符 sha256:<hash 前 16 位>，明文不落库', () => {
  const key = 'rag-mykey-1234567890'
  const cols = apiKeyColumns(key)
  expect(cols.keyHash).toBe(createKeyHash(key))
  expect(cols.keyPrefix).toBe(key.slice(0, 12))
  // 占位符格式：sha256: + hash 前 16 位（保留 unique 约束，明文不出现）
  expect(cols.key).toMatch(/^sha256:[0-9a-f]{16}$/)
  expect(cols.key).not.toContain(key)
})

test('apiKeyColumns: key 列占位符与 hash 前 16 位一致', () => {
  const key = 'another-key-xyz'
  const cols = apiKeyColumns(key)
  const hash = createKeyHash(key)
  expect(cols.key).toBe(`sha256:${hash.slice(0, 16)}`)
})

test('apiKeyPreview: 优先用 keyPrefix 展示', () => {
  expect(apiKeyPreview({ key: 'whatever', keyPrefix: 'rag-mykey123' })).toBe('rag-mykey123…')
})

test('apiKeyPreview: keyPrefix 为空时回退旧格式（前8…后4）', () => {
  const longLegacy = 'legacy-plaintext-key-very-long-1234567890'
  expect(apiKeyPreview({ key: longLegacy, keyPrefix: '' })).toBe('legacy-p…7890')
})

test('apiKeyPreview: 短明文（≤12）直接展示', () => {
  expect(apiKeyPreview({ key: 'short', keyPrefix: '' })).toBe('short')
})
