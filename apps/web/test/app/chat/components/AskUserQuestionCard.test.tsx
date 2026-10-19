/** AskUserQuestionCard 测试：锁定推荐标记、立体边框与安全的单选/补充结构。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UserQuestionItem } from "@autopilot-agent/presentation";
import AskUserQuestionCard from "@/app/chat/components/AskUserQuestionCard";

/** 构造含两道题的安全 Presentation fixture。 */
function createQuestion(): UserQuestionItem {
  return {
    id: "question:request-1",
    kind: "user_question",
    turnId: "turn-1",
    requestId: "request-1",
    callId: "call-1",
    state: "required",
    questions: [
      { id: "scope", header: "范围", question: "这次如何处理？", options: [{ label: "最小修复", description: "只处理当前问题" }, { label: "顺手整理", description: "同时重构相邻代码" }] },
      { id: "验证", header: "验证", question: "需要哪些验证？", options: [{ label: "定向测试", description: "只运行相关测试" }, { label: "全量测试", description: "运行全部测试" }] },
    ],
  };
}

describe("AskUserQuestionCard", function askUserQuestionCardSuite() {
  it("以首项显示推荐标记，并提供立体卡片、radio 与固定 Other 输入", function rendersRecommendedOptionAndSafeControls() {
    const markup = renderToStaticMarkup(<AskUserQuestionCard question={createQuestion()} onSubmit={async function submitAnswers() {}} onCancel={function cancelTurn() {}} />);

    expect(markup).toContain("最小修复（推荐）");
    expect(markup).not.toContain("顺手整理（推荐）");
    expect(markup).toContain("shadow-[4px_4px_0_var(--ink)]");
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('role="radio"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("其他 / 补充说明");
    expect(markup).toContain('role="tablist"');
  });
});
