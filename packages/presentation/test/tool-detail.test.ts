/**
 * 工具明细的 Presentation 投影测试：Live 与 History 必须原样保留 Core 生成的同一份 detail。
 */
import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, ToolDisplayDetail, ToolDisplayFacts } from "@autopilot-agent/core";
import type { AgentPresentationState, ToolCallItem } from "../src/index.js";
import { createPresentationState, reducePresentationInput, replayPresentationInputs, selectTimeline, selectToolCalls } from "../src/index.js";
import { createToolDetailFixture, GLOB_DETAIL, GLOB_TRUNCATED_DETAIL, GREP_CONTENT_DETAIL, GREP_COUNTS_DETAIL, GREP_PATHS_DETAIL, READ_DETAIL } from "./tool-detail.fixture.js";

const ORDERED_CALL_IDS = [
  "call-read-1",
  "call-glob-found",
  "call-glob-truncated",
  "call-grep-content",
  "call-grep-paths",
  "call-grep-counts",
  "call-read-legacy",
];

/** 按 callId 取出唯一工具节点；同一 callId 必须原位更新而不是新增节点。 */
function findCall(state: AgentPresentationState, turnId: string, callId: string): ToolCallItem {
  const matched = selectToolCalls(state, turnId).filter(function byCallId(call) { return call.callId === callId; });
  expect(matched).toHaveLength(1);
  return matched[0];
}

/** 用固定序号构造可排序的 Runtime 信封。 */
function runtimeEvent(sessionId: string, turnId: string, seq: number, event: AgentEventEnvelope["event"]): { kind: "runtime_event"; envelope: AgentEventEnvelope } {
  return { kind: "runtime_event", envelope: { seq, sessionId, turnId, timestamp: `2026-08-25T10:00:${String(seq).padStart(2, "0")}.000Z`, event } };
}

/** 构造带 display.detail 的成功 tool_result 信封。 */
function toolResult(sessionId: string, turnId: string, seq: number, callId: string, toolName: string, display: ToolDisplayFacts): { kind: "runtime_event"; envelope: AgentEventEnvelope } {
  return runtimeEvent(sessionId, turnId, seq, {
    type: "tool_result",
    turnId,
    stepId: "step-1",
    callId,
    toolName,
    retryCount: 0,
    summary: "RAW_TOOL_RESULT_SUMMARY_MUST_NOT_RENDER",
    result: {
      status: "success",
      callId,
      toolName,
      output: "RAW_TOOL_OUTPUT_MUST_NOT_RENDER",
      meta: { durationMs: 12, inputHash: "hash" },
      display,
    },
  });
}

const READ_DISPLAY: ToolDisplayFacts = { titleKey: "tool.read.completed", target: "agent/API-Design.md", summary: "已读取第 205–245 行 · 共 912 行", detail: READ_DETAIL };

describe("工具明细的 Presentation 投影", function toolDetailPresentationSuite() {
  it("History 回放原样保留 Core 生成的专用明细", function replayKeepsDetail() {
    const history = replayPresentationInputs(createToolDetailFixture());

    expect(findCall(history, "turn-detail", "call-read-1").detail).toEqual(READ_DETAIL);
    expect(findCall(history, "turn-detail", "call-glob-found").detail).toEqual(GLOB_DETAIL);
    expect(findCall(history, "turn-detail", "call-grep-content").detail).toEqual(GREP_CONTENT_DETAIL);
    expect(findCall(history, "turn-detail", "call-grep-paths").detail).toEqual(GREP_PATHS_DETAIL);
    expect(findCall(history, "turn-detail", "call-grep-counts").detail).toEqual(GREP_COUNTS_DETAIL);
  });

  it("执行截断时保留截断事实且不出现被推断的总数", function keepsUnknownTotal() {
    const history = replayPresentationInputs(createToolDetailFixture());
    const detail = findCall(history, "turn-detail", "call-glob-truncated").detail;

    expect(detail).toEqual(GLOB_TRUNCATED_DETAIL);
    expect(detail && "totalCount" in detail).toBe(false);
  });

  it("Live 增量归并与 History 回放得到同一批工具节点", function liveMatchesHistory() {
    const inputs = createToolDetailFixture();
    const live = inputs.reduce(reducePresentationInput, createPresentationState());
    const history = replayPresentationInputs(inputs);

    expect(findCall(live, "turn-detail", "call-read-1").detail).toEqual(READ_DETAIL);
    expect(findCall(live, "turn-detail", "call-grep-content").detail).toEqual(GREP_CONTENT_DETAIL);
    expect(selectToolCalls(live, "turn-detail")).toEqual(selectToolCalls(history, "turn-detail"));
  });

  it("旧 transcript 缺少 detail 时保持通用回退且不报错", function fallsBackForLegacyEvents() {
    const legacy = findCall(replayPresentationInputs(createToolDetailFixture()), "turn-detail", "call-read-legacy");

    expect(legacy).toMatchObject({ state: "completed", target: "agent/Design.md", resultSummary: "read" });
    expect(legacy.detail).toBeUndefined();
  });

  it("专用明细不改变 exploration 分组，组内每个 callId 仍保留各自明细", function keepsGroupingAndSafety() {
    const history = replayPresentationInputs(createToolDetailFixture());
    const group = selectTimeline(history).find(function findGroup(item) { return item.kind === "tool_group"; });

    expect(group).toMatchObject({ groupKey: "exploration", toolCallIds: ORDERED_CALL_IDS });
    expect(findCall(history, "turn-detail", "call-glob-truncated").detail).toEqual(GLOB_TRUNCATED_DETAIL);
    expect(JSON.stringify(history)).not.toContain("RAW_");
  });

  it("running 阶段只有类别事实，完成后同一 callId 原位补齐 detail", function fillsDetailInPlaceOnCompletion() {
    const inputs = [
      runtimeEvent("session-runtime", "turn-runtime", 0, { type: "turn_started", turnId: "turn-runtime", stepCount: 0 }),
      runtimeEvent("session-runtime", "turn-runtime", 1, { type: "tool_started", turnId: "turn-runtime", stepId: "step-1", callId: "call-read-1", toolName: "read_file", summary: "RAW_START_MUST_NOT_RENDER" }),
    ];
    const running = inputs.reduce(reducePresentationInput, createPresentationState());
    const runningCall = findCall(running, "turn-runtime", "call-read-1");

    expect(runningCall.state).toBe("running");
    expect(runningCall.detail).toBeUndefined();

    const completed = replayPresentationInputs([
      ...inputs,
      toolResult("session-runtime", "turn-runtime", 2, "call-read-1", "read_file", READ_DISPLAY),
    ]);
    const completedCall = findCall(completed, "turn-runtime", "call-read-1");

    expect(completedCall.state).toBe("completed");
    expect(completedCall.detail).toEqual(READ_DETAIL);
    expect(selectToolCalls(completed, "turn-runtime")).toHaveLength(1);
  });

  it("审批恢复后同一 callId 原位补齐 detail，不新增工具节点", function resumesApprovalWithDetail() {
    const approval = {
      approvalId: "approval-read-1",
      callId: "call-read-approval",
      toolName: "read_file",
      normalizedInputHash: "hash",
      reason: "RAW_APPROVAL_REASON_MUST_NOT_RENDER",
      risk: "read_only" as const,
      preview: {},
      expiresAt: "2026-08-25T11:00:00.000Z",
      allowedDecisions: ["allow_once", "deny"] as const,
      display: { operation: "read", effect: "none" as const, destructive: false, resource: "agent/API-Design.md", risk: "read_only", allowedDecisions: ["allow_once", "deny"] as const },
    };
    const awaiting = replayPresentationInputs([
      runtimeEvent("session-approval", "turn-approval", 0, { type: "turn_started", turnId: "turn-approval", stepCount: 0 }),
      runtimeEvent("session-approval", "turn-approval", 1, { type: "tool_started", turnId: "turn-approval", stepId: "step-1", callId: "call-read-approval", toolName: "read_file", summary: "RAW_START_MUST_NOT_RENDER" }),
      runtimeEvent("session-approval", "turn-approval", 2, {
        type: "approval_required",
        turnId: "turn-approval",
        stepId: "step-1",
        callId: "call-read-approval",
        toolName: "read_file",
        result: { status: "approval_required", callId: "call-read-approval", toolName: "read_file", approval, display: { titleKey: "tool.read.completed", target: "agent/API-Design.md" } },
      }),
    ]);
    const awaitingCall = findCall(awaiting, "turn-approval", "call-read-approval");

    expect(awaitingCall.state).toBe("awaiting_approval");
    expect(awaitingCall.detail).toBeUndefined();

    const resumed = replayPresentationInputs([
      { kind: "runtime_event", envelope: { seq: 0, sessionId: "session-approval", turnId: "turn-approval", timestamp: "2026-08-25T10:00:00.000Z", event: { type: "turn_started", turnId: "turn-approval", stepCount: 0 } } },
      { kind: "runtime_event", envelope: { seq: 1, sessionId: "session-approval", turnId: "turn-approval", timestamp: "2026-08-25T10:00:01.000Z", event: { type: "tool_started", turnId: "turn-approval", stepId: "step-1", callId: "call-read-approval", toolName: "read_file", summary: "RAW_START_MUST_NOT_RENDER" } } },
      { kind: "runtime_event", envelope: { seq: 2, sessionId: "session-approval", turnId: "turn-approval", timestamp: "2026-08-25T10:00:02.000Z", event: { type: "approval_required", turnId: "turn-approval", stepId: "step-1", callId: "call-read-approval", toolName: "read_file", result: { status: "approval_required", callId: "call-read-approval", toolName: "read_file", approval, display: { titleKey: "tool.read.completed", target: "agent/API-Design.md" } } } } },
      toolResult("session-approval", "turn-approval", 3, "call-read-approval", "read_file", READ_DISPLAY),
    ]);

    expect(findCall(resumed, "turn-approval", "call-read-approval")).toMatchObject({ state: "completed", detail: READ_DETAIL });
    expect(selectToolCalls(resumed, "turn-approval")).toHaveLength(1);
    expect(resumed.items.filter(function approvalsOnly(item) { return item.kind === "approval" && item.callId === "call-read-approval"; })).toHaveLength(1);
    expect(resumed.items.find(function resolvedApproval(item) { return item.kind === "approval" && item.callId === "call-read-approval"; })).toMatchObject({ state: "resolved" });
  });

  it("continue/recovery 的重复与乱序信封幂等回放，detail 不被覆盖或清空", function replaysRecoveryIdempotently() {
    const first = toolResult("session-recovery", "turn-recovery", 2, "call-read-1", "read_file", READ_DISPLAY);
    // 第二个调用刻意用 read_file 携带 glob 明细：reducer 只原样复制 detail，从不按 toolName 重新解析。
    const tail = toolResult("session-recovery", "turn-recovery", 3, "call-read-2", "read_file", { titleKey: "tool.read.completed", target: "apps/web/page.tsx", summary: "已读取第 1–10 行 · 共 100 行", detail: GLOB_DETAIL });
    const unordered = [
      runtimeEvent("session-recovery", "turn-recovery", 0, { type: "turn_started", turnId: "turn-recovery", stepCount: 0 }),
      tail,
      runtimeEvent("session-recovery", "turn-recovery", 1, { type: "tool_started", turnId: "turn-recovery", stepId: "step-1", callId: "call-read-1", toolName: "read_file", summary: "RAW_START_MUST_NOT_RENDER" }),
      first,
      first,
      runtimeEvent("session-recovery", "turn-recovery", 4, { type: "turn_completed", turnId: "turn-recovery", checkpoint: {} }),
    ];

    const state = replayPresentationInputs(unordered);
    const calls = selectToolCalls(state, "turn-recovery");

    expect(calls).toHaveLength(2);
    expect(findCall(state, "turn-recovery", "call-read-1").detail).toEqual(READ_DETAIL);
    expect(findCall(state, "turn-recovery", "call-read-2").detail).toEqual(GLOB_DETAIL);
    expect(state.turnSummary?.toolCount).toBe(2);
  });

  it("ToolCallItem.detail 直接引用 Core 的 ToolDisplayDetail，不出现本地复制类型", function usesCoreDetailType() {
    const detail: ToolDisplayDetail = READ_DETAIL;
    expect(detail.kind).toBe("read_file");
  });
});
