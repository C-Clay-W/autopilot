/** Stage 4 测试共享的安全 ContextUsageView fixture；字段与 Core 白名单一致。 */

import type { ContextUsageView } from "@autopilot-agent/core";

/** 构造满足 Core 白名单字段的安全 usage DTO。 */
export function createUsageFixture(overrides: Partial<ContextUsageView> = {}): ContextUsageView {
  return {
    modelRef: "gateway-a/claude-sonnet-4",
    contextWindowTokens: 200_000,
    estimatedAddedTokens: 1_000,
    currentContextTokens: 24_000,
    outputReserveTokens: 8_192,
    compactTriggerTokens: 180_000,
    projectedTokens: 32_192,
    usageRatio: 0.16096,
    compactNeeded: false,
    measurement: "projected",
    breakdown: {
      categories: [
        { kind: "system", tokens: 1_234, windowRatio: 0.00617, projectedRatio: 0.03833, measurement: "estimated" },
        { kind: "memory", tokens: 500, itemCount: 3, windowRatio: 0.0025, projectedRatio: 0.01553, measurement: "estimated" },
        { kind: "skills", tokens: 300, itemCount: 2, windowRatio: 0.0015, projectedRatio: 0.00932, measurement: "estimated" },
        { kind: "conversation", tokens: 22_966, windowRatio: 0.11483, projectedRatio: 0.71283, measurement: "estimated" },
        { kind: "output_reserve", tokens: 8_192, windowRatio: 0.04096, projectedRatio: 0.25445, measurement: "reserved" },
      ],
      freeTokens: 147_808,
      freeRatio: 0.73904,
      compactBufferTokens: 20_000,
      compactBufferRatio: 0.1,
      overLimitTokens: 0,
      overLimitRatio: 0,
      measurement: "estimated",
    },
    ...overrides,
  } as ContextUsageView;
}
