/** DiffSidebar 静态渲染测试：默认展开、ToolCard 复用着色、统计 token、复制按钮语义、截断提示、范围默认值、空态与关闭态。node 环境无 jsdom，点击/焦点/Esc 等交互验收属 Stage 3 实机门禁。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentPresentationItem, ToolCallItem } from "@autopilot-agent/presentation";
import DiffSidebar from "@/app/chat/components/DiffSidebar";
import { NoticeProvider } from "@/app/chat/components/Notice";

/** 构造一条携带安全 diff 的已完成 edit_file 工具节点，允许按字段覆盖。 */
function createDiffTool(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  const callId = overrides.callId ?? "edit-1";
  return {
    id: `tool:${callId}`,
    kind: "tool_call",
    turnId: "turn-1",
    callId,
    toolName: "edit_file",
    profileKey: "edit_file",
    category: "edit",
    state: "completed",
    titleKey: "tool.edit_file",
    target: "agent/Runbook-P14.md",
    diff: { text: "--- a/agent/Runbook-P14.md\n+++ b/agent/Runbook-P14.md\n-old\n+new", added: 1, removed: 1 },
    ...overrides,
  };
}

function renderSidebar(items: AgentPresentationItem[], activeTurnId?: string): string {
  // useNotice 在 hooks 阶段执行（早于 open 提前返回），渲染必须位于 NoticeProvider 内（与 app/layout.tsx 全局挂载一致）。
  return renderToStaticMarkup(<NoticeProvider><DiffSidebar open onClose={() => undefined} width={400} items={items} activeTurnId={activeTurnId} /></NoticeProvider>);
}

describe("DiffSidebar", function diffSidebarSuite() {
  it("open=false 时不渲染任何面板 DOM", function rendersNothingWhenClosed() {
    const markup = renderToStaticMarkup(<NoticeProvider><DiffSidebar open={false} onClose={() => undefined} width={400} items={[createDiffTool()]} /></NoticeProvider>);

    expect(markup).toBe("");
  });

  it("文件行默认展开，渲染折叠语义、路径、复制按钮与头部控件", function rendersExpandedFileRowWithControls() {
    const markup = renderSidebar([createDiffTool()]);

    expect(markup).toContain("文件修改");
    expect(markup).toContain("agent/Runbook-P14.md");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-controls="diff-file-body-0-0"');
    expect(markup).toContain('id="diff-file-body-0-0"');
    expect(markup).toContain('aria-label="复制文件路径"');
    expect(markup).toContain('title="复制文件路径"');
    expect(markup).toContain("复制");
    expect(markup).toContain("全部展开");
    expect(markup).toContain("全部收起");
    expect(markup).toContain('aria-label="关闭 Diff 侧边栏"');
    expect(markup).toContain('aria-label="Diff 范围"');
  });

  it("行级 diff 着色与统计复用 ToolCard 导出，保持 token 一致", function reusesToolCardDiffRendering() {
    const markup = renderSidebar([createDiffTool()]);

    expect(markup).toContain('class="block bg-accent/15 text-accent"');
    expect(markup).toContain('class="block bg-ink/10 text-muted"');
    expect(markup).toContain('class="text-success">+1</span>');
    expect(markup).toContain('class="text-error">-1</span>');
    expect(markup).toContain("+new");
    expect(markup).toContain("-old");
  });

  it("截断的 diff 在文件行内显示已截断提示", function showsTruncatedHint() {
    const markup = renderSidebar([createDiffTool({ callId: "truncated-1", diff: { text: "+new", added: 1, removed: 0, truncated: true } })]);

    expect(markup).toContain("已截断");
  });

  it("默认范围为本轮：显示最近含 diff 的 Turn，历史 Turn 文件不出现", function defaultsToLatestDiffTurn() {
    const items: AgentPresentationItem[] = [
      createDiffTool({ callId: "edit-t1", turnId: "turn-1", target: "agent/Design.md" }),
      createDiffTool({ callId: "edit-t2", turnId: "turn-2", target: "agent/API-Design.md" }),
    ];
    const markup = renderSidebar(items);

    expect(markup).toContain("本轮");
    expect(markup).toContain("agent/API-Design.md");
    expect(markup).not.toContain("agent/Design.md");
  });

  it("在途 activeTurnId 优先作为本轮范围", function prefersActiveTurnIdForScope() {
    const items: AgentPresentationItem[] = [
      createDiffTool({ callId: "edit-t1", turnId: "turn-1", target: "agent/Design.md" }),
      createDiffTool({ callId: "edit-t2", turnId: "turn-2", target: "agent/API-Design.md" }),
    ];
    const markup = renderSidebar(items, "turn-1");

    expect(markup).toContain("agent/Design.md");
    expect(markup).not.toContain("agent/API-Design.md");
  });

  it("无安全 diff 事实时渲染空态且不显示一键展开收起", function rendersEmptyStateWithoutDiff() {
    const markup = renderSidebar([]);

    expect(markup).toContain("暂无文件编辑记录");
    expect(markup).not.toContain("全部展开");
    expect(markup).not.toContain("全部收起");
    expect(markup).not.toContain("复制文件路径");
  });
});
