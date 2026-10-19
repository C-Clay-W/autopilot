/** 工作区分组折叠回归测试：Work 侧栏分组头为可访问折叠开关，折叠后隐藏该组会话行。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(path.resolve(__dirname, "../../app/chat/Sidebar.tsx"), "utf8");

describe("Sidebar 工作区分组折叠", function workspaceCollapseSuite() {
  it("分组头按钮切换折叠态并暴露 aria-expanded", function groupHeaderIsAccessibleToggle() {
    expect(sidebarSource).toContain("toggleWorkspaceCollapsed(workspace.workspaceId)");
    expect(sidebarSource).toContain("aria-expanded={!collapsed}");
  });

  it("折叠后不渲染该组会话行", function hidesSessionsWhenCollapsed() {
    expect(sidebarSource).toContain("{!collapsed && items.map(");
    expect(sidebarSource).toContain('collapsed ? "▸" : "▾"');
  });
});
