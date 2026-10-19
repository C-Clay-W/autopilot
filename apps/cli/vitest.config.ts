/** CLI 契约测试配置；测试直接加载 TypeScript 宿主代码，不启动 Ink 或真实模型。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: packageRoot,
  test: {
    environment: "node",
    // Ink 测试实例共用终端输入模拟层，按文件串行执行以确保连续按键与渲染帧的契约可重复。
    fileParallelism: false,
    include: [
      "test/**/*.test.{ts,tsx}",
    ],
  },
});
