/** S1 独立最小复现：恢复同一 Turn 后 render_ui 的配额与 callId 去重不得重置。 */
import { describe, expect, it } from "vitest";
import { createRenderUiTool } from "../../../src/internal/tools/builtins/render-ui-tool";
import type { ToolExecutionContext } from "../../../src/internal/tools/types";

const validInput = {
  title: "安全交互块",
  fallbackText: "安全文字说明。",
  spec: {
    root: "text",
    elements: { text: { type: "Text", props: { value: "有限文字", size: "md", tone: "ink" } } },
  },
};

/** 为同一 Turn 的不同 Runtime run 实例构造相同 callId 关联上下文。 */
function createToolContext(toolCallId: string): ToolExecutionContext {
  return { permissionMode: "ask", toolCallId };
}

describe("render_ui recovery budget", function suite() {
  it("恢复同一 Turn 时继续去重并保留三块上限", async function preservesBudgetAcrossRecovery() {
    const published: string[] = [];
    const firstRun = createRenderUiTool(function recordFirstRun(callId) { published.push(callId); });
    await firstRun.execute(validInput, createToolContext("call-1"));
    await firstRun.execute(validInput, createToolContext("call-2"));
    await firstRun.execute(validInput, createToolContext("call-3"));

    // 新工厂由 Runtime 从私有 checkpoint/持久发布事件恢复已发布身份；真实入口另有契约用例。
    const recoveredCallIds = JSON.parse(JSON.stringify(published)) as string[];
    const resumedRun = createRenderUiTool(function recordResumedRun(callId) { published.push(callId); }, recoveredCallIds);
    const emittedBeforeDuplicate = published.length;
    await resumedRun.execute(validInput, createToolContext("call-3"));
    const duplicateSuppressed = published.length === emittedBeforeDuplicate;

    let fourthCallRejected = false;
    try {
      await resumedRun.execute(validInput, createToolContext("call-4"));
    } catch {
      fourthCallRejected = true;
    }

    expect({ duplicateSuppressed, fourthCallRejected, published }).toEqual({
      duplicateSuppressed: true,
      fourthCallRejected: true,
      published: ["call-1", "call-2", "call-3"],
    });
  });
});
