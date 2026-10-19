/** Web Host 投影测试配置：让 Vitest 使用 Next.js 同一套 @/* 路径别名。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: packageRoot,
  resolve: {
    alias: {
      "@": packageRoot,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
