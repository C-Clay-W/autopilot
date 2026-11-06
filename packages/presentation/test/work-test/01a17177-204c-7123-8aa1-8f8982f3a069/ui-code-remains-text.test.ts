/** S3 接收边界：普通 JSON/TSX 正文始终是回答，只有结构化事件生成 UI 项。 */
import { describe, expect, it } from "vitest";
import {
  createPresentationState,
  reducePresentationInput,
  selectTurnTimeline,
  selectUiDocuments,
} from "../../../src/index.js";
import { createSavingsFixture, uiEnvelope } from "../../../test/interactive-ui.fixture.js";

describe("S3 ordinary code stays text", function suite() {
  it("不把看似 JSON 或 TSX 的普通回答升级为 UI，只接收结构化 ui_document 事件", function eventBoundary() {
    const codeLikeAnswer = "{\"type\":\"Button\",\"props\":{\"action\":\"continue_chat\"}}\n```tsx\n<button>继续</button>\n```";
    const answer = reducePresentationInput(createPresentationState(), {
      kind: "runtime_event",
      envelope: uiEnvelope(1, { type: "answer_delta", turnId: "turn-code", stepId: "step", delta: codeLikeAnswer }, "turn-code"),
    });

    expect(selectUiDocuments(answer, "turn-code")).toEqual([]);
    expect(selectTurnTimeline(answer, "turn-code")).toMatchObject([
      { kind: "assistant_answer", content: codeLikeAnswer },
    ]);

    const structured = reducePresentationInput(answer, {
      kind: "runtime_event",
      envelope: uiEnvelope(2, { type: "ui_document", turnId: "turn-code", stepId: "step", callId: "ui-1", document: createSavingsFixture() }, "turn-code"),
    });
    expect(selectUiDocuments(structured, "turn-code")).toHaveLength(1);
    expect(selectTurnTimeline(structured, "turn-code").map(function kind(item) { return item.kind; })).toEqual(["assistant_answer", "ui_document"]);
  });
});
