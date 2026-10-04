import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // 仅记录错误与警告：流水线引擎每 1.2s tick 轮询，开启 query 日志会刷爆 dev.log
    log: ['error', 'warn'],
  })

// F-LOC-07：无条件缓存——原条件（仅非 production 缓存）疑似写反，Next standalone 生产模式下
// 不同 route chunk 会各自实例化 client → 连接池膨胀 + SQLITE_BUSY 写锁竞争。
// 单机单进程定位下全局唯一 client 是正确语义（dev 热重载也复用）。
if (!globalForPrisma.prisma) globalForPrisma.prisma = db

/**
 * SQLite 健壮性 PRAGMA 预热（Task 15-b / 审计 #6）：
 * - journal_mode=WAL：写不阻塞读、崩溃恢复更安全（持久设置，写入 DB 文件头，一次生效全局）
 * - synchronous=NORMAL：WAL 模式下的官方推荐档位（兼顾性能与耐久性）
 * - busy_timeout=5000：锁竞争时先等待 5s 再抛 SQLITE_BUSY（每连接生效）
 *
 * 已知局限：Prisma 没有连接钩子，连接池后续新建的连接不会自动携带
 * busy_timeout/synchronous（journal_mode=WAL 除外，它是 DB 级持久属性）。
 * 本平台为单机低并发定位，初始化连接设置 + WAL 已覆盖绝大多数争用场景，
 * 残余风险是极端并发下偶发 SQLITE_BUSY（流水线已有重试兜底），此处不额外引入包装层。
 */
async function applySqlitePragmas(): Promise<void> {
  try {
    await db.$queryRawUnsafe('PRAGMA journal_mode=WAL;')
    await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL;')
    await db.$queryRawUnsafe('PRAGMA busy_timeout=5000;')
  } catch (e) {
    // 预热失败不阻断启动（如 DB 首次访问前的短暂锁竞争），下次冷启动会重试
    console.warn('[db] SQLite PRAGMA 预热失败（不影响启动）:', e instanceof Error ? e.message : e)
  }
}

void applySqlitePragmas()
