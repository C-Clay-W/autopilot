/** S4复用既有Workspace组合夹具，验证真实根键盘消费与问题定位。 */
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
async function fixture(count = 1, missing = false, columns = 100, directoryGate?: Promise<void>) {
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
    readDirectoryPage: async function directory() { await directoryGate; return { items: [parent, ...children] }; },
    readRelations: async function relations(id) { return id === parent.id ? children.map(function relation(child) { return { threadId: child.id, parentThreadId: parent.id, title: child.title, status: child.status, activeTurnId: child.activeTurnId }; }) : []; },
    readEventPage: async function page(id) { return { items: missing ? [] : events.filter(function belongs(event) { return event.sessionId === id; }), cursor: "1" }; },
  });
  await manager.refresh();
  manager.selected().store.recordPrompt("父正文保留");
  const terminal = Object.assign(new EventEmitter(), { columns, rows: 28 });
  const view = render(createElement(CliSessionWorkspace, { manager, terminalSizeSource: terminal, renderMode: "inline", useColor: false, screenReader: false, reducedMotion: true, closeWhenIdle: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  /** 仅收尾本fixture的执行门和管理器。 */
  async function close() { view.unmount(); for (const release of releases) release(); await frame(); await manager.stop(); }
  return { view, manager, submit, resumed, releases, close, events, runtime };
}


it.each([80, 130])("S4 %i列 CtrlA等待问题Enter定位目标，Esc后下一键保留父草稿光标", async function questionNavigation(columns) {
  const f = await fixture(1, true, columns);
  try {
    const parent = f.manager.selected();
    const child = f.manager.related()[0]!;
    child.controller.observe?.([{ sessionId: child.sessionId, turnId: "turn-0", seq: 2, timestamp: new Date().toISOString(), event: { type: "question_required", turnId: "turn-0", callId: "call-q", requestId: "request-q", questions: [] } } as any]);
    child.store.syncProjection(child.controller.getProjection());
    await frame();
    f.view.stdin.write("AB"); await frame(); f.view.stdin.write("\u001b[D"); await frame();
    f.view.stdin.write("\u0001"); await frame(); f.view.stdin.write("\u001b[27u"); f.view.stdin.write("中"); await frame();
    expect(parent.viewState.draftRef.current?.inputRef.current).toBe("A中B");
    f.view.stdin.write("\u0001"); await frame(); f.view.stdin.write("\r");
    await until(function located() { return f.manager.selected().sessionId === child.sessionId; });
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.resumed).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("S4 快速CtrlT方向Enter与CtrlA Enter只提交固定子身份一次", async function rapidRootInput() {
  const f = await fixture(2);
  try {
    await frame();
    f.view.stdin.write("父草稿"); await frame();
    f.view.stdin.write("\u0014"); f.view.stdin.write("\u001b[B"); f.view.stdin.write("\r");
    await until(function child() { return f.manager.selected().sessionId === "child-0"; });
    f.view.stdin.write("\u0014"); f.view.stdin.write("\u001b[A"); f.view.stdin.write("\r");
    await until(function parent() { return f.manager.selected().sessionId === "parent"; });
    await frame();
    f.view.stdin.write("\u0001"); f.view.stdin.write("\r");
    await until(function submitted() { return f.submit.mock.calls.length === 1; });
    expect(f.submit.mock.calls[0]![0]).toMatchObject({ sessionId: "child-0", turnId: "turn-0", approvalId: "approval-0" });
    expect(f.manager.selected().viewState.draftRef.current?.inputRef.current).toBe("父草稿");
  } finally { await f.close(); }
});

it("S4 新卡不抢父输入且原决定恢复卡Enter复用子请求", async function arrivalAndRecovery() {
  const f = await fixture(1, true);
  try {
    const parent = f.manager.selected(); const child = f.manager.related()[0]!;
    parent.attachments = ["controlled-attachment.png"];
    await frame(); f.view.stdin.write("AB"); await frame(); f.view.stdin.write("\u001b[D"); await frame();
    child.controller.observe?.([f.events[0]!]);
    child.store.syncProjection(child.controller.getProjection());
    await frame(); f.view.stdin.write("中"); await frame();
    expect(f.manager.selected()).toBe(parent);
    expect(parent.viewState.draftRef.current?.inputRef.current).toBe("A中B");
    expect(parent.attachments).toEqual(["controlled-attachment.png"]);
    expect(f.view.lastFrame()).toContain("父正文保留");
    child.executionView = { sessionId: child.sessionId, turnId: "turn-0", status: "waiting_approval", execution: "inactive", waiting: "approval", lastSeq: 1, interaction: { state: "decided", approval: f.events[0]! } };
    child.controller.syncObservedInteraction?.({ turnId: "turn-0", status: "waiting_approval" });
    child.store.syncProjection(child.controller.getProjection());
    f.runtime.turns.getRecoverableState = vi.fn(async function saved() { return { turnId: "turn-0", status: "awaiting_approval", recoverable: true, activeSkills: [], lastSeq: 1, interactionState: "decided", approval: (f.events[0]!.event as any).result.approval } as any; });
    f.runtime.approvals.getDecision = vi.fn(async function saved() { return { decision: "allow_once" } as any; });
    await frame(); f.view.stdin.write("\u0001"); f.view.stdin.write("\r");
    await until(function resumed() { return f.resumed.mock.calls.length === 1; });
    expect(f.resumed.mock.calls[0]![0]).toMatchObject({ sessionId: "child-0", turnId: "turn-0", approval: { approvalId: "approval-0", decision: "allow" } });
    expect(f.submit).not.toHaveBeenCalled();
    expect(parent.viewState.draftRef.current?.inputRef.current).toBe("A中B");
  } finally { await f.close(); }
});

it("S4 裸Esc独立解析后下一键进入父草稿，目录CtrlT Esc CtrlT复用同一读取", async function reopensLoadingDirectory() {
  let release!: () => void;
  const gate = new Promise<void>(function hold(resolve) { release = resolve; });
  const f = await fixture(2, false, 80, gate);
  try {
    await frame();
    f.view.stdin.write("\u0014");
    f.view.stdin.write("\u001b");
    // Ink将裸Esc留到setImmediate，等待解码完成再发送下一个独立事件。
    await new Promise(function parsed(resolve) { setImmediate(resolve); });
    f.view.stdin.write("x"); await frame();
    expect(f.manager.selected().viewState.draftRef.current?.inputRef.current).toBe("x");
    f.view.stdin.write("\u0014"); f.view.stdin.write("\u001b[B"); f.view.stdin.write("\r");
    await frame();
    expect(f.manager.selected().sessionId).toBe("parent");
    release();
    await until(function child() { return f.manager.selected().sessionId === "child-0"; });
    expect(f.submit).not.toHaveBeenCalled();
  } finally { release(); await f.close(); }
});

it("S4未知副作用结果的已存决定不提供自动恢复卡", async function unconfirmedRecovery() {
  const f = await fixture(1, true);
  try {
    const child = f.manager.related()[0]!;
    child.executionView = { sessionId: child.sessionId, turnId: "turn-0", status: "waiting_approval", execution: "unconfirmed", lastSeq: 1, interaction: { state: "decided", approval: f.events[0]!, continuation: { controlId: "control", state: "failed", failureCode: "BOUNDARY_CHANGED" } } };
    child.controller.syncObservedInteraction?.({ turnId: "turn-0", status: "waiting_approval" }); child.store.syncProjection(child.controller.getProjection());
    await frame();
    expect(f.view.lastFrame()).not.toContain("Ctrl+A聚焦重试");
    f.view.stdin.write("\u0001"); f.view.stdin.write("\r"); await frame();
    expect(f.resumed).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
