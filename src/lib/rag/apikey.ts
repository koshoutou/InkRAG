/**
 * Agent API Key 安全校验（Task 15-b / 审计 #5：明文存储 + 非恒定时间比对）
 *
 * 存储策略：
 *   - 新建 key：keyHash = sha256(key)（64 位定长 hex）+ keyPrefix（前 12 位，UI 掩码展示），
 *     key 列仅存占位符 `sha256:<hash 前 16 位>`（保留 unique 约束，明文不落库，仅在创建响应返回一次）
 *   - 存量明文 key：惰性迁移 —— 首次校验命中明文列时即原地升级为 keyHash 存储，
 *     key 列改写为 `migrated:<随机>`（明文不再保留，unique 约束不冲突）
 *
 * 校验策略（verifyApiKey）：
 *   1) 按 keyHash 恒定时间比对（node:crypto timingSafeEqual；长度不等直接 false，
 *      避免timingSafeEqual抛异常；逐行比对不因命中位置提前返回）
 *   2) miss 后回退明文 key findUnique（存量兼容），命中即迁移并返回迁移后的行
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import type { ApiKey } from '@prisma/client'

/** sha256(key) 十六进制（64 位定长） */
export function createKeyHash(key: string): string {
  return createHash('sha256').update(key, 'utf-8').digest('hex')
}

/** 两个 64 位 hex 的恒定时间比对（长度异常直接 false，不抛异常） */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

/**
 * 校验 Bearer token → 命中返回 ApiKey 行（含迁移后的最新数据），未命中返回 null。
 *
 * 查询顺序：
 *   1) 全量拉取 keyHash 非空的行，恒定时间逐一比对（不因内容不同泄露比对时长差异）
 *   2) 回退存量明文列 findUnique；命中即惰性迁移（keyHash/keyPrefix 写入、明文销毁）
 */
export async function verifyApiKey(token: string): Promise<ApiKey | null> {
  if (!token) return null
  const tokenHash = createKeyHash(token)

  // ---- 1) keyHash 恒定时间比对 ----
  const hashedRows = await db.apiKey.findMany({ where: { keyHash: { not: '' } } })
  for (const row of hashedRows) {
    if (timingSafeEqualHex(row.keyHash, tokenHash)) return row
  }

  // ---- 2) 存量明文兼容（惰性迁移）----
  const legacy = await db.apiKey.findUnique({ where: { key: token } })
  if (!legacy) return null
  try {
    return await db.apiKey.update({
      where: { id: legacy.id },
      data: {
        keyHash: tokenHash,
        keyPrefix: token.slice(0, 12),
        key: `migrated:${randomBytes(16).toString('hex')}`,
      },
    })
  } catch {
    // 迁移失败（并发校验竞争等）——返回原行，下次校验再迁移
    return legacy
  }
}

/** 新建 key 的列值：key 列占位符（明文不落库） */
export function apiKeyColumns(key: string): { key: string; keyHash: string; keyPrefix: string } {
  const keyHash = createKeyHash(key)
  return {
    key: `sha256:${keyHash.slice(0, 16)}`,
    keyHash,
    keyPrefix: key.slice(0, 12),
  }
}

/** UI 掩码展示：优先 keyPrefix；存量明文行回退旧格式预览 */
export function apiKeyPreview(row: { key: string; keyPrefix: string }): string {
  if (row.keyPrefix) return `${row.keyPrefix}…`
  return row.key.length <= 12 ? row.key : `${row.key.slice(0, 8)}…${row.key.slice(-4)}`
}
