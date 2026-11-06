/** 本任务共享展示回归：真实执行段累计、审批中断收敛与恢复幂等，不涉及真实 Runtime。 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@autopilot-agent/core";
import { createPresentationState, reducePresentationInput, reconcilePresentationApprovals, restorePresentationApproval, selectRequiredApprovals, selectTurnExecutionMs } from "../../../src/index.js";

/** 用单调 seq 和可控执行时间创建真实 reducer 输入。 */
function apply(state: ReturnType<typeof createPresentationState>, seq: number, seconds: number, event: Record<string, unknown>) {
  return reducePresentationInput(state, { kind: "runtime_event", envelope: { sessionId: "s", turnId: "t", seq, timestamp: new Date(seconds * 1000).toISOString(), event: { turnId: "t", ...event } as AgentEvent } });
}

/** 生成与实际 Core 事件同形的审批请求，保留不同 callId 以防只按工具名收敛。 */
function approval(approvalId: string, callId: string) {
  return { type: "approval_required", stepId: "step", callId, toolName: "write_file", result: { status: "approval_required", approval: { approvalId, callId, toolName: "write_file", normalizedInputHash: "hash", risk: "write", reason: "确认", preview: {}, expiresAt: new Date(1e13).toISOString(), allowedDecisions: ["allow_once", "deny"] } } };
}

describe("manual execution clock and approvals", function suite() {
  it("审批、问答、暂停与中断都冻结；重复启动不清零，Summary 与活动行累计一致", function executionSegments() {
    let state = apply(createPresentationState(), 0, 0, { type: "turn_started", stepCount: 0 });
    state = apply(state, 1, 10, approval("old", "old-call"));
    state = apply(state, 2, 11, { type: "turn_paused", checkpoint: {} });
    expect(selectTurnExecutionMs(state, "t", 90000)).toBe(10000);
    state = apply(state, 3, 95, { type: "turn_interrupted", checkpoint: {} });
    expect(selectRequiredApprovals(state)).toHaveLength(0);
    state = apply(state, 4, 100, { type: "turn_started", stepCount: 1 });
    expect(selectTurnExecutionMs(state, "t", 105000)).toBe(15000);
    state = apply(state, 5, 110, approval("new", "new-call"));
    expect(selectRequiredApprovals(state).map(function id(item) { return item.approvalId; })).toEqual(["new"]);
    state = apply(state, 6, 120, { type: "turn_interrupted", checkpoint: {} });
    state = restorePresentationApproval(state, "old");
    state = restorePresentationApproval(state, "new");
    expect(selectRequiredApprovals(state)).toHaveLength(0);
    expect(selectTurnExecutionMs(state, "t", 199000)).toBe(20000);
    state = apply(state, 7, 200, { type: "turn_started", stepCount: 2 });
    state = apply(state, 8, 220, { type: "question_required", requestId: "question", callId: "question-call", questions: [] });
    expect(selectTurnExecutionMs(state, "t", 500000)).toBe(40000);
    state = apply(state, 9, 600, { type: "turn_started", stepCount: 3 });
    state = apply(state, 10, 630, { type: "turn_completed", checkpoint: {} });
    expect(state.turnSummary?.durationMs).toBe(70000);
    expect(selectTurnExecutionMs(state, "t", 999000)).toBe(70000);
    expect(apply(state, 10, 630, { type: "turn_completed", checkpoint: {} })).toBe(state);
  });

  it("权威审批校准只保留当前 ID，缺少/过期身份全部撤卡", function authority() {
    let state = apply(createPresentationState(), 0, 0, { type: "turn_started", stepCount: 0 });
    state = apply(state, 1, 10, approval("old", "one"));
    state = apply(state, 2, 11, approval("current", "two"));
    const current = reconcilePresentationApprovals(state, "current");
    expect(selectRequiredApprovals(current).map(function id(item) { return item.approvalId; })).toEqual(["current"]);
    expect(selectRequiredApprovals(reconcilePresentationApprovals(state))).toHaveLength(0);
    expect(reconcilePresentationApprovals(state).activeOperation).toBeUndefined();
  });

  it("失败恢复请求没有 turn_started 时不能启动或增加执行时钟", function failedResume() {
    let state = apply(createPresentationState(), 0, 10, { type: "turn_started", stepCount: 0 });
    state = apply(state, 1, 15, { type: "turn_failed", checkpoint: {}, error: "fixture" });
    expect(state.executionByTurn?.t.runningSince).toBeUndefined();
    expect(selectTurnExecutionMs(state, "t", 1e9)).toBe(5000);
  });
});
