/** r003 CLI隔离回归：内存Ink输入/视口和fake Runtime，不启动产品CLI或Provider。 */
import { PassThrough } from "node:stream";
import { render as renderInk } from "ink";
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { createCliController } from "../../../src/controller.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createTuiRenderStdout } from "../../../src/tui/lifecycle.js";
import { readTuiTerminalSize } from "../../../src/tui/format.js";
import stringWidth from "string-width";
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
  const b = { ...a, id: "f4fb3297-c74b-4cb0-a7d8-2c31afc8e746", title: "待审批宣传页", creationSource: { actor: { kind: "thread", threadId: a.id, turnId: "source-turn" }, requestId: "create-b" } } as Session;
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
function mount(manager: ReturnType<typeof createCliSessionManager>, onCancel: () => void, onTerminalSizeChange = vi.fn()) {
  const terminal = Object.assign(new EventEmitter(), { columns: 120, rows: 24 });
  const view = render(createElement(CliSessionWorkspace, { manager, onTerminalSizeChange, terminalSizeSource: terminal, closeWhenIdle: false, useColor: false, screenReader: false, renderMode: "alternate-screen", onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: onCancel, onEof: function eof() {}, onAppExit: function exit() {} }));
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 120 }); Object.defineProperty(view.stdout, "rows", { configurable: true, value: 24 }); view.stdout.emit("resize");
  return { ...view, terminal };
}


it("物理尺寸根唯一提交且宽窄回切保留草稿及底栏", async function rootResize() {
  expect(readTuiTerminalSize({ columns: 200, rows: 40 })).toEqual({ columns: 200, rows: 40 });
  const f = await directory(); const commit = vi.fn(); const view = mount(f.manager, vi.fn(), commit);
  try {
    await frame(); view.stdin.write("主会话草稿"); await frame(); f.manager.selected().store.recordPrompt(("长正文中文换行\n").repeat(100)); await frame();
    for (const [columns, rows] of [[180, 32], [72, 20], [140, 28], [100, 24]]) {
      commit.mockClear(); Object.defineProperty(view.stdout, "columns", { configurable: true, value: columns }); Object.defineProperty(view.stdout, "rows", { configurable: true, value: rows });
      view.terminal.columns = columns; view.terminal.rows = rows; view.terminal.emit("resize"); view.stdout.emit("resize"); await frame(); await frame();
      expect(commit.mock.calls).toEqual([[{ columns, rows }]]); const output = view.lastFrame(); expect(output).toContain("主会话草稿"); expect(output).toContain("Ctrl+A关联审批"); expect(output).toContain("tokens:"); expect(output).toContain("workspace:");
      expect(output.split("\n").length).toBeLessThanOrEqual(rows); expect(Math.max(...output.split("\n").map(function width(line) { return stringWidth(line); }))).toBeLessThanOrEqual(columns);
    }
    expect(view.terminal.listenerCount("resize")).toBe(1);
  } finally { view.unmount(); await f.manager.stop(); }
});
it("原地审批精确子目标且Enter和Esc不穿透草稿，独立会话不混入", async function centralApproval() {
  const f = await directory(); const unrelated = { ...f.a, id: "unrelated", title: "无关独立会话" }; f.sessions.set(unrelated.id, unrelated); await f.manager.refresh();
  const child = f.manager.related()[0]; await child.controller.consume(events(lifecycle("child-turn", true))); const cancel = vi.fn(); const view = mount(f.manager, cancel);
  try {
    await frame(); expect(view.lastFrame()).toContain("待审批宣传页"); expect(view.lastFrame()).not.toContain("无关独立会话");
    view.stdin.write("保留的主草稿"); await frame(); view.stdin.write("\u0001"); await frame(); view.stdin.write("\r"); await frame(); expect(view.lastFrame()).toContain("原地审批"); expect(f.manager.selected().sessionId).toBe(f.a.id);
    view.stdin.write("\u001b"); await frame(); expect(cancel).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); view.stdin.write("\r"); await frame(); expect(view.lastFrame()).toContain("原地审批");
    view.stdin.write("\r"); await waitUntil(function done() { return f.calls.includes("continue:" + f.b.id); }); expect(f.calls).toEqual(["approve:" + f.b.id, "continue:" + f.b.id]); expect(f.manager.selected().sessionId).toBe(f.a.id);
    view.stdin.write("\u001b"); await frame(); expect(view.lastFrame()).toContain("保留的主草稿"); expect(cancel).not.toHaveBeenCalled();
  } finally { view.unmount(); await f.manager.stop(); }
});
it("窄屏关联列表可拒绝和展开安全详情，失效重复身份不能误批", async function narrowApproval() {
  const f = await directory(); const child = f.manager.related()[0]; await child.controller.consume(events(lifecycle("child-turn", true))); const view = mount(f.manager, vi.fn());
  try {
    view.terminal.columns = 70; view.terminal.rows = 22; Object.defineProperty(view.stdout, "columns", { configurable: true, value: 70 }); view.terminal.emit("resize"); view.stdout.emit("resize"); await frame();
    view.stdin.write("\u0001"); await frame(); view.stdin.write("\r"); await frame(); view.stdin.write("d"); await frame(); expect(view.lastFrame()).toContain("修改fixture");
    view.stdin.write("\u001b[B"); await frame(); expect(view.lastFrame()).toContain("Enter确认：拒绝"); view.stdin.write("\r"); view.stdin.write("\r"); await waitUntil(function done() { return f.calls.includes("continue:" + f.b.id); });
    expect(f.calls.filter(function submit(call) { return call.startsWith("approve:"); })).toHaveLength(1); expect(f.manager.selected().sessionId).toBe(f.a.id);
    expect((await child.controller.dispatch({ type: "approve", decision: "allow_once", expected: { sessionId: f.b.id, turnId: "child-turn", approvalId: "approval-b" } })).kind).toBe("error");
  } finally { view.unmount(); await f.manager.stop(); }
});

it("待审批到来不抢主输入，旧请求在新审批代次不能提交", async function lateApproval() {
  const f = await directory(); const child = f.manager.related()[0]; const view = mount(f.manager, vi.fn());
  try {
    await frame(); view.stdin.write("先写"); await frame(); await child.controller.consume(events(lifecycle("old-turn", true))); await frame(); view.stdin.write("继续写"); await frame();
    expect(view.lastFrame()).toContain("先写继续写"); expect(view.lastFrame()).not.toContain("原地审批"); expect(f.calls).toEqual([]);
    view.stdin.write("\u0001"); await frame(); view.stdin.write("\r"); await frame();
    const next = lifecycle("new-turn", true); (next[1] as any).result.approval.approvalId = "new-approval"; await child.controller.consume(events(next)); await frame();
    expect(view.lastFrame()).not.toContain("原地审批");
    expect((await child.controller.dispatch({ type: "approve", decision: "allow_once", expected: { sessionId: f.b.id, turnId: "old-turn", approvalId: "approval-b" } })).kind).toBe("error"); expect(f.calls).toEqual([]);
  } finally { view.unmount(); await f.manager.stop(); }
});
it("真实Ink输出生命周期由根resize主动重绘且卸载清理监听", async function outputLifecycle() {
  const f = await directory(); const chunks: string[] = [];
  const terminal = Object.assign(new EventEmitter(), { columns: 180, rows: 30, isTTY: true, write: function write(chunk: string) { chunks.push(chunk); return true; } });
  const output = createTuiRenderStdout(terminal, { columns: 180, rows: 30 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: function raw() {}, ref: function ref() {}, unref: function unref() {} });
  const instance = renderInk(createElement(CliSessionWorkspace, { manager: f.manager, terminalSizeSource: terminal, onTerminalSizeChange: output.setSize, closeWhenIdle: false, useColor: false, screenReader: false, renderMode: "alternate-screen", reducedMotion: true, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }), { stdout: output.stdout as never, stderr: new PassThrough() as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false, incrementalRendering: false });
  try {
    await frame();
    for (const columns of [70, 160, 90]) { const count = chunks.length; terminal.columns = columns; terminal.emit("resize"); await frame(); await frame(); expect(output.stdout.columns).toBe(columns); expect(chunks.length).toBeGreaterThan(count); expect(chunks.slice(count).join("")).toContain("Ctrl+A"); }
  } finally { instance.unmount(); stdin.end(); await f.manager.stop(); }
  expect(terminal.listenerCount("resize")).toBe(0);
});
