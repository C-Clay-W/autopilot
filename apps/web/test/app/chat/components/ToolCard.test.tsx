/** ToolCard 回归测试：工具行使用紧凑 disclosure，安全 edit diff 默认展开，工具专用明细按需展开。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolDisplayDetail } from "@autopilot-agent/core";
import type { ToolCallItem } from "@autopilot-agent/presentation";
import ToolCard, { ToolNameLabel } from "@/app/chat/components/ToolCard";

/** 构造带有已脱敏 diff 的完成工具节点。 */
function createEditedTool(): ToolCallItem {
  return {
    id: "tool:edit-1",
    kind: "tool_call",
    turnId: "turn-1",
    callId: "edit-1",
    toolName: "edit_file",
    profileKey: "edit_file",
    category: "edit",
    state: "completed",
    titleKey: "tool.edit_file",
    target: "index.html",
    diff: { text: "--- a/index.html\n+++ b/index.html\n-old\n+new", files: 1, added: 1, removed: 1 },
  };
}

/** 构造带 Core 专用明细的完成读取节点。 */
function createDetailedTool(): ToolCallItem {
  const detail: ToolDisplayDetail = { kind: "read_file", path: "agent/API-Design.md", startLine: 205, endLine: 245, totalLines: 912, returnedLines: 41, truncated: true };
  return {
    id: "tool:read-1",
    kind: "tool_call",
    turnId: "turn-1",
    callId: "read-1",
    toolName: "read_file",
    profileKey: "read_file",
    category: "read",
    state: "completed",
    titleKey: "tool.read.completed",
    target: "agent/API-Design.md",
    resultSummary: "已读取第 205–245 行 · 共 912 行",
    detail,
  };
}

describe("ToolCard", function toolCardSuite() {
  it("同一行保留阶段总结和目标路径，并默认显示安全 Diff", function showsSafeDiff() {
    const markup = renderToStaticMarkup(<ToolCard tool={createEditedTool()} content="更新首页样式" />);

    expect(markup).toContain("更新首页样式");
    expect(markup).toContain("更新首页样式 · index.html");
    expect(markup).toContain("index.html (+1, -1)");
    expect(markup).toContain("1 个文件 · (\u003cspan class=\"text-success\">+1</span>, \u003cspan class=\"text-error\">-1</span>)".replaceAll("\\u003c", "<"));
    expect(markup.match(/class="text-success">\+1/g)).toHaveLength(2);
    expect(markup.match(/class="text-error">-1/g)).toHaveLength(2);
    expect(markup).toContain("+new");
    expect(markup).toContain("▾");
    expect(markup.indexOf("▾")).toBeLessThan(markup.indexOf("✓"));
    expect(markup).not.toContain("已完成 · 收起");
    expect(markup).not.toContain(">编辑文件<");
    expect(markup).not.toContain("border-l");
  });

  it("有专用明细的工具出现可展开入口，收起时不渲染明细正文", function detailProvidesExpansion() {
    const markup = renderToStaticMarkup(<ToolCard tool={createDetailedTool()} />);

    expect(markup).toContain("aria-expanded=\"false\"");
    expect(markup).toContain("tool-body-read-1");
    expect(markup).toContain("▸");
    // 收起行的 title 与 aria-label 可以含摘要文字，但明细正文区域不允许出现行范围标记。
    expect(markup).not.toContain("已读取第</span>");
    expect(markup).not.toContain("共 <span");
    expect(markup).not.toContain("RAW_TOOL_OUTPUT_MUST_NOT_RENDER");
  });

  it("旧调用没有明细也没有 Diff 时不显示虚假展开入口", function legacyCallHasNoFakeExpansion() {
    const legacy: ToolCallItem = {
      id: "tool:legacy-1",
      kind: "tool_call",
      turnId: "turn-1",
      callId: "legacy-1",
      toolName: "read_file",
      profileKey: "read_file",
      category: "read",
      state: "completed",
      titleKey: "tool.read.completed",
      target: "agent/Design.md",
      resultSummary: "read agent/Design.md",
    };
    const markup = renderToStaticMarkup(<ToolCard tool={legacy} />);

    expect(markup).not.toContain("▸");
    expect(markup).not.toContain("aria-controls");
    expect(markup).toContain("disabled");
    expect(markup).toContain("agent/Design.md");
  });

  it("失败工具在右侧显示红色 x 状态，不与弱化成功状态混用", function highlightsFailedToolStatus() {
    const failedTool: ToolCallItem = {
      ...createDetailedTool(),
      callId: "failed-read-1",
      state: "failed",
    };
    const markup = renderToStaticMarkup(<ToolCard tool={failedTool} content="模型请求调用 read_file" />);

    expect(markup).toContain("bg-error px-1 font-bold text-ink");
    expect(markup).toContain(">× 执行失败</span>");
    expect(markup).toContain("text-accent\">read_file</span>");
  });

  it("失败、拒绝、取消与超时徽标保留各自状态文字", function preservesDistinctFailureLabels() {
    const states = [
      { state: "failed", label: "执行失败" },
      { state: "denied", label: "已拒绝" },
      { state: "cancelled", label: "已取消" },
      { state: "timeout", label: "已超时" },
    ] as const;

    for (const item of states) {
      const tool: ToolCallItem = { ...createDetailedTool(), state: item.state };
      const markup = renderToStaticMarkup(<ToolCard tool={tool} />);

      expect(markup).toContain("bg-error px-1 font-bold text-ink");
      expect(markup).toContain(item.label);
      expect(markup).toContain(`aria-label="read_file：`);
    }
  });

  it("同一摘要中的重复工具调用名称只在 UI 中保留一次并显示次数", function collapsesRepeatedToolNamesInUi() {
    const markup = renderToStaticMarkup(<ToolNameLabel text="模型请求调用 glob_files、glob_files" toolNames={["glob_files"]} />);

    expect(markup.match(/text-accent/g)).toHaveLength(1);
    expect(markup).toContain("模型请求调用 ");
    expect(markup).toContain("</span> ×2");
    expect(markup).not.toContain("glob_files、glob_files");
  });

  it("工具行会合并首个工具摘要中的重复工具名", function collapsesRepeatedToolNamesInToolCard() {
    const markup = renderToStaticMarkup(<ToolCard tool={createDetailedTool()} content="模型请求调用 read_file、read_file、read_file" />);

    expect(markup).toContain("read_file ×3");
    expect(markup).not.toContain("read_file、read_file、read_file");
  });

  it("多个补充工具名之间保留 UI 分隔", function separatesMissingToolNamesInUi() {
    const markup = renderToStaticMarkup(<ToolNameLabel text="已检查 6 项" toolNames={["read_file", "glob_files", "grep_files"]} appendMissing />);

    expect(markup).toContain('read_file</span>、<span class="text-accent">glob_files</span>、<span class="text-accent">grep_files</span>');
    expect(markup).not.toContain("read_fileglob_filesgrep_files");
  });

  it("完成摘要不含工具名时仍补出稳定的强调色工具名", function keepsToolNameAccentAfterCompletion() {
    const markup = renderToStaticMarkup(<ToolCard tool={createDetailedTool()} />);

    expect(markup).toContain('text-accent">read_file</span>');
    expect(markup).toContain("已读取第");
  });
});
