/** S3宿主退出仅投影既有持久事实：等待保留、未交付保留、未启动领取释放。 */
import { expect, it } from "vitest";
import { createNodeThreadRunner } from "../../src/node/thread-runner";
import type { NodeThreadRunnerOptions } from "../../src/node/thread-runner";

/** 不启动Runner或模型循环，直接核对退出分类和精确释放集合。 */
it("Runner退出保留paused等待与pending，仅释放本owner未启动claimed", async function exitFacts() {
  const cancelled: string[] = [];
  const released: string[] = [];
  const options = {
    runtime: { turns: { cancel: async function cancel(input: { turnId: string }) { cancelled.push(input.turnId); } } },
    ports: { turnStore: { get: async function get(id: string) { return id === "waiting" ? { id, sessionId: "b", status: "waiting_approval" } : undefined; } } },
    delivery: {
      ownerId: "owner",
      listGroups: async function groups() { return ["g"]; },
      readGroup: async function read() { return { deliveries: [{ messageId: "paused", threadId: "b", turnId: "waiting", status: "delivered", ownerId: "owner" }, { messageId: "pending", threadId: "c", status: "pending" }, { messageId: "reserved", threadId: "d", reservedTurnId: "not-started", status: "claimed", ownerId: "owner" }, { messageId: "other-owner", threadId: "e", status: "claimed", ownerId: "other" }] }; },
      releaseDelivery: async function release(input: { messageId: string }) { released.push(input.messageId); },
      recordHostOffline: async function offline() {},
    },
  } as unknown as NodeThreadRunnerOptions;
  const report = await createNodeThreadRunner(options).stop();
  expect(cancelled).toEqual([]);
  expect(released).toEqual(["reserved"]);
  expect(report.waitingTurnIds).toEqual(["waiting"]);
  expect(report.pendingMessageIds).toEqual(["pending", "reserved"]);
  expect(report.cancelledTurnIds).toEqual([]);
});
