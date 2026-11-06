/** ChildTaskStrip 回归测试：只投影活跃子任务的标题与阶段，空列表不占版面。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChildTaskStrip from "@/app/chat/components/ChildTaskStrip";

describe("ChildTaskStrip", function childTaskStripSuite() {
  it("没有活跃子任务时不渲染任何内容", function rendersNothing() {
    expect(renderToStaticMarkup(<ChildTaskStrip workspaceId="ws" items={[]} />)).toBe("");
  });

  it("展示子任务标题与阶段，并保留可访问名称", function rendersActiveChildren() {
    const html = renderToStaticMarkup(<ChildTaskStrip
      workspaceId="ws"
      items={[
        { sessionId: "child-1", title: "依赖清单核对", phase: "running", updatedAt: Date.parse("2026-10-30T14:20:00+08:00") },
        { sessionId: "child-2", title: "冗余依赖复核", phase: "waiting_approval", updatedAt: Date.parse("2026-10-30T14:10:00+08:00") },
      ]}
    />);
    expect(html).toContain('aria-label="协作子任务"');
    expect(html).toContain("依赖清单核对");
    expect(html).toContain("执行中");
    expect(html).toContain("冗余依赖复核");
    expect(html).toContain("等待审批");
  });
});
