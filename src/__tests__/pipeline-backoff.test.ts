/**
 * 流水线重试退避单元测试（A08）
 *
 * 覆盖 F-CONC-01：retryBackoffMs 退避序列 2s/8s/30s + 0-1s 抖动。
 * 固化边界：attempts 上界封顶 30s，下界 1，抖动区间 [0, 1000)。
 */
import { test, expect } from 'bun:test'
import { retryBackoffMs, RETRY_BACKOFF_BASE_MS } from '@/lib/rag/pipeline'

test('退避基础序列为 2s / 8s / 30s（F-CONC-01 契约）', () => {
  expect(RETRY_BACKOFF_BASE_MS).toEqual([2_000, 8_000, 30_000])
})

test('attempts=1 → 2s + jitter', () => {
  for (let i = 0; i < 50; i++) {
    const v = retryBackoffMs(1)
    expect(v).toBeGreaterThanOrEqual(2_000)
    expect(v).toBeLessThan(3_000) // 2_000 + [0,1000)
  }
})

test('attempts=2 → 8s + jitter', () => {
  for (let i = 0; i < 50; i++) {
    const v = retryBackoffMs(2)
    expect(v).toBeGreaterThanOrEqual(8_000)
    expect(v).toBeLessThan(9_000)
  }
})

test('attempts≥3 → 30s + jitter（封顶）', () => {
  for (const a of [3, 4, 5, 10, 100]) {
    for (let i = 0; i < 20; i++) {
      const v = retryBackoffMs(a)
      expect(v).toBeGreaterThanOrEqual(30_000)
      expect(v).toBeLessThan(31_000)
    }
  }
})

test('attempts≤0 应按 1 处理（Math.max 兜底）', () => {
  for (const a of [0, -1, -100]) {
    const v = retryBackoffMs(a)
    expect(v).toBeGreaterThanOrEqual(2_000)
    expect(v).toBeLessThan(3_000)
  }
})

test('抖动有随机性（多次调用至少出现 2 个不同值）', () => {
  const seen = new Set<number>()
  for (let i = 0; i < 100; i++) seen.add(retryBackoffMs(1))
  // 50 次 2s 槽位理论上应至少出现若干不同抖动值；放宽到 ≥2 防极端伪随机退化
  expect(seen.size).toBeGreaterThanOrEqual(2)
})
