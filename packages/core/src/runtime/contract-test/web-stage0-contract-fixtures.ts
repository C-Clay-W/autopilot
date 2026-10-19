/**
 * Web Search Stage 0 通用契约夹具：冻结 capability、凭据与 HTML 解析边界。
 */

/** Core 只冻结通用 Search capability，具体供应商协议由 Adapter 契约验证。 */
export const WEB_STAGE0_CAPABILITY_DECISION = {
  settingsShape: { webSearch: { provider: "openai-compatible", baseUrl: "https://search.example/v1", model: "search-model", credentialRef: { provider: "openai-compatible", key: "search" } } },
  providerResolvedByAdapter: true,
  searchModelIndependentFromMainModel: true,
  storesPlaintextKey: false,
} as const;

/** Stage 3 的 HTML 解析候选及进入实现前必须满足的自动审计门。 */
export const WEB_STAGE0_HTML_EXTRACTOR_DECISION = {
  packageName: "linkedom",
  installStage: 3,
  rawHtmlFallbackAllowed: false,
  requiredChecks: ["license", "bundle-size", "maintenance", "npm-audit", "bounded-fixtures"],
} as const;
