/** 验证 Node 协作 Runner 驱动真实 Turn、崩溃收敛与跨进程中断，不使用真实 Provider。 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { RuntimePorts, ThreadDeliveryService } from "@autopilot-agent/core";
import { createAgentRuntime } from "../../../core/src/runtime/public/create-agent-runtime";
import { createSessionService } from "../../../core/src/runtime/application/session-service";
import { createThreadService } from "../../../core/src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../../core/src/runtime/application/thread-delivery-service";
import type { ModelSampler } from "../../../core/src/internal/kernel/model-sampler";
import { initializeNodeStateRoot } from "../../src/node/state-root";
import { createNodeRuntimePorts } from "../../src/node/create-node-runtime-ports";
import { createNodeThreadRunner } from "../../src/node/thread-runner";

/** 创建任务私有隔离根，禁止读写用户真实状态根。 */
function fixture(): { workspace: string; state: string } {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/plan1101-01a196cc/fixtures/node-roots");
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

describe("Node 协作 Runner", function threadRunner() {
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

  it("跨进程领取后崩溃的投递在新宿主重启后收敛执行", async function recoversFromChildCrash() {
    const f = await setup();
    const sent = await f.threads.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "崩溃后恢复" });
    const marker = path.join(f.state, "child-claimed.txt");
    const script = [
      'import adapters from "./src/index.ts";',
      'import core from "../core/src/index.ts";',
      'import fs from "node:fs";',
      'const ports = adapters.createNodeRuntimePorts({ stateRoot: process.env.RUNNER_STATE });',
      'const delivery = core.createThreadDeliveryService(ports, ports.threadStore, { workspaceId: "w", stateRootId: "root", ownerId: "child" });',
      'const claimed = await delivery.claimDeliveries({ activeThreads: [] });',
      'fs.writeFileSync(process.env.RUNNER_MARKER, String(claimed.length));',
      'setInterval(function alive() {}, 1000);',
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, RUNNER_STATE: f.state, RUNNER_MARKER: marker },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", function collect(chunk: Buffer) { stderr += chunk.toString("utf8"); });
    try {
      try {
        await until(async function claimed() { return fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : undefined; }, 30_000);
      } catch (error) {
        throw new Error(`${(error as Error).message}; child stderr: ${stderr.slice(0, 500)}`);
      }
      // 只领取、未启动 Turn 就强制终止，模拟真实宿主崩溃。
      child.kill("SIGKILL");
      await new Promise<void>(function closed(resolve) { child.on("close", function done() { resolve(); }); });
      const control = (await f.ports.threadStore.readControl(f.groupId))!;
      expect(control.deliveries.find(function match(item) { return item.messageId === sent.messageId; })?.status).toBe("claimed");

      const runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: sampler() } });
      const runner = createNodeThreadRunner({ delivery: f.delivery, runtime, ports: f.ports, pollIntervalMs: 50, staleMs: 0, heartbeatMs: 60_000 });
      try {
        await runner.start();
        await until(async function delivered() {
          const current = await f.threads.messageStatus({ groupId: f.groupId, threadId: f.child.threadId, messageId: sent.messageId });
          return current.deliveryStatus === "delivered" ? current : undefined;
        });
      } finally {
        await runner.stop();
      }
      expect(await f.ports.turnStore.list(f.child.threadId)).toHaveLength(1);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }
  }, 150_000);

  it("Turn 已保存但回执丢失时只回填，不重复启动", async function backfillsOnly() {
    const f = await setup();
    const sent = await f.threads.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "已执行" });
    const lost = host(f.ports, "lost");
    const claimed = (await lost.claimDeliveries({ activeThreads: [] }))[0];
    const turnId = claimed.delivery.reservedTurnId!;
    await f.ports.turnStore.save({ id: turnId, sessionId: f.child.threadId, status: "completed", frozenRunConfig: {}, startedAt: 1, completedAt: 2 });
    const runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: sampler() } });
    const runner = createNodeThreadRunner({ delivery: f.delivery, runtime, ports: f.ports, pollIntervalMs: 50, staleMs: 0, heartbeatMs: 60_000 });
    await runner.start();
    try {
      await until(async function delivered() {
        const control = await f.ports.threadStore.readControl(f.groupId);
        return control?.deliveries.find(function match(item) { return item.messageId === sent.messageId; })?.status === "delivered";
      });
    } finally {
      const report = await runner.stop();
      expect(report.releasedMessageIds).toEqual([]);
      expect(report.unconfirmedTurnIds).toEqual([]);
    }
    const turns = await f.ports.turnStore.list(f.child.threadId);
    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe(turnId);
  }, 60_000);

  it("跨进程中断由持有 Turn 的 owner 取消并回报应用状态", async function interruptByOwner() {
    const f = await setup();
    await f.threads.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "长任务" });
    const runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: sampler("完成", 8_000) } });
    const runner = createNodeThreadRunner({ delivery: f.delivery, runtime, ports: f.ports, pollIntervalMs: 50, staleMs: 10_000 });
    await runner.start();
    try {
      const live = await until(async function running() {
        const session = await f.ports.sessionStore.get(f.child.threadId);
        return session?.status === "running" ? session.activeTurnId : undefined;
      });
      const accepted = await f.threads.interrupt({ groupId: f.groupId, requestId: "stop", threadId: f.child.threadId, expectedTurnId: live! });
      expect(accepted.accepted).toBe(true);
      await until(async function applied() {
        const control = await f.ports.threadStore.readControl(f.groupId);
        return control?.controls.find(function match(item) { return item.controlId === accepted.controlId; })?.status === "applied";
      });
      const turn = await f.ports.turnStore.get(live!);
      expect(turn?.status).not.toBe("running");
    } finally {
      await runner.stop();
    }
  }, 150_000);

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
  it("迟到等待中断意图拒绝旧Turn，不改写后续等待轮", async function staleWaitingIntent() {
    const f = await setup();
    const session = (await f.ports.sessionStore.get(f.child.threadId))!;
    await f.ports.sessionStore.save({ ...session, status: "waiting_approval", activeTurnId: undefined });
    await f.ports.turnStore.save({ id: "old-wait", sessionId: f.child.threadId, status: "waiting_approval", frozenRunConfig: {}, startedAt: 1 });
    await f.ports.checkpointStore.save(f.child.threadId, { turnId: "old-wait", status: "awaiting_approval", stepCount: 0, messages: [], completedCallIds: [] });
    const accepted = await f.threads.interrupt({ groupId: f.groupId, requestId: "old-stop", threadId: f.child.threadId, expectedTurnId: "old-wait" });
    await f.ports.turnStore.save({ id: "new-wait", sessionId: f.child.threadId, status: "waiting_approval", frozenRunConfig: {}, startedAt: 2 });
    await f.ports.checkpointStore.save(f.child.threadId, { turnId: "new-wait", status: "awaiting_approval", stepCount: 0, messages: [], completedCallIds: [] });
    const runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: sampler() } });
    const runner = createNodeThreadRunner({ delivery: f.delivery, runtime, ports: f.ports, pollIntervalMs: 50 });
    await runner.start();
    try {
      await until(async function rejected() { return (await f.ports.threadStore.readControl(f.groupId))?.controls.find(function same(item) { return item.controlId === accepted.controlId; })?.status === "rejected"; });
    } finally { await runner.stop(); }
    expect((await f.ports.sessionStore.get(f.child.threadId))?.status).toBe("waiting_approval");
    expect((await f.ports.turnStore.get("new-wait"))?.status).toBe("waiting_approval");
    expect((await f.ports.checkpointStore.getLatest(f.child.threadId))?.turnId).toBe("new-wait");
  }, 60_000);

});
