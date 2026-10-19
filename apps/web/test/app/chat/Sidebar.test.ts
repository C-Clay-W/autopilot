/** Sidebar 回归测试：状态槽必须接入共享列表项且固定在删除按钮右侧。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(path.resolve(__dirname, "../../../app/chat/Sidebar.tsx"), "utf8");
const composerSource = readFileSync(path.resolve(__dirname, "../../../app/chat/components/ChatComposer.tsx"), "utf8");

describe("Sidebar", function sidebarSuite() {
  it("使用 manager 列表项的状态快照渲染固定状态槽", function rendersSharedSessionStatus() {
    expect(sidebarSource).toContain("useSessionTaskList()");
    expect(sidebarSource).toContain("<SessionStatusIndicator phase={item.phase} terminalNotice={item.terminalNotice} isCurrent=");
    expect(sidebarSource.indexOf("handleDeleteSession")).toBeLessThan(sidebarSource.indexOf("<SessionStatusIndicator"));
  });

  it("新建按钮只切换到空白 Chat，避免运行中创建请求阻塞导航", function opensBlankChatWithoutPost() {
    expect(sidebarSource).toContain("立即打开空白 Chat");
    expect(sidebarSource).not.toContain("method: \"POST\"");
  });

  it("只把可操作且确有历史会话的工作区渲染到侧栏", function hidesUnavailableAndEmptyWorkspaceRecords() {
    expect(sidebarSource).toContain("visibleWorkspaceGroups");
    expect(sidebarSource).toContain('workspace.available && workspace.trustStatus === "trusted"');
    expect(sidebarSource).toContain(".filter(function hasSessions(group) { return group.items.length > 0; })");
    expect(sidebarSource).toContain("暂无历史会话");
    expect(sidebarSource).not.toContain("此工作区当前不可用");
  });

  it("资源目录只在 Chat 模式显示并进入 Chat 知识管理页", function scopesResourceDirectoryToChat() {
    expect(sidebarSource).toContain('{isChat && <Link');
    expect(sidebarSource).toContain('href="/chat/knowledge"');
    expect(sidebarSource).toContain("资源目录");
    expect(sidebarSource).not.toContain('href="/lancedb"');
  });

  it("输入区不再提供重复的知识库管理入口", function removesComposerKnowledgeLink() {
    expect(composerSource).not.toContain("管理私有知识库");
    expect(composerSource).toContain("可从左侧资源目录预览或删除");
  });
});
