/** Web CR 定向验证配置：跨包全部加载当前源码，避免旧 dist 掩盖接口差异。 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: {
    '@autopilot-agent/core': path.resolve('packages/core/src/index.ts'),
    '@autopilot-agent/presentation': path.resolve('packages/presentation/src/index.ts'),
  } },
  test: { environment: 'node', include: ['test/web-cr-repair.test.ts'] },
});
