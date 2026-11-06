/** r010实机展示回归：审批恢复不伪造取消，真实取消结果仍按取消显示。 */
import { expect, it } from "vitest";
import { createPresentationState, reducePresentationInput } from "../../../src/index.js";
import type { AgentEvent } from "@autopilot-agent/core";

it("审批恢复关闭旧卡并继续处理工具，仅真实取消结果显示cancelled", function resumesWithoutFalseCancellation() {
  let state = createPresentationState(); let seq = 0;
  /** 用安全事件推进真实Presentation归约器，不直接改节点状态。 */
  function apply(event: AgentEvent) { state = reducePresentationInput(state, { kind: "runtime_event", envelope: { sessionId: "s", turnId: "t", seq: ++seq, timestamp: new Date(seq).toISOString(), event } }); }
  apply({ type: "tool_started", turnId: "t", stepId: "step", callId: "c", toolName: "run_command" } as AgentEvent);
  apply({ type: "approval_required", turnId: "t", stepId: "step", callId: "c", toolName: "run_command", result: { status: "approval_required", approval: { approvalId: "a", constraint: "test" } } } as AgentEvent);
  const awaiting = state;
  apply({ type: "turn_started", turnId: "t", stepCount: 1 });
  expect(state.items.find(function tool(item) { return item.kind === "tool_call"; })).toMatchObject({ state: "running" });
  expect(state.items.find(function approval(item) { return item.kind === "approval"; })).toMatchObject({ state: "resolved" });
  const resumed = state;
  apply({ type: "tool_result", turnId: "t", stepId: "step", callId: "c", toolName: "run_command", retryCount: 0, result: { status: "success", output: {} } } as AgentEvent);
  expect(state.items.find(function tool(item) { return item.kind === "tool_call"; })).toMatchObject({ state: "completed" });
  state = resumed;
  apply({ type: "tool_result", turnId: "t", stepId: "step", callId: "c", toolName: "run_command", retryCount: 0, result: { status: "cancelled", error: { code: "EXECUTION_CANCELLED", message: "合成取消" } } } as AgentEvent);
  expect(state.items.find(function tool(item) { return item.kind === "tool_call"; })).toMatchObject({ state: "cancelled" });
  state = awaiting;
  apply({ type: "turn_interrupted", turnId: "t", checkpoint: { status: "interrupted" } } as AgentEvent);
  expect(state.items.find(function tool(item) { return item.kind === "tool_call"; })).toMatchObject({ state: "cancelled" });
});
