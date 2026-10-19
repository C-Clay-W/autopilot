/** Monorepo ESLint 配置：覆盖 Core、Adapters 与 CLI 的 TypeScript 源码和测试。 */
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-types/**",
      "**/node_modules/**",
      "apps/web/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    // 既有代码尚未迁移到 strict lint；本门禁先确保所有 workspace 都经 ESLint 解析，
    // 类型正确性仍由各 workspace 的 typecheck 强制保证。
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
