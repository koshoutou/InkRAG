/**
 * 生成上传/解析测试资产（Task 13-a）：bun scripts/gen-sample-docs.ts
 *
 * 产出 /tmp/rag-samples/：
 *   sample-docx.docx —— 中文 ≥300 字：标题层级/有序无序列表/表格/加粗斜体（docx 库生成）
 *   sample-pdf.pdf   —— 英文多段落 RAG 主题（pdfkit 内置字体无 CJK，故用英文）
 *   sample.txt       —— 中文纯文本（空行分段）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const OUT_DIR = '/tmp/rag-samples'

async function genDocx(): Promise<void> {
  const docx = await import('docx')
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
  } = docx as any

  const doc = new Document({
    creator: 'RAG Workbench',
    title: '企业级 RAG 知识库平台技术白皮书',
    sections: [
      {
        children: [
          new Paragraph({ text: '企业级 RAG 知识库平台技术白皮书', heading: HeadingLevel.HEADING_1 }),
          new Paragraph(
            '检索增强生成（RAG）通过将大语言模型与外部知识库结合，显著降低幻觉率并提升回答的可溯源性。'
            + '企业级落地需要对文档解析、语义切分、向量检索与重排序四个环节做端到端工程化治理，'
            + '本白皮书围绕这四个环节给出平台的设计决策与实现要点，供团队在私有化部署场景下参考。',
          ),
          new Paragraph({ text: '一、文档解析管线', heading: HeadingLevel.HEADING_2 }),
          new Paragraph(
            '解析管线的目标是将 PDF、Word、网页等异构文档统一转换为结构化 Markdown 与布局元数据。'
            + '平台采用双模式设计：配置 MinerU 服务时走六步协议获得精确版面坐标；未配置时启用内置降级解析器，'
            + '对 docx 采用 mammoth 本地解析，对网页采用主内容抽取，保证无外部依赖时全链路可用。',
          ),
          new Paragraph({ text: '解析环节的关键指标：', style: 'ListParagraph' }),
          new Paragraph({ text: '结构保真：标题层级、列表嵌套与表格必须完整保留', bullet: { level: 0 } }),
          new Paragraph({ text: '坐标对齐：middle.json 布局块与 markdown 字符偏移严格对齐', bullet: { level: 0 } }),
          new Paragraph({ text: '字符卫生：控制字符、零宽字符与冗余空行需统一清洗', bullet: { level: 0 } }),
          new Paragraph({ text: '二、切分与嵌入流程', heading: HeadingLevel.HEADING_2 }),
          new Paragraph(
            '切分采用父子双层结构：父块承载章节上下文供重排参考，子块作为检索单元控制召回粒度。'
            + '嵌入阶段批量调用 OpenAI 兼容接口生成稠密向量，同时构建词法稀疏向量，'
            + '两路信号经 RRF 融合后再进入重排层，兼顾语义召回与关键词精确匹配。',
          ),
          new Paragraph({ text: '标准处理步骤如下：', style: 'ListParagraph' }),
          new Paragraph({ text: '上传文件并计算流式哈希，命中即秒传', numbering: { reference: 'steps', level: 0 } }),
          new Paragraph({ text: '解析并落盘 full.md 与 middle.json 产物', numbering: { reference: 'steps', level: 0 } }),
          new Paragraph({ text: '按配置切分为父子 chunk 并写入数据库', numbering: { reference: 'steps', level: 0 } }),
          new Paragraph({ text: '批量嵌入并向量入库，完成后进入就绪状态', numbering: { reference: 'steps', level: 0 } }),
          new Paragraph({ text: '三、模式对比', heading: HeadingLevel.HEADING_2 }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                tableHeader: true,
                children: [
                  new TableCell({ width: { size: 25, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: '环节', alignment: AlignmentType.CENTER, bold: true })] }),
                  new TableCell({ width: { size: 37.5, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: '本地模式', bold: true })] }),
                  new TableCell({ width: { size: 37.5, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: '外部服务模式', bold: true })] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('文档解析')] }),
                  new TableCell({ children: [new Paragraph('内置降级解析器')] }),
                  new TableCell({ children: [new Paragraph('MinerU 六步协议')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('向量嵌入')] }),
                  new TableCell({ children: [new Paragraph('确定性哈希特征')] }),
                  new TableCell({ children: [new Paragraph('OpenAI 兼容接口')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('向量存储')] }),
                  new TableCell({ children: [new Paragraph('内置 SQLite 引擎')] }),
                  new TableCell({ children: [new Paragraph('Qdrant 集群')] }),
                ],
              }),
            ],
          }),
          new Paragraph({ text: '四、结论', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({
            children: [
              new TextRun('平台在沙箱环境与生产环境间共享同一套状态机与产物契约，'),
              new TextRun({ text: '切换成本集中在配置层而非代码层', bold: true }),
              new TextRun('。配合父子检索、混合召回与重排序，'),
              new TextRun({ text: '端到端检索质量', italics: true }),
              new TextRun('在多轮回归测试中保持稳定，为后续接入更多文档类型（如 wiki 导入与批量上传）奠定了基础。'),
            ],
          }),
        ],
      },
    ],
    numbering: {
      config: [
        {
          reference: 'steps',
          levels: [
            { level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START },
          ],
        },
      ],
    },
  })

  const buf = await Packer.toBuffer(doc)
  writeFileSync(path.join(OUT_DIR, 'sample-docx.docx'), buf)
}

function genPdf(): void {
  // pdfkit 为 CJS；require 上下文在 bun 直跑脚本下可用 createRequire
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const PDFDocument = require('pdfkit')
  const doc = new PDFDocument({ size: 'A4', margin: 50 })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()))

  const paragraphs: [string, number][] = [
    ['Retrieval-Augmented Generation for Enterprise Knowledge Bases', 16],
    ['Retrieval-Augmented Generation (RAG) grounds large language models in external knowledge, dramatically reducing hallucination and improving answer traceability. An enterprise-grade RAG platform must handle heterogeneous ingestion: PDF reports, Word documents, wiki pages, and plain text notes. This document exercises the plain-text extraction path of the built-in PDF parser with multiple paragraphs of English prose.', 11],
    ['Document parsing is the first mile of the pipeline. The platform normalizes every source format into Markdown plus layout metadata, so that downstream chunking, embedding, and retrieval never need to care about the original file type. Heading levels, nested lists, and pipe tables must survive the conversion intact, while redundant control characters and blank lines are scrubbed away.', 11],
    ['Chunking uses a parent-child hierarchy. Parent chunks carry section-level context for reranking; child chunks are the retrieval units with configurable token size and overlap. Atomic blocks such as code and tables are protected from being split mid-structure, which keeps each retrieved fragment self-contained and quotable.', 11],
    ['The embedding stage produces dense vectors through an OpenAI-compatible endpoint while simultaneously building lexical sparse vectors. Both signals are fused with reciprocal rank fusion before an optional reranker refines the final ordering. In sandbox mode, deterministic hash-feature vectors and a BM25-like lexical rerank keep the whole chain reproducible without GPUs.', 11],
    ['Finally, the pipeline exposes a six-state machine: queued, parsing, chunking, embedding, upserting, and ready (or failed). Every state transition is broadcast over socket.io so the UI can stream byte-level upload progress and stage-level progress to the operator. This document was generated by pdfkit at build time to serve as a stable English test asset for regression testing.', 11],
  ]
  for (const [text, size] of paragraphs) {
    doc.font('Helvetica').fontSize(size).text(text, { align: size >= 14 ? 'center' : 'justify', lineGap: 4 })
    doc.moveDown(0.8)
  }
  doc.end()
  done.then(() => {
    writeFileSync(path.join(OUT_DIR, 'sample-pdf.pdf'), Buffer.concat(chunks))
  })
}

function genTxt(): void {
  const content = [
    '向量数据库选型备忘',
    '',
    '本地演示模式使用内置 SQLite 向量引擎，数据面与控制面同库，备份与恢复随 SQLite 快照一起完成。生产模式切换到 Qdrant 集群后，payload 索引与分片配置按计划书固化，检索调试台的四阶段白盒耗时在两种模式下口径一致。',
    '',
    '切换向量化模式后的标准恢复路径：先执行批量重解析让全部文档重新入库，再跑一轮测试集回归确认命中率与 MRR 回到基线。若个别文档失败，用单文档 retry 从失败阶段续跑即可，无需整库重建。',
    '',
    '注意事项：嵌入模型与维度在建库时锁定，中途换模型等于换库；重切分只影响 chunk 层，不会重新解析原文。',
  ].join('\n')
  writeFileSync(path.join(OUT_DIR, 'sample.txt'), content, 'utf-8')
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  await genDocx()
  const pdfDone = genPdf()
  genTxt()
  await pdfDone
  console.log('OK → /tmp/rag-samples/{sample-docx.docx, sample-pdf.pdf, sample.txt}')
}

void main()
