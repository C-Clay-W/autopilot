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



it.each(["running", "unconfirmed", "lost"])("r007 %s无请求CtrlA不打开普通任务或误报审批，CtrlT仍可管理", async function noRequest(kind) {
 const f = await fixture(1, true);
 try {
  const child = f.manager.related()[0]!;
  child.controller.syncObservedInteraction?.({ turnId: "turn-0", status: "running" }); child.store.syncProjection(child.controller.getProjection());
  child.executionView = { sessionId: child.sessionId, turnId: "turn-0", status: "running", execution: kind === "running" ? "active" : kind as any, lastSeq: 1 };
  await frame(); f.view.stdin.write("DRAFT"); await frame(); f.view.stdin.write("\u0001"); await frame();
  expect(f.view.lastFrame()).toContain("暂无待处理审批/问答");
  expect(f.view.lastFrame()).not.toContain("关联审批状态待确认");
  expect(f.view.lastFrame()).not.toContain("子任务0");
  expect(f.manager.selected().viewState.draftRef.current?.inputRef.current).toBe("DRAFT");
  expect(f.submit).not.toHaveBeenCalled(); expect(f.resumed).not.toHaveBeenCalled();
  f.view.stdin.write("\u0014"); await frame(); expect(f.view.lastFrame()).toContain("子任务0");
 } finally { await f.close(); }
});
it("r007 CtrlA问答列表只含真实问题，Enter精确定位，不混入普通running", async function questionOnly() {
 const f = await fixture(2, true);
 try {
  const [question, running] = f.manager.related();
  for (const child of [question, running]) { child.controller.syncObservedInteraction?.({ turnId: child.sessionId === question.sessionId ? "turn-0" : "turn-1", status: "running" }); child.store.syncProjection(child.controller.getProjection()); }
  question.controller.observe?.([{ sessionId: question.sessionId, turnId: "turn-0", seq: 2, timestamp: new Date().toISOString(), event: { type: "question_required", turnId: "turn-0", callId: "q", requestId: "question", questions: [] } } as any]); question.store.syncProjection(question.controller.getProjection());
  await frame(); f.view.stdin.write("\u0001"); await frame();
  expect(f.view.lastFrame()).toContain("子任务0"); expect(f.view.lastFrame()).not.toContain("子任务1");
  f.view.stdin.write("\r"); await until(function selected() { return f.manager.selected().sessionId === question.sessionId; });
  expect(f.submit).not.toHaveBeenCalled(); expect(f.resumed).not.toHaveBeenCalled();
 } finally { await f.close(); }
});
