/** r002独立观察：活动源会话关闭侧栏及无渲染间隔选择真实ask目标，使用内存Ink/fake Runtime。 */
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";

/** 只向Controller提供fixture事件，不使用真实状态或Provider。 */
async function* events(items: unknown[]) { for (const item of items) yield item as never; }

/** 有界等候可观察结果，不重发按键。 */
async function until(predicate: () => boolean, diagnostic?: () => string) {
  for (let count = 0; count < 30; count++) {
    if (predicate()) return;
    await new Promise<void>(function tick(resolve) { setTimeout(resolve, 40); });
  }
  expect(predicate(), diagnostic?.()).toBe(true);
}

it("活动源Esc只关闭面板，无渲染间隔Ctrl+T下Enter仅切入ask目标，再独立Enter批准原目标", async function burstSelection() {
  const source = { id: "source", title: "正在执行的源会话", productMode: "work", projectId: "p", status: "running", createdAt: 1, updatedAt: 1 };
  const target = { ...source, id: "target", title: "历史ask目标", status: "idle", defaultRunConfig: { permissionMode: "ask" } };
  const sessions = new Map([[source.id, source], [target.id, target]]);
  const calls: unknown[] = [];
  const runtime = {
    sessions: { list: async function list() { return [...sessions.values()]; }, get: async function get(id: string) { return sessions.get(id); } },
    approvals: { submit: async function submit(input) { calls.push({ type: "approve", ...input }); } },
    turns: {
      start: async function* start() { calls.push({ type: "start" }); },
      continue: function resume(input) { calls.push({ type: "continue", ...input }); return events([{ type: "turn_completed", turnId: input.turnId, checkpoint: { status: "completed", messages: [], completedCallIds: [] } }]); },
      cancel: async function cancel(input) { calls.push({ type: "cancel", ...input }); },
      getFrozenRunConfig: async function frozen() { return undefined; }, getRecoverableState: async function state() { return null; },
    },
  } as never;
  /** 为固定身份创建真实CLI Controller和Store。 */
  function controller(sessionId: string) { return createCliController({ runtime, sessionId, renderer: createPlainRenderer("text") }); }
  const primary = controller(source.id);
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: source as never, initialController: primary, createController: controller, readEvents: async function history() { return []; } });
  await manager.refresh();
  await primary.consume(events([{ type: "turn_started", turnId: "source-turn", stepCount: 0 }]));
  await manager.entries()[1].controller.consume(events([
    { type: "turn_started", turnId: "target-turn", stepCount: 0 },
    { type: "approval_required", turnId: "target-turn", stepId: "step", callId: "write", toolName: "edit_file", result: { status: "approval_required", approval: { approvalId: "target-approval", reason: "fixture编辑", allowedDecisions: ["allow_once", "deny"], display: { allowedDecisions: ["allow_once", "deny"], risk: "workspace_mutating", effect: "workspace", operation: "编辑fixture", actionPreview: "fixture-only" } } } },
    { type: "turn_paused", turnId: "target-turn", checkpoint: { turnId: "target-turn", status: "awaiting_approval", messages: [], completedCallIds: [] } },
  ]));
  const dispatch = vi.spyOn(manager.entries()[1].controller, "dispatch");
  const cancel = vi.fn();
  const terminal = Object.assign(new EventEmitter(), { columns: 120, rows: 24 });
  const view = render(createElement(CliSessionWorkspace, { manager, terminalSizeSource: terminal, useColor: false, screenReader: false, renderMode: "alternate-screen", closeWhenIdle: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: cancel, onEof: function eof() {}, onAppExit: function exit() {} }));
  try {
    await until(function ready() { return view.lastFrame().includes("会话 · Ctrl+T"); });
    view.stdin.write("\u001b");
    await until(function closed() { return !view.lastFrame().includes("会话 · Ctrl+T"); });
    expect(manager.entries()[0].store.getSnapshot().status).toBe("running");
    expect(cancel).not.toHaveBeenCalled();
    view.stdin.write("\u0014"); view.stdin.write("\u001b[B"); view.stdin.write("\r");
    await until(function selected() { return manager.selected().sessionId === target.id && view.lastFrame().includes("允许本次"); });
    expect(calls).toEqual([]);
    expect(manager.selected().store.getSnapshot().pendingApproval?.allowedDecisions).toEqual(["allow_once", "deny"]);
    // 菜单可见后进入独立输入事件循环，允许Ink提交该帧的输入订阅，不重发按键。
    await new Promise<void>(function nextInputEvent(resolve) { setImmediate(resolve); });
    view.stdin.write("\r");
    await until(function resumed() { return calls.some(function resumedTarget(call: any) { return call.type === "continue" && call.sessionId === target.id; }); }, function diagnostics() { return JSON.stringify({ calls, dispatch: dispatch.mock.calls, frame: view.lastFrame() }); });
    expect(calls.filter(function approved(call: any) { return call.type === "approve"; })).toEqual([expect.objectContaining({ sessionId: target.id, approvalId: "target-approval", decision: "allow_once" })]);
    expect(calls.some(function wrongAction(call: any) { return call.type === "start" || call.type === "cancel" || call.sessionId === source.id; })).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  } finally { view.unmount(); await manager.stop(); }
}, 10000);
