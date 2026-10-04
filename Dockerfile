# InkRAG 单镜像部署（主服务 + pipeline-events 共进程）
#
# 构建：docker build -t inkrag:latest .
# 运行：docker run -d --name inkrag \
#   -p 2607:2607 \
#   -v inkrag-data:/app/db \
#   -e PANEL_SECRET=$(openssl rand -hex 32) \
#   -e METRICS_SCRAPE_TOKEN=$(openssl rand -hex 16) \
#   inkrag:latest
#
# 设计要点（OPS-009/012）：
# - 多阶段构建：builder 装 deps + prisma generate + next build；runtime 仅拷贝 standalone + mini-service + prisma client
# - 同一镜像内由 supervisord 编排两个进程（主服务 2607 + pipeline-events 2608/2609），
#   任一退出自动重启；SIGTERM 转发给两进程，主服务 drainForShutdown 优雅关闭
# - 数据卷挂 /app/db：SQLite + .panel.secret + backups 全部持久化
# - 健康检查走 /api/system/health/live（SEC-002：公开探针，仅 {ok:true}）
#
# 备选：若不想用 supervisord，可用 docker-compose 起两个容器（主服务 + events），
#       共享 PANEL_SECRET 与 /app/db 卷即可。

# ---------------------------- builder ----------------------------
FROM oven/bun:1.3 AS builder
WORKDIR /app

# 先拷 manifest 利用 docker 层缓存
COPY package.json bun.lock* ./
COPY mini-services/pipeline-events/package.json mini-services/pipeline-events/bun.lock* ./mini-services/pipeline-events/

# 安装主服务依赖
RUN bun install --frozen-lockfile

# 安装 mini-service 依赖
RUN cd mini-services/pipeline-events && bun install --frozen-lockfile

# 拷贝源码
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
COPY mini-services ./mini-services
COPY public ./public
COPY next.config.ts tsconfig.json postcss.config.mjs tailwind.config.ts components.json eslint.config.mjs ./

# 生成 Prisma Client（OPS-009：build 前必须 generate，否则 standalone 缺类型）
RUN bun run db:generate

# 构建 Next.js standalone（output: 'standalone'，自包含 node_modules）
RUN bun run build

# ---------------------------- runtime ----------------------------
FROM oven/bun:1.3 AS runtime
WORKDIR /app

# 安装 supervisord 用于进程编排（两个服务同镜像）
RUN apt-get update && apt-get install -y --no-install-recommends supervisor dumb-init \
    && rm -rf /var/lib/apt/lists/*

# 拷贝 standalone 产物（含自包含 node_modules）
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma Client（runtime 也要，standalone 不含 @prisma/client 的引擎二进制）
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# mini-service（独立进程，独立依赖）
COPY --from=builder /app/mini-services/pipeline-events ./mini-services/pipeline-events

# 数据卷：SQLite + .panel.secret + backups
RUN mkdir -p /app/db
VOLUME ["/app/db"]

ENV NODE_ENV=production
ENV PANEL_PORT=2607
ENV RAG_EVENTS_SOCKET_PORT=2608
ENV RAG_EVENTS_EMIT_PORT=2609
# standalone server.js 读 PORT（与 scripts/start 一致）
ENV PORT=2607
# 密钥文件基址与主服务一致（standalone cwd = /app）
ENV PANEL_SECRET_FILE=/app/db/.panel.secret

# supervisord 配置：编排主服务 + pipeline-events
COPY <<'EOF' /etc/supervisor/conf.d/inkrag.conf
[program:inkrag-main]
command=bun /app/server.js
directory=/app
autorestart=true
startretries=3
stopwaitsecs=35
stopsignal=TERM
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=NODE_ENV="production",PORT="%(ENV_PANEL_PORT)s",PANEL_SECRET_FILE="/app/db/.panel.secret"

[program:inkrag-events]
command=bun /app/mini-services/pipeline-events/index.ts
directory=/app/mini-services/pipeline-events
autorestart=true
startretries=3
stopwaitsecs=10
stopsignal=TERM
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=NODE_ENV="production",PANEL_SECRET_FILE="/app/db/.panel.secret"

[supervisord]
nodaemon=true
logfile=/dev/null
logfile_maxbytes=0
EOF

# dumb-init 处理 PID 1 信号转发（避免 node 直接做 PID 1 的信号坑）
ENTRYPOINT ["dumb-init", "--"]

# 健康检查：SEC-002 拆分后的公开探针（仅 {ok:true}，不暴露内部状态）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:2607/api/system/health/live || exit 1

EXPOSE 2607 2608
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/inkrag.conf"]
