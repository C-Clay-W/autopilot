/** diff-sidebar-model 单测：验证侧边栏派生数据的空态、过滤、Turn 分组、scope、同文件合并、统计兜底与 truncated 聚合（Plan G6/G7）。 */
import { describe, expect, it } from "vitest";
import type { AgentPresentationItem, ToolCallItem } from "@autopilot-agent/presentation";
import { selectDiffSections } from "@/app/chat/components/diff-sidebar-model";

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

describe("selectDiffSections", function selectDiffSectionsSuite() {
  it("空 items 或无安全 diff 文本时返回空数组", function returnsEmptyWithoutDiffText() {
    expect(selectDiffSections([], "all", undefined)).toEqual([]);
    expect(selectDiffSections([createDiffTool({ diff: undefined })], "all", undefined)).toEqual([]);
    expect(selectDiffSections([createDiffTool({ diff: { added: 1, removed: 1 } })], "all", undefined)).toEqual([]);
  });

  it("非 completed 状态、无 target 或非 tool_call 节点不进入侧边栏", function filtersNonCompletedAndPathlessTools() {
    const items: AgentPresentationItem[] = [
      createDiffTool({ callId: "running-1", state: "running" }),
      createDiffTool({ callId: "await-1", state: "awaiting_approval" }),
      createDiffTool({ callId: "failed-1", state: "failed" }),
      createDiffTool({ callId: "no-target-1", target: undefined }),
      { id: "answer-1", kind: "assistant_answer", channel: "final", turnId: "turn-1", stepId: "s1", content: "完成" },
      createDiffTool(),
    ];
    const sections = selectDiffSections(items, "all", undefined);
    expect(sections).toHaveLength(1);
    expect(sections[0].files).toHaveLength(1);
    expect(sections[0].files[0].filePath).toBe("agent/Runbook-P14.md");
  });

  it("scope=all 按 Turn 分区并保持首次出现顺序，分区统计为区内求和", function groupsSectionsByTurnOrder() {
    const items: AgentPresentationItem[] = [
      createDiffTool({ callId: "edit-t2", turnId: "turn-2", diff: { text: "+a\n+b", added: 2, removed: 0 } }),
      createDiffTool({ callId: "edit-t1", turnId: "turn-1" }),
      createDiffTool({ callId: "edit-t2b", turnId: "turn-2", target: "agent/Design.md", diff: { text: "-x", added: 0, removed: 1 } }),
    ];
    const sections = selectDiffSections(items, "all", undefined);
    expect(sections.map(function toTurnId(section) { return section.turnId; })).toEqual(["turn-2", "turn-1"]);
    expect(sections[0].files.map(function toPath(entry) { return entry.filePath; })).toEqual(["agent/Runbook-P14.md", "agent/Design.md"]);
    expect(sections[0].added).toBe(2);
    expect(sections[0].removed).toBe(1);
    expect(sections[1].added).toBe(1);
    expect(sections[1].removed).toBe(1);
  });

  it("scope=turn 仅保留 latestTurnId 指定 Turn，latestTurnId 为 undefined 时返回空数组", function scopesSectionsToLatestTurn() {
    const items: AgentPresentationItem[] = [
      createDiffTool({ callId: "edit-t1", turnId: "turn-1" }),
      createDiffTool({ callId: "edit-t2", turnId: "turn-2" }),
    ];
    const latest = selectDiffSections(items, "turn", "turn-2");
    expect(latest).toHaveLength(1);
    expect(latest[0].turnId).toBe("turn-2");
    expect(selectDiffSections(items, "turn", undefined)).toEqual([]);
  });

  it("同 Turn 同文件多次编辑合并为单文件行：diff 按序拼接、统计求和、key 使用 turnId::filePath", function mergesRepeatedEditsPerFile() {
    const items: AgentPresentationItem[] = [
      createDiffTool({ callId: "edit-1", diff: { text: "+a", added: 1, removed: 0 } }),
      createDiffTool({ callId: "edit-2", diff: { text: "-b\n+c", added: 1, removed: 1 } }),
    ];
    const sections = selectDiffSections(items, "all", undefined);
    expect(sections).toHaveLength(1);
    expect(sections[0].files).toHaveLength(1);
    const entry = sections[0].files[0];
    expect(entry.key).toBe("turn-1::agent/Runbook-P14.md");
    expect(entry.diffText).toBe("+a\n-b\n+c");
    expect(entry.added).toBe(2);
    expect(entry.removed).toBe(1);
    expect(entry.truncated).toBe(false);
  });

  it("旧数据缺 added/removed 字段时从安全文本兜底统计并归一 CRLF", function fallsBackToTextStats() {
    const tool = createDiffTool({
      callId: "legacy-1",
      diff: { text: "--- a/f\r\n+++ b/f\r\n@@ -1,2 +1,3 @@\r\n ctx\r\n-del\r\n+add1\r\n+add2\r\n+add3" },
    });
    const [section] = selectDiffSections([tool], "all", undefined);
    expect(section.files[0].added).toBe(3);
    expect(section.files[0].removed).toBe(1);
  });

  it("存在 Core 统计字段时优先使用字段值，单侧缺失仅该侧兜底", function prefersCoreStatFields() {
    const tool = createDiffTool({ callId: "stats-1", diff: { text: "+a\n+b\n+c\n-d", added: 7 } });
    const [section] = selectDiffSections([tool], "all", undefined);
    expect(section.files[0].added).toBe(7);
    expect(section.files[0].removed).toBe(1);
  });

  it("任一来源截断即标记 truncated，全部未截断保持 false", function aggregatesTruncatedFlag() {
    const items: AgentPresentationItem[] = [
      createDiffTool({ callId: "edit-1", diff: { text: "+a", added: 1, removed: 0 } }),
      createDiffTool({ callId: "edit-2", diff: { text: "+b", added: 1, removed: 0, truncated: true } }),
    ];
    const [section] = selectDiffSections(items, "all", undefined);
    expect(section.files[0].truncated).toBe(true);

    const clean = selectDiffSections([createDiffTool()], "all", undefined);
    expect(clean[0].files[0].truncated).toBe(false);
  });
});
