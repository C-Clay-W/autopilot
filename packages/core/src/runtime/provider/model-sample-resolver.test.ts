/**
 * runtime/provider/model-sample-resolver.test.ts — firstParty effort 冻结契约。
 *
 * 验证 CC settings 的 requested effort 只生成 Anthropic Messages 字段，明确请求的 max
 * 会在 Turn 冻结前原样保留，由目标兼容端点决定是否接受该强度。
 */

import { describe, expect, it } from "vitest";
import { resolveFirstPartyModelSampleOptions } from "./model-sample-resolver";

describe("firstParty model sample resolver", function firstPartyResolverSuite() {
  it("保留 low/medium/high，并在关闭 thinking 时仍发送显式 effort", function preservesVerifiedEffort() {
    const resolved = resolveFirstPartyModelSampleOptions(
      { provider: "firstParty", modelId: "fixture-model[1m]" },
      { effort: "medium" },
      { thinkingEnabled: false },
    );

    expect(resolved).toEqual({
      sampleOptions: { model: "fixture-model[1m]", reasoningEffort: "medium" },
      effectiveReasoning: { effort: "medium", source: "requested" },
    });
  });

  it("明确请求的 max 原样冻结，none 只关闭 thinking", function preservesMaxAndDisablesNone() {
    const max = resolveFirstPartyModelSampleOptions(
      { provider: "firstParty", modelId: "fixture-model" },
      { effort: "max" },
    );
    const none = resolveFirstPartyModelSampleOptions(
      { provider: "firstParty", modelId: "fixture-model" },
      { effort: "none" },
    );

    expect(max).toEqual({
      sampleOptions: { model: "fixture-model", thinking: "enabled", reasoningEffort: "max" },
      effectiveReasoning: { effort: "max", source: "requested" },
    });
    expect(none).toEqual({
      sampleOptions: { model: "fixture-model", thinking: "disabled" },
      effectiveReasoning: { effort: "none", source: "requested" },
    });
  });
});
