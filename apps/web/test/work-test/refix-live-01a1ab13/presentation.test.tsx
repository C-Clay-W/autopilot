/** r003 复制状态矩阵与受信内部约定的实时/历史展示。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createPresentationState } from "@autopilot-agent/presentation";
import ChatMessageItem from "@/app/chat/components/ChatMessageItem";
import TurnPresentation from "@/app/chat/components/TurnPresentation";
import { restoreWebInputPresentation } from "@/lib/runtime-host/web-input-presentation";
import { replayWebPresentation, reduceWebPresentationEvent } from "@/lib/runtime-host/web-presentation-adapter";
/** 渲染正式消息组件，所有无关动作使用空回调。 */
function markup(state: string | undefined, message: object = {}, currentTurn = "turn", extraItems: any[] = []) {
 const presentation: any = { ...createPresentationState(), turnId: currentTurn, items: [{ id: "answer", kind: "assistant_answer", turnId: "turn", stepId: "step", channel: "final", content: "回复正文" }, ...(state ? [{ id: "summary", kind: "turn_summary", turnId: "turn", state, toolCount: 0 }] : []), ...extraItems] };
 const props: any = { msg: { id: "assistant", role: "assistant", turnId: "turn", content: "", ...message }, workspaceId: "workspace", sessionId: "session", isChat: false, presentation, showProcess: false, loading: true, canWrite: true, renderEvidence: function empty() { return null; }, workPreview: undefined };
 return renderToStaticMarkup(createElement(ChatMessageItem, props));
}
it.each([
 [undefined, { activity: "answer" }, false], [undefined, {}, false], ["interrupted", { canContinue: true, termination: { recoverable: true } }, false],
 ["limit_reached", { canContinue: true }, false], ["completed", { activity: "answer" }, false], ["completed", {}, true], ["failed", {}, true], ["interrupted", { termination: { recoverable: false } }, true],
] as const)("r003 复制只由本Turn真实终态开放 %s %j", function copyMatrix(state, message, expected) {
 expect(markup(state, message).includes('aria-label="复制回复"')).toBe(expected);
});
it("r003 历史完成消息不受新Turn loading影响且复制保持键盘可达", function historicalCopy() {
 const html = markup("completed", {}, "new-turn");
 expect(html).toContain('aria-label="复制回复"');
 expect(html).toContain("group-focus-within:opacity-100");
 expect(html).not.toContain("z-10 hidden");
});
it("r003 内部约定实时和历史投影一致、默认不占Prompt且过程详情保留，普通相同正文仍显示", function purposeProjection() {
 const envelope: any = { sessionId: "session", turnId: "turn", seq: 1, timestamp: "2026-11-05T12:00:00Z", event: { type: "input_joined", turnId: "turn", inputId: "internal" } };
 const inputs: any[] = [{ inputId: "internal", sessionId: "session", turnId: "turn", delivery: "steer", status: "consumed", content: "只在完成时汇报", origin: { kind: "thread", threadId: "parent", purpose: "reporting_agreement" }, attachments: [], selectedSkills: [], createdAt: envelope.timestamp }];
 const live = restoreWebInputPresentation(reduceWebPresentationEvent(createPresentationState(), { ...envelope.event, ...envelope, event: undefined, type: "input_joined", inputId: "internal" }, "session"), [envelope], inputs);
 const history = restoreWebInputPresentation(replayWebPresentation([envelope]), [envelope], inputs);
 expect(live.items).toEqual(history.items);
 /** 正式Turn组件消费同一用途字段。 */
 function render(state: any, showThinking: boolean) { return renderToStaticMarkup(createElement(TurnPresentation, { state, turnId: "turn", showThinking, onApprovalDecision: function noop() {}, onUserQuestionSubmit: async function noop() {}, onUserQuestionCancel: function noop() {} } as any)); }
 expect(render(history, false)).not.toContain("只在完成时汇报");
 expect(render(history, true)).toContain("内部汇报约定");
 expect(render(history, true)).toContain("只在完成时汇报");
 const user = restoreWebInputPresentation(replayWebPresentation([envelope]), [envelope], [{ ...inputs[0], origin: { kind: "thread", threadId: "parent" } }]);
 expect(render(user, false)).toContain("只在完成时汇报");
});

it.each(["approval", "user_question"])("r003 %s等待期间即使残留final片段也无复制", function waitingCopy(kind) {
 const html = markup("completed", {}, "turn", [{ id: "waiting", kind, turnId: "turn", state: "required", approvalId: "approval", requestId: "question", questions: [] }]);
 expect(html).not.toContain('aria-label="复制回复"');
});
it("r003 可恢复失败不复制，确认的不可恢复中断可复制", function recoveryCopy() {
 expect(markup("failed", { termination: { recoverable: true } })).not.toContain('aria-label="复制回复"');
 expect(markup("interrupted", { termination: { recoverable: false }, stopState: "stopped" })).toContain('aria-label="复制回复"');
});
