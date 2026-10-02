/**
 * docx 本地解析（契约 §26 —— RAGFlow 同款思路的 Node 轻量实现）
 *
 * 流程：mammoth.convertToHtml(buffer) → 语义 HTML（h1-h6/p/ul/ol/table/strong/a/img/pre）
 *   → 共享 htmlToMarkdown（noExtract：docx 无站点骨架，跳过主内容抽取）
 *   → 结构化 markdown（标题层级 / 嵌套列表 / 管道表格 / 加粗斜体 / 链接 / 图片占位 / 代码块）
 *
 * 清洗由 html-clean 的 cleanMarkdownText 统一完成：
 *   控制字符、\r\n、零宽/全角空白、行首尾修剪、bullet 统一、>2 连续空行 → 2
 *   —— 清除冗余字符且保持结构与内容完整（对标 RAGFlow 本地解析的输出卫生要求）
 *
 * mammoth 为纯 JS（运行时动态导入，Node runtime 服务端专用，不经客户端打包）。
 */
import { promises as fs } from 'node:fs'
import { htmlToMarkdown } from './html-clean'

export interface DocxParseResult {
  markdown: string
  warnings: string[]
}

/** docx 文件 → 结构化 markdown（带 mammoth 转换告警透出） */
export async function docxToMarkdown(filePath: string): Promise<DocxParseResult> {
  // 动态导入：服务端纯 JS 包，避免模块图提前耦合
  const mod: any = await import('mammoth')
  const mammoth = (mod.default ?? mod) as {
    convertToHtml(input: { buffer: Buffer }): Promise<{ value: string; messages: { message: string; type: string }[] }>
  }

  const buffer = await fs.readFile(filePath)
  if (buffer.length === 0) {
    throw new Error('docx 文件为空')
  }
  // zip 魔数校验（docx = PK zip 容器）——扩展名伪装的纯文本快速失败
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw new Error('不是合法的 docx 文件（缺少 zip 容器魔数，可能扩展名伪装）')
  }

  const result = await mammoth.convertToHtml({ buffer })
  const warnings = (result.messages ?? [])
    .filter((m) => m && typeof m.message === 'string')
    .slice(0, 5)
    .map((m) => m.message)

  const markdown = htmlToMarkdown(result.value ?? '', { noExtract: true })
  return { markdown, warnings }
}
