/** Web Presentation 适配器回归测试：锁定 Live/History 共用 reducer、callId 与原始字段隔离。 */
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentEventEnvelope } from "@autopilot-agent/core";
import { selectAssistantAnswers, selectToolCalls } from "@autopilot-agent/presentation";
import { reduceWebPresentationEvent, reduceWebTransportEvent, replayWebPresentation } from "@/lib/runtime-host/web-presentation-adapter";

/** 用最小安全工具事件构造可持久化的 Runtime 信封。 */
function envelope(seq: number, event: Record<string, unknown>): AgentEventEnvelope {
  return {
    seq,
    sessionId: "session-web",
    turnId: "turn-web",
    timestamp: `2026-08-24T08:00:0${seq}.000Z`,
    event: event as AgentEvent,
  };
}

describe("web presentation adapter", function webPresentationAdapterSuite() {
  it("History 乱序回放与 Live reducer 生成同一安全状态", function replaysHistoryWithLiveReducer() {
    const events = [
      envelope(1, { type: "turn_started", turnId: "turn-web", stepCount: 0 }),
      envelope(2, { type: "tool_started", turnId: "turn-web", stepId: "step-1", callId: "call-read", toolName: "read_file", summary: "RAW_TOOL_START" }),
      envelope(3, { type: "tool_result", turnId: "turn-web", stepId: "step-1", callId: "call-read", toolName: "read_file", summary: "RAW_TOOL_RESULT", result: { status: "success", callId: "call-read", toolName: "read_file", output: "RAW_TOOL_OUTPUT", display: { titleKey: "tool.read.completed", target: "README.md", summary: "12 lines" } } }),
      envelope(4, { type: "answer_delta", turnId: "turn-web", stepId: "step-1", delta: "已读取文件。" }),
    ];
    const history = replayWebPresentation([events[3], events[1], events[0], events[2], events[2]]);
    const live = events.reduce(function reduceLive(state, item) {
      return reduceWebPresentationEvent(state, { sessionId: item.sessionId, turnId: item.turnId, seq: item.seq, timestamp: item.timestamp, ...item.event }, item.sessionId);
    }, replayWebPresentation([]));

    expect(selectAssistantAnswers(history, "turn-web")).toEqual(selectAssistantAnswers(live, "turn-web"));
    expect(selectToolCalls(history, "turn-web")).toEqual(selectToolCalls(live, "turn-web"));
    expect(JSON.stringify(history)).not.toContain("RAW_TOOL_START");
    expect(JSON.stringify(history)).not.toContain("RAW_TOOL_RESULT");
    expect(JSON.stringify(history)).not.toContain("RAW_TOOL_OUTPUT");
  });

  it("Host diagnostics 不会伪装为 Runtime 信封或推进 Turn seq", function ignoresHostDiagnostics() {
    const initial = replayWebPresentation([envelope(1, { type: "turn_started", turnId: "turn-web", stepCount: 0 })]);
    const next = reduceWebPresentationEvent(initial, { type: "context_diagnostic", turnId: "turn-web", diagnostics: ["safe"] }, "session-web");

    expect(next).toEqual(initial);
  });

  it("浏览器连接状态作为 Host 事件独立保存，不推进 Runtime seq", function keepsTransportOutsideTranscript() {
    const initial = replayWebPresentation([envelope(1, { type: "turn_started", turnId: "turn-web", stepCount: 0 })]);
    const next = reduceWebTransportEvent(initial, "disconnected");

    expect(next.transport).toBe("disconnected");
    expect(next.lastSeqByTurn["turn-web"]).toBe(1);
  });
});
