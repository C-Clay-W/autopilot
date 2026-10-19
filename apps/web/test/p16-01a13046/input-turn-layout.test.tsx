/** P16 Web 回归：安全 Inbox/消费事件恢复、Turn 内原文与 Todo 顺序。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, InboxInput } from "@autopilot-agent/core";
import { capturePresentationInputPosition, createPresentationState, reducePresentationInput } from "@autopilot-agent/presentation";
import { restoreWebInputPresentation } from "@/lib/runtime-host/web-input-presentation";
import { replayWebPresentation, reduceWebPresentationEvent } from "@/lib/runtime-host/web-presentation-adapter";
import TurnPresentation from "@/app/chat/components/TurnPresentation";

/** 构造同一会话的公开安全事件序列，不放入私有 checkpoint。 */
function events(): AgentEventEnvelope[] {
  return [
    { type: "turn_started", turnId: "A", stepCount: 0 },
    { type: "answer_delta", turnId: "A", stepId: "s", delta: "消费前过程" },
    { type: "input_consumed", turnId: "A", inputId: "steer" },
    { type: "answer_delta", turnId: "A", stepId: "s", delta: "消费后过程" },
    { type: "todo_updated", turnId: "A", todoChainId: "chain", todos: [{ content: "本轮任务", activeForm: "本轮任务", status: "completed" }], counts: { pending: 0, inProgress: 0, completed: 1 } },
    { type: "turn_completed", turnId: "A", checkpoint: { turnId: "A", status: "completed", stepCount: 1 } },
  ].map(function envelope(event, index) { return { sessionId: "session", turnId: "A", seq: index + 1, timestamp: new Date(1000 + index * 1000).toISOString(), event } as AgentEventEnvelope; });
}

/** 构造已消费 Inbox 引用；附件与 Skill 正文从不进入展示字段。 */
function input(): InboxInput {
  return { inputId: "steer", sessionId: "session", turnId: "A", delivery: "steer", status: "consumed", content: "引导独特原文\n@docs/a.md", clientMessageId: "client", attachments: [{ id: "file", name: "a.png", mimeType: "image/png", relativePath: "PRIVATE_PATH" }], selectedSkills: [], createdAt: new Date(2000).toISOString() };
}

describe("P16 Web input Turn layout", function suite() {
  it("History 使用安全消费边界恢复原文一次，Todo 位于 Summary 前且不泄漏附件", function historyInput() {
    const envelopes = events();
    const state = restoreWebInputPresentation(replayWebPresentation(envelopes), envelopes, [input()]);
    const markup = renderToStaticMarkup(<TurnPresentation state={state} turnId="A" showThinking onApprovalDecision={function ignore() {}} onUserQuestionSubmit={async function ignore() {}} onUserQuestionCancel={function ignore() {}} />);
    expect(markup.indexOf("消费前过程")).toBeLessThan(markup.indexOf("引导独特原文"));
    expect(markup.indexOf("引导独特原文")).toBeLessThan(markup.indexOf("消费后过程"));
    expect(markup.indexOf("Todo")).toBeLessThan(markup.indexOf("Turn Summary"));
    expect(markup.split("引导独特原文")).toHaveLength(2);
    expect(markup).not.toContain("PRIVATE_PATH");
    const nextTurn = renderToStaticMarkup(<TurnPresentation state={state} turnId="B" showThinking onApprovalDecision={function ignore() {}} onUserQuestionSubmit={async function ignore() {}} onUserQuestionCancel={function ignore() {}} />);
    expect(nextTurn).not.toContain("Todo");
  });

  it("消费先到POST确认后到仍补一次原文且保留原轮", function lateConfirmedInput() {
    let state = createPresentationState();
    state = reduceWebPresentationEvent(state, { type: "turn_started", turnId: "A", seq: 1 }, "session");
    const position = capturePresentationInputPosition(state, "A", 1);
    state = reduceWebPresentationEvent(state, { type: "input_consumed", turnId: "A", inputId: "steer", seq: 2 }, "session");
    state = reducePresentationInput(state, { kind: "host_event", event: { kind: "input", input: { inputId: "steer", turnId: "B", content: input().content, delivery: "steer", position, state: "queued" } } });
    expect(state.items.find(function one(item) { return item.kind === "input_notice"; })).toMatchObject({ content: input().content, turnId: "A", state: "consumed" });
  });
});
