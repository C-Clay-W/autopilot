/** r006待审批身份与关联/当前卡：合成Runtime、真实Controller和内存Ink。 */
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { readCliSessionSummary } from "../../../src/session-summary.js";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";
import { TuiLiveTurn } from "../../../src/tui/timeline/turn.js";
import type { AgentEventEnvelope, AgentRuntime, RuntimePorts, Session } from "@autopilot-agent/core";

/** 给Ink被动effect一次有界提交机会。 */
async function frame() { await new Promise(function tick(resolve) { setTimeout(resolve, 40); }); }
/** 等待可观察帧，不重发输入。 */
async function until(check: () => boolean) { for (let i = 0; i < 25 && !check(); i++) await frame(); expect(check()).toBe(true); }
const pending = { approvalId: "approval-child", callId: "call", toolName: "todo_write", constraint: "task-files:v1", reason: "合成文件清单", allowedDecisions: ["allow_once", "deny"] as const, display: { operation: "编辑任务文件", actionPreview: "合成文件清单", allowedDecisions: ["allow_once", "deny"] as const } };

it("pending Session没有activeTurnId仍返回精确当前Turn，归属/状态/迟到变化失败安全", async function currentIdentity() {
  const summary = { id: "child", status: "waiting_approval", productMode: "work", projectId: "p", createdAt: 0, updatedAt: 0 };
  const get = vi.fn().mockResolvedValue(summary); const latest = vi.fn().mockResolvedValue({ id: "turn-child", sessionId: "child", status: "waiting_approval" });
  const ports = { sessionStore: { getDirectoryEntry: get }, turnStore: { getLatest: latest } } as unknown as RuntimePorts;
  expect(await readCliSessionSummary(ports, "child")).toMatchObject({ currentTurnId: "turn-child" });
  latest.mockResolvedValueOnce({ id: "foreign", sessionId: "other", status: "waiting_approval" }); expect((await readCliSessionSummary(ports, "child"))?.currentTurnId).toBeUndefined();
  get.mockResolvedValueOnce(summary).mockResolvedValueOnce({ ...summary, status: "completed" }); expect(await readCliSessionSummary(ports, "child")).toBeNull();
});

it("当前有效审批即使没有live事件仍显示原文件集合审批菜单", async function emptyEventsCard() {
  const view = render(createElement(TuiLiveTurn, { turnId: "turn-child", events: [], pendingApproval: pending as never, approvalSelectedIndex: 0, status: "waiting_approval", useColor: false, screenReader: false, todoExpanded: false, maximumWidth: 78 }));
  try { await frame(); expect(view.lastFrame()).toContain("批准本任务文件修改"); expect(view.lastFrame()).toContain("拒绝"); } finally { view.unmount(); }
});

it("父Ctrl+A可原地批准无activeTurnId子任务；切入目标自身卡仍可操作且草稿隔离", async function relatedApproval() {
  const initial = { id: "root", title: "父任务", status: "completed", productMode: "work", projectId: "p", createdAt: 0, updatedAt: 0 } as Session;
  const child = { ...initial, id: "child", title: "子任务", status: "waiting_approval" as const };
  const submit = vi.fn(async function approve() {}); const resumed = vi.fn();
  const runtime = { sessions: { get: async function get(id: string) { return id === "root" ? initial : child; } }, approvals: { submit }, turns: { getFrozenRunConfig: async function frozen() { return null; }, getUsageSnapshot: async function usage() { return { contextUsage: null, turnUsage: null }; }, continue: async function* resume(input: unknown) { resumed(input); } } } as unknown as AgentRuntime;
  const ports = { sessionStore: { getDirectoryEntry: runtime.sessions.get }, turnStore: { getLatest: async function latest() { return { id: "turn-child", sessionId: "child", status: "waiting_approval" }; } } } as unknown as RuntimePorts;
  /** 每目标固定绑定真实Controller，禁止观察启动执行。 */
  function controller(id: string) { return createCliController({ runtime, sessionId: id, renderer: createPlainRenderer("text") }); }
  const event = { sessionId: "child", turnId: "turn-child", seq: 24, timestamp: new Date().toISOString(), event: { type: "approval_required", turnId: "turn-child", stepId: "s", callId: "call", toolName: "todo_write", result: { status: "approval_required", approval: pending } } } as unknown as AgentEventEnvelope;
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: initial, initialController: controller("root"), createController: controller, readSummary: function summary(id) { return readCliSessionSummary(ports, id); }, readRelations: async function relations(id) { const summary = await readCliSessionSummary(ports, "child"); return id === "root" ? [{ threadId: "child", parentThreadId: "root", title: "子任务", status: summary!.status, activeTurnId: summary!.currentTurnId }] : []; }, readEventPage: async function page(id) { return { items: id === "child" ? [event] : [], cursor: "tail" }; } });
  await manager.refresh();
  const terminal = Object.assign(new EventEmitter(), { columns: 120, rows: 28 });
  const view = render(createElement(CliSessionWorkspace, { manager, terminalSizeSource: terminal, renderMode: "inline", useColor: false, screenReader: false, reducedMotion: true, closeWhenIdle: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  try {
    await frame(); view.stdin.write("父草稿"); await frame(); expect(view.lastFrame()).toContain("Ctrl+A原地处理");
    view.stdin.write("\u0001"); await until(function listed() { return view.lastFrame().includes("关联任务"); }); view.stdin.write("\r"); await until(function menu() { return view.lastFrame().includes("批准本任务文件修改"); });
    view.stdin.write("\u001b"); await frame(); view.stdin.write("\u001b"); await frame();
    await manager.select("child"); await frame(); expect(manager.selected().store.getSnapshot().pendingApproval?.approvalId).toBe("approval-child"); expect(view.lastFrame()).toContain("批准本任务文件修改");
    await manager.select("root"); await frame(); view.stdin.write("\u0001"); await frame(); view.stdin.write("\r"); await frame(); view.stdin.write("\r"); await until(function approved() { return submit.mock.calls.length === 1; });
    expect(submit).toHaveBeenCalledWith({ sessionId: "child", turnId: "turn-child", approvalId: "approval-child", decision: "allow_once" });
    expect(resumed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "child", turnId: "turn-child" })); expect(manager.entries()[0]!.viewState.draftRef.current?.inputRef.current).toBe("父草稿");
  } finally { view.unmount(); await manager.stop(); }
});
