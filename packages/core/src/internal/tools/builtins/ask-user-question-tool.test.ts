/**
 * AskUserQuestion 工具与 Kernel：验证 capability 注册、暂停和交互独占边界。
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentRuntime, type AgentLoopEvent } from "../../agent-runtime";
import { createAskUserQuestionTool } from "./ask-user-question-tool";
import { ToolRegistry } from "../tool-registry";
import { createAgentKernel } from "../../kernel/agent-kernel";
import type { AgentToolDefinition } from "../types";
import { createAgentTextMessage } from "../../types/agent-message";

/** 收集异步事件流，便于断言暂停边界。 */
async function collectEvents(events: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const collected: AgentLoopEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

/** 返回测试用的单题请求。 */
function createRequest() {
  return {
    requestId: "request-1",
    questions: [{
      id: "scope",
      header: "范围",
      question: "应完成哪个范围？",
      options: [
        { label: "最小修复", description: "仅处理当前问题" },
        { label: "完整实现", description: "完成所有计划项" },
      ],
    }],
  };
}

/** 创建会依次返回固定采样结果的 mock sampler。 */
function createSampler(results: Array<{ content: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; reasoningSummary: string; finishReason?: string }>) {
  const sample = vi.fn(async function sampleModel() {
    const result = results.shift();
    if (!result) throw new Error("缺少 mock 采样结果");
    return result;
  });
  return { sample };
}

/** 创建会记录是否真正执行的非交互测试工具。 */
function createWriteProbe(executed: { value: number }): AgentToolDefinition<{}, { ok: true }> {
  return {
    name: "write_probe",
    description: "测试写入工具",
    inputSchema: z.object({}).strict(),
    metadata: { effect: "workspace", destructive: false, concurrency: { max: 1 }, retry: { safe: false } },
    createActionFacts() { return { toolName: "write_probe", effect: "workspace", destructive: false, operation: "write_probe", requiresApproval: false }; },
    async execute() { executed.value += 1; return { ok: true }; },
    serializeOutput(output) { return output; },
  };
}

describe("AskUserQuestion 工具", function askUserQuestionToolSuite() {
  it("只在 capability 存在时注册模型工具", function registersOnlyWithCapability() {
    const hidden = createAgentRuntime();
    const visible = createAgentRuntime({ userQuestions: { async request() { return createRequest(); } } });
    expect(hidden.getToolDefinitions().some((tool) => tool.name === "ask_user_question")).toBe(false);
    expect(visible.getToolDefinitions().some((tool) => tool.name === "ask_user_question")).toBe(true);
  });

  it("要求模型将结合上下文判断的推荐方案放在第一项", function instructsRecommendedOptionFirst() {
    const tool = createAskUserQuestionTool({ async request() { return createRequest(); } });

    expect(tool.description).toContain("已知会话上下文");
    expect(tool.description).toContain("已获得的项目环境");
    expect(tool.description).toContain("推荐方案放在第一个选项");
    expect(tool.description).toContain("不要在 label 或 description 中添加“（推荐）”");
  });

  it("持久化请求后发出 question_required 并暂停同一 Turn", async function pausesForQuestion() {
    const registry = new ToolRegistry();
    registry.register(createAskUserQuestionTool({ async request() { return createRequest(); } }));
    const sampler = createSampler([{ content: "", toolCalls: [{ id: "ask-1", name: "ask_user_question", input: { questions: createRequest().questions } }], reasoningSummary: "需要确认范围" }]);
    const events = await collectEvents(createAgentKernel({ turnId: "turn-1", messages: [createAgentTextMessage("user", "请确认范围")], toolRegistry: registry, permissionContext: { mode: "auto_approve" }, modelSampler: sampler }).run());
    const question = events.find((event) => event.type === "question_required");
    const paused = events.find((event) => event.type === "turn_paused");

    expect(question).toMatchObject({ requestId: "request-1", callId: "ask-1" });
    expect(paused).toMatchObject({ checkpoint: { status: "awaiting_user_input", pendingCalls: [{ id: "ask-1" }] } });
    expect(events.some((event) => event.type === "tool_result" && event.toolName === "ask_user_question")).toBe(false);
  });

  it("混合调用时不执行任何非交互工具，并要求模型重试", async function rejectsMixedInteractiveCalls() {
    const registry = new ToolRegistry();
    const executed = { value: 0 };
    registry.register(createAskUserQuestionTool({ async request() { return createRequest(); } }));
    registry.register(createWriteProbe(executed));
    const sampler = createSampler([
      { content: "", toolCalls: [{ id: "ask-1", name: "ask_user_question", input: { questions: createRequest().questions } }, { id: "write-1", name: "write_probe", input: {} }], reasoningSummary: "同时请求" },
      { content: "已改为普通回答。", toolCalls: [], reasoningSummary: "完成" },
    ]);
    const events = await collectEvents(createAgentKernel({ turnId: "turn-1", messages: [createAgentTextMessage("user", "请确认范围")], toolRegistry: registry, permissionContext: { mode: "auto_approve" }, modelSampler: sampler }).run());

    expect(executed.value).toBe(0);
    expect(events.filter((event) => event.type === "tool_result")).toHaveLength(2);
    expect(events.filter((event) => event.type === "tool_result").every((event) => event.result.status === "error" && event.result.error.code === "INTERACTIVE_TOOL_CONFLICT")).toBe(true);
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
  });
});
