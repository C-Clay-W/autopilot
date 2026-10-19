/** Todo 连续上下文契约测试：验证 claimed queue 注入快照、普通新 Turn 隔离、reminder 不累积。 */
import { describe, it, expect } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime } from "../public/create-agent-runtime";
import type { AgentLoopEvent } from "../../internal/agent-runtime";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import { createAgentTextMessage, getAgentMessageText, type AgentMessage } from "../../internal/types/agent-message";

/** 把事件流收集为数组。 */
async function collectEvents(generator: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** 创建并保存一个测试 Session。 */
async function seedSession(ports: ReturnType<typeof createMemoryPorts>, sessionId: string) {
  await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
}

/** 构造记录每次采样消息的 mock 采样器。 */
function createRecordingSampler(results: Array<{ content: string; toolCalls?: unknown[] }>) {
  const sampledMessages: AgentMessage[][] = [];
  const sampler: ModelSampler = {
    async sample(messages) {
      sampledMessages.push(messages.map(function clone(message) { return { ...message }; }));
      const result = results.shift();
      if (!result) throw new Error("缺少 mock 采样结果");
      return { content: result.content, toolCalls: (result.toolCalls ?? []) as any, reasoningSummary: "mock", finishReason: "stop" };
    },
  };
  return { sampler, sampledMessages };
}

describe("Todo continuity contract test", function todoContinuityContractSuite() {
  it("claimed queue 连续 Turn 注入最近 Todo 快照，普通新 Turn 不注入且 reminder 不跨 Turn 累积", async function injectsSnapshotOnlyForClaimedQueue() {
    const ports = createMemoryPorts();
    const sessionId = "todo-continuity";
    await seedSession(ports, sessionId);
    const { sampler, sampledMessages } = createRecordingSampler([
      { content: "", toolCalls: [{ id: "call-1", name: "todo_write", input: { todos: [
        { content: "分析需求", activeForm: "正在分析需求", status: "completed" },
        { content: "执行修改", activeForm: "正在执行修改", status: "in_progress" },
      ] } }] },
      { content: "首轮完成" },
      { content: "次轮完成" },
      { content: "普通新任务完成" },
      { content: "队列任务完成" },
    ]);
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelRef: { provider: "deepseek", modelId: "deepseek-v4-flash" }, modelSampler: sampler } });

    // 第一轮：写入 Todo，产生 durable todo_updated 事件。
    const firstTurnEvents = await collectEvents(runtime.turns.start({ sessionId, content: "首轮" }));
    expect(firstTurnEvents.some(function isTodoUpdated(event) { return event.type === "todo_updated"; })).toBe(true);

    // 第二轮：claimed queue 连续路径注入快照 reminder。
    await collectEvents(runtime.turns.start({ sessionId, content: "次轮", continuity: { source: "claimed_queue" } }));
    const queueMessages = sampledMessages[2];
    const reminder = queueMessages.filter(function isReminder(message) { return message.role === "system" && getAgentMessageText(message).includes("【Todo 快照】"); });
    expect(reminder).toHaveLength(1);
    expect(getAgentMessageText(reminder[0])).toContain("[completed] 分析需求");
    expect(getAgentMessageText(reminder[0])).toContain("[in_progress] 执行修改 —— 正在执行修改");

    // 第三轮：普通新 Turn 创建独立任务链，不注入旧 Todo。
    await collectEvents(runtime.turns.start({ sessionId, content: "普通新任务" }));
    const normalMessages = sampledMessages[3];
    expect(normalMessages.filter(function isReminder(message) { return getAgentMessageText(message).includes("【Todo 快照】"); })).toHaveLength(0);

    // 第四轮：普通新任务的 claimed queue 只能继承第三轮任务链，不能复活首轮 Todo。
    await collectEvents(runtime.turns.start({ sessionId, content: "队列任务", continuity: { source: "claimed_queue" } }));
    const queuedAfterNormalMessages = sampledMessages[4];
    expect(queuedAfterNormalMessages.filter(function isReminder(message) { return getAgentMessageText(message).includes("【Todo 快照】"); })).toHaveLength(0);
  });

  it("Session 无 Todo 事件时 claimed queue 连续 Turn 也不注入 reminder", async function skipsInjectionWithoutSnapshot() {
    const ports = createMemoryPorts();
    const sessionId = "todo-continuity-empty";
    await seedSession(ports, sessionId);
    const { sampler, sampledMessages } = createRecordingSampler([{ content: "首轮完成" }, { content: "次轮完成" }]);
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelRef: { provider: "deepseek", modelId: "deepseek-v4-flash" }, modelSampler: sampler } });

    await collectEvents(runtime.turns.start({ sessionId, content: "首轮" }));
    await collectEvents(runtime.turns.start({ sessionId, content: "次轮", continuity: { source: "claimed_queue" } }));

    expect(sampledMessages[1].filter(function isReminder(message) { return message.role === "system" && getAgentMessageText(message).includes("【Todo 快照】"); })).toHaveLength(0);
  });

  it("压缩后 Continue 从 checkpoint Todo 快照恢复完整 reminder", async function restoresSnapshotAfterCompaction() {
    const ports = createMemoryPorts();
    const sessionId = "todo-continuity-continue";
    const turnId = "todo-continuity-continue-turn";
    await seedSession(ports, sessionId);
    const { sampler, sampledMessages } = createRecordingSampler([
      { content: "", toolCalls: [{ id: "call-1", name: "todo_write", input: { todos: [
        { content: "执行修改", activeForm: "正在执行修改", status: "in_progress" },
      ] } }] },
      { content: "恢复完成" },
    ]);
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelRef: { provider: "deepseek", modelId: "deepseek-v4-flash" }, modelSampler: sampler } });

    await collectEvents(runtime.turns.start({ sessionId, turnId, content: "首轮", runConfig: { maxSteps: 1 } }));
    const checkpoint = await ports.checkpointStore.getLatest(sessionId);
    if (!checkpoint?.todoSnapshot) throw new Error("Todo 快照未写入 checkpoint");
    await ports.checkpointStore.save(sessionId, { ...checkpoint, messages: [createAgentTextMessage("user", "压缩后的上下文")] });

    await collectEvents(runtime.turns.continue({ sessionId, turnId }));
    const restoredMessages = sampledMessages[1];
    expect(restoredMessages.filter(function isReminder(message) { return message.role === "system" && getAgentMessageText(message).includes("【Todo 快照】"); })).toHaveLength(1);
    expect(restoredMessages.some(function containsTodo(message) { return getAgentMessageText(message).includes("执行修改"); })).toBe(true);
  });
});
