/**
 * 产物目录管理（计划书 §9.3 / 契约 §10）
 *
 * {ARTIFACTS_ROOT}/
 *   {kbId}/{docId}/
 *     source.<ext>       # 原始文件
 *     full.md            # 解析 markdown
 *     middle.json        # layout + bbox
 *     chunks/{chunkId}.txt
 *
 * storage_key 一律存相对路径 `{kbId}/{docId}/...`；根目录来自配置，便于迁移。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const ARTIFACTS_ROOT = process.env.RAG_ARTIFACTS_DIR
  ? path.resolve(process.env.RAG_ARTIFACTS_DIR)
  : path.resolve(process.cwd(), 'artifacts')

/** 文档产物目录（绝对） */
export function docDir(kbId: string, docId: string): string {
  return path.join(ARTIFACTS_ROOT, kbId, docId)
}

/** 确保文档产物目录存在 */
export async function ensureDocDir(kbId: string, docId: string): Promise<string> {
  const dir = docDir(kbId, docId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 原始文件路径（source.<ext>） */
export function sourcePath(kbId: string, docId: string, ext: string): string {
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '') || 'bin'
  return path.join(docDir(kbId, docId), `source.${safeExt}`)
}

/** 解析 markdown 路径 */
export function markdownPath(kbId: string, docId: string): string {
  return path.join(docDir(kbId, docId), 'full.md')
}

/** middle.json 路径 */
export function middleJsonPath(kbId: string, docId: string): string {
  return path.join(docDir(kbId, docId), 'middle.json')
}

/** chunks 目录 */
export function chunksDir(kbId: string, docId: string): string {
  return path.join(docDir(kbId, docId), 'chunks')
}

/** 单个 chunk 全文文件路径 */
export function chunkPath(kbId: string, docId: string, chunkId: string): string {
  return path.join(chunksDir(kbId, docId), `${chunkId}.txt`)
}

/**
 * 相对路径 → 绝对路径（防路径穿越）。
 * rel 形如 `{kbId}/{docId}/chunks/{id}.txt`；校验不含 `..` 且非绝对路径。
 */
export function resolveStorageKey(rel: string): string {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error(`非法存储路径: ${rel}`)
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`非法存储路径（绝对路径）: ${rel}`)
  }
  return path.join(ARTIFACTS_ROOT, normalized)
}

/** 删除整棵文档产物目录 */
export async function removeDocDir(kbId: string, docId: string): Promise<void> {
  await fs.rm(docDir(kbId, docId), { recursive: true, force: true })
}

/** 删除整个知识库产物目录 */
export async function removeKbDir(kbId: string): Promise<void> {
  await fs.rm(path.join(ARTIFACTS_ROOT, kbId), { recursive: true, force: true })
}

/** 读取 chunk 全文（storageKey 为 chunk txt 的相对路径） */
export async function readChunkText(storageKey: string): Promise<string> {
  try {
    return await fs.readFile(resolveStorageKey(storageKey), 'utf-8')
  } catch {
    return ''
  }
}
