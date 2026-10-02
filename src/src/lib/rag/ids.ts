/**
 * 确定性 ID（计划书 §14.7 幂等 ID）
 *
 * chunk id = uuidv5(`${kbId}:${docId}:${seq}:${textHash}`, NAMESPACE)
 * 同一文档同一配置重跑不产生重复向量点（upsert 同 ID 覆盖）。
 */
import { createHash } from 'node:crypto'
import { v5 as uuidv5 } from 'uuid'

/**
 * 平台自定义 UUID v5 命名空间。
 * 注：uuid 库强制 RFC 4122 variant 位（第 4 组首字符须为 8/9/a/b），
 * 任务书建议的 '...-2c1d-...' 不满足，固化为 '...-8c1d-...'（契约偏差，已记录 worklog）。
 */
export const RAG_KB_NAMESPACE = '9f8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d'

/** sha256(text) 前 16 位十六进制 */
export function textHash16(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16)
}

/** 确定性 chunk ID：同 (kbId, docId, seq, text) 恒等 */
export function deterministicChunkId(
  kbId: string,
  docId: string,
  seq: number,
  textHash: string
): string {
  return uuidv5(`${kbId}:${docId}:${seq}:${textHash}`, RAG_KB_NAMESPACE)
}
