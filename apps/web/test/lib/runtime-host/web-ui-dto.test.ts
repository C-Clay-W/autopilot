/** Web Session DTO 测试：锁定 Core 运行摘要的安全单向投影。 */
import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, Session } from "@autopilot-agent/core";
import { toWebSessionDto } from "@/lib/runtime-host/web-ui-dto";
import { envelopeToSseLine } from "@/lib/runtime-host/web-event-sse-adapter";

/** 构造包含不应暴露字段的最小 Core Session fixture。 */
function createSessionFixture(): Session {
  return {
    id: "session-1",
    persistenceMode: "durable",
    status: "running",
    activeTurnId: "turn-1",
    title: "并行任务 A",
    createdAt: 100,
    updatedAt: 200,
  };
}

describe("toWebSessionDto", function webSessionDtoSuite() {
  it("只投影列表所需的安全运行摘要", function mapsSafeRuntimeSummary() {
    const dto = toWebSessionDto(createSessionFixture());

    expect(dto).toMatchObject({
      id: "session-1",
      title: "并行任务 A",
      createdAt: 100,
      updatedAt: 200,
      status: "active",
      runtimeStatus: "running",
      activeTurnId: "turn-1",
    });
    expect(Object.keys(dto)).toEqual(["id", "title", "createdAt", "updatedAt", "status", "runtimeStatus", "activeTurnId", "pinnedSkills"]);
  });
});

describe("Web Agent SSE projection", function webAgentSseProjectionSuite() {
  it("仅发送安全终态字段并移除 checkpoint 与错误正文", function projectsSafeTerminalEvent() {
    const envelope = {
      seq: 4,
      sessionId: "session-1",
      turnId: "turn-1",
      event: {
        type: "turn_interrupted",
        turnId: "turn-1",
        error: "PRIVATE_PROVIDER_BODY api_key=sk-private C:/private/model.ts",
        checkpoint: {
          turnId: "turn-1",
          status: "interrupted_recoverable",
          messages: [{ role: "user", content: "PRIVATE_MESSAGE" }],
          runtimeBudget: { startedAt: 10, totalTokens: 12 },
          usageAnchor: { toolSignature: "PRIVATE_USAGE" },
        },
        termination: { reason: "runtime_budget", recoverable: true, budget: { used: 1_001, limit: 1_000, unit: "ms" } },
      },
    } as unknown as AgentEventEnvelope;
    const line = envelopeToSseLine(envelope, "turn-1");
    const payload = JSON.parse(line.slice("data: ".length));

    expect(payload).toMatchObject({
      seq: 4,
      turnId: "turn-1",
      type: "turn_interrupted",
      termination: { reason: "runtime_budget", recoverable: true, budget: { used: 1_001, limit: 1_000, unit: "ms" } },
    });
    for (const privateValue of ["PRIVATE_PROVIDER_BODY", "sk-private", "private.ts", "PRIVATE_MESSAGE", "runtimeBudget", "usageAnchor", "PRIVATE_USAGE"]) {
      expect(line).not.toContain(privateValue);
    }
    expect(payload.checkpoint).toBeUndefined();
    expect(payload.error).toBeUndefined();
  });
});
