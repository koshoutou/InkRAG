import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "InkRAG 知识库管理平台",
  description:
    "InkRAG 知识库管理平台：文档解析、父子切分、混合检索、三屏联动可视化与白盒调试。",
  keywords: ["RAG", "知识库", "向量检索", "Qdrant", "MinerU", "chunking", "hybrid search"],
  // favicon 由文件约定 src/app/icon.svg 提供（Next App Router 自动注入 <link rel="icon">）
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
