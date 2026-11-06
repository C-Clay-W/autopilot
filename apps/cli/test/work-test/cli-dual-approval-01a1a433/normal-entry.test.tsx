/** 双入口审批正常Workspace入口回归，真实Controller/Store/Ink，受控Runtime流。 */
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { AgentRuntimeError, type AgentEventEnvelope, type AgentRuntime, type Session } from "@autopilot-agent/core";
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

it("自动显示真实子卡且正文草稿光标保留，不抢输入焦点", async function automaticCard() {
  const f = await fixture();
  try {
    await frame(); f.view.stdin.write("草稿AB"); await frame(); f.view.stdin.write("\u001b[D"); await frame();
    expect(f.view.lastFrame()).toContain("批准本任务文件修改");
    expect(f.view.lastFrame()).toContain("父正文保留");
    f.view.stdin.write("中"); await frame();
    expect(f.manager.selected().viewState.draftRef.current?.inputRef.current).toBe("草稿A中B");
    expect(f.submit).not.toHaveBeenCalled(); expect(f.manager.selected().sessionId).toBe("parent");
  } finally { await f.close(); }
});

it("聚焦卡仍保留正文，批准子长流后父输入和下一子请求可继续处理", async function independentInput() {
  const f = await fixture(2);
  try {
    await frame(); f.view.stdin.write("父草稿"); await frame(); f.view.stdin.write("\u0001"); await frame();
    expect(f.view.lastFrame()).toContain("父正文保留");
    f.view.stdin.write("\r"); await until(function submitted() { return f.resumed.mock.calls.length === 1; });
    f.view.stdin.write("追加"); await frame();
    expect(f.manager.selected().viewState.draftRef.current?.inputRef.current).toBe("父草稿追加");
    f.view.stdin.write("\u0001"); await frame(); f.view.stdin.write("\r"); await until(function second() { return f.resumed.mock.calls.length === 2; });
    expect(f.submit.mock.calls).toEqual([[{ sessionId: "child-0", turnId: "turn-0", approvalId: "approval-0", decision: "allow_once" }], [{ sessionId: "child-1", turnId: "turn-1", approvalId: "approval-1", decision: "allow_once" }]]);
    expect(f.manager.selected().sessionId).toBe("parent");
  } finally { await f.close(); }
});

it("快照不足的关联审批不得切换目标", async function unconfirmed() {
  const f = await fixture(1, true);
  try { await frame(); f.view.stdin.write("\u0001"); await frame(); f.view.stdin.write("\r"); await frame(); expect(f.manager.selected().sessionId).toBe("parent"); expect(f.submit).not.toHaveBeenCalled(); }
  finally { await f.close(); }
});

it("子自身入口批准后父旧卡同步撤下，打开子目标复用原Controller", async function childEntry() {
  const f = await fixture();
  try {
    const child = f.manager.related()[0]!; const original = child.controller;
    await f.manager.select(child.sessionId); await frame();
    expect(child.controller).toBe(original);
    f.view.stdin.write("\r"); await until(function started() { return f.resumed.mock.calls.length === 1; });
    await f.manager.select("parent"); await frame();
    expect(f.view.lastFrame()).not.toContain("批准本任务文件修改");
    expect(f.submit).toHaveBeenCalledTimes(1);
    f.view.stdin.write("主输入"); await frame(); expect(f.manager.selected().viewState.draftRef.current?.inputRef.current).toBe("主输入");
  } finally { await f.close(); }
});

it("旧身份与重复批准不影响其他目标或同Turn新请求", async function staleAndRepeated() {
  const f = await fixture(2);
  try {
    const child = f.manager.related()[0]!;
    const expected = { sessionId: child.sessionId, turnId: "turn-0", approvalId: "old-request" };
    expect(await child.controller.dispatch({ type: "approve", expected, decision: "allow_once" })).toMatchObject({ kind: "error" });
    expect(f.submit).not.toHaveBeenCalled();
    const first = child.controller.dispatch({ type: "approve", expected: { ...expected, approvalId: "approval-0" }, decision: "allow_once" });
    await until(function executing() { return f.resumed.mock.calls.length === 1; });
    expect(await child.controller.dispatch({ type: "approve", expected: { ...expected, approvalId: "approval-0" }, decision: "deny" })).toMatchObject({ kind: "error" });
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.manager.related()[1]!.store.getSnapshot().pendingApproval?.approvalId).toBe("approval-1");
    for (const release of f.releases) release(); await first;
    const event = f.events[0]!;
    if (event.event.type !== "approval_required") throw new Error("missing request");
    child.controller.observe!([{ ...event, seq: 20, event: { ...event.event, result: { ...event.event.result, approval: { ...event.event.result.approval, approvalId: "next-request" } } } }]);
    expect(await child.controller.dispatch({ type: "approve", expected: { ...expected, approvalId: "approval-0" }, decision: "deny" })).toMatchObject({ kind: "error" });
    expect(child.controller.getProjection().pendingApproval?.approvalId).toBe("next-request");
    expect(f.submit).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it("决定保存前失败可重试同一真实请求", async function retrySubmission() {
  const f = await fixture();
  try {
    const child = f.manager.related()[0]!;
    const expected = { sessionId: child.sessionId, turnId: "turn-0", approvalId: "approval-0" };
    f.submit.mockRejectedValueOnce(new Error("controlled submit failure"));
    f.runtime.turns.getRecoverableState = async function recover() { return { sessionId: child.sessionId, turnId: expected.turnId, status: "awaiting_approval", recoverable: true, interactionState: "pending", activeSkills: [], approval: { approvalId: expected.approvalId, toolName: "todo_write" } }; };
    await frame(); f.view.stdin.write("\u0001"); await frame(); f.view.stdin.write("\r");
    await until(function attempted() { return f.submit.mock.calls.length === 1; }); await frame(); await f.manager.refresh();
    expect(child.store.getSnapshot().pendingApproval?.approvalId).toBe(expected.approvalId);
    f.view.stdin.write("\u0001"); await frame(); f.view.stdin.write("\r");
    await until(function continued() { return f.resumed.mock.calls.length === 1; });
    expect(f.submit).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});

it.each(["known", "unknown"] as const)("审批继续%s失败保留安全码，校准查询失败不掩盖原阶段", async function safeContinuationFailure(kind) {
  const f = await fixture();
  try {
    const failure = kind === "known" ? new AgentRuntimeError("TURN_ALREADY_RUNNING", "private-path-and-token") : Object.assign(new Error("private-path-and-token"), { code: "PRIVATE_TOKEN_VALUE" });
    f.runtime.turns.continue = async function* failContinuation() { throw failure; };
    f.runtime.turns.getRecoverableState = async function failCalibration() { throw new Error("private-calibration-data"); };
    const child = f.manager.related()[0]!;
    const result = await child.controller.dispatch({ type: "approve", expected: { sessionId: child.sessionId, turnId: "turn-0", approvalId: "approval-0" }, decision: "allow_once" });
    expect(result.kind).toBe("error");
    expect(result.message).toContain(`CLI_APPROVAL_CONTINUE_FAILED/${kind === "known" ? "TURN_ALREADY_RUNNING" : "CLI_RUNTIME_ERROR"}`);
    expect(result.message).not.toContain("private"); expect(result.message).not.toContain("PRIVATE_TOKEN_VALUE");
    expect(f.submit).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});
