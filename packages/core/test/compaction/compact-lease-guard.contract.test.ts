/** Step 5：manual compact 的跨进程 lease 守卫契约测试，不连接真实 Provider。 */

import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../../src/runtime/public/create-agent-runtime";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import type { AgentLoopEvent } from "../../src/internal/agent-runtime";
import type { AgentMessage } from "../../src/internal/types/agent-message";

/** 读取 canonical 消息中的普通文本，供摘要 sampler 识别摘要请求。 */
function getMessageText(message: AgentMessage | undefined): string {
  return message?.content.filter(function isTextBlock(block) { return block.type === "text"; }).map(function readTextBlock(block) { return block.text; }).join("") ?? "";
}

/** 创建确定性摘要 sampler：摘要调用返回固定摘要，正常采样挂起直到取消。 */
function createGuardSampler(hang: boolean) {
  return {
    async sample(messages: AgentMessage[], tools: unknown[], _options: { signal?: AbortSignal }, onDelta?: (delta: string) => void) {
      const isSummary = tools.length === 0 && getMessageText(messages[0]).includes("上下文压缩器");
      if (isSummary) return { content: "守卫摘要", toolCalls: [], reasoningSummary: "summary", finishReason: "stop" };
      if (!hang) {
        onDelta?.("完成");
        return { content: "完成", toolCalls: [], reasoningSummary: "answer", finishReason: "stop" };
      }
      // 挂起采样保持 Turn 活动，使本进程成为 lease owner；取消信号到达后返回以收口事件流。
      await new Promise<void>((resolve) => {
        const signal = _options.signal;
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { content: "已取消", toolCalls: [], reasoningSummary: "cancelled", finishReason: "stop" };
    },
  };
}

/** 建立 durable Session。 */
async function seedSession(ports: ReturnType<typeof createMemoryPorts>, id: string): Promise<void> {
  await ports.sessionStore.save({ id, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
}

/** 构造三条完整 user turn 的消息，供 compact 摘要旧回合。 */
function seedMessages() {
  return [
    { role: "user" as const, content: [{ type: "text" as const, text: "第一轮问题" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "第一轮回答" }] },
    { role: "user" as const, content: [{ type: "text" as const, text: "第二轮问题" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "第二轮回答" }] },
    { role: "user" as const, content: [{ type: "text" as const, text: "第三轮问题" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "第三轮回答" }] },
  ];
}

describe("Step 5 compact lease guard", function compactLeaseGuardSuite() {
  it("其他进程持有新鲜 lease 时 compact 被拒绝", async function rejectsContenderCompact() {
    const ports = createMemoryPorts();
    const sessionId = "step5-guard-fresh";
    const turnId = "step5-guard-fresh-turn";
    await seedSession(ports, sessionId);
    await ports.checkpointStore.save(sessionId, {
      turnId,
      status: "running",
      stepCount: 0,
      messages: seedMessages(),
      completedCallIds: [],
      lease: { leaseId: "lease-guard", ownerId: "owner-other", heartbeatAt: Date.now(), safeBoundarySeq: 1 },
    });
    // CR 边界：checkpoint 来源 Turn 必须真实存在并带新边界签发字段，否则 compact 前置门按旧来源拒绝。
    await ports.turnStore.save({ id: turnId, sessionId, status: "running", frozenRunConfig: { workContextVersion: 1, capabilityCeiling: { productMode: "work" } }, startedAt: Date.now(), schemaVersion: 2 });
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "auto_approve", modelSampler: createGuardSampler(false) } });
    await expect(
      runtime.turns.compact({ sessionId, turnId, trigger: "manual", messages: seedMessages(), preserveRecentTurns: 1, targetTokens: 10_000, sampler: createGuardSampler(false) }),
    ).rejects.toMatchObject({ code: "TURN_ALREADY_RUNNING" });
  });

  it("lease 过期后 compact 允许执行", async function allowsAfterStaleLease() {
    const ports = createMemoryPorts();
    const sessionId = "step5-guard-stale";
    const turnId = "step5-guard-stale-turn";
    await seedSession(ports, sessionId);
    await ports.checkpointStore.save(sessionId, {
      turnId,
      status: "running",
      stepCount: 0,
      messages: seedMessages(),
      completedCallIds: [],
      lease: { leaseId: "lease-guard-stale", ownerId: "owner-other", heartbeatAt: Date.now() - 46_000, safeBoundarySeq: 1 },
    });
    await ports.turnStore.save({ id: turnId, sessionId, status: "running", frozenRunConfig: { workContextVersion: 1, capabilityCeiling: { productMode: "work" } }, startedAt: Date.now(), schemaVersion: 2 });
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "auto_approve", modelSampler: createGuardSampler(false) } });
    const result = await runtime.turns.compact({ sessionId, turnId, trigger: "manual", messages: seedMessages(), preserveRecentTurns: 1, targetTokens: 10_000, sampler: createGuardSampler(false) });
    expect(result.summary).toContain("守卫摘要");
  });

  it("lease owner 本进程活动 Turn 期间可以 compact", async function allowsOwnerCompact() {
    const ports = createMemoryPorts();
    const sessionId = "step5-guard-owner";
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "auto_approve", modelSampler: createGuardSampler(true) } });
    const events: AgentLoopEvent[] = [];
    const streamDone = (async () => {
      for await (const event of runtime.turns.start({ sessionId, content: "挂起采样" })) events.push(event);
    })();
    // 等待初始 checkpoint 带新鲜 lease 落盘后再以 owner 身份 compact。
    await new Promise<void>((resolve) => {
      const timer = setInterval(async () => {
        const checkpoint = await ports.checkpointStore.getLatest(sessionId);
        if (checkpoint?.lease) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    const turnId = (await ports.checkpointStore.getLatest(sessionId))!.turnId;
    const result = await runtime.turns.compact({ sessionId, turnId, trigger: "manual", messages: seedMessages(), preserveRecentTurns: 1, targetTokens: 10_000, sampler: createGuardSampler(false) });
    expect(result.summary).toContain("守卫摘要");
    await runtime.turns.cancel({ sessionId, turnId });
    await streamDone;
  });
});
