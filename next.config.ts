import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 读取 package.json version 作为版本唯一真源（A13 修复）。
 * 通过 env 注入 INKRAG_VERSION，构建时内联到客户端 bundle，UI 直接 process.env.INKRAG_VERSION。
 * 消除此前 package.json(0.2.1) / PlatformShell(v1.0) / AppShell(v1.0) / README(v1.10) 四套版本号并存。
 */
const pkgVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * 全局安全响应头（Task 15-b / 审计 #3）：
 * - nosniff：禁止浏览器 MIME 嗅探（配合下载路由的 octet-stream 白名单）
 * - Referrer-Policy / X-Frame-Options：基础外泄与嵌入防护
 * - CSP：default-src 'self' 收口；script/style 的 unsafe-inline/unsafe-eval 为 Next.js
 *   dev 模式（HMR/快照评估）所需；img blob: 放行上传预览；worker blob: 放行 pdfjs worker；
 *   connect-src ws/wss 放行开发态 WebSocket 网关
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "worker-src 'self' blob:",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here (t14e: prisma client reload trigger) */
  // 关闭开发模式左下角 Next.js 路由指示徽标（Next 15.2+ 支持布尔值）
  devIndicators: false,
  // A13: 版本号注入（构建时内联到客户端 bundle，UI 读 process.env.INKRAG_VERSION）
  env: {
    INKRAG_VERSION: pkgVersion,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // pdfjs-dist 服务端引用 legacy build：外部化以避免打包 worker/canvas 分支
  serverExternalPackages: ["pdfjs-dist"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
