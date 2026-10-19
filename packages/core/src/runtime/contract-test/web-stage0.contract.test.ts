/**
 * Web Search Stage 0 契约测试：离线冻结 Core capability、凭据和 HTML 解析门。
 */

import { describe, expect, it } from "vitest";
import {
  WEB_STAGE0_CAPABILITY_DECISION,
  WEB_STAGE0_HTML_EXTRACTOR_DECISION,
} from "./web-stage0-contract-fixtures";

describe("Web Search Stage 0 contract", function webStage0ContractSuite() {
  /** 验证 Core 不冻结供应商、endpoint 或 Search 模型。 */
  it("只冻结中性 capability 与凭据引用", function freezesCapabilityDecision() {
    expect(WEB_STAGE0_CAPABILITY_DECISION).toEqual({
      settingsShape: { webSearch: { provider: "openai-compatible", baseUrl: "https://search.example/v1", model: "search-model", credentialRef: { provider: "openai-compatible", key: "search" } } },
      providerResolvedByAdapter: true,
      searchModelIndependentFromMainModel: true,
      storesPlaintextKey: false,
    });
    expect(Object.keys(WEB_STAGE0_CAPABILITY_DECISION.settingsShape.webSearch)).toEqual(["provider", "baseUrl", "model", "credentialRef"]);
  });

  it("Stage 3 只允许经自动审计的 DOM 解析器且禁止 raw HTML 降级", function freezesHtmlExtractorGate() {
    expect(WEB_STAGE0_HTML_EXTRACTOR_DECISION).toEqual({
      packageName: "linkedom",
      installStage: 3,
      rawHtmlFallbackAllowed: false,
      requiredChecks: ["license", "bundle-size", "maintenance", "npm-audit", "bounded-fixtures"],
    });
  });
});
