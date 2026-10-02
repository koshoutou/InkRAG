# InkRAG · 轻量 RAG 知识库管理平台

> 一套可自托管的轻量级 RAG 知识库管理系统：多格式文档解析 → 父子双块切分 → 混合检索（稠密 + 稀疏 + Rerank）→ 全链路白盒可观测。

## 功能总览

- **多格式解析**：PDF / DOCX / MD / TXT / HTML 及扩展类型；支持自部署 MinerU 与官方 MinerU 云服务双通道
- **父子双块切分**：Markdown 感知 + token 窗口 + 原子保护块（代码 / 表格 / 图片），切分沙盒无损试验
- **混合检索**：Dense（bge-m3）+ Sparse（BM25）+ RRF 融合 + Rerank（bge-reranker-v2-m3），三模式可切
- **三屏联动**：原文 / Markdown / chunk 三屏双向联动，chunk 可编辑、启停、删除，变更即同步向量库与文档版本
- **文档版本管理**：切分配置变更自动快照历史版本，chunk 级 diff 对比、恢复历史版本、删除版本
- **实时任务中心**：每篇文档的解析 / 切分 / 向量化 / 入库进度实时推送，失败可重试、报错可展开
- **系统运维**：健康矩阵、资源占用、面板数据 + Qdrant 快照一体化备份 / 恢复 / 上传恢复
- **开放 API**：Bearer Key 鉴权的对外检索 API（v1），Prometheus 指标暴露

## 技术栈

Next.js 16（App Router）· TypeScript · Tailwind CSS 4 · shadcn/ui · Prisma（SQLite）· socket.io · Zustand · TanStack Query

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 初始化数据库
cp .env.example .env   # 按需修改 DATABASE_URL
bun run db:push

# 3. 启动主服务（端口 3000）
bun run dev

# 4. 启动实时事件服务（socket.io，端口 3003/3004）
cd mini-services/pipeline-events && bun install && bun run dev
```

打开 `http://localhost:3000`，在「设置」中配置 Qdrant / Embedding / Rerank / MinerU；不配置时自动进入本地演示模式（本地向量引擎 + 降级解析器 + Mock 嵌入）。

## 文档

- [API 契约（19+ 节）](./docs/api-contract.md)
## License

本仓库基于 **InkRAG Open Source License**（[LICENSE](./LICENSE)，Apache License 2.0 + 附加条款）开源发布。

- **著作权始终归 Inkcoo（koshoutou）所有。**
- **保留作者署名（Inkcoo / InkRAG）时：可闭源、可商用**，可对外提供服务、可出售，无需另行取得商业许可。
- 若在**对外商用产品/服务**中**移除作者署名（Inkcoo / InkRAG）**：须先取得 **Inkcoo** 的书面授权（是否收费、收费多少由作者决定）。
- **商业规模门槛**：达百万级月活跃用户（MAU）或千万人民币级月营收时，即便保留署名，对外提供服务也须取得 **Inkcoo** 的商业许可。
- 商业授权详见 [COMMERCIAL.md](./COMMERCIAL.md)。

## NOTICE

版权与署名信息见 [NOTICE](./NOTICE)。

## 致谢 / Acknowledgments

本项目的功能设计与协议实现参考并受益于以下优秀的开源社区项目，在此致以诚挚的感谢：

- [Dify](https://github.com/langgenius/dify) —— 知识库 API 交互规范与 `/v1/datasets` 兼容层的设计参考
- [RAGFlow](https://github.com/infiniflow/ragflow) —— 文档清洗算法与多屏联动交互的设计参考
- [MinerU](https://github.com/opendatalab/MinerU) —— 文档解析引擎接入与「导出到 Dify」链路的设计参考

再次感谢上述开源项目及其维护者为整个开源社区所做出的杰出贡献。
