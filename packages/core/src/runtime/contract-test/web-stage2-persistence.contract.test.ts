/**
 * Web Search Stage 2 持久化契约：公开事件与 durable checkpoint 不保留 query 或搜索正文。
 */

import { describe, expect, it } from "vitest";
import { createAgentRuntime as createInternalAgentRuntime, type AgentCheckpoint, type AgentLoopEvent } from "../../internal/agent-runtime";
import { createAgentTextMessage } from "../../internal/types/agent-message";
import type { AgentMessage } from "../../internal/types/agent-message";
import type { AgentSampleResult } from "../../internal/lib/llm";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime as createPersistedAgentRuntime } from "../public/create-agent-runtime";
import { sanitizeAgentTerminationView } from "../protocol/recoverable-turn-view";
import { sanitizeCheckpoint, sanitizeEventForExternal } from "../protocol/sanitize-checkpoint";
import { WebSearchCapabilityError } from "../protocol/web-capability";

const PRIVATE_QUERY = "PRIVATE_STAGE2_QUERY";
const PRIVATE_ANSWER = "PRIVATE_STAGE2_PROVIDER_ANSWER";
const PRIVATE_URL = "https://private-response.example/source";

/** 构造包含 Search 调用、结果和 replay state 的完整内部 checkpoint。 */
function createSearchCheckpoint(): AgentCheckpoint {
  return {
    turnId: "turn-stage2",
    status: "completed",
    stepCount: 1,
    consumedInputIds: ["input-safe"],
    completedCallIds: ["search-call"],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: `准备搜索 ${PRIVATE_QUERY}` },
          { type: "tool-call", id: "search-call", name: "web_search", input: { query: PRIVATE_QUERY } },
        ],
        adapterReplayState: { apiProtocol: "openai-chat-completions", value: { arguments: PRIVATE_QUERY } },
      },
      {
        role: "user",
        content: [{
          type: "tool-result",
          toolCallId: "search-call",
          content: [{ type: "text", text: JSON.stringify({ answer: PRIVATE_ANSWER, sources: [{ title: "source", url: PRIVATE_URL }] }) }],
          isError: false,
        }],
      },
    ],
  };
}

/** 验证 checkpoint 脱敏保留工具配对，但删除 query、答案、URL 和 replay state。 */
describe("Web Search Stage 2 persistence", function webSearchPersistenceSuite() {
  /** 验证公开 checkpoint 只留下生命周期字段，不携带任何消息正文。 */
  it("从 checkpoint 删除模型消息、工具配对与 Provider 结果", function redactsSearchCheckpointData() {
    const original = createSearchCheckpoint();
    const sanitized = sanitizeCheckpoint(original);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(PRIVATE_QUERY);
    expect(serialized).not.toContain(PRIVATE_ANSWER);
    expect(serialized).not.toContain(PRIVATE_URL);
    expect(serialized).not.toContain("adapterReplayState");
    expect(sanitized).toMatchObject({ turnId: "turn-stage2", status: "completed", stepCount: 1, messages: [], completedCallIds: [], consumedInputIds: ["input-safe"] });
    expect(JSON.stringify(original)).toContain(PRIVATE_QUERY);
  });

  /** 非终态 checkpoint 事件与 getState 使用同一白名单，不向宿主投影消息或工具事实。 */
  it("非终态 checkpoint 事件只保留生命周期与 Skill 身份", function projectsOnlySafeNonTerminalCheckpointFields() {
    const event = sanitizeEventForExternal({
      type: "input_consumed",
      turnId: "turn-nonterminal-safe",
      inputId: "input-safe",
      checkpoint: {
        turnId: "turn-nonterminal-safe",
        status: "running",
        stepCount: 2,
        messages: [
          createAgentTextMessage("user", "PRIVATE_MODEL_MESSAGE"),
          { role: "assistant", content: [{ type: "tool-call", id: "private-call", name: "run_command", input: { command: "PRIVATE_TOOL_ARGUMENT" } }] },
        ],
        completedCallIds: ["private-call"],
        consumedInputIds: ["input-safe"],
        pendingCalls: [{ id: "private-pending", name: "run_command", input: { command: "PRIVATE_PENDING_ARGUMENT" } }],
        runtimeBudget: { startedAt: 10, totalTokens: 12 },
        usageAnchor: { usage: { inputTokens: 12, outputTokens: 0, contextTokens: 12 }, messageCount: 1, toolSignature: "PRIVATE_USAGE_SIGNATURE" },
        activeSkills: [{ skillId: "skill-safe", contentHash: "hash-safe", private: "DROP_SKILL_FIELD" }],
      },
    } as unknown as AgentLoopEvent);
    const serialized = JSON.stringify(event);

    expect("checkpoint" in event ? event.checkpoint : undefined).toMatchObject({
      turnId: "turn-nonterminal-safe",
      status: "running",
      stepCount: 2,
      messages: [],
      completedCallIds: [],
      activeSkills: [{ skillId: "skill-safe", contentHash: "hash-safe" }],
    });
    expect(serialized).not.toContain("PRIVATE_MODEL_MESSAGE");
    expect(serialized).not.toContain("PRIVATE_TOOL_ARGUMENT");
    expect(serialized).not.toContain("PRIVATE_PENDING_ARGUMENT");
    expect(serialized).not.toContain("runtimeBudget");
    expect(serialized).not.toContain("usageAnchor");
    expect(serialized).not.toContain("pendingCalls");
    expect(serialized).not.toContain("consumedInputIds");
  });

  /** 终态事件只公开固定原因、恢复布尔值和匹配原因的安全预算数值。 */
  it("终态序列化丢弃私有 checkpoint、未知字段和原始错误", function projectsSafeTerminalFacts() {
    const serialized = sanitizeEventForExternal({
      type: "turn_failed",
      turnId: "turn-terminal-safe",
      error: "PRIVATE_PROVIDER_BODY api_key=sk-private C:/private/model.ts",
      checkpoint: {
        turnId: "turn-terminal-safe",
        status: "failed",
        stepCount: 1,
        messages: [
          createAgentTextMessage("user", "PRIVATE_USER_MESSAGE"),
          { role: "assistant", content: [{ type: "tool-call", id: "private-call", name: "run_command", input: { command: "PRIVATE_TOOL_ARGUMENT" } }] },
          { role: "assistant", content: [{ type: "tool-result", toolCallId: "private-call", content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }], isError: false }] },
        ],
        completedCallIds: [],
        activeSkills: [{ skillId: "skill-safe", contentHash: "hash-safe", private: "DROP_SKILL_FIELD" }],
        interruptionReason: "token_budget",
        runtimeBudget: { startedAt: 10, totalTokens: 12 },
        usageAnchor: { usage: { inputTokens: 12, outputTokens: 0, contextTokens: 12 }, messageCount: 1, toolSignature: "PRIVATE_USAGE_SIGNATURE" },
      },
      termination: {
        reason: "token_budget",
        recoverable: true,
        budget: { used: 12, limit: 10, unit: "tokens", private: "DROP" },
      },
    } as unknown as AgentLoopEvent);
    const serializedText = JSON.stringify(serialized);

    expect(serialized).toMatchObject({ termination: { recoverable: false, reason: "token_budget" } });
    expect("termination" in serialized ? serialized.termination?.budget : undefined).toBeUndefined();
    expect(serializedText).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(serializedText).not.toContain("sk-private");
    expect(serializedText).not.toContain("private.ts");
    expect(serializedText).not.toContain("PRIVATE_USER_MESSAGE");
    expect(serializedText).not.toContain("PRIVATE_TOOL_ARGUMENT");
    expect(serializedText).not.toContain("PRIVATE_TOOL_RESULT");
    expect(serializedText).not.toContain("runtimeBudget");
    expect(serializedText).not.toContain("usageAnchor");
    expect(serializedText).not.toContain("PRIVATE_USAGE_SIGNATURE");
    expect(serializedText).not.toContain("DROP");
    expect(serialized).toMatchObject({ checkpoint: { status: "failed", messages: [], completedCallIds: [], activeSkills: [{ skillId: "skill-safe", contentHash: "hash-safe" }] } });
    expect("checkpoint" in serialized ? serialized.checkpoint : undefined).not.toHaveProperty("pendingCalls");
  });

  /** 旧事件没有预算投影时保留可恢复事实，但不从等待时间补算预算数值。 */
  it("旧终态事件只按 Core checkpoint 状态确定恢复性", function keepsLegacyTerminalProjectionMinimal() {
    const event = sanitizeEventForExternal({
      type: "turn_interrupted",
      turnId: "turn-terminal-legacy",
      checkpoint: {
        turnId: "turn-terminal-legacy",
        status: "interrupted_recoverable",
        interruptionReason: "runtime_budget",
        stepCount: 1,
        messages: [],
        completedCallIds: [],
        runtimeBudget: { startedAt: 10, totalTokens: 0 },
      },
    } as unknown as AgentLoopEvent);

    expect("termination" in event ? event.termination : undefined).toEqual({ recoverable: true, reason: "runtime_budget" });
    expect("checkpoint" in event ? event.checkpoint : undefined).toMatchObject({ status: "interrupted_recoverable", messages: [], completedCallIds: [] });
  });

  /** 预算白名单允许零值，但拒绝负数、非有限数和不安全整数。 */
  it("只接受有限非负安全整数作为终态预算", function validatesNonNegativeBudgetValues() {
    const zeroLimit = sanitizeAgentTerminationView({ reason: "runtime_budget", recoverable: true, budget: { used: 0, limit: 0, unit: "ms" } });
    const negativeLimit = sanitizeAgentTerminationView({ reason: "runtime_budget", recoverable: true, budget: { used: 0, limit: -1, unit: "ms" } });
    const infiniteUsed = sanitizeAgentTerminationView({ reason: "runtime_budget", recoverable: true, budget: { used: Number.POSITIVE_INFINITY, limit: 1, unit: "ms" } });

    expect(zeroLimit).toEqual({ reason: "runtime_budget", recoverable: true, budget: { used: 0, limit: 0, unit: "ms" } });
    expect(negativeLimit).toEqual({ reason: "runtime_budget", recoverable: true });
    expect(infiniteUsed).toEqual({ reason: "runtime_budget", recoverable: true });
  });

  /** 验证公开 tool_result 只携带安全来源计数，不携带原始 answer 或 URL。 */
  it("从公开工具事件删除 Search 原始输出", function redactsSearchToolResultEvent() {
    const event = sanitizeEventForExternal({
      type: "tool_result",
      turnId: "turn-stage2",
      stepId: "step-stage2",
      callId: "search-call",
      toolName: "web_search",
      retryCount: 0,
      summary: "找到 1 个公开来源",
      result: {
        status: "success",
        callId: "search-call",
        toolName: "web_search",
        output: { answer: PRIVATE_ANSWER, sources: [{ title: "source", url: PRIVATE_URL }], truncated: false },
        meta: { durationMs: 1, inputHash: "safe-hash" },
        display: { titleKey: "tool.search.completed", detail: { kind: "web_search", sourceCount: 1, truncated: false } },
      },
    });

    expect(event.type === "tool_result" && event.result.status === "success" && event.result.output).toEqual({ sourceCount: 1, truncated: false });
    expect(JSON.stringify(event)).not.toContain(PRIVATE_ANSWER);
    expect(JSON.stringify(event)).not.toContain(PRIVATE_URL);
  });

  /** 验证真实 Turn 持久化边界脱敏，但同一进程的第二次采样仍能读取完整 Search 结果。 */
  it("在 Event、Transcript 与 durable checkpoint 前删除原始搜索数据", async function redactsPersistedSearchData() {
    const ports = createMemoryPorts();
    const sessionId = "stage2-persisted-search";
    let sampleCount = 0;
    let continuationMessages: AgentMessage[] = [];
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: 1, updatedAt: 1 });
    const runtime = createPersistedAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        modelSampler: {
          /** 第一次请求 Search，第二次确认进程内工具结果仍可供原主模型继续回答。 */
          async sample(messages) {
            sampleCount++;
            if (sampleCount === 1) return { content: "", reasoningSummary: "", toolCalls: [{ id: "persist-search", name: "web_search", input: { query: PRIVATE_QUERY } }] };
            continuationMessages = messages;
            return { content: "PUBLIC_FINAL_ANSWER", reasoningSummary: "", toolCalls: [] };
          },
        },
        web: {
          search: {
            /** 返回含私有测试标记的完整 Adapter 结果。 */
            async search() {
              return { answer: PRIVATE_ANSWER, sources: [{ title: "source", url: PRIVATE_URL }], truncated: false };
            },
          },
        },
      },
    });
    const events = [];
    for await (const event of runtime.turns.start({ sessionId, content: "请搜索公开资料" })) events.push(event);
    const transcript = await ports.transcriptStore.getEvents(sessionId);
    const checkpoint = await ports.checkpointStore.getLatest(sessionId);

    expect(JSON.stringify(continuationMessages)).toContain(PRIVATE_ANSWER);
    expect(JSON.stringify(events)).not.toContain(PRIVATE_QUERY);
    expect(JSON.stringify(events)).not.toContain(PRIVATE_ANSWER);
    expect(JSON.stringify(events)).not.toContain(PRIVATE_URL);
    expect(JSON.stringify(transcript)).not.toContain(PRIVATE_QUERY);
    expect(JSON.stringify(transcript)).not.toContain(PRIVATE_ANSWER);
    expect(JSON.stringify(transcript)).not.toContain(PRIVATE_URL);
    expect(JSON.stringify(checkpoint)).not.toContain(PRIVATE_QUERY);
    expect(JSON.stringify(checkpoint)).not.toContain(PRIVATE_ANSWER);
    expect(JSON.stringify(checkpoint)).not.toContain(PRIVATE_URL);
  });
});

/** 创建始终由同一主模型 sampler 完成 Search 前后两次采样的受控夹具。 */
function createMainModelSampler(label: string, calls: Array<{ label: string; messages: AgentMessage[] }>): ModelSampler {
  let sampleCount = 0;
  return {
    /** 首次请求 Search，第二次读取工具结果并完成回答。 */
    async sample(messages): Promise<AgentSampleResult> {
      calls.push({ label, messages });
      sampleCount++;
      if (sampleCount === 1) {
        return { content: "", reasoningSummary: "", toolCalls: [{ id: `${label}-search`, name: "web_search", input: { query: "public fixture" } }] };
      }
      return { content: `${label} completed`, reasoningSummary: "", toolCalls: [] };
    },
  };
}

/** 运行一次带 Search 的主模型闭环并收集终态，证明工具结果回到原 sampler。 */
async function runSearchTurn(label: string, calls: Array<{ label: string; messages: AgentMessage[] }>): Promise<AgentLoopEvent[]> {
  const runtime = createInternalAgentRuntime({
    modelSampler: createMainModelSampler(label, calls),
    permissionMode: "auto_approve",
    web: {
      search: {
        /** 返回固定公开结果，隔离真实网络与 Provider。 */
        async search() {
          return { answer: "PUBLIC_SEARCH_RESULT", sources: [{ title: "source", url: "https://example.com" }], truncated: false };
        },
      },
    },
  });
  const events: AgentLoopEvent[] = [];
  for await (const event of runtime.run({ turnId: `${label}-turn`, messages: [{ role: "user", content: [{ type: "text", text: "请搜索" }] }] })) events.push(event);
  return events;
}

/** 验证两类主 sampler 都各自在 Search 后继续采样。 */
describe("Web Search Stage 2 main model isolation", function webSearchMainModelIsolationSuite() {
  /** 两条主模型链路不能被 Search Adapter 的内部模型身份替换。 */
  it("将 Search 结果返回发起调用的原主模型", async function returnsSearchResultToOriginalMainModel() {
    const calls: Array<{ label: string; messages: AgentMessage[] }> = [];
    const firstEvents = await runSearchTurn("main-model-a", calls);
    const secondEvents = await runSearchTurn("main-model-b", calls);

    expect(calls.filter(
      /** 只统计第一个主 sampler 的调用。 */
      function isFirstMainModelCall(call) { return call.label === "main-model-a"; },
    )).toHaveLength(2);
    expect(calls.filter(
      /** 只统计第二个主 sampler 的调用。 */
      function isSecondMainModelCall(call) { return call.label === "main-model-b"; },
    )).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.messages)).toContain("PUBLIC_SEARCH_RESULT");
    expect(JSON.stringify(calls[3]?.messages)).toContain("PUBLIC_SEARCH_RESULT");
    expect(firstEvents.some(
      /** 判断第一条主链是否正常完成。 */
      function completedFirstMainModel(event) { return event.type === "turn_completed"; },
    )).toBe(true);
    expect(secondEvents.some(
      /** 判断第二条主链是否正常完成。 */
      function completedSecondMainModel(event) { return event.type === "turn_completed"; },
    )).toBe(true);
  });

  /** 验证 Adapter 稳定错误码进入工具终态，而 Provider 原始正文不会穿透。 */
  it("保留 Search 稳定错误码并脱敏失败正文", async function preservesStableSearchErrorCode() {
    let sampleCount = 0;
    const runtime = createInternalAgentRuntime({
      permissionMode: "auto_approve",
      modelSampler: {
        /** 首次调用 Search，收到工具错误后以普通正文结束。 */
        async sample() {
          sampleCount++;
          return sampleCount === 1
            ? { content: "", reasoningSummary: "", toolCalls: [{ id: "rate-limited-search", name: "web_search", input: { query: "public" } }] }
            : { content: "稍后再试", reasoningSummary: "", toolCalls: [] };
        },
      },
      web: {
        search: {
          /** 模拟 Adapter 已完成脱敏的限流错误。 */
          async search() {
            throw new WebSearchCapabilityError("WEB_SEARCH_RATE_LIMITED", "PRIVATE_PROVIDER_ERROR_BODY");
          },
        },
      },
    });
    const events: AgentLoopEvent[] = [];
    for await (const event of runtime.run({ turnId: "stable-error-turn", messages: [{ role: "user", content: [{ type: "text", text: "请搜索" }] }] })) events.push(event);
    const toolResult = events.find(
      /** 查找本次 Search 的工具终态。 */
      function findSearchResult(event) { return event.type === "tool_result" && event.toolName === "web_search"; },
    );

    expect(toolResult?.type === "tool_result" && toolResult.result.status === "error" && toolResult.result.error).toEqual({
      code: "WEB_SEARCH_RATE_LIMITED",
      message: "网络搜索服务当前限流",
    });
    expect(JSON.stringify(toolResult)).not.toContain("PRIVATE_PROVIDER_ERROR_BODY");
  });
});
