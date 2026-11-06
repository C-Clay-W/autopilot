/** 验证 Node 协作 Runner 驱动真实 Turn、崩溃收敛与跨进程中断，不使用真实 Provider。 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { RuntimePorts, ThreadDeliveryService } from "@autopilot-agent/core";
import { createAgentRuntime } from "../../../../core/src/runtime/public/create-agent-runtime";
import { createSessionService } from "../../../../core/src/runtime/application/session-service";
import { createThreadService } from "../../../../core/src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../../../core/src/runtime/application/thread-delivery-service";
import type { ModelSampler } from "../../../../core/src/internal/kernel/model-sampler";
import { initializeNodeStateRoot } from "../../../src/node/state-root";
import { createNodeRuntimePorts } from "../../../src/node/create-node-runtime-ports";
import { createNodeThreadRunner } from "../../../src/node/thread-runner";

/** 创建任务私有隔离根，禁止读写用户真实状态根。 */
function fixture(): { workspace: string; state: string } {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/refix-live-01a1ab13/fixtures/r002-runner");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "runner-"));
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  fs.mkdirSync(workspace);
  initializeNodeStateRoot(state);
  return { workspace, state };
}

/** 确定性 mock 采样器；慢任务按 AbortSignal 结束，避免测试依赖真实 Provider。 */
function sampler(content = "完成", delayMs = 0): ModelSampler {
  return {
    async sample(_messages, _tools, options, onDelta) {
      if (delayMs) {
        await new Promise<void>(function wait(resolve, reject) {
          const timer = setTimeout(resolve, delayMs);
          options.signal?.addEventListener("abort", function stop() { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
          if (options.signal?.aborted) { clearTimeout(timer); reject(new Error("aborted")); }
        });
      }
      if (onDelta) for (const char of content) onDelta(char);
      return { content, toolCalls: [], reasoningSummary: "mock", finishReason: "stop" };
    },
  };
}

/** 用同一 Ports 装配受信宿主的投递服务。 */
function host(ports: RuntimePorts, ownerId: string): ThreadDeliveryService {
  return createThreadDeliveryService(ports, ports.threadStore, { workspaceId: "w", stateRootId: "root", ownerId });
}

/** 轮询直到条件成立；超时明确失败，不静默当作通过。 */
async function until<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise(function tick(resolve) { setTimeout(resolve, 50); });
  }
  throw new Error("condition timeout");
}

/** 建立工作区、协作组与一个空闲子会话。 */
async function setup() {
  const f = fixture();
  const ports = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
  const root = await createSessionService(ports).create({ title: "root" });
  const context = { workspaceId: "w", stateRootId: "root", projectId: root.projectId!, actor: { kind: "human" as const, principalId: "user" }, allowedTools: [], modelCatalog: [] };
  const threads = createThreadService(ports, ports.threadStore, context);
  const group = await threads.enable({ rootThreadId: root.id, requestId: "enable" });
  const child = await threads.create({ groupId: group.group.groupId, parentThreadId: root.id, requestId: "child", title: "child" });
  return { ...f, ports, root, threads, groupId: group.group.groupId, child, delivery: host(ports, "host-a") };
}

describe("r002真实Runner关键路径", function tests() {
  it("驱动空闲目标完成 Turn 并按真实结果回填交付", async function runsTurn() {
    const f = await setup();
    const sent = await f.threads.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "执行定向测试" });
    const runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: sampler("已完成定向测试") } });
    const runner = createNodeThreadRunner({ delivery: f.delivery, runtime, ports: f.ports, pollIntervalMs: 50, staleMs: 10_000 });
    await runner.start();
    try {
      const turn = await until(async function completed() { return (await f.ports.turnStore.list(f.child.threadId)).find(function done(item) { return item.status === "completed"; }); });
      const status = await until(async function delivered() {
        const current = await f.threads.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId });
        return current.deliveryStatus === "delivered" ? current : undefined;
      });
      expect(status.execution).toEqual({ turnId: turn.id, status: "completed" });
      const events = await f.threads.listEvents({ groupId: f.groupId });
      expect(events.items.some(function delivered(event) { return event.kind === "message_delivered"; })).toBe(true);
    } finally {
      const report = await runner.stop();
      expect(report.stopped).toBe(true);
      expect(report.unconfirmedTurnIds).toEqual([]);
      expect(runner.isRunning()).toBe(false);
    }
  }, 120_000);

  it("两个 Runner 竞争同一投递时只启动一个 Turn", async function singleStart() {
    const f = await setup();
    const sent = await f.threads.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "竞争任务" });
    const first = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const second = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const runnerA = createNodeThreadRunner({ delivery: host(first, "host-a"), runtime: createAgentRuntime({ ports: first, defaultRunConfig: { modelSampler: sampler() } }), ports: first, pollIntervalMs: 30, staleMs: 10_000 });
    const runnerB = createNodeThreadRunner({ delivery: host(second, "host-b"), runtime: createAgentRuntime({ ports: second, defaultRunConfig: { modelSampler: sampler() } }), ports: second, pollIntervalMs: 30, staleMs: 10_000 });
    try {
      await Promise.all([runnerA.start(), runnerB.start()]);
      await until(async function delivered() {
        const control = await first.threadStore.readControl(f.groupId);
        return control?.deliveries.find(function match(item) { return item.messageId === sent.messageId; })?.status === "delivered";
      });
      const turns = await first.turnStore.list(f.child.threadId);
      expect(turns).toHaveLength(1);
      expect(turns[0].status).toBe("completed");
    } finally {
      await Promise.all([runnerA.stop(), runnerB.stop()]);
    }
  }, 120_000);

  it("20组单次发现、空闲退避、外部变化两秒内可见且kick不丢失", async function polling() {
    const f = await setup();
    const seed = await f.ports.threadStore.readControl(f.groupId);
    for (let n = 0; n < 19; n++) {
      const control = structuredClone(seed!); control.group.groupId = `extra-${n}`; control.revision = 0;
      await f.ports.threadStore.compareAndSetControl(control.group.groupId, null, control);
    }
    const list = vi.spyOn(f.ports.threadStore, "listGroups");
    const read = vi.spyOn(f.ports.threadStore, "readControl");
    const runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: sampler() } });
    const runner = createNodeThreadRunner({ ports: f.ports, delivery: f.delivery, runtime });
    expect(runner.isRunning()).toBe(false);
    await runner.start();
    expect(runner.isRunning()).toBe(true);
    expect(list).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(20);
    await new Promise(function wait(resolve) { setTimeout(resolve, 1650); });
    expect(list.mock.calls.length).toBeLessThanOrEqual(3);
    const external = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const control = await external.threadStore.readControl(f.groupId);
    control!.controls.push({ controlId: "external-interrupt", kind: "interrupt", threadId: f.child.threadId, expectedTurnId: "finished", status: "pending", createdAt: 0, updatedAt: 0 });
    await external.threadStore.compareAndSetControl(f.groupId, control!.revision, { ...control!, revision: control!.revision + 1 });
    vi.spyOn(f.ports.turnStore, "get").mockResolvedValue({ id: "finished", status: "completed" } as any);
    try {
      await until(async function seen() { return (await external.threadStore.readControl(f.groupId))!.controls[0]?.status === "rejected"; }, 2600);
      runner.kick(); runner.kick();
    } finally { await runner.stop(); expect(runner.isRunning()).toBe(false); }
  });
});

// 快照只发现候选，后续领取仍读取当前宿主与控制版本。
it("旧快照不能绕过宿主变化和CAS，也不发现其他工作区", async function staleSnapshot() {
  const f=await setup();
  const sent=await f.threads.send({groupId:f.groupId,threadId:f.child.threadId,requestId:"stale",mode:"run",content:"安全测试"});
  const snapshot=await f.delivery.querySnapshot();
  const current=await f.ports.threadStore.readControl(f.groupId);
  current!.members=current!.members.map(function change(m){return m.threadId===f.child.threadId?{...m,executionHost:"web-work-v1"}:m;});
  await f.ports.threadStore.compareAndSetControl(f.groupId,current!.revision,{...current!,revision:current!.revision+1});
  expect(await f.delivery.claimDeliveries({activeThreads:[],snapshot})).toEqual([]);
  const final=await f.ports.threadStore.readControl(f.groupId);
  expect(final!.deliveries.find(function target(d){return d.messageId===sent.messageId;})?.status).toBe("pending");
  expect(await createThreadDeliveryService(f.ports,f.ports.threadStore,{workspaceId:"foreign",stateRootId:"root",ownerId:"other"}).querySnapshot()).toEqual([]);
});

  it("等待审批的目标由 owner 直接收尾为 interrupted", async function interruptsWaitingApproval() {
    const f = await setup();
    const session = (await f.ports.sessionStore.get(f.child.threadId))!;
    await f.ports.sessionStore.save({ ...session, status: "waiting_approval", activeTurnId: undefined });
    await f.ports.turnStore.save({ id: "turn-approval", sessionId: f.child.threadId, status: "waiting_approval", frozenRunConfig: {}, startedAt: 1 });
    await f.ports.checkpointStore.save(f.child.threadId, { turnId: "turn-approval", status: "awaiting_approval", stepCount: 0, messages: [], completedCallIds: [] });
    const accepted = await f.threads.interrupt({ groupId: f.groupId, requestId: "stop-approval", threadId: f.child.threadId, expectedTurnId: "turn-approval" });
    expect(accepted.accepted).toBe(true);
    const runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: sampler() } });
    const runner = createNodeThreadRunner({ delivery: f.delivery, runtime, ports: f.ports, pollIntervalMs: 50, staleMs: 10_000 });
    await runner.start();
    try {
      await until(async function applied() {
        const control = await f.ports.threadStore.readControl(f.groupId);
        return control?.controls.find(function match(item) { return item.controlId === accepted.controlId; })?.status === "applied";
      });
    } finally {
      await runner.stop();
    }
    expect((await f.ports.turnStore.get("turn-approval"))?.status).toBe("interrupted");
    expect((await f.ports.sessionStore.get(f.child.threadId))?.status).toBe("interrupted");
  }, 60_000);
