/** S2 定向投影：安全文档、时间线位置、重放幂等、旧历史和故障兼容。 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@autopilot-agent/core";
import { createPresentationState, reducePresentationInput, replayPresentationInputs, selectTurnTimeline, selectUiDocuments } from "../src/index.js";
import { createSavingsFixture, createUiEnvelopes, uiEnvelope } from "./interactive-ui.fixture.js";

describe("S2 interactive UI presentation", function suite() {
  it("同一事件 Live 与乱序 History 一致，UI 截开同一步文字且不受 reset/终态影响", function replay() {
    const events = createUiEnvelopes();
    const inputs = events.map(function input(envelope) { return { kind: "runtime_event" as const, envelope }; });
    const live = inputs.reduce(reducePresentationInput, createPresentationState());
    const history = replayPresentationInputs([...inputs].reverse());
    expect(history).toEqual(live);
    const timeline = selectTurnTimeline(live, "turn-ui");
    expect(timeline.map(function kind(item) { return item.kind; })).toEqual(["assistant_answer", "ui_document", "assistant_answer", "assistant_answer", "turn_summary"]);
    expect(timeline.filter(function text(item) { return item.kind === "assistant_answer"; }).map(function content(item) { return item.kind === "assistant_answer" ? item.content : ""; })).toEqual(["前文", "后文", "总结"]);
    expect(selectUiDocuments(live, "turn-ui")[0].document).toEqual(createSavingsFixture());
    expect(reducePresentationInput(live, inputs[2])).toBe(live);
  });

  it("同一 Turn 的多个独立 UI 块按事件顺序回放并保留文字分隔", function multiBlockReplay() {
    const firstDocument = createSavingsFixture();
    const secondDocument = { ...firstDocument, uiId: `ui_${"1".repeat(32)}`, title: "预算对照" };
    const events = [
      uiEnvelope(0, { type: "answer_delta", turnId: "turn-ui", stepId: "step", delta: "行程说明" }),
      uiEnvelope(1, { type: "ui_document", turnId: "turn-ui", stepId: "step", callId: "ui-trip", document: firstDocument }),
      uiEnvelope(2, { type: "answer_delta", turnId: "turn-ui", stepId: "step", delta: "预算说明" }),
      uiEnvelope(3, { type: "ui_document", turnId: "turn-ui", stepId: "step", callId: "ui-budget", document: secondDocument }),
      uiEnvelope(4, { type: "ui_document", turnId: "turn-ui", stepId: "step", callId: "ui-trip", document: { ...firstDocument, title: "重复块不得覆盖" } }),
      uiEnvelope(5, { type: "answer_delta", turnId: "turn-ui", stepId: "step", delta: "结尾" }),
    ];
    const inputs = events.map(function input(envelope) { return { kind: "runtime_event" as const, envelope }; });
    const live = inputs.reduce(reducePresentationInput, createPresentationState());
    const history = replayPresentationInputs([...inputs].reverse());

    expect(history).toEqual(live);
    expect(selectTurnTimeline(live, "turn-ui").map(function kind(item) { return item.kind; })).toEqual([
      "assistant_answer", "ui_document", "assistant_answer", "ui_document", "assistant_answer",
    ]);
    expect(selectTurnTimeline(live, "turn-ui").filter(function isAnswer(item) { return item.kind === "assistant_answer"; }).map(function content(item) { return item.kind === "assistant_answer" ? item.content : ""; })).toEqual([
      "行程说明", "预算说明", "结尾",
    ]);
    expect(selectUiDocuments(live, "turn-ui").map(function title(item) { return item.title; })).toEqual([
      firstDocument.title, "预算对照",
    ]);
  });

  it("同一 uiId 不更新旧块，不同 Turn 保持独立，工具分组在 UI 处断开", function identity() {
    const document = createSavingsFixture();
    const events = [
      uiEnvelope(1, { type: "tool_started", turnId: "turn-ui", stepId: "step", callId: "read1", toolName: "read_file" } as AgentEvent),
      uiEnvelope(2, { type: "ui_document", turnId: "turn-ui", stepId: "step", callId: "ui1", document }),
      uiEnvelope(3, { type: "ui_document", turnId: "turn-ui", stepId: "step", callId: "ui1", document: { ...document, title: "不可覆盖" } }),
      uiEnvelope(4, { type: "tool_started", turnId: "turn-ui", stepId: "step", callId: "read2", toolName: "read_file" } as AgentEvent),
      uiEnvelope(5, { type: "ui_document", turnId: "turn-other", stepId: "step", callId: "ui1", document }, "turn-other"),
    ];
    const state = replayPresentationInputs(events.map(function input(envelope) { return { kind: "runtime_event", envelope }; }));
    expect(selectUiDocuments(state, "turn-ui")).toHaveLength(1);
    expect(selectUiDocuments(state, "turn-ui")[0].title).toBe(document.title);
    expect(selectUiDocuments(state, "turn-other")[0].id).not.toBe(selectUiDocuments(state, "turn-ui")[0].id);
    expect(selectTurnTimeline(state, "turn-ui").map(function kind(item) { return item.kind; })).toEqual(["tool_call", "ui_document", "tool_call"]);
  });

  it("非法节点及未知版本只存文字回退，旧历史仍只含文字", function invalid() {
    const document = createSavingsFixture();
    for (const invalid of [{ ...document, schemaVersion: 99 }, { ...document, spec: { root: "bad", elements: { bad: { type: "script", props: { html: "RAW_SPEC" } } } } }]) {
      const state = replayPresentationInputs([{ kind: "runtime_event", envelope: uiEnvelope(1, { type: "ui_document", turnId: "turn-ui", stepId: "s", callId: "ui1", document: invalid } as unknown as AgentEvent) }]);
      expect(selectUiDocuments(state, "turn-ui")[0].document).toBeUndefined();
      expect(JSON.stringify(state)).not.toContain("RAW_SPEC");
      expect(selectUiDocuments(state, "turn-ui")[0].fallbackText).toBe(document.fallbackText);
    }
    const old = replayPresentationInputs([{ kind: "runtime_event", envelope: uiEnvelope(1, { type: "answer_delta", turnId: "turn-ui", stepId: "s", delta: "旧记录" }) }]);
    expect(selectUiDocuments(old, "turn-ui")).toEqual([]);
    expect(selectTurnTimeline(old, "turn-ui")[0]).toMatchObject({ kind: "assistant_answer", content: "旧记录" });
  });
});
