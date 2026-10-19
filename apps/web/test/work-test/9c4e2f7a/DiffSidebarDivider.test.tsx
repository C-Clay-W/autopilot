/** DiffSidebarDivider 静态渲染回归测试（work-test 任务 9c4e2f7a，问题 2.1）：验证分隔条的 separator 语义、宽度 aria 投影与窄屏隐藏；node 环境无 jsdom，拖动/键盘交互验收属实机门禁。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DiffSidebarDivider from "@/app/chat/components/DiffSidebarDivider";

describe("DiffSidebarDivider", function diffSidebarDividerSuite() {
  it("渲染 separator 语义并投影当前宽度", function rendersSeparatorSemantics() {
    const markup = renderToStaticMarkup(<DiffSidebarDivider width={420} onChange={() => undefined} />);

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('aria-label="调整 Diff 侧边栏宽度"');
    expect(markup).toContain('aria-valuenow="420"');
    expect(markup).toContain('aria-valuemin="300"');
    expect(markup).toContain('tabindex="0"');
  });

  it("窄屏隐藏、桌面端显示，默认无拖动态", function hiddenOnNarrowViewports() {
    const markup = renderToStaticMarkup(<DiffSidebarDivider width={400} onChange={() => undefined} />);

    expect(markup).toContain("hidden");
    expect(markup).toContain("md:block");
    expect(markup).toContain("cursor-col-resize");
    expect(markup).not.toContain("data-dragging");
  });
});
