/** CLI Presentation adapter 测试：验证 Core 事件、共享 selector、TUI 与 Plain/JSONL 的边界。 */

import type { AgentEvent } from "@autopilot-agent/core";
import { Box } from "ink";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createCliEventProjector } from "../src/event-projector.js";
import { createPlainRenderer } from "../src/renderer.js";
import { createTuiApprovalOptions, TuiApprovalPrompt } from "../src/tui/approval.js";
import { TuiPromptLine } from "../src/tui/transcript.js";
import { renderTimeline } from "../src/tui/timeline/static-timeline.js";
import { TuiLiveTurn } from "../src/tui/timeline/turn.js";
import { createTuiViewportSources } from "../src/tui/viewport/sources.js";

/** 将 fixture 最小对象视为公开 AgentEvent，避免测试触及 Core 私有实现。 */
function asEvent(value: unknown): AgentEvent {
  return value as AgentEvent;
}

/** 构造具有两个同名 read_file 调用的共享 Presentation 投影。 */
function createReadProjection(options: { failed?: boolean } = {}) {
  const projector = createCliEventProjector({ sessionId: "session-presentation", now: function fixedNow() { return new Date("2026-08-24T06:00:00.000Z"); } });
  projector.project(asEvent({ type: "turn_started", turnId: "turn-presentation", stepCount: 0 }));
  projector.project(asEvent({ type: "reasoning_summary", turnId: "turn-presentation", stepId: "step-thinking", summary: "正在思考" }));
  projector.project(asEvent({ type: "reasoning_summary", turnId: "turn-presentation", stepId: "step-1", summary: "模型请求调用 read_file、read_file" }));
  projector.project(asEvent({ type: "tool_started", turnId: "turn-presentation", stepId: "step-1", callId: "read-1", toolName: "read_file", summary: "RAW_START_1" }));
  projector.project(asEvent({ type: "tool_result", turnId: "turn-presentation", stepId: "step-1", callId: "read-1", toolName: "read_file", retryCount: 0, summary: "RAW_RESULT_1", result: { status: "success", callId: "read-1", toolName: "read_file", output: "RAW_OUTPUT_1", meta: { durationMs: 1, inputHash: "hash" }, display: { titleKey: "tool.read.completed", target: "src/one.ts", summary: "1 line" } } }));
  projector.project(asEvent({ type: "tool_started", turnId: "turn-presentation", stepId: "step-1", callId: "read-2", toolName: "read_file", summary: "RAW_START_2" }));
  projector.project(asEvent({ type: "tool_result", turnId: "turn-presentation", stepId: "step-1", callId: "read-2", toolName: "read_file", retryCount: 0, summary: "RAW_RESULT_2", result: { status: "success", callId: "read-2", toolName: "read_file", output: "RAW_OUTPUT_2", meta: { durationMs: 1, inputHash: "hash" }, display: { titleKey: "tool.read.completed", target: "src/two.ts", summary: "2 lines" } } }));
  if (options.failed) {
    projector.project(asEvent({
      type: "turn_failed",
      turnId: "turn-presentation",
      error: "修改任务未完成写后验证，不能标记为完成",
      checkpoint: { turnId: "turn-presentation", status: "failed", stepCount: 2, messages: [], completedCallIds: [] },
    }));
  }
  return projector.getProjection();
}

/** 构造带有明确工具终态的共享 Presentation 投影。 */
function createToolFailureProjection(status: "failed" | "denied" | "cancelled" | "timeout") {
  const projector = createCliEventProjector({ sessionId: `session-${status}` });
  const turnId = `turn-${status}`;
  projector.project(asEvent({ type: "turn_started", turnId, stepCount: 0 }));
  projector.project(asEvent({ type: "tool_started", turnId, stepId: "step-failure", callId: `call-${status}`, toolName: "read_file", summary: "正在读取" }));
  projector.project(asEvent({
    type: "tool_result",
    turnId,
    stepId: "step-failure",
    callId: `call-${status}`,
    toolName: "read_file",
    retryCount: 0,
    summary: "工具终态",
    result: {
      status,
      callId: `call-${status}`,
      toolName: "read_file",
      error: { code: status === "timeout" ? "TOOL_TIMEOUT" : status === "denied" ? "APPROVAL_REQUIRED" : status === "cancelled" ? "CANCELLED" : "TOOL_FAILED", message: "已安全脱敏" },
      display: { titleKey: status === "failed" ? "tool.read.running" : "tool.read.completed", target: "src/fail.md", summary: "工具未成功完成" },
    },
  }));
  return projector.getProjection();
}

/** 构造只携带 Core 安全 Web 明细的 CLI 投影。 */
function createWebProjection() {
  const projector = createCliEventProjector({ sessionId: "session-web-presentation", now: function fixedNow() { return new Date("2026-09-05T01:00:00.000Z"); } });
  projector.project(asEvent({ type: "turn_started", turnId: "turn-web-presentation", stepCount: 0 }));
  projector.project(asEvent({ type: "tool_started", turnId: "turn-web-presentation", stepId: "step-web", callId: "search-web", toolName: "web_search", summary: "PRIVATE_QUERY" }));
  projector.project(asEvent({ type: "tool_result", turnId: "turn-web-presentation", stepId: "step-web", callId: "search-web", toolName: "web_search", retryCount: 0, summary: "PRIVATE_QUERY", result: { status: "success", callId: "search-web", toolName: "web_search", output: "PRIVATE_SEARCH_OUTPUT", meta: { durationMs: 1, inputHash: "hash" }, display: { titleKey: "tool.web_search.completed", summary: "找到 4 个公开来源，结果已截断", detail: { kind: "web_search", sourceCount: 4, truncated: true } } } }));
  projector.project(asEvent({ type: "tool_result", turnId: "turn-web-presentation", stepId: "step-web", callId: "fetch-web", toolName: "web_fetch", retryCount: 0, summary: "PRIVATE_PAGE_BODY", result: { status: "success", callId: "fetch-web", toolName: "web_fetch", output: "PRIVATE_PAGE_BODY", meta: { durationMs: 1, inputHash: "hash" }, display: { titleKey: "tool.web_fetch.completed", target: "docs.example.com", summary: "已读取 text/html，内容已截断", detail: { kind: "web_fetch", host: "docs.example.com", contentType: "text/html", truncated: true } } } }));
  return projector.getProjection();
}

describe("CLI Presentation adapter", function cliPresentationAdapterSuite() {
  it("交互 TUI 从共享 selector 渲染连续 read group，且不读取 raw 工具文本", function rendersSharedTimeline() {
    const projection = createReadProjection();
    const rendered = render(createElement(TuiLiveTurn, {
      turnId: "turn-presentation",
      events: projection.events,
      presentation: projection.presentation,
      status: "running",
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: true,
      todoExpanded: false,
      maximumWidth: 80,
    }));
    const frame = rendered.lastFrame() ?? "";

    expect(frame).toContain("• Exploring codebase · 2 operations");
    expect(frame).toContain("正在思考");
    expect(frame).not.toContain("模型请求调用 read_file、read_file");
    expect(frame).not.toContain("●");
    expect(frame).not.toContain("RAW_");
    expect(projection.presentation.items.filter(function reads(item) { return item.kind === "tool_call" && item.toolName === "read_file"; }).map(function callId(item) { return item.callId; })).toEqual(["read-1", "read-2"]);
    expect(projection.presentation.items.filter(function reads(item) { return item.kind === "tool_call" && item.toolName === "read_file"; }).map(function getTarget(item) { return item.target; })).toEqual(["src/one.ts", "src/two.ts"]);
    rendered.unmount();
  });

  it("执行失败显示完成态名称与叉号，其他终态保留状态文字，备用屏仅给徽标加错误 chip", function keepsFailureSemanticsWithoutColor() {
    const statuses = [
      { state: "failed", label: "× [读取]" },
      { state: "denied", label: "已拒绝" },
      { state: "cancelled", label: "已取消" },
      { state: "timeout", label: "已超时" },
    ] as const;

    for (const item of statuses) {
      const projection = createToolFailureProjection(item.state);
      const turnId = `turn-${item.state}`;
      const rendered = render(createElement(TuiLiveTurn, {
        turnId,
        events: projection.events,
        presentation: projection.presentation,
        status: "running",
        approvalSelectedIndex: 0,
        useColor: false,
        screenReader: true,
        todoExpanded: false,
        maximumWidth: 80,
      }));
      expect(rendered.lastFrame()).toContain(item.label);
      if (item.state === "failed") {
        expect(rendered.lastFrame()).not.toContain("执行失败");
        expect(rendered.lastFrame()).not.toContain("正在读取");
        expect(rendered.lastFrame()).toContain("TOOL_FAILED");
      }
      const sources = createTuiViewportSources({
        transcript: [],
        pendingInputs: [],
        liveTurnId: turnId,
        liveEvents: projection.events,
        livePresentation: projection.presentation,
        liveMetrics: { startedAt: Date.now() - 1_000 },
        hasLiveApprovalEvent: false,
        activity: { phase: "thinking", frame: 0 },
        status: "running",
        activeSkills: [],
        cancellationRequested: false,
      } as never, undefined, 0, 80);
      const source = sources.find(function findFailureSource(candidate) { return candidate.text.includes(item.label); });
      expect(source?.text).toContain(item.label);
      expect(source?.spans).toContainEqual(expect.objectContaining({ style: "chip-error" }));
      if (item.state === "failed") {
        expect(source?.text).not.toContain("执行失败");
        expect(source?.text).toContain("TOOL_FAILED");
        expect(source?.spans).toContainEqual({ start: 2, end: "× [读取]".length, style: "chip-error" });
      }
      rendered.unmount();
    }
  });

  it("工具分组默认收起，Ctrl+O 详情态在交互与备用屏展开组内调用", function expandsToolGroupsOnDemand() {
    const projection = createReadProjection();
    const collapsed = render(createElement(TuiLiveTurn, {
      turnId: "turn-presentation",
      events: projection.events,
      presentation: projection.presentation,
      status: "running",
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: false,
      todoExpanded: false,
      maximumWidth: 80,
    }));
    expect(collapsed.lastFrame()).toContain("• Exploring codebase · 2 operations");
    expect(collapsed.lastFrame()).not.toContain("src/one.ts");
    collapsed.unmount();
    const expanded = render(createElement(TuiLiveTurn, {
      turnId: "turn-presentation",
      events: projection.events,
      presentation: projection.presentation,
      status: "running",
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: false,
      todoExpanded: true,
      maximumWidth: 80,
    }));
    expect(expanded.lastFrame()).toContain("src/one.ts");
    expect(expanded.lastFrame()).toContain("src/two.ts");
    expanded.unmount();
    const viewportSources = createTuiViewportSources({
      transcript: [],
      pendingInputs: [],
      liveTurnId: "turn-presentation",
      liveEvents: projection.events,
      livePresentation: projection.presentation,
      liveMetrics: { startedAt: Date.now() - 1_000 },
      hasLiveApprovalEvent: false,
      activity: { phase: "thinking", frame: 0 },
      status: "running",
      activeSkills: [],
      cancellationRequested: false,
    } as never, undefined, 0, 80, true);
    expect(viewportSources.map(function getText(source) { return source.text; }).join("\n")).toContain("src/one.ts");
  });

  it("失败原因显示在交互时间线与备用 viewport 的失败终态附近", function rendersSafeFailureReasonAcrossTuiPaths() {
    const projection = createReadProjection({ failed: true });
    const safeReason = "修改任务未完成写后验证，不能标记为完成";
    const rendered = render(createElement(TuiLiveTurn, {
      turnId: "turn-presentation",
      events: projection.events,
      presentation: projection.presentation,
      status: "failed",
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: true,
      todoExpanded: false,
      maximumWidth: 80,
    }));
    const staticTimeline = render(createElement(Box, null, renderTimeline(projection.events, false, {
      presentation: projection.presentation,
      turnId: "turn-presentation",
    })));
    const snapshot = {
      transcript: [],
      pendingInputs: [],
      liveTurnId: "turn-presentation",
      liveEvents: projection.events,
      livePresentation: projection.presentation,
      liveMetrics: { startedAt: Date.now() - 1_000 },
      hasLiveApprovalEvent: false,
      activity: { phase: "thinking", frame: 0 },
      status: "failed",
      activeSkills: [],
      cancellationRequested: false,
    };
    const presentationViewport = createTuiViewportSources(snapshot as never, undefined, 0, 80).map(function getText(source) { return source.text; }).join("\n");
    const fallbackSnapshot = { ...snapshot, livePresentation: undefined };
    const fallbackViewport = createTuiViewportSources(fallbackSnapshot as never, undefined, 0, 80).map(function getText(source) { return source.text; }).join("\n");

    expect(rendered.lastFrame()).toContain(`原因：${safeReason}`);
    expect(staticTimeline.lastFrame()).toContain(`原因：${safeReason}`);
    expect(presentationViewport).toContain(`原因：${safeReason}`);
    expect(fallbackViewport).toContain(`Status · Failed (RUNTIME_ERROR) · 原因：${safeReason}`);
    expect(fallbackViewport).not.toContain("RAW_");
    rendered.unmount();
    staticTimeline.unmount();
  });

  it("编辑文件摘要在交互 TUI 与备用屏都显示新增/删除行数", function rendersDiffStatsInBothTuiPaths() {
    const projector = createCliEventProjector({ sessionId: "session-edit-stats", now: function fixedNow() { return new Date("2026-09-18T06:00:00.000Z"); } });
    projector.project(asEvent({ type: "turn_started", turnId: "turn-edit-stats", stepCount: 0 }));
    projector.project(asEvent({ type: "tool_started", turnId: "turn-edit-stats", stepId: "step-edit", callId: "edit-stats", toolName: "edit_file", summary: "RAW_START" }));
    projector.project(asEvent({ type: "tool_result", turnId: "turn-edit-stats", stepId: "step-edit", callId: "edit-stats", toolName: "edit_file", retryCount: 0, summary: "RAW_RESULT", result: { status: "success", callId: "edit-stats", toolName: "edit_file", output: "RAW_OUTPUT", meta: { durationMs: 1, inputHash: "hash" }, display: { titleKey: "tool.edit.completed", target: "src/app.ts", summary: "edit", diff: { text: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra", files: 1, added: 2, removed: 1 } } } }));
    const projection = projector.getProjection();
    const rendered = render(createElement(TuiLiveTurn, {
      turnId: "turn-edit-stats",
      events: projection.events,
      presentation: projection.presentation,
      status: "running",
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: true,
      todoExpanded: false,
      maximumWidth: 80,
    }));
    const expectedStats = "src/app.ts · edit (+2, -1)";
    expect(rendered.lastFrame()).toContain(expectedStats);
    const viewportSources = createTuiViewportSources({
      transcript: [],
      pendingInputs: [],
      liveTurnId: "turn-edit-stats",
      liveEvents: projection.events,
      livePresentation: projection.presentation,
      liveMetrics: { startedAt: Date.now() - 1_000 },
      hasLiveApprovalEvent: false,
      activity: { phase: "thinking", frame: 0 },
      status: "running",
      activeSkills: [],
      cancellationRequested: false,
    } as never, undefined, 0, 80);
    const statisticsSource = viewportSources.find(function findStatisticsSource(source) { return source.text.includes(expectedStats); });
    const addedStart = statisticsSource?.text.indexOf("+2") ?? -1;
    const removedStart = statisticsSource?.text.indexOf("-1") ?? -1;
    expect(statisticsSource?.text).toContain(expectedStats);
    expect(statisticsSource?.spans).toEqual(expect.arrayContaining([
      { start: addedStart, end: addedStart + 2, style: "diff-added" },
      { start: removedStart, end: removedStart + 2, style: "diff-removed" },
    ]));
    rendered.unmount();
  });

  it("共享 Presentation 只显示已消费引导状态", function rendersConsumedInputState() {
    const projector = createCliEventProjector({ sessionId: "session-input" });
    projector.project(asEvent({
      type: "input_consumed",
      turnId: "turn-input",
      inputId: "input-1",
      checkpoint: {
        turnId: "turn-input",
        status: "running",
        stepCount: 1,
        messages: [{ role: "user", content: [{ type: "text", text: "继续检查审批链" }] }],
        completedCallIds: [],
        consumedInputIds: ["input-1"],
      },
    }));
    const projection = projector.getProjection();
    const rendered = render(createElement(TuiLiveTurn, {
      turnId: "turn-input",
      events: projection.events,
      presentation: projection.presentation,
      status: "running",
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: true,
      todoExpanded: false,
      maximumWidth: 80,
    }));

    expect(rendered.lastFrame()).toContain("Input consumed");
    expect(rendered.lastFrame()).not.toContain("继续检查审批链");
    const viewportSources = createTuiViewportSources({
      transcript: [],
      pendingInputs: [],
      liveTurnId: "turn-input",
      liveEvents: projection.events,
      livePresentation: projection.presentation,
      liveMetrics: { startedAt: Date.now() - 1_000 },
      hasLiveApprovalEvent: false,
      activity: { phase: "thinking", frame: 0 },
      status: "running",
      activeSkills: [],
      cancellationRequested: false,
    } as never, undefined, 0, 80);
    expect(viewportSources.map(function getText(source) { return source.text; }).join("\n")).toContain("Input consumed");
    rendered.unmount();
  });

  it("过程回答直接显示正文且两种 TUI 渲染出口都不显示过程输出标题", function rendersProcessAnswerWithoutLabel() {
    const projector = createCliEventProjector({ sessionId: "session-process" });
    projector.project(asEvent({ type: "turn_started", turnId: "turn-process", stepCount: 0 }));
    projector.project(asEvent({ type: "answer_delta", turnId: "turn-process", stepId: "step-process", delta: "正在检查当前实现。" }));
    const projection = projector.getProjection();
    const rendered = render(createElement(TuiLiveTurn, {
      turnId: "turn-process",
      events: projection.events,
      presentation: projection.presentation,
      status: "running",
      metrics: { startedAt: Date.now() - 2_000 },
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: false,
      todoExpanded: false,
      maximumWidth: 80,
    }));
    const viewportSources = createTuiViewportSources({
      transcript: [],
      pendingInputs: [],
      liveTurnId: "turn-process",
      liveEvents: projection.events,
      livePresentation: projection.presentation,
      hasLiveApprovalEvent: false,
      activity: { phase: "thinking", frame: 0 },
      status: "running",
      activeSkills: [],
      cancellationRequested: false,
    } as never, undefined, 0, 80);
    const viewportText = viewportSources.map(function getText(source) { return source.text; }).join("\n");

    expect(rendered.lastFrame()).toContain("正在检查当前实现。");
    expect(rendered.lastFrame()).not.toContain("Thinking for");
    expect(rendered.lastFrame()).not.toContain("过程输出");
    expect(viewportText).toContain("正在检查当前实现。");
    expect(viewportText).not.toContain("过程输出");
    rendered.unmount();
  });

  it("共享 Presentation 终态保留总耗时，已提交 prompt 不再携带输入箭头", function preservesDurationAndSeparatesPromptPrefix() {
    const projector = createCliEventProjector({ sessionId: "session-completed" });
    projector.project(asEvent({ type: "turn_started", turnId: "turn-completed", stepCount: 0 }));
    projector.project(asEvent({ type: "turn_completed", turnId: "turn-completed", checkpoint: { turnId: "turn-completed", status: "completed", stepCount: 1, messages: [], completedCallIds: [] } }));
    const projection = projector.getProjection();
    const timeline = render(createElement(Box, null, renderTimeline(projection.events, false, {
      presentation: projection.presentation,
      turnId: "turn-completed",
      totalDurationMs: 12_000,
    })));
    const prompt = render(createElement(TuiPromptLine, { content: "检查当前工作区", useColor: false, columns: 80 }));

    expect(timeline.lastFrame()).toContain("* Cogitated for 12s");
    expect(prompt.lastFrame()).toContain("检查当前工作区");
    expect(prompt.lastFrame()).not.toContain("› 检查当前工作区");
    timeline.unmount();
    prompt.unmount();
  });

  it("后台任务卡显示 Core 脱敏的 executable 标签而不读取原始命令", function rendersSafeBackgroundProgramLabel() {
    const projector = createCliEventProjector({ sessionId: "session-job" });
    projector.project(asEvent({ type: "turn_started", turnId: "turn-job", stepCount: 0 }));
    projector.project(asEvent({ type: "tool_result", turnId: "turn-job", stepId: "step-job", callId: "job-call", toolName: "start_background_job", retryCount: 0, summary: "PRIVATE_COMMAND", result: { status: "success", callId: "job-call", toolName: "start_background_job", output: { program: "PRIVATE_PROGRAM", args: ["PRIVATE_ARG"] }, meta: { durationMs: 1, inputHash: "hash" }, display: { titleKey: "tool.job.start.completed", target: "powershell", summary: "job-1 · 当前状态：running", job: { action: "start", jobId: "job-1", programLabel: "powershell", observedStatus: "running" } } } }));
    const projection = projector.getProjection();
    const rendered = render(createElement(TuiLiveTurn, {
      turnId: "turn-job",
      events: projection.events,
      presentation: projection.presentation,
      status: "running",
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: false,
      todoExpanded: false,
      maximumWidth: 80,
    }));
    const frame = rendered.lastFrame() ?? "";
    const viewportSources = createTuiViewportSources({
      transcript: [],
      pendingInputs: [],
      liveTurnId: "turn-job",
      liveEvents: projection.events,
      livePresentation: projection.presentation,
      liveMetrics: { startedAt: 0 },
      hasLiveApprovalEvent: false,
      activity: { phase: "thinking", frame: 0 },
      status: "running",
      activeSkills: [],
      cancellationRequested: false,
    } as never, undefined, 0, 80);
    const jobSource = viewportSources.find(function findJobSource(source) { return source.text.includes("POWERSHELL"); });
    const programStart = jobSource?.text.indexOf("POWERSHELL") ?? -1;

    expect(frame).toContain("后台任务已启动");
    expect(frame).toContain("POWERSHELL · job-1 · 当前状态：running");
    expect(frame).toContain("/jobs 查看后台任务");
    expect(frame).not.toContain("PRIVATE_");
    expect(jobSource?.spans).toContainEqual({ start: programStart, end: programStart + "POWERSHELL".length, style: "accent" });
    rendered.unmount();
  });

  it("审批菜单只渲染 Core 冻结的决定，Plain/JSONL 仍保留 callId", function preservesApprovalAndMachineContract() {
    const projector = createCliEventProjector({ sessionId: "session-presentation" });
    projector.project(asEvent({ type: "approval_required", turnId: "turn-presentation", stepId: "step-1", callId: "edit-1", toolName: "edit_file", result: { status: "approval_required", callId: "edit-1", toolName: "edit_file", approval: { approvalId: "approval-1", callId: "edit-1", toolName: "edit_file", normalizedInputHash: "hash", reason: "RAW_APPROVAL_REASON", risk: "write", preview: { raw: "RAW_APPROVAL_PREVIEW" }, expiresAt: "2026-08-24T07:00:00.000Z", display: { operation: "edit", effect: "workspace", destructive: false, resource: "src/app.ts", allowedDecisions: ["allow_once", "deny"] } }, display: { titleKey: "tool.edit.running", target: "src/app.ts" } } }));
    const projection = projector.getProjection();
    const event = projection.events[0];

    expect(projection.pendingApproval && createTuiApprovalOptions(projection.pendingApproval).map(function decision(option) { return option.decision; })).toEqual(["allow_once", "deny"]);
    expect(event).toMatchObject({ type: "approval_required", callId: "edit-1", allowedDecisions: ["allow_once", "deny"] });
    expect(createPlainRenderer("jsonl").render(event!)).not.toContain("RAW_");
  });

  /** run_command 工作区级授权展示为"记住此命令"，且不误显示 settings.local.json 提示（普通命令记忆走授权库）。 */
  it("run_command 审批展示记住此命令与精确身份说明", function rendersRememberCommandApproval() {
    const options = createTuiApprovalOptions({ approvalId: "approval-run-1", toolName: "run_command", reason: "命令不在已识别的风险分类中", risk: "unknown", allowedDecisions: ["allow_once", "allow_workspace", "deny"] });

    expect(options.map(function decision(option) { return option.decision; })).toEqual(["allow_once", "allow_workspace", "deny"]);
    expect(options.find(function findByDecision(option) { return option.decision === "allow_workspace"; })?.label).toBe("记住此命令");
    const rendered = render(createElement(TuiApprovalPrompt, {
      pendingApproval: { approvalId: "approval-run-1", toolName: "run_command", reason: "命令不在已识别的风险分类中", risk: "unknown", allowedDecisions: ["allow_once", "allow_workspace", "deny"] },
      selectedIndex: 1,
      useColor: false,
      screenReader: false,
    }));
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("记住此命令");
    expect(frame).toContain("程序、参数与工作目录完全一致");
    expect(frame).not.toContain("settings.local.json");
    rendered.unmount();
  });

  /** TUI 必须使用专用标题与 Core Web 明细，不回读原始查询、URL 或网页正文。 */
  it("渲染安全的 Web 来源数、域名、类型与截断事实", function rendersSafeWebToolDetails() {
    const projection = createWebProjection();
    const rendered = render(createElement(TuiLiveTurn, {
      turnId: "turn-web-presentation",
      events: projection.events,
      presentation: projection.presentation,
      status: "running",
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: true,
      todoExpanded: false,
      maximumWidth: 100,
    }));
    const frame = rendered.lastFrame() ?? "";

    expect(frame).toContain("网络搜索");
    expect(frame).toContain("找到 4 个公开来源 · 结果已截断");
    expect(frame).toContain("网页读取");
    expect(frame).toContain("docs.example.com · text/html · 内容已截断");
    expect(frame).not.toContain("PRIVATE_");
    rendered.unmount();
  });
});
