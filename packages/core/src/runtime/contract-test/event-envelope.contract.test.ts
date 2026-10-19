/**
 * runtime/contract-test/event-envelope.contract.test.ts — Event Envelope 契约测试
 *
 * 验证 createEventEnvelope 工厂：
 * - 输出形状正确（seq / sessionId / turnId / timestamp / event）
 * - event 字段不被破坏
 * - seq 单调递增（由调用方保证，工厂只透传）
 */

import { describe, it, expect } from "vitest";
import { createEventEnvelope } from "../protocol";
import type { AgentEvent } from "../protocol";

describe("createEventEnvelope contract test", function envelopeContractSuite() {
  it("输出形状正确，event 字段不被破坏", function shapeCorrect() {
    const event = { type: "turn_started", turnId: "t1" } as unknown as AgentEvent;
    const envelope = createEventEnvelope({
      seq: 1,
      sessionId: "s1",
      turnId: "t1",
      timestamp: "2026-08-02T03:00:00.000Z",
      event,
    });

    expect(envelope.seq).toBe(1);
    expect(envelope.sessionId).toBe("s1");
    expect(envelope.turnId).toBe("t1");
    expect(envelope.timestamp).toBe("2026-08-02T03:00:00.000Z");
    expect(envelope.event).toBe(event);
    expect((envelope.event as Record<string, unknown>).type).toBe("turn_started");
  });

  it("不同 seq 的 envelope 互不干扰", function independentEnvelopes() {
    const event1 = { type: "turn_started" } as unknown as AgentEvent;
    const event2 = { type: "turn_completed" } as unknown as AgentEvent;

    const envelope1 = createEventEnvelope({
      seq: 1,
      sessionId: "s1",
      turnId: "t1",
      timestamp: "2026-08-02T03:00:00.000Z",
      event: event1,
    });
    const envelope2 = createEventEnvelope({
      seq: 2,
      sessionId: "s1",
      turnId: "t1",
      timestamp: "2026-08-02T03:00:01.000Z",
      event: event2,
    });

    expect(envelope1.seq).toBe(1);
    expect(envelope2.seq).toBe(2);
    expect((envelope1.event as Record<string, unknown>).type).toBe("turn_started");
    expect((envelope2.event as Record<string, unknown>).type).toBe("turn_completed");
  });

  it("timestamp 透传，不做格式校验（由调用方保证 ISO 8601）", function timestampPassthrough() {
    const envelope = createEventEnvelope({
      seq: 1,
      sessionId: "s1",
      turnId: "t1",
      timestamp: "custom-timestamp",
      event: { type: "turn_started" } as unknown as AgentEvent,
    });

    expect(envelope.timestamp).toBe("custom-timestamp");
  });
});
