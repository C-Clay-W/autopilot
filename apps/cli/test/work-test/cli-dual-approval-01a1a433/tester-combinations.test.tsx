/** 独立Tester交错键盘与双目标组合验证，运行时流受控。 */
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import type { AgentEventEnvelope, AgentRuntime, Session } from "@autopilot-agent/core";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";

/** 给Ink一次有界绘制机会。 */
async function frame() { await new Promise(function tick(resolve) { setTimeout(resolve, 40); }); }
/** 只等待条件，不重发输入。 */
async function until(check: () => boolean) { for (let i = 0; i < 40 && !check(); i++) await frame(); expect(check()).toBe(true); }
/** 构造精确目标审批并让批准后的执行停在受控门上。 */
async function fixture(count = 1, missing = false) {
  const parent = { id: "parent", title: "父任务", status: "idle", productMode: "work", projectId: "p", createdAt: 0, updatedAt: 0 } as Session;
  const children = Array.from({ length: count }, function child(_, i) { return { ...parent, id: `child-${i}`, title: `子任务${i}`, status: "waiting_approval", activeTurnId: `turn-${i}` } as Session; });
  const events = children.map(function approval(child, i) { return { sessionId: child.id, turnId: child.activeTurnId, seq: 1, timestamp: new Date().toISOString(), event: { type: "approval_required", turnId: child.activeTurnId, stepId: "s", callId: `call-${i}`, toolName: "todo_write", result: { status: "approval_required", approval: { approvalId: `approval-${i}`, callId: `call-${i}`, toolName: "todo_write", constraint: "task-files:v1", reason: `文件清单${i}`, expiresAt: new Date(Date.now() + 60000).toISOString(), allowedDecisions: ["allow_once", "deny"], display: { operation: "编辑任务文件", actionPreview: `文件清单${i}`, allowedDecisions: ["allow_once", "deny"] } } } } } as AgentEventEnvelope; });
  const releases: Array<() => void> = [];
  const submit = vi.fn(async function submit() {});
  const resumed = vi.fn();
  const runtime = { sessions: { get: async function get(id: string) { return id === parent.id ? parent : children.find(function same(child) { return child.id === id; }); } }, approvals: { submit }, turns: {
    getFrozenRunConfig: async function frozen() { return null; }, getUsageSnapshot: async function usage() { return { contextUsage: null, turnUsage: null }; },
    continue: async function* resume(input: { sessionId: string; turnId: string }) { resumed(input); yield { type: "turn_started", turnId: input.turnId, stepCount: 1 }; await new Promise<void>(function hold(resolve) { releases.push(resolve); }); yield { type: "turn_completed", turnId: input.turnId, checkpoint: { turnId: input.turnId, status: "completed", stepCount: 1, messages: [], completedCallIds: [] } }; },
  } } as unknown as AgentRuntime;
  /** 为每个目标复用生产Controller。 */
  function controller(id: string) { return createCliController({ runtime, sessionId: id, renderer: createPlainRenderer("text") }); }
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: parent, initialController: controller(parent.id), createController: controller,
    readDirectoryPage: async function directory() { return { items: [parent, ...children] }; },
    readRelations: async function relations(id) { return id === parent.id ? children.map(function relation(child) { return { threadId: child.id, parentThreadId: parent.id, title: child.title, status: child.status, activeTurnId: child.activeTurnId }; }) : []; },
    readEventPage: async function page(id) { return { items: missing ? [] : events.filter(function belongs(event) { return event.sessionId === id; }), cursor: "1" }; },
  });
  await manager.refresh();
  manager.selected().store.recordPrompt("父正文保留");
  const terminal = Object.assign(new EventEmitter(), { columns: 100, rows: 28 });
  const view = render(createElement(CliSessionWorkspace, { manager, terminalSizeSource: terminal, renderMode: "inline", useColor: false, screenReader: false, reducedMotion: true, closeWhenIdle: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  /** 仅收尾本fixture的执行门和管理器。 */
  async function close() { view.unmount(); for (const release of releases) release(); await frame(); await manager.stop(); }
  return { view, manager, submit, resumed, releases, close, events, runtime };
}


it("双子运行期间主输入实际发送，第二子拒绝身份独立", async function parentSend() {
  const f = await fixture(2);
  const started = vi.fn();
  f.runtime.turns.start = async function* start(input) { started(input); yield { type: "turn_started", turnId: "parent-turn", stepCount: 0 }; yield { type: "turn_completed", turnId: "parent-turn", checkpoint: { turnId: "parent-turn", status: "completed", stepCount: 0, messages: [], completedCallIds: [] } }; };
  try {
    await frame(); f.view.stdin.write("父消息"); await frame(); f.view.stdin.write("\u0001"); await frame(); f.view.stdin.write("\r");
    await until(function running() { return f.resumed.mock.calls.length === 1; });
    f.view.stdin.write("\r"); await until(function sent() { return started.mock.calls.length === 1; });
    expect(started.mock.calls[0]![0]).toMatchObject({ sessionId: "parent", content: "父消息" });
    f.view.stdin.write("\u0001"); await frame(); f.view.stdin.write("\u001b[B"); await frame(); f.view.stdin.write("\r");
    await until(function second() { return f.submit.mock.calls.length === 2; });
    expect(f.submit.mock.calls[1]![0]).toMatchObject({ sessionId: "child-1", approvalId: "approval-1", decision: "deny" });
    expect(f.manager.selected().sessionId).toBe("parent");
  } finally { await f.close(); }
});

it("CtrlT键盘进入子会话自行审批，返回父会话草稿光标保留", async function keyboardChild() {
  const f = await fixture(2);
  try {
    await frame(); f.view.stdin.write("AB"); await frame(); f.view.stdin.write("\u001b[D"); await frame();
    f.view.stdin.write("\u0014"); await frame(); f.view.stdin.write("\u001b[B"); await frame(); f.view.stdin.write("\r");
    await until(function selected() { return f.manager.selected().sessionId === "child-0"; });
    f.view.stdin.write("\r"); await until(function resumed() { return f.resumed.mock.calls.length === 1; });
    f.view.stdin.write("\u0014"); await frame(); f.view.stdin.write("\u001b[A"); await frame(); f.view.stdin.write("\r");
    await until(function parent() { return f.manager.selected().sessionId === "parent"; });
    await frame(); await frame(); f.view.stdin.write("中"); await frame();
    expect(f.manager.selected().viewState.draftRef.current?.inputRef.current).toBe("A中B");
    expect(f.view.lastFrame()).not.toContain("文件清单0");
    expect(f.view.lastFrame()).toContain("文件清单1");
    expect(f.submit.mock.calls[0]![0]).toMatchObject({ sessionId: "child-0", approvalId: "approval-0" });
  } finally { await f.close(); }
});

it("审批聚焦后CtrlT仍可打开会话选择", async function switchWhileFocused() {
  const f = await fixture();
  try {
    await frame(); f.view.stdin.write("\u0001"); await frame(); f.view.stdin.write("\u0014"); await frame();
    expect(f.view.lastFrame()).toContain("会话 · ↑↓/Enter");
    expect(f.submit).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

