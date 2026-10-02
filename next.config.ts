import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  // 关闭开发模式左下角 Next.js 路由指示徽标（Next 15.2+ 支持布尔值）
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // pdfjs-dist 服务端引用 legacy build：外部化以避免打包 worker/canvas 分支
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
