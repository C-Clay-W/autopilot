/** Web 协作宿主契约：hostOnline 事实、Runner 生命周期与人类的发送回执。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime, createMemoryPorts, createThreadFacade } from "@autopilot-agent/core";
import type { ModelSampler, RuntimePorts } from "@autopilot-agent/core";
import { createWebTurnHost } from "@/lib/workspace-host/web-turn-host";
import { WEB_THREAD_PRINCIPAL_ID } from "@/lib/workspace-host/web-thread-capability";
import { getSessionMessages } from "@/lib/session-store";
import { mapHistoryMessage } from "@/app/chat/history-restore";
import { createWebThreadHost, type WebThreadHost } from "@/lib/workspace-host/web-thread-host";

/** 固定回答的采样器：Runner 真实驱动 Turn 时不触达网络。 */
const sampler: ModelSampler = {
  async sample() { return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" }; },
};

const hosts: WebThreadHost[] = [];

/** 建立内存宿主、Work 根会话与协作组；返回可直接断言的协作入口。 */
async function setup(modelSampler: ModelSampler = sampler, queue = false) {
  const ports: RuntimePorts = createMemoryPorts();
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler } });
  const root = await runtime.sessions.create({ title: "root" });
  const capability = { workspaceId: "ws", stateRootId: "root-1", projectId: root.projectId!, allowedTools: ["send_thread"], modelCatalog: [], onThreadCreated: function wakeRunner() {} };
  // 交接写入器只在显式发送 handoff 时触达磁盘；测试工作区使用临时目录。
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "web-thread-host-"));
  const turnHost = createWebTurnHost({ runtime, ports, ...(queue ? { prepareQueuedTurn: async function prepare(input) { return { content: input.input.content }; } } : {}) });
  const host = createWebThreadHost({ workspaceId: "ws", stateRootId: "root-1", projectId: root.projectId!, workspaceRoot, runtime, ports, capability, turnHost });
  hosts.push(host);
  const threads = host.facade();
  await threads.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
  const group = (await threads.groupOf({ protocolVersion: 1, threadId: root.id })).group;
  return { ports, runtime, root, host, turnHost, threads, groupId: group!.groupId, workspaceRoot };
}

afterEach(async function stopHosts() {
  await Promise.all(hosts.splice(0).map(function stop(host) { return host.stop(); }));
});

describe("Web 协作宿主", function webThreadHostContract() {
  it("Core create_thread 回调接管 Web Runner，宿主回调不进入克隆状态", async function toolCreateWakesRunner() {
    const ports: RuntimePorts = createMemoryPorts();
    const bootstrapRuntime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: sampler } });
    const root = await bootstrapRuntime.sessions.create({ title: "fresh-root" });
    let samples = 0;
    const createChild: ModelSampler = {
      async sample() {
        samples++;
        if (samples === 1) return { content: "", toolCalls: [{ id: "create-child", name: "create_thread", input: { title: "回调子会话" } }], reasoningSummary: "fixture", finishReason: "tool_calls" };
        return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
      },
    };
    let host: WebThreadHost | undefined;
    const capability = {
      workspaceId: "ws",
      stateRootId: "root-1",
      projectId: root.projectId!,
      humanPrincipalId: WEB_THREAD_PRINCIPAL_ID,
      allowRootGroupBootstrap: true,
      allowedTools: ["create_thread", "send_thread"],
      modelCatalog: [],
      onThreadCreated: function wakeWebRunner() { host?.ensureStarted(); host?.kick(); },
    };
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { threads: capability, modelSampler: createChild } });
    const turnHost = createWebTurnHost({ runtime, ports });
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "web-thread-create-wake-"));
    const activeHost = createWebThreadHost({ workspaceId: "ws", stateRootId: "root-1", projectId: root.projectId!, workspaceRoot, runtime, ports, capability, turnHost });
    host = activeHost;
    hosts.push(activeHost);
    expect(await ports.threadStore.listGroups()).toEqual([]);
    expect(activeHost.isRunning()).toBe(false);
    const started = turnHost.start({ sessionId: root.id, turnId: "create-thread-turn", content: "按需创建子会话" });
    expect(await turnHost.waitSettled(started.turnId, 5000)).toBe(true);
    expect(turnHost.status(started.turnId)?.failure).toBeUndefined();
    expect(activeHost.isRunning()).toBe(true);
    const group = (await activeHost.facade().groupOf({ protocolVersion: 1, threadId: root.id })).group;
    expect(group).toMatchObject({ rootThreadId: root.id, enabled: true });
    const control = await ports.threadStore.readControl(group!.groupId);
    expect(control?.group.createdBy).toMatchObject({ kind: "thread", threadId: root.id, turnId: started.turnId });
    expect(control?.group.ownerPrincipalId).toBe(WEB_THREAD_PRINCIPAL_ID);
    const child = (await activeHost.facade().list({ protocolVersion: 1, groupId: group!.groupId })).items.find(function notRoot(item) { return item.threadId !== root.id; });
    expect(child).toBeDefined();
    expect(await ports.sessionStore.get(child!.threadId)).not.toBeNull();
  });

  it("普通执行登记不会启动离线协作 Runner", async function registrationDoesNotStartRunner() {
    const f = await setup();
    const child = await f.threads.create({ protocolVersion: 1, groupId: f.groupId, parentThreadId: f.root.id, title: "目标", requestId: "offline-child" });
    await f.threads.send({ protocolVersion: 1, groupId: f.groupId, threadId: child.threadId, requestId: "offline-run", mode: "run", content: "任务" });
    f.turnHost.start({ sessionId: f.root.id, turnId: "offline-ordinary", content: "普通任务" });
    expect(await f.turnHost.waitSettled("offline-ordinary", 5000)).toBe(true);
    await new Promise<void>(function wait(resolve) { setTimeout(resolve, 350); });
    expect(f.host.isRunning()).toBe(false);
    expect(await f.ports.turnStore.list(child.threadId)).toHaveLength(0);
  });
  it("普通 start 消费 steer，空闲 notify 不启动会话", async function startSteerAndIdleNotify() {
    let started!: () => void; let release!: () => void;
    const seen = new Promise<void>(function wait(resolve) { started = resolve; });
    const gate = new Promise<void>(function wait(resolve) { release = resolve; });
    const controlled: ModelSampler = { async sample() { started(); await gate; return { content: "完成", toolCalls: [], reasoningSummary: "", finishReason: "stop" }; } };
    const f = await setup(controlled);
    f.host.ensureStarted();
    await f.threads.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "idle-notify", mode: "notify", content: "空闲通知" });
    await new Promise<void>(function wait(resolve) { setTimeout(resolve, 350); });
    expect(await f.ports.turnStore.list(f.root.id)).toHaveLength(0);
    f.turnHost.start({ sessionId: f.root.id, turnId: "start-steer", content: "任务" });
    await seen;
    await f.threads.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, expectedTurnId: "start-steer", requestId: "start-steer", mode: "steer", content: "启动引导" });
    f.host.kick();
    let bridged = false;
    for (let i = 0; i < 100; i++) {
      if ((await f.runtime.inbox.list({ sessionId: f.root.id })).some(function match(item) { return item.content === "启动引导"; })) { bridged = true; break; }
      await new Promise<void>(function wait(resolve) { setTimeout(resolve, 25); });
    }
    expect(bridged).toBe(true); release();
    expect(await f.turnHost.waitSettled("start-steer", 5000)).toBe(true);
    expect((await f.runtime.inbox.list({ sessionId: f.root.id })).find(function match(item) { return item.content === "启动引导"; })?.status).toBe("consumed");
  });

  it("普通 continue 的 interrupt 由 owner 应用", async function continueInterrupt() {
    let started!: () => void;
    let seen = new Promise<void>(function wait(resolve) { started = resolve; });
    const slow: ModelSampler = { async sample(_messages, _tools, options) {
      started(); await new Promise<void>(function wait(_resolve, reject) { options?.signal?.addEventListener("abort", function abort() { reject(new Error("aborted")); }, { once: true }); });
      return { content: "", toolCalls: [], reasoningSummary: "", finishReason: "stop" };
    } };
    const f = await setup(slow); f.host.ensureStarted();
    f.turnHost.start({ sessionId: f.root.id, turnId: "resume-stop", content: "任务" }); await seen;
    f.turnHost.cancel({ sessionId: f.root.id, turnId: "resume-stop" });
    expect(await f.turnHost.waitSettled("resume-stop", 5000)).toBe(true);
    seen = new Promise<void>(function wait(resolve) { started = resolve; });
    f.turnHost.continue({ sessionId: f.root.id, turnId: "resume-stop" }); await seen;
    await f.threads.interrupt({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, expectedTurnId: "resume-stop", requestId: "resume-stop" });
    f.host.kick();
    expect(await f.turnHost.waitSettled("resume-stop", 5000)).toBe(true);
    expect((await f.ports.turnStore.get("resume-stop"))?.status).toBe("interrupted");
  });
  it("其他 owner 不接管普通执行的中断", async function otherOwnerCannotCancel() {
    let started!: () => void;
    const seen = new Promise<void>(function wait(resolve) { started = resolve; });
    const slow: ModelSampler = { async sample(_messages, _tools, options) {
      started();
      await new Promise<void>(function wait(_resolve, reject) { options?.signal?.addEventListener("abort", function abort() { reject(new Error("aborted")); }, { once: true }); });
      return { content: "", toolCalls: [], reasoningSummary: "", finishReason: "stop" };
    } };
    const f = await setup(slow);
    const otherRuntime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: slow } });
    const other = createWebThreadHost({ workspaceId: "ws", stateRootId: "root-1", projectId: f.root.projectId!, workspaceRoot: f.workspaceRoot, runtime: otherRuntime, ports: f.ports, capability: { workspaceId: "ws", stateRootId: "root-1", projectId: f.root.projectId!, allowedTools: ["send_thread"], modelCatalog: [] } });
    hosts.push(other);
    other.ensureStarted();
    f.turnHost.start({ sessionId: f.root.id, turnId: "owned-turn", content: "任务" });
    await seen;
    await f.threads.interrupt({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, expectedTurnId: "owned-turn", requestId: "stop-owned" });
    other.kick();
    await new Promise<void>(function wait(resolve) { setTimeout(resolve, 350); });
    expect((await f.ports.turnStore.get("owned-turn"))?.status).toBe("running");
    expect((await f.ports.threadStore.readControl(f.groupId))?.controls[0]?.status).toBe("pending");
    f.host.ensureStarted(); f.host.kick();
    expect(await f.turnHost.waitSettled("owned-turn", 5000)).toBe(true);
    expect((await f.ports.turnStore.get("owned-turn"))?.status).toBe("interrupted");
  });

  it("普通队列启动的 Turn 进入协作 owner 索引", async function queuedOwnerControl() {
    let samples = 0;
    let started!: () => void;
    const seen = new Promise<void>(function wait(resolve) { started = resolve; });
    const sequence: ModelSampler = { async sample(_messages, _tools, options) {
      samples++;
      if (samples > 1) {
        started();
        await new Promise<void>(function wait(_resolve, reject) { options?.signal?.addEventListener("abort", function abort() { reject(new Error("aborted")); }, { once: true }); });
      }
      return { content: "完成", toolCalls: [], reasoningSummary: "", finishReason: "stop" };
    } };
    const f = await setup(sequence, true);
    f.host.ensureStarted();
    f.turnHost.start({ sessionId: f.root.id, turnId: "first-turn", content: "第一轮" });
    await f.runtime.inbox.post({ sessionId: f.root.id, clientMessageId: "queued", delivery: "queue", content: "排队" });
    await seen;
    const live = (await f.ports.sessionStore.get(f.root.id))?.activeTurnId;
    expect(live).toBeTruthy();
    await f.threads.interrupt({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, expectedTurnId: live!, requestId: "stop-queue" });
    f.host.kick();
    expect(await f.turnHost.waitSettled(live!, 5000)).toBe(true);
    expect((await f.ports.turnStore.get(live!))?.status).toBe("interrupted");
  });
  it("普通 start 与 continue 的协作控制由实际 owner 应用", async function ordinaryOwnerControl() {
    let started!: () => void;
    let release!: () => void;
    let seen = new Promise<void>(function wait(resolve) { started = resolve; });
    let gate = new Promise<void>(function wait(resolve) { release = resolve; });
    const controlled: ModelSampler = { async sample(_messages, _tools, options) {
      started();
      await Promise.race([gate, new Promise<void>(function cancelled(_resolve, reject) { options?.signal?.addEventListener("abort", function abort() { reject(new Error("aborted")); }, { once: true }); })]);
      return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
    } };
    const f = await setup(controlled);
    f.host.ensureStarted();
    f.turnHost.start({ sessionId: f.root.id, turnId: "ordinary-turn", content: "任务" });
    await seen;
    await expect(f.threads.interrupt({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, expectedTurnId: "wrong", requestId: "wrong" })).rejects.toMatchObject({ code: "THREAD_TURN_MISMATCH" });
    await f.threads.interrupt({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, expectedTurnId: "ordinary-turn", requestId: "stop" });
    f.host.kick();
    expect(await f.turnHost.waitSettled("ordinary-turn", 5000)).toBe(true);
    expect((await f.ports.turnStore.get("ordinary-turn"))?.status).toBe("interrupted");
    seen = new Promise<void>(function wait(resolve) { started = resolve; });
    gate = new Promise<void>(function wait(resolve) { release = resolve; });
    f.turnHost.continue({ sessionId: f.root.id, turnId: "ordinary-turn" });
    await seen;
    await f.threads.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, expectedTurnId: "ordinary-turn", requestId: "steer", mode: "steer", content: "补充约束" });
    f.host.kick();
    let bridged = false;
    for (let i = 0; i < 100; i++) {
      if ((await f.runtime.inbox.list({ sessionId: f.root.id })).some(function match(item) { return item.content === "补充约束"; })) { bridged = true; break; }
      await new Promise<void>(function wait(resolve) { setTimeout(resolve, 25); });
    }
    expect(bridged).toBe(true);
    release();
    expect(await f.turnHost.waitSettled("ordinary-turn", 5000)).toBe(true);
    expect((await f.runtime.inbox.list({ sessionId: f.root.id })).find(function match(item) { return item.content === "补充约束"; })?.status).toBe("consumed");
  });
  it("未接管驱动时 run 回执 hostOffline，接管后不再标记离线", async function hostOfflineFact() {
    const f = await setup();
    expect(f.host.isRunning()).toBe(false);
    const offline = await f.threads.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "offline", mode: "run", content: "执行" });
    expect(offline).toMatchObject({ deliveryStatus: "pending", hostOffline: true });
    f.host.ensureStarted();
    expect(f.host.isRunning()).toBe(true);
    // hostOnline 在入口创建时冻结：Route 先 ensureStarted 再 bind，因此这里重新取入口。
    const onlineThreads = f.host.facade();
    const online = await onlineThreads.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "online", mode: "run", content: "再执行" });
    expect("hostOffline" in online).toBe(false);
    // 通知在任何在线状态下都不会被标记为离线回执。
    const notify = await f.threads.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "notify", mode: "notify", content: "通知" });
    expect("hostOffline" in notify).toBe(false);
  });

  it("接管后 Runner 领取 run 投递并真实驱动目标 Turn", async function runnerDrivesTurn() {
    const f = await setup();
    f.host.ensureStarted();
    await f.threads.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "drive", mode: "run", content: "执行并回报" });
    f.host.kick();
    // 短轮询等待一次真实执行收尾；不引入浏览器或真实 Provider。
    for (let attempt = 0; attempt < 40; attempt++) {
      const turns = await f.ports.turnStore.list(f.root.id);
      if (turns.some(function completed(turn) { return turn.status === "completed"; })) return;
      await new Promise(function wait(resolve) { setTimeout(resolve, 50); });
    }
    throw new Error("Runner 未在预期时间内完成目标 Turn");
  });

  it("真实交接经 Runner 投影并保留模型完整输入", async function handoffThroughRunner() {
    let sampled = "";
    const capture: ModelSampler = { async sample(messages) { sampled = JSON.stringify(messages); return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" }; } };
    const f = await setup(capture);
    const child = await f.threads.create({ protocolVersion: 1, groupId: f.groupId, parentThreadId: f.root.id, title: "目标", requestId: "child" });
    await f.ports.turnStore.save({ id: "sender-turn", sessionId: f.root.id, status: "running", frozenRunConfig: {}, startedAt: 1 });
    const sender = createThreadFacade(f.ports, { workspaceId: "ws", stateRootId: "root-1", projectId: f.root.projectId!, allowedTools: ["send_thread"], modelCatalog: [], actor: { kind: "thread", threadId: f.root.id, turnId: "sender-turn" }, handoff: { async write(input) { return { handoffId: input.handoffId, relativePath: `.autopilot/thread-passdown-${input.handoffId}.md`, sha256: createHash("sha256").update(`# Handoff：${input.title}\n\n${input.markdown}\n`, "utf8").digest("hex") }; } } });
    const sent = await sender.send({ protocolVersion: 1, groupId: f.groupId, threadId: child.threadId, requestId: "handoff", mode: "run", content: "继续任务", handoff: { title: "交接标题", markdown: "交接摘要内容" } });
    const original = (await f.threads.messages({ protocolVersion: 1, groupId: f.groupId, threadId: child.threadId })).items[0]!;
    f.host.ensureStarted(); f.host.kick();
    for (let attempt = 0; attempt < 100; attempt++) {
      const messages = await getSessionMessages(f.runtime, child.threadId);
      const prompt = messages.find(function findPrompt(message) { return message.clientRecordId === `thread:${sent.messageId}`; });
      if (prompt && sampled) {
        const restored = mapHistoryMessage(prompt, undefined, undefined);
        expect(restored.origin).toEqual({ kind: "thread", threadId: f.root.id });
        expect(restored.content).toBe("# Handoff：交接标题\n\n继续任务");
        expect(restored.handoffDisplay?.summary).toBe("交接摘要内容");
        expect(restored.content).not.toContain(sent.handoffRef!.sha256);
        expect(sampled).toContain(original.content.replace(/\n/g, "\\n"));
        return;
      }
      await new Promise(function wait(resolve) { setTimeout(resolve, 50); });
    }
    throw new Error("交接投影或模型采样未完成");
  });

  it("人类入口始终绑定本地 principal，且停用后可读不可写", async function humanFacadeBoundary() {
    const f = await setup();
    const outsider = f.host.facade("other-principal");
    expect(await outsider.groupOf({ protocolVersion: 1, threadId: f.root.id })).toEqual({ protocolVersion: 1, group: null });
    await f.threads.disable({ protocolVersion: 1, groupId: f.groupId, requestId: "disable" });
    await expect(f.threads.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "after-disable", mode: "notify", content: "x" }))
      .rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    expect((await f.threads.readState({ protocolVersion: 1, groupId: f.groupId })).revision).toBe(0);
  });
});
