/**
 * runtime/contract-test/input-inbox.contract.test.ts
 *
 * Phase 4：InputInbox Port 行为契约。
 */

import { describe, it, expect } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentInputInboxCapability } from "../application/input-inbox-service";

describe("InputInbox contract", () => {
  it("投递 steer 输入并 drain", async () => {
    const ports = createMemoryPorts();
    const input = await ports.inputInbox.post({
      sessionId: "s1",
      turnId: "t1",
      delivery: "steer",
      content: "继续",
      attachments: [],
      selectedSkills: [],
    });
    expect(input.sessionId).toBe("s1");
    expect(input.turnId).toBe("t1");
    expect(input.delivery).toBe("steer");
    expect(input.status).toBe("pending");

    const drained = await ports.inputInbox.drain({
      sessionId: "s1",
      turnId: "t1",
      maxDelivery: "steer",
      boundary: "before_sample",
    });
    expect(drained).toHaveLength(1);
    expect(drained[0].inputId).toBe(input.inputId);
    expect(drained[0].status).toBe("claimed");
  });

  it("queue 输入在 steer drain 时不返回", async () => {
    const ports = createMemoryPorts();
    await ports.inputInbox.post({
      sessionId: "s1",
      turnId: undefined,
      delivery: "queue",
      content: "下一条",
      attachments: [],
      selectedSkills: [],
    });
    const drained = await ports.inputInbox.drain({
      sessionId: "s1",
      turnId: "t1",
      maxDelivery: "steer",
      boundary: "before_sample",
    });
    expect(drained).toHaveLength(0);
  });

  it("queue 输入可被 queue drain 返回", async () => {
    const ports = createMemoryPorts();
    const input = await ports.inputInbox.post({
      sessionId: "s1",
      turnId: undefined,
      delivery: "queue",
      content: "下一条",
      attachments: [],
      selectedSkills: [],
    });
    const drained = await ports.inputInbox.drain({
      sessionId: "s1",
      turnId: "t1",
      maxDelivery: "queue",
      boundary: "before_sample",
    });
    expect(drained).toHaveLength(1);
    expect(drained[0].inputId).toBe(input.inputId);
  });

  it("取消后 drain 不返回", async () => {
    const ports = createMemoryPorts();
    const input = await ports.inputInbox.post({
      sessionId: "s1",
      turnId: "t1",
      delivery: "steer",
      content: "继续",
      attachments: [],
      selectedSkills: [],
    });
    const ok = await ports.inputInbox.cancel(input.inputId);
    expect(ok).toBe(true);
    const drained = await ports.inputInbox.drain({
      sessionId: "s1",
      turnId: "t1",
      maxDelivery: "steer",
      boundary: "before_sample",
    });
    expect(drained).toHaveLength(0);
  });

  it("claimNext 按 steer 优先并可显式 consume", async () => {
    const ports = createMemoryPorts();
    const queue = await ports.inputInbox.post({
      sessionId: "s1",
      delivery: "queue",
      content: "先排队",
      clientMessageId: "queue-1",
      attachments: [],
      selectedSkills: [],
    });
    const steer = await ports.inputInbox.post({
      sessionId: "s1",
      turnId: "old-turn",
      delivery: "steer",
      content: "优先处理",
      clientMessageId: "steer-1",
      attachments: [],
      selectedSkills: [],
    });

    const claimed = await ports.inputInbox.claimNext({ sessionId: "s1" });
    expect(claimed?.inputId).toBe(steer.inputId);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.clientMessageId).toBe("steer-1");

    expect(await ports.inputInbox.consume({ sessionId: "s1", inputId: steer.inputId, turnId: "new-turn" })).toBe(true);
    expect((await ports.inputInbox.claimNext({ sessionId: "s1" }))?.inputId).toBe(queue.inputId);
    expect(await ports.inputInbox.consume({ sessionId: "s1", inputId: steer.inputId, turnId: "new-turn" })).toBe(false);
  });

  it("list 只读返回指定 Session 的输入", async () => {
    const ports = createMemoryPorts();
    const first = await ports.inputInbox.post({ sessionId: "s1", delivery: "queue", content: "第一条", attachments: [], selectedSkills: [] });
    await ports.inputInbox.post({ sessionId: "s2", delivery: "queue", content: "其他会话", attachments: [], selectedSkills: [] });
    const listed = await ports.inputInbox.list({ sessionId: "s1" });
    expect(listed.map((input) => input.inputId)).toEqual([first.inputId]);
    expect(listed[0].status).toBe("pending");
  });

  it("Agent capability drain 后会把输入标记为 consumed", async () => {
    const ports = createMemoryPorts();
    const input = await ports.inputInbox.post({ sessionId: "s1", turnId: "t1", delivery: "steer", content: "已执行引导", attachments: [], selectedSkills: [] });
    const capability = createAgentInputInboxCapability(ports.inputInbox, "s1", "t1");

    await expect(capability.drain({ turnId: "t1", maxDelivery: "steer", boundary: "before_sample" })).resolves.toEqual([{ inputId: input.inputId, content: "已执行引导" }]);
    expect((await ports.inputInbox.list({ sessionId: "s1" }))[0].status).toBe("consumed");
  });
});
