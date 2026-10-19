/**
 * todo_write 工具与 Kernel：验证 schema 约束、自动允许与仅成功后发 todo_updated。
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentRuntime, type AgentLoopEvent } from "../../agent-runtime";
import { createTodoWriteTool } from "./todo-write-tool";
import { ToolRegistry } from "../tool-registry";
import type { AgentToolDefinition } from "../types";
import { createAgentKernel } from "../../kernel/agent-kernel";
import { sanitizeEventForExternal } from "../../../runtime/protocol/sanitize-checkpoint";
import { createAgentTextMessage, getAgentMessageText } from "../../types/agent-message";

/** 收集异步事件流，便于断言事件边界。 */
async function collectEvents(events: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const collected: AgentLoopEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

/** 构造单个待办项；默认 pending。 */
function createTodo(overrides: Partial<{ content: string; activeForm: string; status: string }> = {}) {
  return {
    content: overrides.content ?? "分析需求",
    activeForm: overrides.activeForm ?? "正在分析需求",
    status: overrides.status ?? "pending",
  };
}

/** 创建会依次返回固定采样结果的 mock sampler。 */
function createSampler(results: Array<{ content: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; reasoningSummary: string }>) {
  const sample = vi.fn(async function sampleModel(..._args: unknown[]) {
    const result = results.shift();
    if (!result) throw new Error("缺少 mock 采样结果");
    return result;
  });
  return { sample };
}

/** 直接执行一次 kernel 流，返回全部事件。 */
async function runKernel(toolCalls: Array<{ id: string; name: string; input: unknown }>): Promise<AgentLoopEvent[]> {
  const registry = new ToolRegistry();
  registry.register(createTodoWriteTool());
  const sampler = createSampler([
    { content: "", toolCalls, reasoningSummary: "维护任务链" },
    { content: "已完成。", toolCalls: [], reasoningSummary: "完成" },
  ]);
  return collectEvents(createAgentKernel({ turnId: "turn-1", messages: [createAgentTextMessage("user", "请执行任务")], toolRegistry: registry, permissionContext: { mode: "ask" }, modelSampler: sampler }).run());
}

/** 执行 Stage 5 的确定性模型行为脚本，验证 Kernel 不会丢失或重排 Todo 更新。 */
async function runBehaviorMatrix(results: Array<{ content: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; reasoningSummary: string }>, includeFailingVerifier = false): Promise<AgentLoopEvent[]> {
  const registry = new ToolRegistry();
  registry.register(createTodoWriteTool());
  if (includeFailingVerifier) {
    const verifier: AgentToolDefinition<Record<string, never>, Record<string, never>> = {
      name: "verify_step",
      description: "测试专用失败验证工具。",
      inputSchema: z.object({}).strict(),
      metadata: { effect: "none", destructive: false, concurrency: { max: 1, resourceKey: "test:verify" }, retry: { safe: false } },
      /** 测试工具不需要审批，只用于制造确定性的验证失败。 */
      createActionFacts() {
        return { toolName: "verify_step", effect: "none", destructive: false, operation: "verify_step" };
      },
      /** 始终失败，验证 Todo 不应因此被脚本提前标记完成。 */
      async execute() {
        throw new Error("验证失败");
      },
      /** 测试工具成功时原样序列化；当前失败场景不会抵达此分支。 */
      serializeOutput(output) {
        return output;
      },
    };
    registry.register(verifier);
  }
  const sampler = createSampler(results);
  return collectEvents(createAgentKernel({
    turnId: "turn-behavior-matrix",
    messages: [createAgentTextMessage("user", "执行测试场景")],
    toolRegistry: registry,
    permissionContext: { mode: "ask" },
    modelSampler: sampler,
  }).run());
}

describe("todo_write 工具", function todoWriteToolSuite() {
  it("默认 Runtime 始终注册 todo_write，不需要 capability", function registersByDefault() {
    const runtime = createAgentRuntime();
    expect(runtime.getToolDefinitions().some(function isTodoWrite(tool) { return tool.name === "todo_write"; })).toBe(true);
  });

  it("模型描述与 system 策略对齐，包含使用、跳过、更新与完成限制边界", function instructsUsagePolicy() {
    const tool = createTodoWriteTool();
    expect(tool.description).toContain("整表替换");
    expect(tool.description).toContain("复杂多阶段");
    expect(tool.description).toContain("只读多阶段也适用");
    expect(tool.description).toContain("简单问答");
    expect(tool.description).toContain("难以判断时使用");
    expect(tool.description).toContain("立即标 completed");
    expect(tool.description).toContain("恰好一项 in_progress");
    expect(tool.description).toContain("不得把对应项标为 completed");
  });

  it("简单任务的确定性脚本不调用 todo_write", async function skipsTodoForSimpleTaskFixture() {
    const events = await runBehaviorMatrix([
      { content: "这是简单任务的直接回答。", toolCalls: [], reasoningSummary: "直接回答" },
    ]);

    expect(events.some(function isTodoUpdated(event) { return event.type === "todo_updated"; })).toBe(false);
    expect(events.some(function isCompleted(event) { return event.type === "turn_completed"; })).toBe(true);
  });

  it("复杂任务的确定性脚本逐阶段更新并在验证后完成", async function preservesProgressiveTodoUpdates() {
    const first = [
      createTodo({ content: "分析需求", activeForm: "正在分析需求", status: "in_progress" }),
      createTodo({ content: "实施修改", activeForm: "正在实施修改", status: "pending" }),
      createTodo({ content: "验证结果", activeForm: "正在验证结果", status: "pending" }),
    ];
    const second = first.map(function advanceToImplementation(todo, index) {
      return { ...todo, status: index === 0 ? "completed" : index === 1 ? "in_progress" : "pending" };
    });
    const third = first.map(function advanceToVerification(todo, index) {
      return { ...todo, status: index < 2 ? "completed" : "in_progress" };
    });
    const completed = first.map(function completeTodo(todo) { return { ...todo, status: "completed" }; });
    const events = await runBehaviorMatrix([
      { content: "", toolCalls: [{ id: "todo-1", name: "todo_write", input: { todos: first } }], reasoningSummary: "开始" },
      { content: "", toolCalls: [{ id: "todo-2", name: "todo_write", input: { todos: second } }], reasoningSummary: "进入实施" },
      { content: "", toolCalls: [{ id: "todo-3", name: "todo_write", input: { todos: third } }], reasoningSummary: "进入验证" },
      { content: "", toolCalls: [{ id: "todo-4", name: "todo_write", input: { todos: completed } }], reasoningSummary: "验证通过" },
      { content: "任务已完成。", toolCalls: [], reasoningSummary: "收口" },
    ]);
    const updates = events.filter(function isTodoUpdated(event): event is Extract<AgentLoopEvent, { type: "todo_updated" }> { return event.type === "todo_updated"; });

    expect(updates.map(function getStatuses(event) { return event.todos.map(function getStatus(todo) { return todo.status; }); })).toEqual([
      ["in_progress", "pending", "pending"],
      ["completed", "in_progress", "pending"],
      ["completed", "completed", "in_progress"],
      ["completed", "completed", "completed"],
    ]);
  });

  it("发现新项且验证失败时保持未完成状态", async function keepsFailedVerificationOpen() {
    const initial = [createTodo({ content: "实施修改", activeForm: "正在实施修改", status: "in_progress" })];
    const discovered = [
      createTodo({ content: "实施修改", activeForm: "正在实施修改", status: "completed" }),
      createTodo({ content: "修复验证问题", activeForm: "正在修复验证问题", status: "in_progress" }),
    ];
    const events = await runBehaviorMatrix([
      { content: "", toolCalls: [{ id: "todo-1", name: "todo_write", input: { todos: initial } }], reasoningSummary: "开始" },
      { content: "", toolCalls: [{ id: "verify-1", name: "verify_step", input: {} }], reasoningSummary: "验证" },
      { content: "", toolCalls: [{ id: "todo-2", name: "todo_write", input: { todos: discovered } }], reasoningSummary: "发现问题" },
      { content: "验证仍失败，任务未完成。", toolCalls: [], reasoningSummary: "报告阻塞" },
    ], true);
    const updates = events.filter(function isTodoUpdated(event): event is Extract<AgentLoopEvent, { type: "todo_updated" }> { return event.type === "todo_updated"; });
    const verification = events.find(function isVerifierResult(event) { return event.type === "tool_result" && event.toolName === "verify_step"; });

    expect(verification?.type === "tool_result" && verification.result.status).toBe("error");
    expect(updates.at(-1)?.todos).toEqual(discovered);
    expect(updates.at(-1)?.counts).toEqual({ pending: 0, inProgress: 1, completed: 1 });
  });

  it("接受 0、1、20 项整表提交并计算 counts", function acceptsValidLists() {
    const schema = createTodoWriteTool().inputSchema;
    expect(schema.safeParse({ todos: [] }).success).toBe(true);
    expect(schema.safeParse({ todos: [createTodo({ status: "in_progress" })] }).success).toBe(true);
    const twenty = Array.from({ length: 20 }, function createItem(_value, index) {
      return createTodo({ content: `步骤 ${index + 1}`, activeForm: `正在执行步骤 ${index + 1}`, status: index === 0 ? "in_progress" : "pending" });
    });
    expect(schema.safeParse({ todos: twenty }).success).toBe(true);
  });

  it("拒绝 21 项、重复 content、空文本与未知字段", function rejectsInvalidLists() {
    const schema = createTodoWriteTool().inputSchema;
    const twentyOne = Array.from({ length: 21 }, function createItem(_value, index) {
      return createTodo({ content: `步骤 ${index + 1}`, status: index === 0 ? "in_progress" : "pending" });
    });
    expect(schema.safeParse({ todos: twentyOne }).success).toBe(false);
    expect(schema.safeParse({ todos: [createTodo({ status: "in_progress" }), createTodo({ content: "分析需求", status: "pending" })] }).success).toBe(false);
    expect(schema.safeParse({ todos: [createTodo({ content: "   ", status: "in_progress" })] }).success).toBe(false);
    expect(schema.safeParse({ todos: [createTodo({ status: "in_progress" }), { content: "执行修改", status: "pending" }] }).success).toBe(false);
    expect(schema.safeParse({ todos: [createTodo({ status: "in_progress" }), { ...createTodo({ content: "执行修改" }), extra: "字段" }] }).success).toBe(false);
  });

  it("拒绝绝对路径与凭据片段进入公开 Todo 事件", function rejectsUnsafeTodoText() {
    const schema = createTodoWriteTool().inputSchema;

    expect(schema.safeParse({ todos: [createTodo({ content: "读取 C:\\Users\\example-user\\secret", status: "in_progress" })] }).success).toBe(false);
    expect(schema.safeParse({ todos: [createTodo({ activeForm: "处理 api_key=fake-secret", status: "in_progress" })] }).success).toBe(false);
  });

  it("存在未完成项时必须恰好一个 in_progress；全 completed 允许 0 个", function enforcesSingleActive() {
    const schema = createTodoWriteTool().inputSchema;
    expect(schema.safeParse({ todos: [createTodo(), createTodo({ content: "执行修改", activeForm: "正在执行修改" })] }).success).toBe(false);
    expect(schema.safeParse({ todos: [createTodo({ status: "in_progress" }), createTodo({ content: "执行修改", activeForm: "正在执行修改", status: "in_progress" })] }).success).toBe(false);
    expect(schema.safeParse({ todos: [createTodo({ status: "completed" }), createTodo({ content: "执行修改", activeForm: "正在执行修改", status: "completed" })] }).success).toBe(true);
  });

  it("成功调用后发出带 todos 与 counts 的 todo_updated，且不需审批", async function emitsEventOnSuccess() {
    const events = await runKernel([{ id: "todo-1", name: "todo_write", input: { todos: [
      createTodo({ content: "分析需求", activeForm: "正在分析需求", status: "completed" }),
      createTodo({ content: "执行修改", activeForm: "正在执行修改", status: "in_progress" }),
      createTodo({ content: "验证结果", activeForm: "正在验证结果" }),
    ] } }]);
    const updated = events.find(function isTodoUpdated(event) { return event.type === "todo_updated"; });

    expect(updated).toMatchObject({
      turnId: "turn-1",
      todos: [
        { content: "分析需求", status: "completed" },
        { content: "执行修改", status: "in_progress" },
        { content: "验证结果", status: "pending" },
      ],
      counts: { pending: 1, inProgress: 1, completed: 1 },
    });
    expect(events.some(function isApprovalRequired(event) { return event.type === "approval_required"; })).toBe(false);
    expect(events.some(function isTurnCompleted(event) { return event.type === "turn_completed"; })).toBe(true);
  });

  it("清空列表发出空 todos 与全零 counts 的 todo_updated", async function emitsClearEvent() {
    const events = await runKernel([{ id: "todo-1", name: "todo_write", input: { todos: [] } }]);
    const updated = events.find(function isTodoUpdated(event) { return event.type === "todo_updated"; });

    expect(updated).toMatchObject({ todos: [], counts: { pending: 0, inProgress: 0, completed: 0 } });
  });

  it("schema 失败时工具报错且不发出 todo_updated", async function noEventOnFailure() {
    const events = await runKernel([{ id: "todo-1", name: "todo_write", input: { todos: [
      createTodo({ status: "in_progress" }),
      createTodo({ content: "执行修改", activeForm: "正在执行修改", status: "in_progress" }),
    ] } }]);
    const failed = events.find(function isTodoResult(event) { return event.type === "tool_result" && event.toolName === "todo_write"; });
    if (failed?.type !== "tool_result") throw new Error("todo_write 结果事件不存在");

    expect(failed.result.status).toBe("error");
    expect(events.some(function isTodoUpdated(event) { return event.type === "todo_updated"; })).toBe(false);
  });

  it("对外 tool_result 只保留 Todo counts，完整列表只走 todo_updated", function redactsTodoToolOutput() {
    const event = sanitizeEventForExternal({
      type: "tool_result",
      turnId: "turn-1",
      stepId: "step-1",
      callId: "todo-1",
      toolName: "todo_write",
      retryCount: 0,
      summary: "Todo 0/1",
      result: {
        status: "success",
        callId: "todo-1",
        toolName: "todo_write",
        output: { todos: [createTodo({ content: "内部任务", status: "in_progress" })], counts: { pending: 0, inProgress: 1, completed: 0 } },
        meta: { durationMs: 1, inputHash: "todo-test" },
      },
    });

    if (event.type !== "tool_result" || event.result.status !== "success") throw new Error("Todo 工具结果类型不正确");
    expect(event.result.output).toEqual({ counts: { pending: 0, inProgress: 1, completed: 0 } });
  });

  it("消费 steer 后自动压缩仍保留 Todo 快照", async function preservesSnapshotAcrossSteerAndCompaction() {
    const registry = new ToolRegistry();
    registry.register(createTodoWriteTool());
    const sampler = createSampler([
      { content: "", toolCalls: [{ id: "todo-1", name: "todo_write", input: { todos: [createTodo({ status: "in_progress" })] } }], reasoningSummary: "建表" },
      { content: "已恢复执行", toolCalls: [], reasoningSummary: "完成" },
    ]);
    let compacted = false;
    const events = await collectEvents(createAgentKernel({
      turnId: "turn-steer-compact",
      messages: [createAgentTextMessage("user", "执行复杂任务")],
      toolRegistry: registry,
      permissionContext: { mode: "ask" },
      modelSampler: sampler,
      inputInbox: {
        async drain(input) {
          return input.boundary === "after_tools" ? [{ inputId: "steer-1", content: "继续下一阶段" }] : [];
        },
      },
      contextCompaction: {
        shouldCompact(input) {
          return !compacted && input.messages.some(function hasTodoResult(message) {
            return message.role === "user" && message.content[0]?.type === "tool-result" && message.content[0].toolCallId === "todo-1";
          });
        },
        async compact() {
          compacted = true;
          return { outcome: "changed", summary: "已压缩", messages: [createAgentTextMessage("system", "已压缩历史摘要：任务继续")], preTokens: 100, postTokens: 10, preservedFromIndex: 2 };
        },
      },
    }).run());

    const resumedMessages = sampler.sample.mock.calls.at(1)?.[0] as unknown as import("../../types/agent-message").AgentMessage[] | undefined;
    if (!resumedMessages) throw new Error("第二次采样消息不存在");
    expect(events.some(function consumesSteer(event) { return event.type === "input_consumed" && event.inputId === "steer-1"; })).toBe(true);
    expect(resumedMessages.some(function containsTodoReminder(message) { return message.role === "system" && getAgentMessageText(message).includes("【Todo 快照】"); })).toBe(true);
    expect(resumedMessages.some(function containsSteer(message) { return message.role === "user" && getAgentMessageText(message) === "继续下一阶段"; })).toBe(false);
  });
});
