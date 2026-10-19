/** Presentation package 定向测试：验证安全边界、callId 身份、replay 幂等与 Host 输入。 */
import { describe, expect, it } from "vitest";
import type { AgentCheckpoint, AgentEvent, AgentEventEnvelope } from "@autopilot-agent/core";
import { createPresentationState, groupToolCalls, redactPresentationText, reducePresentationInput, replayPresentationInputs, resolvePresentationApproval, restorePresentationApproval, selectAssistantAnswers, selectRequiredApprovals, selectTimeline, selectToolCalls } from "../src/index.js";
import { createPresentationFixture } from "./presentation.fixture.js";

describe("Presentation reducer", function presentationReducerSuite() {
  it("只投影安全展示事实，并按 callId 保留同名工具", function projectsSafeFacts() {
    const state = replayPresentationInputs(createPresentationFixture());
    const calls = selectToolCalls(state, "turn-primary");
    const readCalls = calls.filter(function isRead(call) { return call.toolName === "read_file"; });
    const serialized = JSON.stringify(state);

    expect(readCalls.map(function getId(call) { return call.callId; })).toEqual(["call-read-1", "call-read-2"]);
    expect(calls.find(function findEdit(call) { return call.callId === "call-edit-1" })).toMatchObject({ state: "completed", target: "apps/web/page.tsx", diff: { files: 1, added: 12, removed: 9 } });
    expect(calls.find(function findCommand(call) { return call.callId === "call-command-ok" })).toMatchObject({ state: "completed", resultSummary: "Exit 0" });
    expect(calls.find(function findFailure(call) { return call.callId === "call-command-failed" })).toMatchObject({ state: "failed", errorCode: "COMMAND_FAILED" });
    expect(calls.find(function findTimeout(call) { return call.callId === "call-command-timeout" })).toMatchObject({ state: "timeout", errorCode: "TOOL_TIMEOUT" });
    expect(calls.find(function findMcp(call) { return call.callId === "call-mcp-1" })?.category).toBe("external");
    expect(state.items.filter(function compactNotices(item) { return item.kind === "context_notice"; }).map(function getState(item) { return item.state; })).toEqual(["compacting", "compacted", "failed"]);
    expect(state.items.filter(function undoItems(item) { return item.kind === "undo"; }).map(function getState(item) { return item.state; })).toEqual(["completed", "failed"]);
    expect(state.items.filter(function terminalItems(item) { return item.kind === "turn_summary"; }).map(function getState(item) { return item.state; })).toEqual(["failed", "interrupted", "limit_reached", "completed"]);
    expect(serialized).not.toContain("RAW_");
    expect(state.turnSummary).toMatchObject({ state: "completed", toolCount: 7 });
  });

  it("只保留已消费引导状态，不从 checkpoint 提取私有正文", function omitsConsumedInputContent() {
    const checkpoint: AgentCheckpoint = {
      turnId: "turn-input",
      status: "running",
      stepCount: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "继续检查审批链" }] }],
      completedCallIds: [],
      consumedInputIds: ["input-1"],
    };
    const state = replayPresentationInputs([
      { kind: "runtime_event", envelope: { seq: 1, sessionId: "session-input", turnId: "turn-input", timestamp: "2026-09-17T01:00:00.000Z", event: { type: "input_consumed", turnId: "turn-input", inputId: "input-1", checkpoint } as AgentEvent } },
    ]);

    expect(state.items).toContainEqual(expect.objectContaining({ kind: "input_notice", inputId: "input-1", state: "consumed" }));
    expect(JSON.stringify(state.items)).not.toContain("继续检查审批链");
  });

  it("拒绝的 write/edit 不计入实际修改文件数", function excludesDeniedMutationsFromSummary() {
    const state = replayPresentationInputs([
      { kind: "runtime_event", envelope: { seq: 0, sessionId: "session-denied", turnId: "turn-denied", timestamp: "2026-09-02T00:00:00.000Z", event: { type: "turn_started", turnId: "turn-denied", stepCount: 0 } as AgentEvent } },
      { kind: "runtime_event", envelope: { seq: 1, sessionId: "session-denied", turnId: "turn-denied", timestamp: "2026-09-02T00:00:01.000Z", event: { type: "tool_started", turnId: "turn-denied", stepId: "step-1", callId: "call-denied", toolName: "write_file", summary: "正在创建文件" } as AgentEvent } },
      { kind: "runtime_event", envelope: { seq: 2, sessionId: "session-denied", turnId: "turn-denied", timestamp: "2026-09-02T00:00:02.000Z", event: { type: "tool_result", turnId: "turn-denied", stepId: "step-1", callId: "call-denied", toolName: "write_file", retryCount: 0, summary: "写入被拒绝", result: { status: "denied", callId: "call-denied", toolName: "write_file", error: { code: "APPROVAL_REQUIRED", message: "用户拒绝执行本次工具调用" }, display: { titleKey: "tool.write.completed", target: "stage7-deny-retest.txt", summary: "create" } } } as AgentEvent } },
      { kind: "runtime_event", envelope: { seq: 3, sessionId: "session-denied", turnId: "turn-denied", timestamp: "2026-09-02T00:00:03.000Z", event: { type: "turn_completed", turnId: "turn-denied", checkpoint: {} } as AgentEvent } },
    ]);

    expect(state.turnSummary).toMatchObject({ state: "completed", toolCount: 1 });
    expect(state.turnSummary?.modifiedFileCount).toBeUndefined();
  });

  it("在审批恢复后更新同一工具节点，并仅展示冻结的允许决定", function resumesApproval() {
    const state = replayPresentationInputs(createPresentationFixture());
    const approval = state.items.find(function findApproval(item) { return item.kind === "approval" && item.approvalId === "approval-edit-1"; });

    expect(approval).toMatchObject({ state: "resolved", display: { allowedDecisions: ["allow_once", "deny"] } });
    expect(selectRequiredApprovals(state)).toEqual([]);
    expect(selectToolCalls(state).filter(function editCall(call) { return call.callId === "call-edit-1"; })).toHaveLength(1);
  });

  it("本地提交审批决定后立即收起卡片并清除等待授权活动", function resolvesApprovalLocally() {
    const awaiting = replayPresentationInputs(createPresentationFixture().filter(function beforeToolResult(input) {
      return input.kind !== "runtime_event" || input.envelope.seq <= 8;
    }));
    const resolved = resolvePresentationApproval(awaiting, "approval-edit-1");

    expect(selectRequiredApprovals(resolved)).toEqual([]);
    expect(resolved.activeOperation).toBeUndefined();
    expect(resolved.items.find(function findApproval(item) { return item.kind === "approval" && item.approvalId === "approval-edit-1" })).toMatchObject({ state: "resolved" });
  });

  it("审批提交失败时恢复卡片，但不覆盖已经继续执行的工具事实", function restoresApprovalAfterFailure() {
    const awaiting = replayPresentationInputs(createPresentationFixture().filter(function beforeToolResult(input) {
      return input.kind !== "runtime_event" || input.envelope.seq <= 8;
    }));
    const resolved = resolvePresentationApproval(awaiting, "approval-edit-1");
    const restored = restorePresentationApproval(resolved, "approval-edit-1");

    expect(selectRequiredApprovals(restored)).toHaveLength(1);
    expect(restored.activeOperation).toEqual({ kind: "approval", id: "approval:approval-edit-1" });

    const completed = replayPresentationInputs(createPresentationFixture());
    expect(restorePresentationApproval(completed, "approval-edit-1")).toBe(completed);
  });

  it("审批暂停不生成 Turn Summary，避免恢复后将阶段性摘要插入最终回答前", function omitsSummaryForApprovalPause() {
    const checkpoint: AgentCheckpoint = { turnId: "turn-awaiting", status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [] };
    const envelopes: AgentEventEnvelope[] = [
      { seq: 1, sessionId: "session-awaiting", turnId: "turn-awaiting", timestamp: "2026-08-25T00:00:00.000Z", event: { type: "turn_started", turnId: "turn-awaiting", stepCount: 0 } as AgentEvent },
      { seq: 2, sessionId: "session-awaiting", turnId: "turn-awaiting", timestamp: "2026-08-25T00:00:01.000Z", event: { type: "turn_paused", turnId: "turn-awaiting", checkpoint } as AgentEvent },
    ];

    expect(replayPresentationInputs(envelopes.map(function toInput(envelope) { return { kind: "runtime_event" as const, envelope }; })).turnSummary).toBeUndefined();
  });

  it("仅将连续成功探索工具折叠为视图组，失败和超时保持单独可见", function groupsExplorationOnly() {
    const state = replayPresentationInputs(createPresentationFixture());
    const timeline = selectTimeline(state);
    const group = timeline.find(function findGroup(item) { return item.kind === "tool_group"; });

    expect(group).toMatchObject({ groupKey: "exploration", toolCallIds: ["call-read-1", "call-read-2"] });
    expect(timeline.some(function hasTimeout(item) { return item.kind === "tool_call" && item.callId === "call-command-timeout"; })).toBe(true);
    expect(groupToolCalls(state.items).filter(function groupsOnly(item) { return item.kind === "tool_group"; })).toHaveLength(1);
  });

  it("只隐藏同一 turn 与 step 内已有真实调用的自动工具名摘要", function hidesRedundantToolCallSummaryByStep() {
    const envelopes: AgentEventEnvelope[] = [
      { seq: 1, sessionId: "session-dedupe", turnId: "turn-dedupe", timestamp: "2026-10-11T01:00:00.000Z", event: { type: "turn_started", turnId: "turn-dedupe", stepCount: 0 } as AgentEvent },
      { seq: 2, sessionId: "session-dedupe", turnId: "turn-dedupe", timestamp: "2026-10-11T01:00:01.000Z", event: { type: "reasoning_summary", turnId: "turn-dedupe", stepId: "step-1", summary: "模型请求调用 read_file、read_file" } as AgentEvent },
      { seq: 3, sessionId: "session-dedupe", turnId: "turn-dedupe", timestamp: "2026-10-11T01:00:02.000Z", event: { type: "tool_started", turnId: "turn-dedupe", stepId: "step-1", callId: "call-read-1", toolName: "read_file", summary: "正在读取" } as AgentEvent },
      { seq: 4, sessionId: "session-dedupe", turnId: "turn-dedupe", timestamp: "2026-10-11T01:00:03.000Z", event: { type: "tool_result", turnId: "turn-dedupe", stepId: "step-1", callId: "call-read-1", toolName: "read_file", retryCount: 0, summary: "读取完成", result: { status: "success", callId: "call-read-1", toolName: "read_file", output: "raw one", meta: { durationMs: 1, inputHash: "hash-1" }, display: { titleKey: "tool.read.completed", target: "src/one.md", summary: "10 行" } } } as AgentEvent },
      { seq: 5, sessionId: "session-dedupe", turnId: "turn-dedupe", timestamp: "2026-10-11T01:00:04.000Z", event: { type: "tool_started", turnId: "turn-dedupe", stepId: "step-1", callId: "call-read-2", toolName: "read_file", summary: "正在读取" } as AgentEvent },
      { seq: 6, sessionId: "session-dedupe", turnId: "turn-dedupe", timestamp: "2026-10-11T01:00:05.000Z", event: { type: "tool_result", turnId: "turn-dedupe", stepId: "step-1", callId: "call-read-2", toolName: "read_file", retryCount: 0, summary: "读取完成", result: { status: "success", callId: "call-read-2", toolName: "read_file", output: "raw two", meta: { durationMs: 1, inputHash: "hash-2" }, display: { titleKey: "tool.read.completed", target: "src/two.md", summary: "20 行" } } } as AgentEvent },
      { seq: 7, sessionId: "session-dedupe", turnId: "turn-dedupe", timestamp: "2026-10-11T01:00:06.000Z", event: { type: "reasoning_summary", turnId: "turn-dedupe", stepId: "step-2", summary: "模型请求调用 run_command" } as AgentEvent },
      { seq: 8, sessionId: "session-dedupe", turnId: "turn-dedupe", timestamp: "2026-10-11T01:00:07.000Z", event: { type: "reasoning_summary", turnId: "turn-dedupe", stepId: "step-3", summary: "正在核对安全边界" } as AgentEvent },
    ];
    const inputs = envelopes.map(function toInput(envelope) { return { kind: "runtime_event" as const, envelope }; });
    const state = replayPresentationInputs(inputs);
    const timeline = selectTimeline(state);
    const calls = selectToolCalls(state, "turn-dedupe");

    expect(timeline.some(function hasRedundantThinking(item) { return item.kind === "thinking" && item.stepId === "step-1"; })).toBe(false);
    expect(timeline).toContainEqual(expect.objectContaining({ kind: "thinking", stepId: "step-2", summary: "模型请求调用 run_command" }));
    expect(timeline).toContainEqual(expect.objectContaining({ kind: "thinking", stepId: "step-3", summary: "正在核对安全边界" }));
    expect(state.items).toContainEqual(expect.objectContaining({ kind: "thinking", stepId: "step-1", summary: "模型请求调用 read_file、read_file" }));
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: "call-read-1", stepId: "step-1", target: "src/one.md", resultSummary: "10 行" }),
      expect.objectContaining({ callId: "call-read-2", stepId: "step-1", target: "src/two.md", resultSummary: "20 行" }),
    ]));
  });

  it("reset 将过程回答归档，并为同一 Turn 保留唯一最终答复", function separatesProcessAndFinalAnswer() {
    const state = replayPresentationInputs([
      { kind: "runtime_event", envelope: { seq: 1, sessionId: "session-process", turnId: "turn-process", timestamp: "2026-08-25T01:00:00.000Z", event: { type: "answer_delta", turnId: "turn-process", stepId: "step-1", delta: "先说明当前发现。" } } },
      { kind: "runtime_event", envelope: { seq: 2, sessionId: "session-process", turnId: "turn-process", timestamp: "2026-08-25T01:00:01.000Z", event: { type: "answer_reset", turnId: "turn-process", stepId: "step-1" } } },
      { kind: "runtime_event", envelope: { seq: 3, sessionId: "session-process", turnId: "turn-process", timestamp: "2026-08-25T01:00:02.000Z", event: { type: "tool_started", turnId: "turn-process", stepId: "step-1", callId: "call-1", toolName: "read_file", summary: "正在读取文件" } } },
    ]);

    expect(state.items).toContainEqual(expect.objectContaining({ kind: "assistant_answer", channel: "process", content: "先说明当前发现。" }));
    const retried = replayPresentationInputs([
      { kind: "runtime_event" as const, envelope: { seq: 1, sessionId: "session-process", turnId: "turn-process", timestamp: "2026-08-25T01:00:00.000Z", event: { type: "answer_delta", turnId: "turn-process", stepId: "step-1", delta: "先说明当前发现。" } } },
      { kind: "runtime_event" as const, envelope: { seq: 2, sessionId: "session-process", turnId: "turn-process", timestamp: "2026-08-25T01:00:01.000Z", event: { type: "answer_discard", turnId: "turn-process", stepId: "step-1" } } },
      { kind: "runtime_event" as const, envelope: { seq: 3, sessionId: "session-process", turnId: "turn-process", timestamp: "2026-08-25T01:00:02.000Z", event: { type: "answer_delta", turnId: "turn-process", stepId: "step-2", delta: "最终答复。" } } },
    ]);

    expect(retried.items).not.toContainEqual(expect.objectContaining({ kind: "assistant_answer", content: "先说明当前发现。" }));
    expect(selectAssistantAnswers(retried, "turn-process")).toEqual([expect.objectContaining({ channel: "final", stepId: "step-2", content: "最终答复。" })]);
  });

  it("discard 删除明确无效的候选，不让它成为过程或最终输出", function discardsInvalidAnswerCandidate() {
    const retried = replayPresentationInputs([
      { kind: "runtime_event" as const, envelope: { seq: 1, sessionId: "session-process", turnId: "turn-process", timestamp: "2026-08-25T01:00:00.000Z", event: { type: "answer_delta", turnId: "turn-process", stepId: "step-1", delta: "过程片段。" } } },
      { kind: "runtime_event" as const, envelope: { seq: 2, sessionId: "session-process", turnId: "turn-process", timestamp: "2026-08-25T01:00:01.000Z", event: { type: "answer_discard", turnId: "turn-process", stepId: "step-1" } } },
      { kind: "runtime_event" as const, envelope: { seq: 3, sessionId: "session-process", turnId: "turn-process", timestamp: "2026-08-25T01:00:02.000Z", event: { type: "answer_delta", turnId: "turn-process", stepId: "step-1", delta: "最终答复。" } } },
    ]);
    expect(retried.items).not.toContainEqual(expect.objectContaining({ kind: "assistant_answer", content: "过程片段。" }));
    expect(selectAssistantAnswers(retried, "turn-process")).toEqual([expect.objectContaining({ channel: "final", content: "最终答复。" })]);
  });

  it("对重复、continue 与乱序 Runtime 信封幂等回放，Host 事件保持 Runtime 外边界", function replaysDeterministically() {
    const fixture = createPresentationFixture();
    const primary = fixture.filter(function primaryOnly(input) { return input.kind === "runtime_event" && input.envelope.turnId === "turn-primary"; });
    const unordered = [...primary.slice(10), primary[4], ...primary.slice(0, 10)].reverse();
    const state = replayPresentationInputs(unordered);
    const live = primary.slice(0, 3).reduce(reducePresentationInput, createPresentationState());
    const full = replayPresentationInputs(fixture);

    expect(selectToolCalls(state, "turn-primary")).toHaveLength(7);
    expect(state.turnSummary).toMatchObject({ state: "completed", toolCount: 7, modifiedFileCount: 1 });
    expect(full.transport).toBe("reconnecting");
    expect(full.items.find(function findJob(item) { return item.kind === "job"; })).toMatchObject({ state: "interrupted" });
    expect(full.items.find(function findEvidence(item) { return item.kind === "capability_notice" && item.scope === "evidence"; })).toMatchObject({ summary: "2 个来源" });
    expect(live).toBeDefined();
  });

  it("脱敏 Host 文本并保持长度边界", function redactsHostText() {
    expect(redactPresentationText("token=abc authorization: xyz Bearer hello")).toBe("token=[REDACTED] authorization: [REDACTED] Bearer [REDACTED]");
  });
});
