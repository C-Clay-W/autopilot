/** S3最关键契约：只读切换/迟到归属、保活草稿与后台输入门、按owner退出。 */
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import type { AgentRuntime, AgentEventEnvelope, Session } from "@autopilot-agent/core";
import { createCliController } from "../../src/controller.js";
import { createCliSessionManager } from "../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../src/tui/session-workspace.js";

/** 使用受控Runtime和真实CLI投影，测试不能启动模型或恢复入口。 */
function fixture() {
  const a = { id: "a", title: "A", productMode: "work", projectId: "p", persistenceMode: "durable", status: "idle", createdAt: 1, updatedAt: 1 } as Session;
  const b = { ...a, id: "b", title: "B" } as Session;
  const sessions = new Map([[a.id, a], [b.id, b]]);
  const calls: string[] = [];
  const events = new Map<string, AgentEventEnvelope[]>();
  const runtime = {
    sessions: { list: async function list() { return [...sessions.values()]; }, get: async function get(id: string) { return sessions.get(id); } },
    turns: {
      start: async function* start() { calls.push("start"); },
      continue: async function* resume() { calls.push("continue"); },
      cancel: async function cancel(input: { sessionId: string }) { calls.push("cancel:" + input.sessionId); sessions.set(input.sessionId, { ...sessions.get(input.sessionId)!, status: "interrupted", activeTurnId: undefined }); },
      getRecoverableState: async function recover() { calls.push("recover"); return null; },
      getFrozenRunConfig: async function frozen() { return undefined; },
    },
  } as unknown as AgentRuntime;
  /** 每个ID创建固定Controller，只有自己的安全事件可进入。 */
  function controller(sessionId: string) { return createCliController({ runtime, sessionId, renderer: { format: "text", render: function empty() { return ""; } } }); }
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: a, initialController: controller("a"), createController: controller, readEvents: async function read(id) { return events.get(id) ?? []; } });
  return { manager, calls, events, sessions };
}

/** 让Ink处理一次按键和React帧；有界等待，无真实TTY。 */
async function frame() { await new Promise<void>(function tick(resolve) { setTimeout(resolve, 30); }); }

it("查看切换不执行，真实事件去重且迟到响应只更新原Session", async function readOnlySwitch() {
  const f = fixture();
  await f.manager.refresh();
  const a = f.manager.selected();
  const b = f.manager.entries()[1]!;
  f.manager.select("b");
  f.manager.select("a");
  f.events.set("b", [{ sessionId: "b", turnId: "b-turn", seq: 1, timestamp: new Date().toISOString(), event: { type: "answer_delta", turnId: "b-turn", delta: "B-only" } }]);
  await f.manager.refresh();
  await f.manager.refresh();
  expect(b.store.getSnapshot().liveEvents.filter(function answer(event) { return event.type === "answer_delta"; })).toHaveLength(1);
  expect(a.store.getSnapshot().liveEvents).toEqual([]);
  f.manager.handleResult(b, { kind: "error", exitCode: 1, lines: ["B late response"], projection: b.controller.getProjection() });
  expect(f.manager.selected()).toBe(a);
  expect(b.unread).toBe(true);
  expect(JSON.stringify(a.store.getSnapshot())).not.toContain("B late response");
  expect(f.calls).toEqual([]);
  await f.manager.stop();
});

it("会话子树保活独立草稿，后台输入disabled且Ctrl+T列表不执行模型", async function keepsDrafts() {
  const f = fixture();
  await f.manager.refresh();
  const view = render(createElement(CliSessionWorkspace, { manager: f.manager, initial: undefined, closeWhenIdle: false, useColor: false, screenReader: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  try {
    await frame();
    view.stdin.write("alpha"); await frame();
    view.stdin.write("\u0014"); await frame();
    view.stdin.write("\u001b[B"); view.stdin.write("\r"); await frame();
    expect(f.manager.selected().sessionId).toBe("b");
    view.stdin.write("bravo"); await frame();
    view.stdin.write("\u0014"); await frame();
    view.stdin.write("\u001b[A"); view.stdin.write("\r"); await frame();
    expect(f.manager.selected().sessionId).toBe("a");
    expect(view.lastFrame()).toContain("alpha");
    expect(view.lastFrame()).not.toContain("bravo");
    expect(f.calls).toEqual([]);
  } finally { view.unmount(); await f.manager.stop(); }
});

it("退出只取消本controller持有的running，等待审批保留且不沿来源取消", async function exitOwnership() {
  const f = fixture();
  await f.manager.refresh();
  const a = f.manager.entries()[0]!;
  const b = f.manager.entries()[1]!;
  const originalA = a.controller.getProjection();
  a.controller.getProjection = function running() { return { ...originalA, status: "running", turnId: "a-turn" }; };
  a.controller.isExecuting = function owned() { return true; };
  a.controller.dispatch = async function cancel(action) { f.calls.push(action.type + ":a"); return { kind: "ok", exitCode: 0, lines: [], projection: originalA }; };
  b.controller.getProjection = function waiting() { return { ...originalA, status: "waiting_approval", turnId: "b-turn" }; };
  const report = await f.manager.stop();
  expect(f.calls).toEqual(["cancel_turn:a"]);
  expect(report.waiting).toEqual(["b"]);
  expect(report.stopped).toEqual(["a"]);
});
