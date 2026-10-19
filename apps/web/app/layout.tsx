import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import type { ReactNode } from "react";
import { NoticeProvider } from "./chat/components/Notice";

// 本地自托管 JetBrains Mono，构建/运行均不依赖外网
const jetbrainsMono = localFont({
  src: [
    { path: "./assets/fonts/latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./assets/fonts/latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./assets/fonts/latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./assets/fonts/latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Autopilot",
  description: "私有知识库 · 语义检索 · 智能问答",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className={`${jetbrainsMono.variable} font-mono h-full`}>
        <NoticeProvider>{children}</NoticeProvider>
      </body>
    </html>
  );
}
