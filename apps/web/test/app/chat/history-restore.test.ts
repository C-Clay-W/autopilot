import { describe, expect, it } from "vitest";
import type { WebSessionMessageDto } from "@/lib/runtime-host/web-ui-dto";
import type { Message, SessionAgentState } from "@/app/chat/chat-page-types";
import { mapHistoryMessage, shouldRetryHistoryFailure, type HistoryErrorPhase } from "@/app/chat/history-restore";

const termination: NonNullable<Message["termination"]> = {
  reason: "runtime_budget",
  recoverable: true,
  budget: { used: 1_001, limit: 1_000, unit: "ms" },
};

/** 创建具备 History 必填字段的会话消息，其他字段由单个用例显式覆盖。 */
function createHistoryMessage(overrides: Partial<WebSessionMessageDto> = {}): WebSessionMessageDto {
  return {
    type: "message",
    id: "message-1",
    role: "user",
    content: "hello",
    createdAt: 1,
    ...overrides,
  };
}

/** 创建可恢复的当前 Agent Turn，便于核对消息和终止信息的匹配边界。 */
function createRecoverableAgent(turnId: string): SessionAgentState {
  return {
    turnId,
    status: "limit_reached",
    recoverable: true,
    termination,
  };
}

describe("History message mapping", function historyMessageMappingSuite() {
  it("maps a user message without turnId when agent is absent", function mapsUserWithoutAgent() {
    const mapped = mapHistoryMessage(createHistoryMessage(), undefined, undefined);

    expect(mapped.role).toBe("user");
    expect(mapped.termination).toBeUndefined();
  });

  it("does not attach termination to a user message even when its Turn matches", function ignoresUserTurn() {
    const mapped = mapHistoryMessage(createHistoryMessage({ turnId: "turn-current" }), createRecoverableAgent("turn-current"), "turn-current");

    expect(mapped.termination).toBeUndefined();
  });

  it("does not attach termination to a message without a Turn id", function ignoresMessageWithoutTurn() {
    const mapped = mapHistoryMessage(createHistoryMessage({ role: "assistant" }), createRecoverableAgent("turn-current"), "turn-current");

    expect(mapped.termination).toBeUndefined();
  });

  it("attaches termination to the matching assistant Turn", function attachesMatchingTermination() {
    const mapped = mapHistoryMessage(createHistoryMessage({ role: "assistant", turnId: "turn-current" }), createRecoverableAgent("turn-current"), "turn-current");

    expect(mapped.termination).toEqual(termination);
    expect(mapped.canContinue).toBe(true);
  });

  it("does not attach the current termination to a historical Turn", function ignoresDifferentTurn() {
    const mapped = mapHistoryMessage(createHistoryMessage({ role: "assistant", turnId: "turn-old" }), createRecoverableAgent("turn-current"), "turn-current");

    expect(mapped.termination).toBeUndefined();
    expect(mapped.canContinue).toBe(false);
  });

  it("preserves failure data and termination on a matching failed assistant message", function preservesFailureProjection() {
    const failure = { code: "TURN_EXECUTION_FAILED", message: "任务执行失败，请稍后重新发送。" } as const;
    const mapped = mapHistoryMessage(createHistoryMessage({ role: "assistant", turnId: "turn-current", failure }), createRecoverableAgent("turn-current"), "turn-current");

    expect(mapped.failure).toEqual(failure);
    expect(mapped.termination).toEqual(termination);
  });

  it("does not attach assistant termination to tool records normalized for display", function ignoresToolRecord() {
    const mapped = mapHistoryMessage(createHistoryMessage({ role: "tool", turnId: "turn-current" }), createRecoverableAgent("turn-current"), "turn-current");

    expect(mapped.role).toBe("assistant");
    expect(mapped.termination).toBeUndefined();
  });
});

describe("History automatic retry policy", function historyRetryPolicySuite() {
  it.each(["fetch", "json"] as const)("retries transient %s failures", function retriesTransientTransportFailure(phase) {
    expect(shouldRetryHistoryFailure(phase)).toBe(true);
  });

  it.each([500, 502, 503, 504])("retries transient HTTP %i responses", function retriesTransientHttpStatus(status) {
    expect(shouldRetryHistoryFailure("http", status)).toBe(true);
  });

  it.each([400, 404, 408, 429, 501, 505])("does not retry HTTP %i responses", function skipsNonTransientHttpStatus(status) {
    expect(shouldRetryHistoryFailure("http", status)).toBe(false);
  });

  it("does not retry deterministic mapping failures", function skipsMappingFailure() {
    const phase: HistoryErrorPhase = "mapping";

    expect(shouldRetryHistoryFailure(phase)).toBe(false);
  });
});
