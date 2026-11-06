/** r002 CLI隔离回归：内存Ink输入/视口和fake Runtime，不启动产品CLI或Provider。 */
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { createCliController } from "../../../src/controller.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionTitle, getCliSessionDisplayTitle } from "../../../src/session-title.js";
import type { AgentRuntime, Session } from "@autopilot-agent/core";

/** 有界等待一次Ink/React输入刷新，不访问真实TTY。 */
async function frame() { await new Promise<void>(function tick(resolve) { setTimeout(resolve, 40); }); }
/** 等待可观察UI或调用事实就绪，不用重发按键掩盖失败，最多1秒。 */
async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 25; attempt++) { await frame(); if (predicate()) return; }
  expect(predicate()).toBe(true);
}
/** 固定事件源只产生已知安全事件。 */
async function* events(items: unknown[]) { for (const item of items) yield item as never; }
/** 为Controller构造完成或审批等待的真实CLI事件投影。 */
function lifecycle(turnId: string, approval = false) {
  return [
    { type: "turn_started", turnId, stepCount: 0 },
    ...(approval ? [{ type: "approval_required", turnId, stepId: "step", callId: "edit", toolName: "edit_file", result: { status: "approval_required", approval: { approvalId: "approval-b", reason: "需要编辑文件", allowedDecisions: ["allow_once", "deny"], risk: "workspace_mutating", display: { allowedDecisions: ["allow_once", "deny"], risk: "workspace_mutating", effect: "workspace", operation: "编辑文件", actionPreview: "修改fixture" } } } }] : [{ type: "answer_delta", turnId, stepId: "step", delta: "风扇宣传页制作完成，验证结果已保留" }]),
    { type: approval ? "turn_paused" : "turn_completed", turnId, checkpoint: { turnId, status: approval ? "awaiting_approval" : "completed", stepCount: 1, messages: [], completedCallIds: [] } },
  ];
}

/** 建立固定Session目录；切换只读取内存，不启动任务。 */
async function directory(count = 2) {
  const a = { id: "773573f5-3c1b-4b0e-bf60-545fef06c7ff", productMode: "work", projectId: "p", status: "idle", createdAt: 1, updatedAt: 1 } as Session;
  const b = { ...a, id: "f4fb3297-c74b-4cb0-a7d8-2c31afc8e746", title: "待审批宣传页" } as Session;
  const sessions = new Map([[a.id, a], ...(count > 1 ? [[b.id, b] as [string, Session]] : [])]);
  const calls: string[] = [];
  const runtime = { sessions: { list: async function list() { return [...sessions.values()]; }, get: async function get(id: string) { return sessions.get(id); } }, approvals: { submit: async function approve(input) { calls.push("approve:" + input.sessionId); } }, turns: { start: async function* start() { calls.push("start"); }, continue: function resume(input) { calls.push("continue:" + input.sessionId); return events(lifecycle(input.turnId)); }, cancel: async function cancel() { calls.push("cancel"); }, getFrozenRunConfig: async function frozen() { return undefined; }, getRecoverableState: async function recover() { return null; } } } as unknown as AgentRuntime;
  /** 每个Session绑定自己的Controller和事件Store。 */
  function controller(sessionId: string) { return createCliController({ runtime, sessionId, renderer: createPlainRenderer("text") }); }
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: a, initialController: controller(a.id), createController: controller, readEvents: async function read() { return []; } });
  await manager.refresh();
  return { manager, sessions, a, b, calls };
}

/** 挂载内存屏幕并可模拟宽高，保留用户机器所有真实终端。 */
function mount(manager: ReturnType<typeof createCliSessionManager>, onCancel: () => void) {
  const terminal = Object.assign(new EventEmitter(), { columns: 120, rows: 24 });
  const view = render(createElement(CliSessionWorkspace, { manager, terminalSizeSource: terminal, closeWhenIdle: false, useColor: false, screenReader: false, renderMode: "alternate-screen", onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: onCancel, onEof: function eof() {}, onAppExit: function exit() {} }));
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 120 }); Object.defineProperty(view.stdout, "rows", { configurable: true, value: 24 }); view.stdout.emit("resize");
  return { ...view, terminal };
}

it("宽屏可见未聚焦侧栏先消费Esc，Ctrl+T方向键紧接Enter切入目标并审批", async function sidebarInput() {
  const f = await directory(); const cancel = vi.fn();
  await f.manager.entries()[1].controller.consume(events(lifecycle("child-turn", true)));
  expect(f.manager.entries()[1].store.getSnapshot().status).toBe("waiting_approval");
  expect(f.manager.entries()[1].store.getSnapshot().pendingApproval?.allowedDecisions).toEqual(["allow_once", "deny"]);
  const action = vi.spyOn(f.manager.entries()[1].controller, "dispatch");
  const view = mount(f.manager, cancel);
  try {
    await frame(); expect(view.lastFrame()).toMatch(/会话 · (?:Ctrl|↑)/u); expect(view.lastFrame()).not.toContain(f.a.id);
    view.stdin.write("\u001b"); await frame(); expect(cancel).not.toHaveBeenCalled(); expect(view.lastFrame()).not.toMatch(/会话 · (?:Ctrl|↑)/u);
    view.stdin.write("\u0014"); await frame(); view.stdin.write("\u001b[B"); view.stdin.write("\r"); await frame();
    await waitUntil(function targetReady() { return f.manager.selected().sessionId === f.b.id && view.lastFrame().includes("允许本次"); });
    expect(f.manager.selected().sessionId).toBe(f.b.id); expect(f.calls).toEqual([]);
    expect(f.manager.selected().store.getSnapshot().status).toBe("waiting_approval");
    view.stdin.write("\r"); await waitUntil(function submitted() { return f.calls.includes("continue:" + f.b.id); });
    expect(action, view.lastFrame()).toHaveBeenCalledWith({ type: "approve", decision: "allow_once" });
    expect(f.calls).toContain("approve:" + f.b.id); expect(f.calls).toContain("continue:" + f.b.id); expect(cancel).not.toHaveBeenCalled();
  } finally { view.unmount(); await f.manager.stop(); }
});

it("长正文与多次增长不推走侧栏顶部，窄屏overlay有界，空侧栏收回宽度", async function boundedLayout() {
  const f = await directory(); const cancel = vi.fn(); const view = mount(f.manager, cancel);
  try {
    await frame();
    for (let index = 0; index < 3; index++) { f.manager.selected().store.recordPrompt(("很长的正文\n").repeat(100)); await frame(); }
    expect(view.lastFrame()).toMatch(/会话 · (?:Ctrl|↑)/u); expect(view.lastFrame().split("\n").length).toBeLessThanOrEqual(24);
    Object.defineProperty(view.stdout, "columns", { configurable: true, value: 80 }); view.stdout.emit("resize"); view.terminal.columns = 80; view.terminal.emit("resize"); await frame();
    expect(view.lastFrame()).not.toMatch(/会话 · (?:Ctrl|↑)/u); view.stdin.write("\u0014"); await frame(); expect(view.lastFrame()).toMatch(/会话 · (?:Ctrl|↑)/u); expect(view.lastFrame().split("\n").length).toBeLessThanOrEqual(24);
    view.stdin.write("\u001b"); await frame(); expect(cancel).not.toHaveBeenCalled();
  } finally { view.unmount(); await f.manager.stop(); }
  const single = await directory(1); const one = mount(single.manager, cancel);
  try {
    await frame(); expect(one.lastFrame()).not.toMatch(/会话 · (?:Ctrl|↑)/u);
    single.sessions.set(single.a.id, { ...single.a, presentation: { messages: [{ id: "m", role: "user", content: "附件", createdAt: 1, attachments: [{ id: "img", name: "diagram.png", mimeType: "image/png", relativePath: "fixture.png" }] }] } } as Session);
    await single.manager.refresh(); await frame(); expect(one.lastFrame()).toContain("附件"); expect(one.lastFrame()).toContain("diagram.png");
    single.sessions.set(single.a.id, single.a); await single.manager.refresh(); await frame(); expect(one.lastFrame()).not.toMatch(/会话 · (?:Ctrl|↑)/u);
  } finally { one.unmount(); await single.manager.stop(); }
});

it("取消只提交一次精确活动Turn，终态不再显示取消notice", async function cancellation() {
  const cancel = vi.fn(async function cancel() {});
  const runtime = { turns: { cancel, getRecoverableState: async function state() { return null; } } } as never;
  const controller = createCliController({ runtime, sessionId: "session", renderer: createPlainRenderer("text") });
  await controller.consume(events([{ type: "turn_started", turnId: "turn", stepCount: 0 }]));
  await Promise.all([controller.dispatch({ type: "cancel_turn" }), controller.dispatch({ type: "cancel_turn" })]);
  expect(cancel).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledWith({ sessionId: "session", turnId: "turn" });
  await controller.consume(events([{ type: "turn_completed", turnId: "turn", checkpoint: { status: "completed", messages: [], completedCallIds: [] } }]));
  expect((await controller.dispatch({ type: "cancel_turn" })).lines).toEqual([]); expect(cancel).toHaveBeenCalledTimes(1);
});

it("首交互保存短标题并沿Web回答范式更新，手工标题及历史兜底保留", async function titles() {
  const sessions = new Map<string, any>([["auto", { id: "auto" }], ["manual", { id: "manual", title: "我的手工标题" }]]);
  const rename = vi.fn(async function rename(id: string, title: string) { const session = { ...sessions.get(id), title }; sessions.set(id, session); return session; });
  const runtime = { sessions: { get: async function get(id: string) { return sessions.get(id); }, rename }, turns: { start: function start(input) { if (input.sessionId === "auto") expect(sessions.get("auto").title).toBe(createCliSessionTitle(input.content)); return events(lifecycle("title-turn")); } } } as never;
  const automatic = createCliController({ runtime, sessionId: "auto", renderer: createPlainRenderer("text") });
  await automatic.dispatch({ type: "submit_prompt", content: "请制作一个清爽的手持风扇宣传页面，带有产品特征" });
  expect(sessions.get("auto").title).toBe(createCliSessionTitle("风扇宣传页制作完成，验证结果已保留"));
  const manual = createCliController({ runtime, sessionId: "manual", renderer: createPlainRenderer("text") }); await manual.dispatch({ type: "submit_prompt", content: "处理任务" });
  expect(sessions.get("manual").title).toBe("我的手工标题"); expect(rename).toHaveBeenCalledTimes(2);
  expect(getCliSessionDisplayTitle(undefined)).toBe("新对话"); expect(getCliSessionDisplayTitle("773573f5-3c1b-4b0e-bf60-545fef06c7ff")).toBe("新对话");
});
