/** 执行过场的 Web 静态渲染与宿主探测错误投影，不访问真实服务。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createPresentationState, type AgentPresentationState, type ToolCallItem } from "@autopilot-agent/presentation";
import TurnPresentation from "@/app/chat/components/TurnPresentation";
import { createWorkPreviewService, WorkPreviewError } from "@/lib/workspace-host/work-preview-service";
import type { ProbeResult } from "@/lib/workspace-host/work-preview-readiness";

/** 用同一安全状态渲染过程开关与历史视图。 */
function render(state: AgentPresentationState, showThinking: boolean, readOnly = false): string {
  return renderToStaticMarkup(<TurnPresentation state={state} turnId="t" showThinking={showThinking} readOnly={readOnly} productMode="work" onApprovalDecision={function ignore() {}} onUserQuestionSubmit={async function ignore() {}} onUserQuestionCancel={function ignore() {}} />);
}

describe("Web 短行动过场", function suite() {
  it("过程开关与 History 都显示行动与已知失败；模型正文优先且系统来源不冒充模型", function rendersProgress() {
    const tool: ToolCallItem = { id: "tool:a", callId: "a", turnId: "t", stepId: "s", kind: "tool_call", toolName: "open_preview", category: "other", profileKey: "unknown", titleKey: "tool.other.running", state: "failed", errorCode: "PREVIEW_PAGE_NOT_FOUND" };
    const state = { ...createPresentationState(), items: [tool] };
    for (const show of [true, false]) {
      const markup = render(state, show, !show);
      expect(markup).toContain("检查预览页面是否可访问");
      expect(markup).toContain("预览页面不存在（HTTP 404）");
      expect(markup).toContain('data-progress-source="system"');
      expect(markup.indexOf("检查预览页面是否可访问")).toBeLessThan(markup.indexOf("open_preview"));
    }
    const model = { id: "model", kind: "assistant_answer" as const, turnId: "t", stepId: "s", channel: "process" as const, content: "先检查页面可访问性" };
    const explained = render({ ...state, items: [model, tool] }, false);
    expect(explained).toContain(model.content);
    expect(explained).not.toContain("检查预览页面是否可访问");
    expect(explained).toContain("HTTP 404");
  });

  it.each([
    [{ state: "unavailable", reason: "http_status", status: 404 }, "PREVIEW_PAGE_NOT_FOUND", "HTTP 404"],
    [{ state: "unavailable", reason: "http_status", status: 503 }, "PREVIEW_HTTP_ERROR", "HTTP 503"],
    [{ state: "unavailable", reason: "connection_refused" }, "PREVIEW_CONNECTION_FAILED", "无法连接"],
    [{ state: "unavailable", reason: "timeout" }, "PREVIEW_PROBE_TIMEOUT", "超时"],
    [{ state: "unavailable", reason: "aborted" }, "PREVIEW_PROBE_ABORTED", "取消"],
  ] as const)("探测 %j 沿已有工具错误入口投影为 %s", async function projectsProbe(result, code, text) {
    const service = createWorkPreviewService({ workspaceRoot: "C:/fixture", agentAuthorities: ["localhost:3000"], jobsOf: function unused(): never { throw new Error("must not use jobs"); }, probe: async function probe(): Promise<ProbeResult> { return result; } });
    const error = await service.preparePreview({ workspaceId: "C:/fixture", sessionId: "session", turnId: "t", callId: "a", url: "http://127.0.0.1:8099/private", openWhen: "now" }).catch(function failure(error: unknown) { return error; });
    expect(error).toBeInstanceOf(WorkPreviewError);
    expect(error).toMatchObject({ code, toolError: { code } });
    expect((error as WorkPreviewError).toolError.message).toContain(text);
    expect(JSON.stringify((error as WorkPreviewError).toolError)).not.toMatch(/private|secret|8099|127/);
  });
});
