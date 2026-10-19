/** Stage 4 /context 单元回归：parser、projector、renderer、报告格式化与 TUI store。 */

import { describe, expect, it } from "vitest";
import { formatContextReportLines, formatPlainContextReport, formatTuiContextStatus } from "../../src/context-report.js";
import { createCliEventProjector, createInitialCliProjection } from "../../src/event-projector.js";
import { createPlainRenderer } from "../../src/renderer.js";
import { getSlashCommandSuggestions, parseSlashAction } from "../../src/parser.js";
import { createCliTuiStore } from "../../src/tui/store.js";
import type { AgentEvent } from "@autopilot-agent/core";
import type { CliPublicEvent } from "../../src/types.js";
import { createUsageFixture } from "./fixtures.js";

/** 构造测试用 AgentEvent，避免依赖 Kernel private 类型。 */
function asEvent(value: unknown): AgentEvent {
  return value as AgentEvent;
}

describe("Stage 4 /context 单元回归", function contextUsageSuite() {
  it("parser 只接受 /context 与 /context all", function parsesContextCommands() {
    expect(parseSlashAction("/context")).toEqual({ kind: "action", action: { type: "show_context", all: false } });
    expect(parseSlashAction("/context all")).toEqual({ kind: "action", action: { type: "show_context", all: true } });
    expect(parseSlashAction("/context now")).toEqual({ kind: "error", message: "/context 只接受可选 all 参数" });
    expect(getSlashCommandSuggestions("/context").map(function name(command) { return command.usage; })).toEqual(["/context [all]"]);
  });

  it("projector 把 context_usage_updated 投影为 context_usage 公开事件并更新快照", function projectsContextUsageEvent() {
    const projector = createCliEventProjector({ sessionId: "session-1" });
    const usage = createUsageFixture();
    const projected = projector.project(asEvent({ type: "context_usage_updated", turnId: "turn-1", usage }));
    expect(projected.added).toBe(true);
    expect(projected.projection.contextUsage).toEqual(usage);
    const lastEvent = projected.projection.events.at(-1);
    expect(lastEvent).toMatchObject({ type: "context_usage", seq: 1, turnId: "turn-1", usage });
  });

  it("projector 对 usage null 明确清空旧状态而不是保留旧快照", function projectsNullContextUsage() {
    const projector = createCliEventProjector({ sessionId: "session-1" });
    projector.project(asEvent({ type: "context_usage_updated", turnId: "turn-1", usage: createUsageFixture() }));
    const cleared = projector.project(asEvent({ type: "context_usage_updated", turnId: "turn-1", usage: null }));
    expect(cleared.projection.contextUsage).toBeNull();
  });

  it("text 渲染对 context_usage 输出空行，jsonl 输出结构化 DTO", function rendersContextUsageEvent() {
    const event: CliPublicEvent = { type: "context_usage", seq: 1, turnId: "turn-1", usage: null };
    expect(createPlainRenderer("text").render(event)).toBe("");
    const parsed = JSON.parse(createPlainRenderer("jsonl").render(event)) as typeof event;
    expect(parsed).toMatchObject({ type: "context_usage", seq: 1, turnId: "turn-1", usage: null });
  });

  it("unknown 输出固定为 Context: unknown，不生成伪分类或 0%", function formatsUnknownReport() {
    expect(formatPlainContextReport(null, false)).toEqual(["Context: unknown"]);
    expect(formatPlainContextReport(null, true)).toEqual(["Context: unknown"]);
  });

  it("Plain 报告固定字段顺序并聚合 Memory/Skills，不为它们重复分类行", function formatsPlainReport() {
    const lines = formatPlainContextReport(createUsageFixture(), false);
    expect(lines[0]).toBe("Context Usage");
    expect(lines).toContain("model: gateway-a/claude-sonnet-4");
    expect(lines).toContain("projected: 32,192 / 200,000 tokens (16.1% projected) · projected");
    expect(lines).toContain("  系统: 1,234 tokens (0.6% window)");
    expect(lines).toContain("  输出预留: 8,192 tokens (4.1% window) (reserved)");
    expect(lines).toContain("Memory files: 3 items · 500 tokens");
    expect(lines).toContain("Skills: 2 items · 300 tokens");
    expect(lines).toContain("Free space: 147,808 tokens (73.9%)");
    expect(lines).toContain("Autocompact buffer: 20,000 tokens (10.0%)");
    expect(lines.at(-1)).toBe("/context all to expand");
    // 分类列表不重复出现聚合行。
    expect(lines).not.toContain("  Memory: 500 tokens · 3 items (0.2% window)");
  });

  it("/context all 追加安全展开字段且分类行补充 projected 比例", function formatsExpandedReport() {
    const lines = formatPlainContextReport(createUsageFixture(), true);
    expect(lines).toContain("  系统: 1,234 tokens (0.6% window) · 3.8% projected");
    expect(lines).toContain("Memory files: 3 items · 500 tokens (0.3% window) · 1.6% projected");
    expect(lines).toContain("Skills: 2 items · 300 tokens (0.1% window) · 0.9% projected");
    expect(lines).toContain("overall measurement: projected");
    expect(lines).toContain("breakdown measurement: estimated");
    expect(lines).toContain("provider measured: not available");
    expect(lines).toContain("compact needed: no");
    expect(lines).toContain("over limit: 0 tokens (0.0%)");
  });

  it("装饰网格按窗口与列数降级，并排行携带右侧信息", function formatsGridReport() {
    const usage = createUsageFixture();
    const wide = formatContextReportLines(usage, false, { grid: true, columns: 120 });
    // 200k 窗口在 >=80 列使用 10x10 网格。
    const wideGridRows = wide.filter(function isGridLine(line) { return /^[█▓░▒ ]{10}  /.test(line); });
    expect(wideGridRows).toHaveLength(10);
    const narrow = formatContextReportLines(usage, false, { grid: true, columns: 60 });
    // <80 列降为 5 列网格；右侧信息行数更多时余下行不携带网格字符。
    const narrowGridRows = narrow.filter(function isNarrowGridLine(line) {
      return /^[█▓░▒ ]{5}  /.test(line) && /[█▓░▒]/.test(line);
    });
    expect(narrowGridRows).toHaveLength(5);
    const colorless = formatContextReportLines(usage, false, { grid: false, columns: 120 });
    expect(colorless).not.toContain("█");
  });

  it("状态栏只显示整数窗口剩余百分比，来源留在详情", function formatsStatusLabels() {
    expect(formatTuiContextStatus(null)).toBe("unknown");
    expect(formatTuiContextStatus(createUsageFixture({ measurement: "measured" }))).toBe("84%");
    expect(formatTuiContextStatus(createUsageFixture({ measurement: "estimated" }))).toBe("84%");
    expect(formatTuiContextStatus(createUsageFixture({ usageRatio: 1.3 }))).toBe("0%");
    expect(formatContextReportLines(createUsageFixture({ measurement: "estimated" }), true, { grid: false, columns: 120 })).toContain("overall measurement: estimated");
  });

  it("store 对 context_usage 事件只刷新状态事实，不进入时间线", function storesContextUsage() {
    const store = createCliTuiStore();
    const projection = createInitialCliProjection();
    const usage = createUsageFixture();
    store.acceptEvent({ type: "context_usage", seq: 1, turnId: "turn-1", usage }, projection);
    const snapshot = store.getSnapshot();
    expect(snapshot.contextUsage).toEqual(usage);
    expect(snapshot.transcript).toHaveLength(0);
  });
});
