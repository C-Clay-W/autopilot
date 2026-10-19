/** Stage 4 /context 与 /compact 的 Controller 契约回归。 */

import { AgentRuntimeError, type AgentEvent } from "@autopilot-agent/core";
import { describe, expect, it } from "vitest";
import { createCliController } from "../../src/controller.js";
import { createPlainRenderer } from "../../src/renderer.js";
import type { CliRuntime } from "../../src/types.js";
import { createUsageFixture } from "./fixtures.js";

/** 构造测试用 AgentEvent，避免依赖 Kernel private 类型。 */
function asEvent(value: unknown): AgentEvent {
  return value as AgentEvent;
}

/** 将固定事件转换为异步事件流。 */
async function* eventStream(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const event of events) yield event;
}

describe("Stage 4 /context Controller 契约", function contextControllerSuite() {
  it("无 Runtime 时返回 capability-unavailable，不伪造报告", async function requiresRuntime() {
    const controller = createCliController({ renderer: createPlainRenderer("text"), sessionId: "session-1" });
    const result = await controller.dispatch({ type: "show_context", all: false });
    expect(result.kind).toBe("unavailable");
    expect(result.message).toBe("CAPABILITY_UNAVAILABLE: context_usage");
  });

  it("无 Session 时输出 Context: unknown 且 exit 0", async function unknownWithoutSession() {
    const controller = createCliController({ runtime: { turns: {} } as unknown as CliRuntime, renderer: createPlainRenderer("text") });
    const result = await controller.dispatch({ type: "show_context", all: false });
    expect(result.kind).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.lines).toEqual(["Context: unknown"]);
    expect(result.contextView).toEqual({ usage: null, expanded: false });
  });

  it("有 DTO 时输出稳定文本报告并附加专用 contextView", async function reportsUsage() {
    const usage = createUsageFixture();
    const runtime = {
      turns: {
        getContextUsage: async function getContextUsage(input: unknown) {
          expect(input).toEqual({ sessionId: "session-1" });
          return usage;
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });
    const result = await controller.dispatch({ type: "show_context", all: false });
    expect(result.kind).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toBe("Context Usage");
    expect(result.lines).toContain("model: gateway-a/claude-sonnet-4");
    expect(result.contextView).toEqual({ usage, expanded: false });
  });

  it("JSONL 模式只输出结构化安全 DTO 行", async function reportsJsonlDto() {
    const usage = createUsageFixture();
    const runtime = {
      turns: { getContextUsage: async function getContextUsage() { return usage; } },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("jsonl"), sessionId: "session-1" });
    const result = await controller.dispatch({ type: "show_context", all: true });
    expect(result.lines).toHaveLength(1);
    expect(JSON.parse(result.lines[0])).toEqual({ type: "context_usage_report", usage, expanded: true });
  });

  it("查询失败 fail closed 为 unknown，不伪造 0% 或猜测窗口", async function failsClosedToUnknown() {
    const runtime = {
      turns: {
        getContextUsage: async function getContextUsage(): Promise<null> {
          throw new AgentRuntimeError("SESSION_NOT_FOUND", "session missing");
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });
    const result = await controller.dispatch({ type: "show_context", all: false });
    expect(result.kind).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.lines).toEqual(["Context: unknown"]);
    expect(result.contextView).toEqual({ usage: null, expanded: false });
  });

  it("getStatusView 携带 contextUsage；runtime double 缺能力时省略字段", async function statusViewCarriesUsage() {
    const usage = createUsageFixture();
    const withUsage = {
      sessions: { get: async function getSession() { return { id: "session-1", defaultRunConfig: {} }; } },
      turns: { getContextUsage: async function getContextUsage() { return usage; } },
    } as unknown as CliRuntime;
    const enabled = createCliController({ runtime: withUsage, renderer: createPlainRenderer("text"), sessionId: "session-1" });
    expect((await enabled.getStatusView!()).contextUsage).toEqual(usage);

    const withoutUsage = {
      sessions: { get: async function getSession() { return { id: "session-1", defaultRunConfig: {} }; } },
      turns: {},
    } as unknown as CliRuntime;
    const disabled = createCliController({ runtime: withoutUsage, renderer: createPlainRenderer("text"), sessionId: "session-1" });
    expect((await disabled.getStatusView!()).contextUsage).toBeUndefined();
  });
});

describe("Stage 4 /compact 显式 outcome 契约", function compactOutcomeSuite() {
  it("changed 输出 estimated 标注的压缩前后值", async function reportsChangedCompact() {
    const compacts: unknown[] = [];
    const runtime = {
      turns: {
        start: function start() {
          return eventStream([asEvent({ type: "turn_started", turnId: "turn-1", stepCount: 0 })]);
        },
        compact: async function compact(input: unknown) {
          compacts.push(input);
          return { outcome: "changed", summary: "compacted", messages: [], preTokens: 120000, postTokens: 52000, preservedFromIndex: 1 };
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });
    await controller.dispatch({ type: "submit_prompt", content: "hello" });
    const result = await controller.dispatch({ type: "compact" });
    expect(result.kind).toBe("ok");
    expect(result.lines).toEqual(["context compacted: estimated 120000 -> 52000"]);
    expect(compacts).toEqual([{ sessionId: "session-1", turnId: "turn-1", trigger: "manual" }]);
  });

  it("skipped 输出投影未变化原因与当前 estimated 值", async function reportsSkippedCompact() {
    const runtime = {
      turns: {
        start: function start() {
          return eventStream([asEvent({ type: "turn_started", turnId: "turn-1", stepCount: 0 })]);
        },
        compact: async function compact() {
          return { outcome: "skipped", reason: "no_compactable_history", summary: "", messages: [], preTokens: 120000, postTokens: 120000 };
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });
    await controller.dispatch({ type: "submit_prompt", content: "hello" });
    const result = await controller.dispatch({ type: "compact" });
    expect(result.kind).toBe("ok");
    expect(result.lines).toEqual(["context compact skipped: no compactable history; projection unchanged (estimated 120000 tokens)"]);
  });

  it("活动 Turn 中 manual compact 显示 TURN_ALREADY_RUNNING 明确拒绝", async function rejectsWhileTurnRunning() {
    const runtime = {
      turns: {
        start: function start() {
          return eventStream([asEvent({ type: "turn_started", turnId: "turn-1", stepCount: 0 })]);
        },
        compact: async function compact(): Promise<never> {
          throw new AgentRuntimeError("TURN_ALREADY_RUNNING", "turn is still running");
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });
    await controller.dispatch({ type: "submit_prompt", content: "hello" });
    const result = await controller.dispatch({ type: "compact" });
    expect(result.kind).toBe("error");
    expect(result.exitCode).toBe(1);
    expect(result.message).toBe("TURN_ALREADY_RUNNING: 当前 Turn 仍在运行，请等待结束或中断后再压缩");
  });
});
