/** 验证审批拒绝的中性展示和真实失败的保守边界。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentPresentationState } from "@autopilot-agent/presentation";
import TurnPresentation from "@/app/chat/components/TurnPresentation";
import { toWebTurnFailure } from "@/lib/runtime-host/web-turn-failure";

/** 构造由公开审批、工具结果和终态投影得到的状态。 */
function makeState(): AgentPresentationState {
  return { sessionId: "s", turnId: "t", appliedEventIds: [], lastSeqByTurn: {}, turnStartedAt: {}, items: [
    { id: "tool", kind: "tool_call", turnId: "t", callId: "c", toolName: "vision_analyze", profileKey: "other", category: "other", state: "denied", titleKey: "tool.other.failed", errorCode: "APPROVAL_REQUIRED", completedAt: "2026-01-01T00:00:01.000Z" },
    { id: "approval", kind: "approval", turnId: "t", callId: "c", approvalId: "a", toolName: "vision_analyze", state: "resolved" },
    { id: "summary", kind: "turn_summary", turnId: "t", state: "failed", toolCount: 1 },
  ] };
}
/** 以受控失败 DTO 渲染同轮展示。 */
function renderState(state: AgentPresentationState, code: string) {
  return renderToStaticMarkup(<TurnPresentation state={state} turnId="t" showThinking={false} failure={toWebTurnFailure(undefined, code, { failureStage: "tool_execution" })} onApprovalDecision={function ignore() {}} onUserQuestionSubmit={async function ignore() {}} onUserQuestionCancel={function ignore() {}} />);
}
describe("主动拒绝展示", function suite() {
  it("同调用审批拒绝显示中性终态", function denial() {
    const html = renderState(makeState(), "TOOL_DENIED");
    expect(html).toContain("用户已拒绝，本次任务已停止"); expect(html).toContain("用户已拒绝"); expect(html).not.toContain("反馈 ID"); expect(html).not.toContain("执行失败");
  });
  it.each(["PROVIDER_REQUEST_REJECTED", "TURN_EXECUTION_FAILED", "SANDBOX_UNAVAILABLE"])("真实失败 %s 保留失败框", function failure(code) {
    const html = renderState(makeState(), code); expect(html).toContain("反馈 ID"); expect(html).toContain("执行失败"); expect(html).not.toContain("用户已拒绝，本次任务已停止");
  });
  it("策略拒绝、缺审批及后续工具结果不伪装为用户拒绝", function conservative() {
    const state = makeState();
    for (const items of [state.items.filter(function noApproval(item) { return item.kind !== "approval"; }), state.items.map(function policy(item) { return item.kind === "tool_call" ? { ...item, errorCode: "COMMAND_FORBIDDEN" } : item; }), [...state.items, { id: "later", kind: "tool_call" as const, turnId: "t", callId: "later", toolName: "read_file", profileKey: "read_file", category: "read" as const, state: "failed" as const, titleKey: "tool.read.failed", completedAt: "2026-01-01T00:00:02.000Z" }]]) {
      const html = renderState({ ...state, items }, "TOOL_DENIED"); expect(html).toContain("反馈 ID"); expect(html).not.toContain("用户已拒绝，本次任务已停止");
    }
  });
  it("同批跳过不掩盖拒绝，而同一时间的真实错误保持保守", function tiesAndSkipped() {
    const state = makeState();
    const extra = { id: "extra", kind: "tool_call" as const, turnId: "t", callId: "extra", toolName: "read_file", profileKey: "read_file", category: "read" as const, state: "failed" as const, titleKey: "tool.read.failed", completedAt: "2026-01-01T00:00:01.000Z" };
    const skipped = renderState({ ...state, items: [...state.items, { ...extra, errorCode: "TOOL_NOT_EXECUTED_AFTER_DENIAL" }] }, "TOOL_DENIED");
    expect(skipped).toContain("用户已拒绝，本次任务已停止");
    const ambiguous = renderState({ ...state, items: [...state.items, { ...extra, errorCode: "TOOL_EXECUTION_FAILED" }] }, "TOOL_DENIED");
    expect(ambiguous).toContain("反馈 ID"); expect(ambiguous).not.toContain("用户已拒绝，本次任务已停止");
  });
});
