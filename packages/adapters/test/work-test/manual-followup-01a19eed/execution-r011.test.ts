/** r011Node回归：只读lease不创建状态，已有Turn的收尾错误不能被吞成delivered。 */
import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "@autopilot-agent/core";
import { createMemoryPorts } from "../../../../../packages/core/src/runtime/adapters/memory";
import { createSessionService } from "../../../../../packages/core/src/runtime/application/session-service";
import { createThreadService } from "../../../../../packages/core/src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../../../../packages/core/src/runtime/application/thread-delivery-service";
import { createNodeThreadRunner } from "../../../src/node/thread-runner";
import { createNodeLeaseStore } from "../../../src/node/stores/node-lease-store";

it("lease只读不存在根不创建/迁移目录", async function noReadSideEffect() {
  const stateRoot = path.resolve(process.cwd(), "../../.agent-tests/work-test/manual-followup-01a19eed/fixtures/r011", `missing-${randomUUID()}`);
  const store = createNodeLeaseStore({ stateRoot });
  expect(await store.readCurrent!("r011")).toBeNull();
  expect(fs.existsSync(stateRoot)).toBe(false);
});

it("Runner有Turn仍向onError报告流收尾失败并阻止原任务自动重放", async function settleFailure() {
  const ports = createMemoryPorts(process.cwd());
  const root = await createSessionService(ports).create({ title: "父" });
  const threads = createThreadService(ports, ports.threadStore, { workspaceId: "w", stateRootId: "s", projectId: root.projectId!, actor: { kind: "human", principalId: "user" }, allowedTools: [], modelCatalog: [] });
  const enabled = await threads.enable({ rootThreadId: root.id, requestId: "enable" });
  const groupId = enabled.group.groupId;
  const child = await threads.create({ groupId, parentThreadId: root.id, requestId: "child", title: "子" });
  const sent = await threads.send({ groupId, threadId: child.threadId, requestId: "run", mode: "run", content: "仅模拟收尾错误" });
  const errors: unknown[] = [];
  let starts = 0;
  const runtime = { turns: { async *start(input: { sessionId: string; turnId: string }) {
    starts++;
    await ports.turnStore.save({ id: input.turnId, sessionId: input.sessionId, status: "running", startedAt: Date.now(), frozenRunConfig: { workspaceRoot: process.cwd() } });
    throw Error("injected-finalize");
  } } } as unknown as AgentRuntime;
  const delivery = createThreadDeliveryService(ports, ports.threadStore, { workspaceId: "w", stateRootId: "s", ownerId: "executor-r011" });
  const runner = createNodeThreadRunner({ runtime, ports, delivery, pollIntervalMs: 20, onError: function report(error) { errors.push(error); } });
  try {
    await runner.start();
    const deadline = Date.now() + 2000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      status = (await ports.threadStore.readControl(groupId))?.deliveries.find(function same(item) { return item.messageId === sent.messageId; })?.status;
      if (status === "delivered") break;
      await new Promise(function tick(resolve) { setTimeout(resolve, 20); });
    }
    expect(status).toBe("delivered"); expect(errors.some(function matching(error) { return (error as Error).message === "injected-finalize"; })).toBe(true);
    const observed = await threads.wait({ groupId, targets: [{ threadId: child.threadId, taskId: sent.messageId }], timeoutMs: 0 });
    expect(observed.results[0]).toMatchObject({ reason: "attention", summary: { deliveryStatus: "delivered", execution: "unconfirmed" } });
    await new Promise(function tick(resolve) { setTimeout(resolve, 60); });
    expect(starts).toBe(1);
  } finally { await runner.stop(); }
});
