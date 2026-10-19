/** Core 单元与契约测试配置；只执行源码和稳定 test 目录，避免依赖日期测试目录。 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "test/**/*.test.ts",
    ],
  },
});
