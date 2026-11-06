/** S3 问题保存后的正式展示入口静态验证；真实DOM提交生命周期交用户实机验收。 */
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createPresentationState, type UserQuestionItem } from "@autopilot-agent/presentation";
import TurnPresentation from "@/app/chat/components/TurnPresentation";

/** 从安全问题DTO形成已回答快照，不携带答案正文或猜测选项摘要。 */
it("S3 正式TurnPresentation已答问题显示保存事实且没有再次编辑答案入口", function savedPresentation() {
  const question: UserQuestionItem = { id: "question:q1", kind: "user_question", turnId: "turn", requestId: "q1", callId: "call", state: "answered", questions: [{ id: "scope", header: "范围", question: "选择范围", options: [{ label: "小", description: "最小" }, { label: "全", description: "全部" }] }] };
  const markup = renderToStaticMarkup(<TurnPresentation state={{ ...createPresentationState(), turnId: "turn", items: [question] }} turnId="turn" showThinking={false} onApprovalDecision={async function approve() {}} onUserQuestionSubmit={async function answer() {}} onUserQuestionCancel={function cancel() {}} />);
  expect(markup).toContain("答案已保存");
  expect(markup).not.toContain("已提供补充说明");
  expect(markup).not.toContain("提交并继续");
});
