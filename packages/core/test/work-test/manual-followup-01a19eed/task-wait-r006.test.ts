/** r006精确task实际等待默认保留父Turn；只用内存durable Ports/受控采样器。 */
import { expect, it, vi } from "vitest";
import { createAgentRuntime as createKernelRuntime } from "../../../src/internal/agent-runtime";
import { createAgentTextMessage } from "../../../src/internal/types/agent-message";
import type { AgentThreadsCapability } from "../../../src/runtime/application/thread-tool-binding";
import { createAgentRuntime } from "../../../src/runtime/public/create-agent-runtime";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createSessionService } from "../../../src/runtime/application/session-service";
import { createThreadFacade } from "../../../src/runtime/application/thread-service";

/** 有界等待真实状态，不通过重复模型采样推进。 */
async function until(check: () => boolean) { for (let i = 0; i < 50 && !check(); i++) await new Promise(function tick(resolve) { setTimeout(resolve, 10); }); expect(check()).toBe(true); }

it("task实际wait漏flag仍让durable父Turn运行，审批等待不采样，子终态唤醒同父Turn", async function durableParentWait() {
  const ports = createMemoryPorts();
  // 与当前Node Port同形的兼容空等待，必须不能造成协作等待反复取消。
  ports.inputInbox.waitForInput = vi.fn(async function compatibilityNoop() {});
  const sessions = createSessionService(ports); const root = await sessions.create({ title: "parent" });
  const capability = { workspaceId: "w", stateRootId: "state", projectId: root.projectId!, allowedTools: ["wait_threads", "send_thread", "read_progress", "report_progress"], modelCatalog: [] };
  const human = createThreadFacade(ports, { ...capability, actor: { kind: "human", principalId: "user" } });
  const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
  const child = await human.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: root.id, title: "child", requestId: "create" });
  const task = await human.send({ protocolVersion: 1, groupId: group.groupId, threadId: child.threadId, requestId: "run", mode: "run", content: "合成委派" });
  const control = (await ports.threadStore.readControl(group.groupId))!;
  await ports.threadStore.compareAndSetControl(group.groupId, control.revision, { ...control, revision: control.revision + 1, deliveries: control.deliveries.map(function bind(item) { return item.messageId === task.messageId ? { ...item, reservedTurnId: "child-turn", turnId: "child-turn", status: "delivered" as const } : item; }) });
  const childSession = (await ports.sessionStore.get(child.threadId))!;
  const childTurn = { id: "child-turn", sessionId: child.threadId, status: "waiting_approval" as const, frozenRunConfig: {}, startedAt: ports.clock.now(), schemaVersion: 2 };
  await ports.turnStore.save(childTurn); await ports.sessionStore.save({ ...childSession, status: "waiting_approval", activeTurnId: undefined });
  let samples = 0;
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { threads: capability, modelSampler: { async sample() { samples++; return samples === 1 ? { content: "", toolCalls: [{ id: "wait", name: "wait_threads", input: { targets: [{ threadId: child.threadId, taskId: task.messageId }], timeoutMs: 30000 } }], reasoningSummary: "等待" } : { content: samples === 2 ? "子任务等待审批" : "已收到子任务终态", toolCalls: [], reasoningSummary: "汇报" }; } } } });
  const abort = new AbortController();
  const events: Array<{ type: string }> = []; let done = false;
  const running = (async function consume() { for await (const event of runtime.turns.start({ sessionId: root.id, content: "等待本次委派结果", signal: abort.signal })) events.push(event); done = true; })();
  try {
    await until(function waiting() { return samples >= 2; }); await new Promise(function quiet(resolve) { setTimeout(resolve, 60); });
    expect(done).toBe(false); expect((await ports.sessionStore.get(root.id))?.status).toBe("running"); const parent = await ports.turnStore.getLatest(root.id); expect(parent?.status).toBe("running"); expect(samples).toBe(2); expect(ports.inputInbox.waitForInput).toHaveBeenCalledTimes(1);
    expect((await ports.checkpointStore.getLatest(root.id))?.threadObservation?.targets[0].taskId).toBe(task.messageId);
    const beforeSteer = samples;
    await runtime.turns.steer({ sessionId: root.id, turnId: parent!.id, delivery: "steer", content: "后到的明确补充要求" });
    await until(function steered() { return samples > beforeSteer; });
    expect((await ports.sessionStore.get(root.id))?.status).toBe("running");
    await ports.turnStore.save({ ...childTurn, status: "completed" }); await ports.sessionStore.save({ ...childSession, status: "completed", activeTurnId: undefined });
    await running; expect((await ports.turnStore.getLatest(root.id))?.id).toBe(parent?.id); expect((await ports.sessionStore.get(root.id))?.status).toBe("completed"); expect(events.filter(function terminal(event) { return event.type === "turn_completed"; })).toHaveLength(1);
  } finally { if (!done) { abort.abort(); await running; } }
});

it("即时快照与显式false及会话观察不新增跟随依赖", async function snapshotOrDetached() {
  for (const input of [{ targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 0 }, { targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 0, followUntilTerminal: false }, { targets: [{ threadId: "child" }], timeoutMs: 30000 }]) {
    let samples = 0; const wait = vi.fn(async function waiting() { return { results: [{ threadId: "child", taskId: "task", cursor: "c", reason: "attention", pendingProgress: 0, summary: { turnId: "child-turn", turnStatus: "waiting_approval" } }], timedOut: false }; });
    const runtime = createKernelRuntime({ threads: { wait } as unknown as AgentThreadsCapability, modelSampler: { async sample() { samples++; return samples === 1 ? { content: "", toolCalls: [{ id: "snapshot", name: "wait_threads", input }], reasoningSummary: "快照" } : { content: "当前快照已返回", toolCalls: [], reasoningSummary: "完成" }; } } });
    const events = []; for await (const event of runtime.run({ messages: [createAgentTextMessage("user", "合成快照")] })) events.push(event);
    expect(events.at(-1)?.type).toBe("turn_completed"); expect(wait).toHaveBeenCalledTimes(1);
  }
});


it("默认task实际等待可取消；send run仅派工不挂等待责任", async function cancellationAndDetached() {
  const abort = new AbortController(); let waits = 0; let samples = 0;
  const wait = vi.fn(async function waiting(input) { waits++; if (waits > 1) { abort.abort(); return { results: [], timedOut: false }; } return { results: [{ threadId: "child", taskId: "task", cursor: "c", reason: "attention", pendingProgress: 0, summary: { turnId: "child-turn", turnStatus: "waiting_approval" } }], timedOut: false }; });
  const runtime = createKernelRuntime({ threads: { wait } as unknown as AgentThreadsCapability, modelSampler: { async sample() { samples++; return samples === 1 ? { content: "", toolCalls: [{ id: "wait", name: "wait_threads", input: { targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 30000 } }], reasoningSummary: "等待" } : { content: "等待审批", toolCalls: [], reasoningSummary: "阶段" }; } } });
  const events = []; for await (const event of runtime.run({ messages: [createAgentTextMessage("user", "等待")], signal: abort.signal })) events.push(event);
  expect(events.at(-1)?.type).toBe("turn_interrupted"); expect(events.some(function completed(event) { return event.type === "turn_completed"; })).toBe(false);
  let detachedSamples = 0; const send = vi.fn(async function send() { return { messageId: "task", mode: "run", deliverySeq: 1, deliveryStatus: "accepted" }; });
  const detached = createKernelRuntime({ threads: { send, wait } as unknown as AgentThreadsCapability, modelSampler: { async sample() { detachedSamples++; return detachedSamples === 1 ? { content: "", toolCalls: [{ id: "send", name: "send_thread", input: { threadId: "child", mode: "run", content: "后台委派" } }], reasoningSummary: "派工" } : { content: "已派工", toolCalls: [], reasoningSummary: "完成" }; } } });
  const before = waits; const detachedEvents = []; for await (const event of detached.run({ messages: [createAgentTextMessage("user", "仅派工")] })) detachedEvents.push(event);
  expect(detachedEvents.at(-1)?.type).toBe("turn_completed"); expect(waits).toBe(before); expect(send).toHaveBeenCalledTimes(1);
});


it("no-op输入Port等待期间后到取消立即终止原wait，不重新采样", async function laterCancelWithNoop() {
  const abort = new AbortController(); let waits = 0; let samples = 0;
  const capability = { wait: async function wait(input) { waits++; if (waits === 1) return { results: [{ threadId: "child", taskId: "task", cursor: "c", reason: "attention", pendingProgress: 0, summary: { turnId: "child-turn", turnStatus: "waiting_approval" } }], timedOut: false }; return new Promise(function pending(resolve) { input.signal!.addEventListener("abort", function cancelled() { resolve({ results: [], timedOut: false }); }, { once: true }); }); } } as unknown as AgentThreadsCapability;
  const runtime = createKernelRuntime({ threads: capability, inputInbox: { drain: async function empty() { return []; }, waitForInput: async function noop() {} }, modelSampler: { async sample() { samples++; return samples === 1 ? { content: "", toolCalls: [{ id: "wait", name: "wait_threads", input: { targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 30000 } }], reasoningSummary: "等待" } : { content: "等待中", toolCalls: [], reasoningSummary: "阶段" }; } } });
  const started = performance.now(); const timer = setTimeout(function cancelLater() { abort.abort(); }, 80);
  const events = []; try { for await (const event of runtime.run({ messages: [createAgentTextMessage("user", "等待")], signal: abort.signal })) events.push(event); } finally { clearTimeout(timer); }
  expect(performance.now() - started).toBeLessThan(800); expect(samples).toBe(2); expect(waits).toBe(2); expect(events.at(-1)?.type).toBe("turn_interrupted");
});
