/** 真实Node持久端口与Core源码的审批决定、重开和迟到恢复竞争回归，采样受控。 */
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";
import { createNodeRuntimePorts } from "@autopilot-agent/adapters";
import { createAgentRuntime } from "../../../../../packages/core/src/runtime/public/create-agent-runtime";
import type { AgentEvent } from "../../../../../packages/core/src/runtime/protocol";

/** 走完整公开异步事件入口。 */
async function collect(stream: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of stream) events.push(event); return events; }
/** 让Ink和真实文件端口各完成一次异步轮次。 */
async function frame() { await new Promise(function tick(resolve) { setTimeout(resolve, 40); }); }
/** 有界等待正常入口结果，不重复输入。 */
async function until(check: () => boolean) { for (let i = 0; i < 80 && !check(); i++) await frame(); expect(check()).toBe(true); }
/** 每例创建独占持久根并保留测试证据，不访问真实用户配置。 */
async function fixture(twoApprovals = false) {
  const evidence = fileURLToPath(new URL("../../../../../.agent-tests/work-test/cli-dual-approval-01a1a433/runs/r001/states/", import.meta.url));
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(path.join(evidence, "durable-"));
  const workspaceRoot = path.join(root, "workspace"); await mkdir(workspaceRoot);
  const options = { stateRoot: path.join(root, "state"), workspaceRoot, env: {}, userSettingsPath: path.join(root, "user-settings.json"), trustRoot: path.join(root, "trust") };
  let samples = 0;
  /** 首次提出真实任务文件集合声明，后续只结束原Turn。 */
  const sampler = { sample: async function sample() {
    samples++;
    if (samples === 1) return { content: "", toolCalls: [{ id: "todo-once", name: "todo_write", input: { todos: [], fileTargets: [{ path: "controlled.txt", operation: "create" }] } }], reasoningSummary: "fixture" };
    if (samples === 2 && twoApprovals) return { content: "", toolCalls: [{ id: "todo-next", name: "todo_write", input: { todos: [], externalFileTargets: [{ path: path.join(root, "outside.txt"), operation: "create" }] } }], reasoningSummary: "fixture" };
    return { content: "完成", toolCalls: [], reasoningSummary: "fixture" };
  } };
  const config = { modelSampler: sampler, permissionMode: "ask" as const, workspaceRoot, workspaceTrusted: true, maxSteps: 5, sandboxMode: "workspace-write" as const };
  const ports = createNodeRuntimePorts(options);
  await ports.projectStore.save({ id: "fixture-project", name: "fixture", workspaceRoot, createdAt: Date.now(), updatedAt: Date.now() });
  await ports.sessionStore.save({ id: "child", projectId: "fixture-project", productMode: "work", persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
  const runtime = createAgentRuntime({ ports, defaultRunConfig: config });
  const events = await collect(runtime.turns.start({ sessionId: "child", content: "写受控文件" }));
  const request = events.find(function approval(event) { return event.type === "approval_required"; });
  expect(request?.type).toBe("approval_required");
  if (request?.type !== "approval_required") throw new Error("missing approval");
  const identity = { sessionId: "child", turnId: request.turnId, approvalId: request.result.approval.approvalId };
  /** 模拟重开宿主，所有持久端口重新创建。 */
  function reopen() { const nextPorts = createNodeRuntimePorts(options); return { ports: nextPorts, runtime: createAgentRuntime({ ports: nextPorts, defaultRunConfig: config }) }; }
  return { runtime, ports, identity, workspaceRoot, reopen };
}

it("Node唯一决定竞争且重开后复用已存决定自动继续同Turn", async function savedDecision() {
  const f = await fixture(); const second = f.reopen();
  const results = await Promise.allSettled([f.runtime.approvals.submit({ ...f.identity, decision: "allow_once" }), second.runtime.approvals.submit({ ...f.identity, decision: "deny" })]);
  expect(results.filter(function fulfilled(result) { return result.status === "fulfilled"; })).toHaveLength(1);
  const reopened = f.reopen(); const decision = await reopened.runtime.approvals.getDecision(f.identity);
  expect(decision).toBeTruthy();
  const events = await collect(reopened.runtime.turns.continue({ sessionId: f.identity.sessionId, turnId: f.identity.turnId, approval: { approvalId: f.identity.approvalId, decision: decision!.decision === "deny" ? "deny" : "allow" } }));
  expect(events.some(function completed(event) { return event.type === "turn_completed" || event.type === "turn_failed"; })).toBe(true);
  expect((await reopened.ports.turnStore.getLatest("child"))?.id).toBe(f.identity.turnId);
  expect(await reopened.runtime.approvals.getDecision(f.identity)).toEqual(decision);
});

it.each(["终态", "下一暂停"] as const)("迟到continue在另一宿主到达%s后取得租约不能重放旧checkpoint", async function lateContinuation(boundary) {
  const f = await fixture(boundary === "下一暂停"); await f.runtime.approvals.submit({ ...f.identity, decision: "allow_once" });
  const late = f.reopen();
  const acquire = late.ports.leaseStore.acquire.bind(late.ports.leaseStore);
  let release!: () => void; let reached!: () => void;
  const reachedGate = new Promise<void>(function ready(resolve) { reached = resolve; });
  const gate = new Promise<void>(function hold(resolve) { release = resolve; });
  late.ports.leaseStore.acquire = async function delayed(input) { reached(); await gate; return acquire(input); };
  const input = { sessionId: f.identity.sessionId, turnId: f.identity.turnId, approval: { approvalId: f.identity.approvalId, decision: "allow" as const } };
  const delayed = collect(late.runtime.turns.continue(input));
  const outcome = delayed.then(function succeeded(events) { return { events, error: undefined }; }, function failed(error) { return { events: [], error }; });
  await reachedGate;
  try { const events = await collect(f.runtime.turns.continue(input)); expect(events.some(function completed(event) { return event.type === (boundary === "下一暂停" ? "approval_required" : "turn_completed"); })).toBe(true); }
  finally { release(); }
  const result = await outcome;
  expect(result.error).toMatchObject({ code: "TURN_NOT_RESUMABLE" });
  expect((await f.ports.checkpointStore.getLatest("child"))?.completedCallIds).toContain("todo-once");
  const transcript = await f.ports.transcriptStore.getEvents("child");
  expect(transcript.filter(function executed(envelope) { return envelope.event.type === "tool_result" && envelope.event.callId === "todo-once" && envelope.event.result.status === "success"; })).toHaveLength(1);
}, 20000);

it("同Turn下一张真实审批保持隔离，旧决定不能处理新请求", async function nextRequest() {
  const f = await fixture(true);
  await f.runtime.approvals.submit({ ...f.identity, decision: "allow_once" });
  const events = await collect(f.runtime.turns.continue({ sessionId: "child", turnId: f.identity.turnId, approval: { approvalId: f.identity.approvalId, decision: "allow" } }));
  const next = events.find(function request(event) { return event.type === "approval_required"; });
  expect(next?.type).toBe("approval_required");
  if (next?.type !== "approval_required") throw new Error("missing next approval");
  expect(next.turnId).toBe(f.identity.turnId); expect(next.result.approval.approvalId).not.toBe(f.identity.approvalId);
  await expect(f.runtime.approvals.submit({ ...f.identity, decision: "deny" })).rejects.toMatchObject({ code: "APPROVAL_ALREADY_SUBMITTED" });
  const nextIdentity = { ...f.identity, approvalId: next.result.approval.approvalId };
  expect(await f.runtime.approvals.getDecision(nextIdentity)).toBeNull();
  await f.runtime.approvals.submit({ ...nextIdentity, decision: "deny" });
  const ended = await collect(f.runtime.turns.continue({ sessionId: "child", turnId: f.identity.turnId, approval: { approvalId: nextIdentity.approvalId, decision: "deny" } }));
  expect(ended.some(function denied(event) { return event.type === "tool_result" && event.callId === "todo-next" && event.result.status === "denied"; })).toBe(true);
  expect(ended.some(function failed(event) { return event.type === "turn_failed"; })).toBe(true);
}, 20000);

it.each(["expired", "stopped"] as const)("Node %s请求不可批准，零成功工具结果", async function unavailableRequest(mode) {
  const f = await fixture();
  if (mode === "expired") {
    const now = Date.now() + 3600000;
    f.ports.clock.now = function future() { return now; }; f.ports.clock.timestamp = function futureTimestamp() { return new Date(now).toISOString(); };
  } else await f.runtime.turns.cancel({ sessionId: "child", turnId: f.identity.turnId });
  await expect(f.runtime.approvals.submit({ ...f.identity, decision: "allow_once" })).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
  expect(await f.runtime.approvals.getDecision(f.identity)).toBeNull();
  const events = await f.ports.transcriptStore.getEvents("child");
  expect(events.filter(function executed(envelope) { return envelope.event.type === "tool_result" && envelope.event.result.status === "success"; })).toHaveLength(0);
}, 20000);

it("Workspace→Controller→Node Core保存决定后恢复失败，父卡重试复用原决定只执行一次", async function retryFromParent() {
  const f = await fixture();
  const parent = { id: "parent", title: "父任务", projectId: "fixture-project", productMode: "work" as const, persistenceMode: "durable" as const, status: "idle" as const, createdAt: Date.now(), updatedAt: Date.now() };
  await f.ports.sessionStore.save(parent);
  const submit = vi.spyOn(f.runtime.approvals, "submit");
  const continuation = f.runtime.turns.continue.bind(f.runtime.turns);
  let attempts = 0;
  f.runtime.turns.continue = async function* failFirst(input) { attempts++; if (attempts === 1) throw new Error("controlled recovery failure"); yield* continuation(input); };
  /** 所有会话走同一生产控制器和同一个Runtime。 */
  function controller(id: string) { return createCliController({ runtime: f.runtime, sessionId: id, renderer: createPlainRenderer("text") }); }
  const manager = createCliSessionManager({ runtime: f.runtime, projectId: "fixture-project", initialSession: parent, initialController: controller(parent.id), createController: controller,
    readDirectoryPage: async function directory() { return { items: [parent, { id: "child", title: "真实子任务" }] }; },
    readSummary: async function summary(id) { const session = await f.runtime.sessions.get(id); return session ? { ...session, executionView: await f.runtime.turns.getExecutionState({ sessionId: id }) } : null; },
    readRelations: async function relations(id) { if (id !== parent.id) return []; await frame(); const view = await f.runtime.turns.getExecutionState({ sessionId: "child" }); return [{ threadId: "child", parentThreadId: parent.id, title: "真实子任务", status: view?.status, activeTurnId: view?.turnId, executionView: view }]; },
    readEventPage: async function page(id) { return { items: await f.ports.transcriptStore.getEvents(id), cursor: "tail" }; },
  });
  await manager.refresh();
  const terminal = Object.assign(new EventEmitter(), { columns: 100, rows: 28 });
  const view = render(createElement(CliSessionWorkspace, { manager, terminalSizeSource: terminal, renderMode: "inline", useColor: false, screenReader: false, reducedMotion: true, closeWhenIdle: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  try {
    await frame(); view.stdin.write("保留草稿"); await frame(); view.stdin.write("\u0001"); await frame(); view.stdin.write("\r");
    await until(function saved() { return view.lastFrame().includes("尚未恢复执行"); });
    expect(submit).toHaveBeenCalledTimes(1); expect(attempts).toBe(1);
    expect(view.lastFrame()).not.toContain("批准本任务文件修改");
    await frame(); await frame();
    view.stdin.write("\u0001"); await frame(); expect(view.lastFrame()).toContain("Enter重试原决定");
    view.stdin.write("\u0014"); await frame(); expect(view.lastFrame()).toContain("会话 · ↑↓/Enter");
    view.stdin.write("\u001b[B"); await frame(); view.stdin.write("\r");
    await until(function childSelected() { const selected = manager.selected(); return selected.sessionId === "child" && selected.hydrated && !selected.historyLoading; }); await frame(); await frame();
    expect(submit).toHaveBeenCalledTimes(1); expect(attempts).toBe(1);
    view.stdin.write("\u0014"); await frame(); view.stdin.write("\u001b[A"); await frame(); view.stdin.write("\r");
    await until(function parentSelected() { return manager.selected().sessionId === parent.id; }); await frame(); await frame();
    expect(manager.related()[0]?.executionView?.interaction?.state).toBe("decided");
    expect(submit).toHaveBeenCalledTimes(1); expect(attempts).toBe(1);
    view.stdin.write("继续编辑"); await frame(); expect(manager.selected().viewState.draftRef.current?.inputRef.current).toBe("保留草稿继续编辑");
    view.stdin.write("\u0001"); await frame(); view.stdin.write("\r");
    await until(function finished() { return manager.related()[0]?.controller.getProjection().status === "completed"; });
    expect(submit).toHaveBeenCalledTimes(1); expect(attempts).toBe(2);
    expect(manager.selected().sessionId).toBe("parent");
    const transcript = await f.ports.transcriptStore.getEvents("child");
    expect(transcript.filter(function success(envelope) { return envelope.event.type === "tool_result" && envelope.event.callId === "todo-once" && envelope.event.result.status === "success"; })).toHaveLength(1);
  } finally { view.unmount(); await manager.stop(); submit.mockRestore(); }
}, 20000);
