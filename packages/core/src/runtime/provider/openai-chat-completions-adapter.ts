/**
 * runtime/provider/openai-chat-completions-adapter.ts — OpenAI Chat Completions 的唯一 V2 wire Adapter。
 *
 * 本文件独占 Chat Completions 请求、SSE 解析和错误归一化；Kernel 只传入已校验的
 * Provider 中立内容块。兼容差异只读取冻结的 protocolProfile，绝不根据 route、模型或 URL 猜测。
 */

import type { AgentModelToolDefinition, AgentSampleResult, AgentSampleUsage } from "../../internal/lib/llm";
import { AgentSampleError } from "../../internal/lib/llm";
import { recordPerformanceDiagnostic } from "../../internal/performance-diagnostics";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import type { ModelSampleOptions } from "../../internal/types";
import { CanonicalMessageError, getAgentMessageText, type AgentContentBlock, type AgentMessage, validateAgentMessages } from "../../internal/types/agent-message";
import type { OpenAiChatCompletionsProtocolProfile } from "./api-protocol";
import type { ModelBehaviorProfile } from "./model-behavior-profile";
import { createDefaultModelBehaviorProfile } from "./model-behavior-profile";

/** 单次 OpenAI Chat Completions 采样所需的冻结参数。 */
export interface CreateOpenAiChatCompletionsSamplerInput {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  sampleOptions: ModelSampleOptions;
  protocolProfile?: OpenAiChatCompletionsProtocolProfile;
  behaviorProfile?: ModelBehaviorProfile;
}

/** Chat Completions 请求所需的明确输入。 */
export interface OpenAiChatCompletionsRequestInput {
  model: string;
  messages: AgentMessage[];
  tools: AgentModelToolDefinition[];
  sampleOptions: ModelSampleOptions;
  maxTokens: number;
  protocolProfile: OpenAiChatCompletionsProtocolProfile;
}

/** Chat Completions 流式调用的默认超时；用户取消仍由调用方 signal 独立控制。 */
const DEFAULT_AGENT_PROVIDER_TIMEOUT_MS = 120_000;

/** 当旧快照未带 profile 时采用最保守的 Chat Completions 行为。 */
function getProtocolProfile(profile?: OpenAiChatCompletionsProtocolProfile): OpenAiChatCompletionsProtocolProfile {
  return profile ?? {
    apiProtocol: "openai-chat-completions",
    assistantToolCallContent: "empty-string",
    supportsReasoningContent: false,
    supportsUsageInStreaming: false,
  };
}

/** 将 error tool-result 变为标准 content 文本，避免创造 Chat wire 私有字段。 */
function getToolResultContent(block: Extract<AgentContentBlock, { type: "tool-result" }>): string {
  const text = block.content.map(function getResultText(item) { return item.text; }).join("\n");
  return block.isError ? `工具执行失败：\n${text}` : text;
}

/** 将 V2 canonical 历史转换为 Chat Completions messages，并在入口校验工具配对。 */
export function createOpenAiChatCompletionsMessages(
  messages: AgentMessage[],
  protocolProfile: OpenAiChatCompletionsProtocolProfile,
): Array<Record<string, unknown>> {
  return validateAgentMessages(messages).map(function mapMessage(message) {
    if (message.role === "user" && message.content[0]?.type === "tool-result") {
      return { role: "tool", tool_call_id: message.content[0].toolCallId, content: getToolResultContent(message.content[0]) };
    }
    if (message.role !== "assistant") return { role: message.role, content: getAgentMessageText(message) };

    const toolCalls = message.content.filter(function isToolCall(block): block is Extract<AgentContentBlock, { type: "tool-call" }> {
      return block.type === "tool-call";
    });
    const reasoning = message.content.filter(function isReasoning(block): block is Extract<AgentContentBlock, { type: "reasoning" }> {
      return block.type === "reasoning";
    }).map(function getReasoningText(block) { return block.text; }).join("");
    const content = getAgentMessageText(message);
    const result: Record<string, unknown> = {
      role: "assistant",
      content: toolCalls.length > 0 && !content
        ? (protocolProfile.assistantToolCallContent === "null" ? null : "")
        : content,
    };
    if (toolCalls.length > 0) {
      result.tool_calls = toolCalls.map(function mapToolCall(call) {
        return { id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } };
      });
    }
    if (protocolProfile.supportsReasoningContent && reasoning) result.reasoning_content = reasoning;
    return result;
  });
}

/** 将 V2 canonical 与冻结选项构造成可精确断言的 Chat Completions HTTP body。 */
export function createOpenAiChatCompletionsRequest(input: OpenAiChatCompletionsRequestInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: createOpenAiChatCompletionsMessages(input.messages, input.protocolProfile),
    tools: input.tools,
    tool_choice: input.sampleOptions.toolChoice ? { type: "function", function: { name: input.sampleOptions.toolChoice.name } } : "auto",
    temperature: input.sampleOptions.toolChoice ? 0 : input.sampleOptions.temperature ?? 0.2,
    max_tokens: input.maxTokens,
    stream: true,
  };
  if (input.protocolProfile.supportsUsageInStreaming) body.stream_options = { include_usage: true };
  if (input.sampleOptions.thinking) body.thinking = { type: input.sampleOptions.toolChoice ? "disabled" : input.sampleOptions.thinking };
  if (!input.sampleOptions.toolChoice && input.sampleOptions.reasoningEffort) body.reasoning_effort = input.sampleOptions.reasoningEffort;
  if (!input.sampleOptions.toolChoice && !input.sampleOptions.thinking && input.sampleOptions.topP !== undefined) body.top_p = input.sampleOptions.topP;
  return body;
}

/** 校验并归一化 Chat Completions 流式 usage；异常数据绝不成为可信锚点。 */
function normalizeStreamUsage(usage: unknown): AgentSampleUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const candidate = usage as Record<string, unknown>;
  const inputTokens = candidate.prompt_tokens;
  const outputTokens = candidate.completion_tokens;
  const contextTokens = candidate.total_tokens;
  if (
    typeof inputTokens !== "number" || typeof outputTokens !== "number" || typeof contextTokens !== "number"
    || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || !Number.isSafeInteger(contextTokens)
    || inputTokens < 0 || outputTokens < 0 || contextTokens < 0 || contextTokens !== inputTokens + outputTokens
  ) return undefined;
  return { inputTokens, outputTokens, contextTokens };
}

/** 判断 Provider 错误是否是可由 Runtime compact 后重试的上下文溢出。 */
function isContextOverflowResponse(status: number, body: string): boolean {
  return (status === 400 || status === 413 || status === 422)
    && /context[_\s-]?(length|window)|maximum context|too many tokens|token limit/i.test(body);
}

/** 创建只接收 V2 canonical 的 OpenAI Chat Completions sampler。 */
export function createOpenAiChatCompletionsSampler(input: CreateOpenAiChatCompletionsSamplerInput): ModelSampler {
  const { baseUrl, apiKey, timeoutMs, sampleOptions, behaviorProfile = createDefaultModelBehaviorProfile() } = input;
  const protocolProfile = getProtocolProfile(input.protocolProfile);
  return {
    behaviorProfile,
    async sample(messages, tools, options, onDelta) {
      const model = sampleOptions.model;
      if (!model || !baseUrl || !apiKey) throw new AgentSampleError("OpenAI Chat Completions 缺少模型、端点或凭据", "PROVIDER_REQUEST_REJECTED");
      const requestController = new AbortController();
      let requestTimedOut = false;
      let responseStarted = false;
      /** 转发调用方取消，保留内部超时的稳定错误分类。 */
      function forwardCallerAbort(): void {
        requestController.abort();
      }
      if (options.signal?.aborted) requestController.abort();
      else options.signal?.addEventListener("abort", forwardCallerAbort, { once: true });
      const requestTimeout = setTimeout(function abortTimedOutProviderRequest() {
        requestTimedOut = true;
        requestController.abort();
      }, timeoutMs ?? DEFAULT_AGENT_PROVIDER_TIMEOUT_MS);
      requestTimeout.unref?.();

      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(createOpenAiChatCompletionsRequest({ model, messages, tools, sampleOptions: { ...sampleOptions, toolChoice: options.toolChoice }, maxTokens: options.maxTokens ?? sampleOptions.maxTokens ?? 8_192, protocolProfile })),
          signal: requestController.signal,
        });
        if (!response.ok) {
          const errorBody = await response.text().catch(function ignoreProviderErrorBody() { return ""; });
          if (isContextOverflowResponse(response.status, errorBody)) throw new AgentSampleError("模型上下文超过供应商窗口", "CONTEXT_OVERFLOW");
          if (response.status === 429) throw new AgentSampleError("供应商请求被限流", "PROVIDER_RATE_LIMIT");
          if (response.status >= 500) throw new AgentSampleError(`供应商服务暂时不可用 (${response.status})`, "PROVIDER_SERVER_ERROR");
          throw new AgentSampleError(`供应商拒绝请求（HTTP ${response.status}）`, "PROVIDER_REQUEST_REJECTED");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("OpenAI Chat Completions 流式响应 body 不可读");
        responseStarted = true;

        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let finishReason: string | undefined;
        let streamDrained = false;
        let reasoningContentSeen = false;
        let malformedPayloadSeen = false;
        let usageChunkSeen = false;
        let usageChunkInvalid = false;
        let usage: AgentSampleUsage | undefined;
        let reasoningContent = "";
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        /** 消费一条完整 SSE data payload，并按 index 合并 tool_call 参数分片。 */
        function consume(data: string, isDoneMarker: boolean): void {
          if (isDoneMarker) {
            streamDrained = true;
            return;
          }
          if (!data) return;
          try {
            const payload = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
              usage?: unknown;
            };
            if (protocolProfile.supportsUsageInStreaming && payload.usage !== undefined && payload.usage !== null) {
              if (usageChunkSeen || (Array.isArray(payload.choices) && payload.choices.length > 1)) usageChunkInvalid = true;
              else {
                usageChunkSeen = true;
                usage = normalizeStreamUsage(payload.usage);
                if (!usage) usageChunkInvalid = true;
              }
            }
            const choice = payload.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const delta = choice?.delta;
            if (!delta) return;
            if (protocolProfile.supportsReasoningContent && delta.reasoning_content) {
              reasoningContentSeen = true;
              reasoningContent += delta.reasoning_content;
            }
            if (delta.content) {
              content += delta.content;
              recordPerformanceDiagnostic("provider_delta_arrived", "answer_delta");
              onDelta?.(delta.content);
            }
            for (const call of delta.tool_calls ?? []) {
              const index = call.index ?? 0;
              const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
              if (call.id) current.id = call.id;
              if (call.function?.name) current.name += call.function.name;
              if (call.function?.arguments) current.arguments += call.function.arguments;
              calls.set(index, current);
            }
          } catch {
            malformedPayloadSeen = true;
          }
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
              const payload = trimmed.slice(5).trim();
              consume(payload, payload === "[DONE]");
            }
          }
        }
        if (buffer.trim().startsWith("data:")) {
          const payload = buffer.trim().slice(5).trim();
          consume(payload, payload === "[DONE]");
        }
        if (malformedPayloadSeen) throw new AgentSampleError("模型流式响应包含损坏的 JSON 事件", "STREAM_INCOMPLETE");
        const streamIncomplete = !streamDrained && !finishReason;
        const toolCalls = [...calls.entries()].sort(function sortByIndex([left], [right]) { return left - right; }).map(function parseToolCall([, call]) {
          if (!call.id || !call.name) {
            if (finishReason === "length") throw new AgentSampleError("模型输出达到上限，工具调用参数未完成", "MODEL_OUTPUT_LIMIT", Math.max(...[...calls.values()].map(function getArgSize(item) { return Buffer.byteLength(item.arguments, "utf8"); }), 0));
            throw new AgentSampleError("OpenAI Chat Completions 返回了不完整的工具调用", "TOOL_CALL_TRUNCATED");
          }
          try {
            return { id: call.id, name: call.name, input: JSON.parse(call.arguments || "{}") };
          } catch {
            if (finishReason === "length") throw new AgentSampleError(`工具 ${call.name} 的参数 JSON 在输出上限处被截断`, "MODEL_OUTPUT_LIMIT", Buffer.byteLength(call.arguments, "utf8"));
            if (streamIncomplete) throw new AgentSampleError(`工具 ${call.name} 的参数 JSON 因网络提前结束而不完整`, "STREAM_INCOMPLETE", Buffer.byteLength(call.arguments, "utf8"));
            throw new AgentSampleError(`工具 ${call.name} 的参数 JSON 不完整或无效`, "TOOL_CALL_INVALID_JSON", Buffer.byteLength(call.arguments, "utf8"));
          }
        });
        if (streamIncomplete) throw new AgentSampleError("模型流式响应提前结束，未形成完整结果", "STREAM_INCOMPLETE");
        if (finishReason === "length" && toolCalls.length === 0) throw new AgentSampleError("模型输出达到上限，未形成完整可执行结果", "MODEL_OUTPUT_LIMIT", Buffer.byteLength(content, "utf8"));
        if (toolCalls.length === 0 && !content.trim()) {
          const reason = finishReason ? `（finish_reason=${finishReason}）` : "";
          const detail = reasoningContentSeen ? "模型只返回了不可显示的推理内容" : "模型未返回可显示正文或工具调用";
          throw new AgentSampleError(`${detail}${reason}`, "EMPTY_RESPONSE");
        }
        return {
          content,
          toolCalls,
          reasoningSummary: toolCalls.length > 0 ? `模型请求调用 ${toolCalls.map(function getToolName(item) { return item.name; }).join("、")}` : "模型已完成当前步骤判断",
          finishReason,
          ...(toolCalls.length > 0 && reasoningContent ? { reasoningContent } : {}),
          ...(usageChunkSeen && !usageChunkInvalid && usage ? { usage } : {}),
        };
      } catch (error) {
        if (error instanceof AgentSampleError || error instanceof CanonicalMessageError || options.signal?.aborted) throw error;
        if (requestTimedOut) throw new AgentSampleError("供应商请求超时", "PROVIDER_TIMEOUT");
        if (responseStarted) throw new AgentSampleError("模型流式响应提前结束，未形成完整结果", "STREAM_INCOMPLETE");
        throw new AgentSampleError("无法连接模型供应商", "PROVIDER_CONNECTION");
      } finally {
        clearTimeout(requestTimeout);
        options.signal?.removeEventListener("abort", forwardCallerAbort);
      }
    },
  };
}
