/**
 * runtime/contract-test/session-persistence.contract.test.ts — Session 持久化模式契约测试
 *
 * 验证 SessionPersistenceMode 真正生效：
 * - durable 模式正常写入 transcript / checkpoint
 * - ephemeral 模式跳过 transcript / checkpoint 持久化，但 eventSink 仍执行
 */

import { describe, it, expect } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime } from "../public/create-agent-runtime";
import type { AgentLoopEvent } from "../../internal/agent-runtime";
import type { ModelSampler } from "../../internal/kernel/model-sampler";

/** 把事件流收集为数组。 */
async function collectEvents(generator: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** 构造一个确定性 mock 采样器。 */
function createMockSampler(content: string): ModelSampler {
  return {
    sample: async (_messages, _tools, _options, onDelta) => {
      if (onDelta) {
        for (const char of content) onDelta(char);
      }
      return { content, toolCalls: [], reasoningSummary: "mock", finishReason: "stop" };
    },
  };
}

describe("Session persistence mode contract test", function persistenceContractSuite() {
  it("SessionService 支持兼容 ID 与列表查询", async function sessionListAndCompatibilityId() {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({ ports });

    const session = await runtime.sessions.create({ id: "compat-session-001", title: "兼容会话" });
    expect(session.id).toBe("compat-session-001");
    expect((await runtime.sessions.list()).map((item) => item.id)).toContain("compat-session-001");
  });

  it("SessionService 通过公共 API 重命名并拒绝空标题与超长标题", async function renamesSessionThroughPublicApi() {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({ ports });
    const session = await runtime.sessions.create({ id: "rename-session", title: "旧标题" });

    const renamed = await runtime.sessions.rename(session.id, "  新标题  ");
    expect(renamed.title).toBe("新标题");
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(session.updatedAt);
    await expect(runtime.sessions.rename(session.id, " ")).rejects.toMatchObject({ code: "SESSION_TITLE_INVALID" });
    await expect(runtime.sessions.rename(session.id, "x".repeat(201))).rejects.toMatchObject({ code: "SESSION_TITLE_INVALID" });
  });

  it("durable 模式写入 transcript 与 checkpoint", async function durableWrites() {
    const ports = createMemoryPorts();
    const sessionId = "durable-001";
    await ports.sessionStore.save({
      id: sessionId,
      persistenceMode: "durable",
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        modelSampler: createMockSampler("已完成。"),
        maxSteps: 8,
      },
    });

    const events = await collectEvents(
      runtime.turns.start({ sessionId, content: "请确认。" }),
    );
    expect(events.length).toBeGreaterThan(0);

    const transcript = await ports.transcriptStore.getEvents(sessionId);
    expect(transcript.length).toBe(events.length);

    const checkpoint = await ports.checkpointStore.getLatest(sessionId);
    expect(checkpoint).toBeDefined();

    const state = await runtime.turns.getState({ sessionId });
    expect(state.turn?.id).toBe(checkpoint?.turnId);
    expect(state.checkpoint?.turnId).toBe(checkpoint?.turnId);
  });

  it("ephemeral 模式跳过 transcript 与 checkpoint 持久化", async function ephemeralSkips() {
    const ports = createMemoryPorts();
    const sessionId = "ephemeral-001";
    await ports.sessionStore.save({
      id: sessionId,
      persistenceMode: "ephemeral",
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        modelSampler: createMockSampler("已完成。"),
        maxSteps: 8,
      },
    });

    const events = await collectEvents(
      runtime.turns.start({ sessionId, content: "请确认。" }),
    );
    expect(events.length).toBeGreaterThan(0);

    // ephemeral 模式跳过 transcript 持久化
    const transcript = await ports.transcriptStore.getEvents(sessionId);
    expect(transcript.length).toBe(0);

    // ephemeral 模式跳过 checkpoint 持久化
    const checkpoint = await ports.checkpointStore.getLatest(sessionId);
    expect(checkpoint).toBeNull();
  });
});
