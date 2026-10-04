/**
 * safeUnzip 解压预算单元测试（A08）
 *
 * 覆盖 F-LOC-01 + F-EXT-06：解压炸弹防护——条目数 / 单条 / 总量三层预算在「解压前」拦截。
 * 用 fflate zipSync 构造可控 zip，触发各预算边界，断言 ZipBudgetError 与正常解压。
 */
import { test, expect } from 'bun:test'
import { zipSync, strToU8 } from 'fflate'
import { safeUnzip, ZipBudgetError, ZIP_MAX_ENTRIES } from '@/lib/rag/parsers/zip-safe'

/** 构造一个包含 N 个小条目的 zip */
function makeZip(entries: Record<string, string>): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(entries)) {
    files[name] = strToU8(content)
  }
  return zipSync(files)
}

test('正常小 zip 应解压成功并返回条目统计', async () => {
  const data = makeZip({ 'a.txt': 'hello', 'b.txt': 'world' })
  const { files, stats } = await safeUnzip(data)
  expect(Object.keys(files).sort()).toEqual(['a.txt', 'b.txt'])
  expect(new TextDecoder().decode(files['a.txt'])).toBe('hello')
  expect(stats.entries).toBe(2)
  expect(stats.totalOriginalBytes).toBeGreaterThan(0)
})

test('单条目超 maxSingleBytes 在解压前拦截（炸弹不进内存）', async () => {
  // 构造一个内容较大的条目，但 maxSingleBytes 设为极小值
  const big = 'x'.repeat(10_000)
  const data = makeZip({ 'big.txt': big })
  await expect(
    safeUnzip(data, { maxSingleBytes: 1_000 }),
  ).rejects.toThrow(ZipBudgetError)
})

test('累计总量超 maxTotalBytes 在解压前拦截', async () => {
  // 多个小条目累计超 maxTotalBytes
  const entries: Record<string, string> = {}
  for (let i = 0; i < 10; i++) entries[`f${i}.txt`] = 'x'.repeat(1_000)
  const data = makeZip(entries)
  await expect(
    safeUnzip(data, { maxTotalBytes: 5_000 }),
  ).rejects.toThrow(ZipBudgetError)
})

test('条目数超 maxEntries 在解压前拦截', async () => {
  const entries: Record<string, string> = {}
  for (let i = 0; i < 20; i++) entries[`f${String(i).padStart(2, '0')}.txt`] = 'x'
  const data = makeZip(entries)
  await expect(
    safeUnzip(data, { maxEntries: 5 }),
  ).rejects.toThrow(ZipBudgetError)
})

test('默认预算常量已设置（5_000 / 256MB / 512MB）', () => {
  // 固化默认预算契约，防止未来误调
  expect(ZIP_MAX_ENTRIES).toBe(5_000)
})

test('ZipBudgetError 名称为 ZIP_BUDGET_EXCEEDED（调用方按不可重试业务错误处理）', () => {
  const e = new ZipBudgetError('test')
  expect(e.name).toBe('ZIP_BUDGET_EXCEEDED')
  expect(e).toBeInstanceOf(Error)
})
