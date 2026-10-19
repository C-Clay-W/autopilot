import type { NextConfig } from "next";
import path from "node:path";
const nextConfig: NextConfig = {
  // 构建只追踪当前 monorepo，避免用户目录中的其他 lockfile 扩大扫描范围。
  turbopack: { root: path.resolve(__dirname, "../..") },
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
    // 这里明确告诉Next.js哪些外部包应该在服务器端处理，不进入Turbopack流程 -- noted by clayw on 20260708
  serverExternalPackages: ["@lancedb/lancedb", "@autopilot-agent/core", "@autopilot-agent/adapters"],
};

export default nextConfig;
