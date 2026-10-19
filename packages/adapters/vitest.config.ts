/** Node Adapter 契约测试配置；测试直接加载 TypeScript 源码，不依赖生产构建产物。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: packageRoot,
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "test/**/*.test.ts",
    ],
  },
});
