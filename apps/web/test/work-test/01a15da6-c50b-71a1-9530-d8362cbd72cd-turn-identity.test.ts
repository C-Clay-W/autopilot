/** Tester r001 focused edge cases for Turn-scoped identity and approval restoration. */
import { describe, expect, it } from "vitest";
import { createPresentationState, reducePresentationInput, restorePresentationApproval, type PresentationInput, type ToolCallItem, type ApprovalItem } from "@autopilot-agent/presentation";
import type { AgentEvent } from "@autopilot-agent/core";

function runtimeInput(turnId: string, seq: number, timestamp: string, event: AgentEvent): PresentationInput {
  return {
    kind: "runtime_event",
    envelope: { sessionId: "shared-session", turnId, seq, timestamp, event },
  };
}

describe("Presentation Turn identity boundaries", function suite() {
  it("同一供应商 callId 在不同 Turn 下保留独立节点与当前活动身份", function keepsTurnScopedToolIdentity() {
    let state = createPresentationState();
    state = reducePresentationInput(state, runtimeInput("turn-old", 1, "2026-10-21T00:00:00.000Z", { type: "turn_started", turnId: "turn-old", stepCount: 0 }));
    state = reducePresentationInput(state, runtimeInput("turn-old", 2, "2026-10-21T00:00:01.000Z", { type: "tool_started", turnId: "turn-old", stepId: "step-old", callId: "same-provider-id", toolName: "read_file", summary: "old" }));
    state = reducePresentationInput(state, runtimeInput("turn-old", 3, "2026-10-21T00:00:01.500Z", {
      type: "tool_result",
      turnId: "turn-old",
      stepId: "step-old",
      callId: "same-provider-id",
      toolName: "read_file",
      retryCount: 0,
      summary: "old completed",
      result: {
        status: "success",
        callId: "same-provider-id",
        toolName: "read_file",
        output: {},
        meta: { durationMs: 1, inputHash: "fixture-hash" },
        display: { titleKey: "tool.read.completed", target: "README.md", summary: "1 行" },
      },
    }));
    state = reducePresentationInput(state, runtimeInput("turn-new", 1, "2026-10-21T00:00:02.000Z", { type: "turn_started", turnId: "turn-new", stepCount: 0 }));
    state = reducePresentationInput(state, runtimeInput("turn-new", 2, "2026-10-21T00:00:03.000Z", { type: "reasoning_summary", turnId: "turn-new", stepId: "step-new", summary: "new" }));
    state = reducePresentationInput(state, runtimeInput("turn-new", 3, "2026-10-21T00:00:04.000Z", { type: "tool_started", turnId: "turn-new", stepId: "step-new", callId: "same-provider-id", toolName: "open_preview", summary: "new" }));

    expect(state.items.filter(function tool(item) { return item.kind === "tool_call"; })).toHaveLength(2);
    expect(state.items).toContainEqual(expect.objectContaining({ kind: "tool_call", turnId: "turn-old", callId: "same-provider-id", state: "completed" }));
    expect(state.items).toContainEqual(expect.objectContaining({ kind: "tool_call", turnId: "turn-new", callId: "same-provider-id", state: "running" }));
    expect(state.activeOperation).toEqual({ kind: "tool", id: "tool:turn-new:same-provider-id" });
    expect(state.turnId).toBe("turn-new");
  });

  it("restorePresentationApproval resolves the matching Turn when callIds collide", function restoresTurnScopedApproval() {
    const oldTool: ToolCallItem = { id: "tool:turn-old:same", kind: "tool_call", turnId: "turn-old", stepId: "step-old", callId: "same", toolName: "open_preview", profileKey: "unknown", category: "other", state: "completed", titleKey: "tool.other.completed" };
    const newTool: ToolCallItem = { id: "tool:turn-new:same", kind: "tool_call", turnId: "turn-new", stepId: "step-new", callId: "same", toolName: "open_preview", profileKey: "unknown", category: "other", state: "awaiting_approval", titleKey: "tool.other.running" };
    const approval: ApprovalItem = { id: "approval:approval-new", kind: "approval", turnId: "turn-new", approvalId: "approval-new", callId: "same", toolName: "open_preview", state: "resolved" };
    const state = { ...createPresentationState(), turnId: "turn-new", items: [oldTool, newTool, approval] };
    const restored = restorePresentationApproval(state, "approval-new");
    expect(restored.items).toContainEqual(expect.objectContaining({ kind: "approval", turnId: "turn-new", approvalId: "approval-new", state: "required" }));
  });
});
