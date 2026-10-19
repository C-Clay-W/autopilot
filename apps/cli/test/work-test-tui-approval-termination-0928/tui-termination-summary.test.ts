/** runbook-P14 [2026-09-28 12:50] 修复回归：终态文案只在真实结束状态显示；审批等待与进行中状态不得复活旧 termination。 */
import { describe, expect, it } from "vitest";
import { getTuiTerminationSummary, isTerminalStatus } from "../../src/tui/format.js";
import { formatAgentTermination } from "../../src/termination-format.js";
import type { CliTuiTimelineEvent } from "../../src/tui/types.js";
import type { CliTurnStatus } from "../../src/types.js";

/** 构造最小 status 时间线事件；本套件只关心 status 与 termination 字段的选择行为。 */
function statusEvent(status: string, termination?: { reason?: string; recoverable?: boolean }): CliTuiTimelineEvent {
  return { type: "status", seq: 1, turnId: "t1", status, ...(termination ? { termination } : {}) } as unknown as CliTuiTimelineEvent;
}

/** 审批暂停事件序列：running → pause(带旧版本 reasonless termination)，后续无新 status 事件。 */
function approvalPausedEvents(): CliTuiTimelineEvent[] {
  return [statusEvent("running"), statusEvent("interrupted_recoverable", { recoverable: true })];
}

describe("isTerminalStatus 等待态拆分", function terminalStatusSuite() {
  it("waiting_user_input 不是终态", function waitingUserInputIsNotTerminal() {
    expect(isTerminalStatus("waiting_user_input" as CliTurnStatus)).toBe(false);
  });

  it("completed 与真实中断仍是终态", function completedAndInterruptedStayTerminal() {
    expect(isTerminalStatus("completed" as CliTurnStatus)).toBe(true);
    expect(isTerminalStatus("interrupted" as CliTurnStatus)).toBe(true);
    expect(isTerminalStatus("failed" as CliTurnStatus)).toBe(true);
    expect(isTerminalStatus("running" as CliTurnStatus)).toBe(false);
  });
});

describe("getTuiTerminationSummary 当前状态防御", function terminationSummarySuite() {
  it("审批恢复后当前状态 running 不显示旧 pause 的终态文案", function runningStatusHidesStaleTermination() {
    expect(getTuiTerminationSummary(approvalPausedEvents(), "running" as CliTurnStatus)).toBeUndefined();
  });

  it("等待审批或等待回答时不显示终态文案", function waitingStatusesHideTermination() {
    expect(getTuiTerminationSummary(approvalPausedEvents(), "waiting_approval" as CliTurnStatus)).toBeUndefined();
    expect(getTuiTerminationSummary(approvalPausedEvents(), "waiting_user_input" as CliTurnStatus)).toBeUndefined();
  });

  it("completed 不从旧事件复活终态文案", function completedStatusHidesTermination() {
    expect(getTuiTerminationSummary(approvalPausedEvents(), "completed" as CliTurnStatus)).toBeUndefined();
  });

  it("无当前状态时只解释最新生命周期 status：后续 running status 使旧 pause 失效", function latestLifecycleStatusWins() {
    const events = [...approvalPausedEvents(), statusEvent("running")];
    expect(getTuiTerminationSummary(events)).toBeUndefined();
  });

  it("真中断 Turn 仍显示终态原因与恢复性", function realInterruptionShowsTermination() {
    const events = [statusEvent("running"), statusEvent("interrupted", { reason: "runtime_budget", recoverable: true })];
    expect(getTuiTerminationSummary(events, "interrupted" as CliTurnStatus)).toBe("执行时长达到上限 · 可继续");
  });
});

describe("formatAgentTermination 安全兜底文案", function terminationFormatSuite() {
  it("无 reason 且 recoverable 时显示执行已暂停", function recoverableFallback() {
    expect(formatAgentTermination({ recoverable: true })).toBe("执行已暂停 · 可继续");
  });

  it("无 reason 且不可恢复时显示任务已停止", function nonRecoverableFallback() {
    expect(formatAgentTermination({ recoverable: false })).toBe("任务已停止 · 不可继续");
  });
});
