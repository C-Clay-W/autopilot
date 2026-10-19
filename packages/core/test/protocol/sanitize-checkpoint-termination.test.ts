/** runbook-P14 [2026-09-28 12:50] 修复回归：turn_paused 不投影 termination；真实中断完整保留原因、恢复性与预算。 */
import { describe, expect, it } from "vitest";
import { sanitizeEventForExternal } from "../../src/runtime/protocol/sanitize-checkpoint";
import type { AgentLoopEvent } from "../../src/internal/agent-runtime";

/** 构造最小合法 checkpoint；本套件只关心 status 与 interruptionReason 的投影行为。 */
function checkpoint(turnId: string, status: string, interruptionReason?: string): Record<string, unknown> {
  return {
    turnId,
    status,
    stepCount: 1,
    messages: [{ role: "user", content: "PRIVATE_MESSAGE" }],
    completedCallIds: [],
    ...(interruptionReason ? { interruptionReason } : {}),
  };
}

/** 将测试用最小对象视为内部 AgentLoopEvent，避免依赖 checkpoint 全量形状。 */
function asLoopEvent(value: unknown): AgentLoopEvent {
  return value as AgentLoopEvent;
}

type SanitizedTerminal = { termination?: { reason?: string; recoverable?: boolean; budget?: { used: number; limit: number; unit: string } } };

describe("sanitizeEventForExternal termination 投影", function terminationSuite() {
  it("turn_paused + awaiting_approval 不携带 termination", function pausedApprovalHasNoTermination() {
    const event = asLoopEvent({ type: "turn_paused", turnId: "t-approval", checkpoint: checkpoint("t-approval", "awaiting_approval") });
    const sanitized = sanitizeEventForExternal(event) as SanitizedTerminal;
    expect(sanitized.termination).toBeUndefined();
  });

  it("turn_paused + awaiting_user_input 不携带 termination", function pausedUserInputHasNoTermination() {
    const event = asLoopEvent({ type: "turn_paused", turnId: "t-question", checkpoint: checkpoint("t-question", "awaiting_user_input") });
    const sanitized = sanitizeEventForExternal(event) as SanitizedTerminal;
    expect(sanitized.termination).toBeUndefined();
  });

  it("turn_interrupted + runtime_budget 完整保留原因、恢复性与预算", function interruptedKeepsBudgetFacts() {
    const event = asLoopEvent({
      type: "turn_interrupted",
      turnId: "t-budget",
      termination: { reason: "runtime_budget", budget: { used: 1001, limit: 1000, unit: "ms" } },
      checkpoint: checkpoint("t-budget", "interrupted_recoverable", "runtime_budget"),
    });
    const sanitized = sanitizeEventForExternal(event) as SanitizedTerminal;
    expect(sanitized.termination).toEqual({ reason: "runtime_budget", recoverable: true, budget: { used: 1001, limit: 1000, unit: "ms" } });
  });
});
