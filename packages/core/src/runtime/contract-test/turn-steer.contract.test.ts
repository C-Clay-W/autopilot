/**
 * runtime/contract-test/turn-steer.contract.test.ts
 *
 * Phase 4：TurnService.steer() 与 InputInbox 集成契约。
 */

import { describe, it, expect } from "vitest";
import { createAgentRuntime } from "../public";
import { createMemoryPorts } from "../adapters/memory";

describe("TurnService.steer contract", () => {
  it("steer 投递 pending 输入到 inbox", async () => {
    const ports = createMemoryPorts();
    // steer 入口会 requireSession；夹具先建立 Session。
    await ports.sessionStore.save({ id: "s1", persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const runtime = createAgentRuntime({ ports });

    await runtime.turns.steer({
      sessionId: "s1",
      turnId: "t1",
      content: "请继续",
    });

    const drained = await ports.inputInbox.drain({
      sessionId: "s1",
      turnId: "t1",
      maxDelivery: "steer",
      boundary: "before_sample",
    });
    expect(drained).toHaveLength(1);
    expect(drained[0].content).toBe("请继续");
    expect(drained[0].delivery).toBe("steer");
    expect(drained[0].status).toBe("claimed");
  });

  it("以 /queue 开头的内容标记为 queue 投递", async () => {
    const ports = createMemoryPorts();
    await ports.sessionStore.save({ id: "s1", persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const runtime = createAgentRuntime({ ports });

    await runtime.turns.steer({
      sessionId: "s1",
      turnId: "t1",
      content: "/queue 下一条",
    });

    const drained = await ports.inputInbox.drain({
      sessionId: "s1",
      turnId: "t1",
      maxDelivery: "queue",
      boundary: "before_sample",
    });
    expect(drained).toHaveLength(1);
    expect(drained[0].content).toBe("下一条");
    expect(drained[0].delivery).toBe("queue");
  });
});