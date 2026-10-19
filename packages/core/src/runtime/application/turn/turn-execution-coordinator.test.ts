/**
 * Turn 事件合并回归测试：验证连续文本分片只改变持久化分片，不跨事件边界合并。
 */

import { expect, it, vi } from "vitest";
import type { AgentEvent } from "../../protocol";
import { createMemoryPorts } from "../../adapters/memory";
import { createAgentRuntime } from "../../public/create-agent-runtime";
import type { ModelSampler } from "../../../internal/kernel/model-sampler";
import { coalesceDeltaEvents } from "./turn-execution-coordinator";

/** 构造一个不含用户正文之外元数据的 answer delta。 */
function answerDelta(delta: string, stepId = "step-1"): AgentEvent {
  return { type: "answer_delta", turnId: "turn-1", stepId, delta };
}

/** 收集合并器输出的事件序列。 */
async function collectEvents(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of coalesceDeltaEvents(source)) events.push(event);
  return events;
}

it("合并同一 turn/step/type 的连续 delta，并在其他事件前 flush", async function mergesAdjacentDeltas() {
  async function* source(): AsyncGenerator<AgentEvent> {
    yield answerDelta("a");
    yield answerDelta("b");
    yield { type: "answer_reset", turnId: "turn-1", stepId: "step-1" };
    yield answerDelta("c", "step-2");
  }

  await expect(collectEvents(source())).resolves.toEqual([
    answerDelta("ab"),
    { type: "answer_reset", turnId: "turn-1", stepId: "step-1" },
    answerDelta("c", "step-2"),
  ]);
});

it("达到 4KiB 边界时先输出当前批次，再保留后续 delta", async function flushesAtByteLimit() {
  async function* source(): AsyncGenerator<AgentEvent> {
    yield answerDelta("a".repeat(4090));
    yield answerDelta("b".repeat(10));
  }

  await expect(collectEvents(source())).resolves.toEqual([
    answerDelta("a".repeat(4090)),
    answerDelta("b".repeat(10)),
  ]);
});

it("Runtime 异常前先 flush 尚未持久化的 delta", async function flushesBeforeSourceError() {
  async function* source(): AsyncGenerator<AgentEvent> {
    yield answerDelta("before-error");
    throw new Error("source failed");
  }

  const iterator = coalesceDeltaEvents(source());
  await expect(iterator.next()).resolves.toEqual({ value: answerDelta("before-error"), done: false });
  await expect(iterator.next()).rejects.toThrow("source failed");
});

/** 建立一个可产生固定完成事件的 durable Runtime。 */
async function createDurableRuntimeForPersistenceOrder() {
  const ports = createMemoryPorts();
  const sessionId = "session-persistence-order";
  await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: 1, updatedAt: 1 });
  const sampler: ModelSampler = {
    async sample() {
      return { content: "done", reasoningSummary: "", toolCalls: [] };
    },
  };
  return { ports, sessionId, runtime: createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "auto_approve", modelSampler: sampler } }) };
}

it("durable 事件先追加 Transcript 再通知 EventSink", async function persistsBeforePublishing() {
  const { ports, sessionId, runtime } = await createDurableRuntimeForPersistenceOrder();
  const order: string[] = [];
  const transcriptAppend = ports.transcriptStore.append.bind(ports.transcriptStore);
  const eventSinkWrite = ports.eventSink.write.bind(ports.eventSink);
  vi.spyOn(ports.transcriptStore, "append").mockImplementation(async function appendTranscript(...args) {
    order.push("transcript");
    await transcriptAppend(...args);
  });
  vi.spyOn(ports.eventSink, "write").mockImplementation(async function writeEvent(...args) {
    order.push("event-sink");
    await eventSinkWrite(...args);
  });

  const events: AgentEvent[] = [];
  for await (const event of runtime.turns.start({ sessionId, turnId: "turn-persistence-order", content: "hello" })) events.push(event);

  expect(events.some((event) => event.type === "turn_completed")).toBe(true);
  expect(order.length).toBeGreaterThan(0);
  expect(order.filter((item) => item === "transcript").length).toBe(order.filter((item) => item === "event-sink").length);
  for (let index = 0; index < order.length; index += 2) expect(order.slice(index, index + 2)).toEqual(["transcript", "event-sink"]);
});

it("Transcript 追加失败时不提前通知 durable EventSink", async function doesNotPublishBeforeTranscriptFailure() {
  const { ports, sessionId, runtime } = await createDurableRuntimeForPersistenceOrder();
  const order: string[] = [];
  vi.spyOn(ports.transcriptStore, "append").mockImplementation(async function rejectTranscript() {
    order.push("transcript");
    throw new Error("TRANSCRIPT_WRITE_FAILED");
  });
  vi.spyOn(ports.eventSink, "write").mockImplementation(async function writeEvent() {
    order.push("event-sink");
  });

  await expect((async function collectEvents() {
    const events: AgentEvent[] = [];
    for await (const event of runtime.turns.start({ sessionId, turnId: "turn-persistence-failure", content: "hello" })) events.push(event);
    return events;
  })()).rejects.toThrow("TRANSCRIPT_WRITE_FAILED");
  expect(order).toEqual(["transcript"]);
});
