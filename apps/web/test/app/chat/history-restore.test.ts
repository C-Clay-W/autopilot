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

  it("旧 History failure DTO 获得稳定 ID 和固定安全文案", function normalizesLegacyFailureProjection() {
    const messageId = "123e4567-e89b-42d3-a456-426614174001";
    const failure = { code: "TURN_EXECUTION_FAILED", message: "PRIVATE_OLD_FAILURE_DETAIL" } as unknown as NonNullable<WebSessionMessageDto["failure"]>;
    const message = createHistoryMessage({ id: messageId, role: "assistant", turnId: "turn-current", failure });
    const mapped = mapHistoryMessage(message, createRecoverableAgent("turn-current"), "turn-current");
    const refreshed = mapHistoryMessage(message, createRecoverableAgent("turn-current"), "turn-current");

    expect(mapped.failure?.feedbackId).toBe(messageId);
    expect(mapped.failure).toEqual(refreshed.failure);
    expect(mapped.failure?.message).not.toContain("PRIVATE_OLD_FAILURE_DETAIL");
    expect(mapped.failure?.diagnostic.stage).toBe("legacy_history");
    expect(mapped.termination).toEqual(termination);
  });

  it("旧版精确凭据失败从消息正文恢复时重复刷新保留同一 ID", function restoresLegacyBodyWithStableId() {
    const messageId = "123e4567-e89b-42d3-a456-426614174002";
    const message = createHistoryMessage({ id: messageId, role: "assistant", turnId: "turn-legacy", content: "指定的 Provider credentialRef 无法解析" });
    const first = mapHistoryMessage(message, undefined, undefined);
    const second = mapHistoryMessage(message, undefined, undefined);

    expect(first.failure?.feedbackId).toBe(messageId);
    expect(second.failure?.feedbackId).toBe(messageId);
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
