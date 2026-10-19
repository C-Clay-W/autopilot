/**
 * runtime/provider/anthropic-messages-adapter.ts — Anthropic Messages 的唯一 V2 wire Adapter。
 *
 * 只在本文件处理 Anthropic 的 request、stream、thinking replay 与错误映射；Kernel 仅传入
 * 已校验的 Provider 中立内容块和冻结配置，任何 Anthropic wire 字段都不反向进入 canonical。
 */

import Anthropic, { APIError } from "@anthropic-ai/sdk";
import type { AgentModelToolDefinition, AgentSampleResult } from "../../internal/lib/llm";
import { AgentSampleError } from "../../internal/lib/llm";
import { recordPerformanceDiagnostic } from "../../internal/performance-diagnostics";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import type { AgentContentBlock, AgentJsonObject, AgentMessage } from "../../internal/types/agent-message";
import { getAgentMessageText, validateAgentMessages } from "../../internal/types/agent-message";
import type { ModelSampleOptions } from "../../internal/types";
import type { ModelBehaviorProfile } from "./model-behavior-profile";
import { createDefaultModelBehaviorProfile } from "./model-behavior-profile";

/** 创建 Anthropic Messages 采样器所需的已冻结参数。 */
export interface CreateAnthropicMessagesSamplerInput {
  baseUrl?: string;
  apiKey?: string;
  authMode?: "api_key" | "bearer";
  timeoutMs?: number;
  sampleOptions: ModelSampleOptions;
  behaviorProfile?: ModelBehaviorProfile;
}

/** 只保存 Anthropic replay 所需的最小字段，主动排除 citations/caller 等 SDK 响应字段。 */
type AnthropicReplayBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: AgentJsonObject };

/** 判断值是否为普通对象，避免从带原型对象读取 replay 字段。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/** 判断值是否为不含循环、函数或特殊原型的 JSON 值。 */
function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value) || (!Array.isArray(value) && !isPlainRecord(value))) return false;
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? value.every(function validateArrayItem(item) { return isJsonValue(item, ancestors); })
      : Object.values(value).every(function validateObjectItem(item) { return isJsonValue(item, ancestors); });
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

/** 判断值是否为可重放的 JSON object input。 */
function isJsonObject(value: unknown): value is AgentJsonObject {
  return isPlainRecord(value) && isJsonValue(value, new Set<object>());
}

/** 判断对象是否恰好包含指定字段，拒绝 SDK 新增字段或伪造 wire 扩展。 */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every(function isExpectedKey(key) { return expected.includes(key); });
  } catch {
    return false;
  }
}

/** 按来源选择严格 replay 字段校验或响应字段筛选。 */
function hasReplayKeys(value: Record<string, unknown>, expected: readonly string[], strict: boolean): boolean {
  try {
    return strict ? hasExactKeys(value, expected) : expected.every(function hasExpectedKey(key) { return Object.prototype.hasOwnProperty.call(value, key); });
  } catch {
    return false;
  }
}

/** 统一创建不携带 Provider 原文的 replay 校验错误。 */
function invalidReplay(): never {
  throw new AgentSampleError("Anthropic thinking replay 状态损坏，已拒绝发送请求", "PROVIDER_REQUEST_REJECTED");
}

/** 官方 Anthropic API 地址；只有该地址维持严格的 thinking 签名校验。 */
const OFFICIAL_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** 判断 baseUrl 是否为官方 Anthropic：兼容网关（DS/MiMo 等）返回的 thinking 可能缺签名，需要容忍开关。 */
function isOfficialAnthropicBaseUrl(baseUrl: string | undefined): boolean {
  return (baseUrl ?? OFFICIAL_ANTHROPIC_BASE_URL).replace(/\/+$/u, "") === OFFICIAL_ANTHROPIC_BASE_URL;
}

/** 将 SDK 响应或 durable replay 归一化为严格、可发送的 Anthropic 内容块。 */
function normalizeAnthropicReplayContent(value: unknown, strict = true, tolerateUnsignedThinking = false): AnthropicReplayBlock[] {
  if (!Array.isArray(value) || value.length === 0) return invalidReplay();
  return value.flatMap(function normalizeReplayBlock(block): AnthropicReplayBlock[] {
    if (!isPlainRecord(block) || typeof block.type !== "string") return invalidReplay();
    if (block.type === "text") {
      if (!hasReplayKeys(block, ["type", "text"], strict) || typeof block.text !== "string") return invalidReplay();
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "thinking") {
      // 兼容网关的 thinking 缺/空签名：容忍模式下原样保留、不伪造签名；官方地址维持严格校验。
      if (tolerateUnsignedThinking) {
        if (typeof block.thinking !== "string") return invalidReplay();
        if (block.signature === undefined) return [{ type: "thinking", thinking: block.thinking }];
        if (typeof block.signature !== "string") return invalidReplay();
        return [{ type: "thinking", thinking: block.thinking, signature: block.signature }];
      }
      if (!hasReplayKeys(block, ["type", "thinking", "signature"], strict)
        || typeof block.thinking !== "string"
        || typeof block.signature !== "string"
        || block.signature.trim().length === 0) return invalidReplay();
      return [{ type: "thinking", thinking: block.thinking, signature: block.signature }];
    }
    if (block.type === "redacted_thinking") {
      // 兼容网关的 Anthropic 兼容层不支持 redacted_thinking：容忍模式下回放前丢弃（语义比较本就不读取它）。
      if (tolerateUnsignedThinking) return [];
      if (!hasReplayKeys(block, ["type", "data"], strict) || typeof block.data !== "string" || block.data.trim().length === 0) return invalidReplay();
      return [{ type: "redacted_thinking", data: block.data }];
    }
    if (block.type === "tool_use") {
      if (!hasReplayKeys(block, ["type", "id", "name", "input"], strict)
        || typeof block.id !== "string"
        || block.id.trim().length === 0
        || typeof block.name !== "string"
        || block.name.trim().length === 0
        || !isJsonObject(block.input)) return invalidReplay();
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    }
    return invalidReplay();
  });
}

/** 比较 JSON input 的稳定语义，避免 replay 工具参数与 canonical 不一致。 */
function jsonValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** 校验 replay 与 canonical assistant 的可见文本、推理文本和工具调用逐项一致。 */
function assertReplayMatchesCanonical(message: AgentMessage, replay: AnthropicReplayBlock[]): void {
  const expected = message.content.flatMap(function toComparableCanonical(block): Array<{ type: string; text?: string; id?: string; name?: string; input?: AgentJsonObject }> {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "reasoning") return [{ type: "thinking", text: block.text }];
    if (block.type === "tool-call") return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    return [];
  });
  const actual = replay.flatMap(function toComparableReplay(block): Array<{ type: string; text?: string; id?: string; name?: string; input?: AgentJsonObject }> {
    if (block.type === "redacted_thinking") return [];
    // Provider 可返回带签名但无正文的 thinking；它必须保留给 wire replay，但不对应 canonical reasoning。
    if (block.type === "thinking" && block.thinking.length === 0) return [];
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "thinking") return [{ type: "thinking", text: block.thinking }];
    return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
  });
  // canonical 的 reasoning 位置可与 Provider wire 的 thinking 位置不同，但各类语义块的顺序必须稳定。
  const semanticTypes = ["text", "thinking", "tool_use"];
  if (semanticTypes.some(function mismatchSemanticType(type) {
    const expectedOfType = expected.filter(function isExpectedType(item) { return item.type === type; });
    const actualOfType = actual.filter(function isActualType(item) { return item.type === type; });
    return expectedOfType.length !== actualOfType.length || expectedOfType.some(function mismatch(item, index) {
      const candidate = actualOfType[index];
      return !candidate
        || item.text !== candidate.text
        || item.id !== candidate.id
        || item.name !== candidate.name
        || !jsonValuesEqual(item.input, candidate.input);
    });
  })) invalidReplay();
}

/** 将 V2 assistant 内容块映射为 Anthropic 允许发送的内容块。 */
function createAssistantContent(message: AgentMessage, tolerateUnsignedThinking: boolean): Anthropic.ContentBlockParam[] {
  const replay = message.adapterReplayState;
  if (replay?.apiProtocol === "anthropic-messages") {
    const normalizedReplay = normalizeAnthropicReplayContent(replay.value, true, tolerateUnsignedThinking);
    assertReplayMatchesCanonical(message, normalizedReplay);
    return normalizedReplay as Anthropic.ContentBlockParam[];
  }
  if (message.content.some(function hasReasoning(block) { return block.type === "reasoning"; })) {
    throw new AgentSampleError("Anthropic reasoning 缺少可重放 signature，已拒绝伪造请求", "PROVIDER_REQUEST_REJECTED");
  }
  return message.content.flatMap(function mapAssistantBlock(block): Anthropic.ContentBlockParam[] {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "tool-call") return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    return [];
  });
}

/** 将连续 V2 tool-result 合并为一条 Anthropic user message，保留 error 语义。 */
function appendToolResult(requestMessages: Anthropic.MessageParam[], block: Extract<AgentContentBlock, { type: "tool-result" }>): void {
  const result: Anthropic.ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: block.toolCallId,
    content: block.content.map(function mapResultText(item) { return { type: "text" as const, text: item.text }; }),
    is_error: block.isError,
  };
  const previous = requestMessages.at(-1);
  if (previous?.role === "user" && Array.isArray(previous.content)
    && previous.content.every(function isToolResult(item) { return item.type === "tool_result"; })) {
    previous.content.push(result);
    return;
  }
  requestMessages.push({ role: "user", content: [result] });
}

/** 将完整 V2 历史转换为 Anthropic 的非 system 消息，并在入口验证配对不变量。 */
export function createAnthropicConversationMessages(messages: AgentMessage[], tolerateUnsignedThinking = false): Anthropic.MessageParam[] {
  const requestMessages: Anthropic.MessageParam[] = [];
  for (const message of validateAgentMessages(messages)) {
    if (message.role === "system") continue;
    if (message.role === "user" && message.content[0]?.type === "tool-result") {
      appendToolResult(requestMessages, message.content[0]);
      continue;
    }
    if (message.role === "assistant") {
      requestMessages.push({ role: "assistant", content: createAssistantContent(message, tolerateUnsignedThinking) });
      continue;
    }
    requestMessages.push({ role: "user", content: getAgentMessageText(message) });
  }
  return requestMessages;
}

/** 将 V2 canonical 和冻结采样选项转换为 Anthropic SDK 请求。 */
export function createAnthropicMessagesRequest(
  model: string,
  messages: AgentMessage[],
  tools: AgentModelToolDefinition[],
  sampleOptions: ModelSampleOptions,
  maxTokens: number,
  tolerateUnsignedThinking = false,
): Anthropic.MessageStreamParams {
  const canonical = validateAgentMessages(messages);
  const system = canonical.filter(function isSystemMessage(message) { return message.role === "system"; })
    .map(getAgentMessageText)
    .filter(Boolean)
    .join("\n\n");
  const effort = sampleOptions.reasoningEffort;
  return {
    model,
    max_tokens: maxTokens,
    messages: createAnthropicConversationMessages(canonical, tolerateUnsignedThinking),
    stream: true,
    ...(system ? { system } : {}),
    ...(tools.length > 0 ? {
      tools: tools.map(function mapTool(tool) {
        return { name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters };
      }),
      tool_choice: sampleOptions.toolChoice ? { type: "tool", name: sampleOptions.toolChoice.name, disable_parallel_tool_use: true } : { type: "auto" },
    } : {}),
    ...(sampleOptions.toolChoice ? { temperature: 0 } : sampleOptions.temperature !== undefined ? { temperature: sampleOptions.temperature } : {}),
    ...(!sampleOptions.toolChoice && sampleOptions.topP !== undefined ? { top_p: sampleOptions.topP } : {}),
    ...(sampleOptions.toolChoice ? { thinking: { type: "disabled" as const } } : sampleOptions.thinking === "enabled" ? { thinking: { type: "adaptive" as const } } : sampleOptions.thinking === "disabled" ? { thinking: { type: "disabled" as const } } : {}),
    ...(!sampleOptions.toolChoice && (effort === "low" || effort === "medium" || effort === "high" || effort === "max") ? { output_config: { effort } } : {}),
  } as Anthropic.MessageStreamParams;
}

/** 将 Anthropic stop_reason 映射为 Kernel 的既有完成边界。 */
function normalizeFinishReason(value: string | null): string | undefined {
  if (value === "end_turn") return "stop";
  if (value === "tool_use") return "tool_calls";
  if (value === "max_tokens") return "length";
  return value ?? undefined;
}

/** 从 Anthropic 最终消息提取文本、工具调用和仅供同协议使用的 replay state。 */
function extractAnthropicResult(message: Anthropic.Message, tolerateUnsignedThinking: boolean): Pick<AgentSampleResult, "content" | "toolCalls" | "reasoningContent" | "adapterReplayState"> {
  const replayContent = normalizeAnthropicReplayContent(message.content, false, tolerateUnsignedThinking);
  let content = "";
  let reasoningContent = "";
  const toolCalls: AgentSampleResult["toolCalls"] = [];
  let hasThinking = false;
  for (const block of replayContent) {
    if (block.type === "text") {
      content += block.text;
      continue;
    }
    if (block.type === "thinking") {
      reasoningContent += block.thinking;
      hasThinking = true;
      continue;
    }
    if (block.type === "redacted_thinking") {
      hasThinking = true;
      continue;
    }
    if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return {
    content,
    toolCalls,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(hasThinking ? { adapterReplayState: { apiProtocol: "anthropic-messages" as const, value: replayContent } } : {}),
  };
}

/** 将 SDK HTTP 错误映射为不含 Provider 原文的稳定 Agent 错误。 */
function normalizeProviderError(error: unknown, signal?: AbortSignal): never {
  if (error instanceof AgentSampleError || signal?.aborted) throw error;
  if (error instanceof APIError) {
    if (error.status === 429) throw new AgentSampleError("供应商请求被限流", "PROVIDER_RATE_LIMIT");
    if (error.status === 408) throw new AgentSampleError("供应商请求超时", "PROVIDER_TIMEOUT");
    if (typeof error.status === "number" && error.status >= 500) throw new AgentSampleError(`供应商服务暂时不可用 (${error.status})`, "PROVIDER_SERVER_ERROR");
    throw new AgentSampleError(`供应商拒绝请求（HTTP ${error.status ?? 0}）`, "PROVIDER_REQUEST_REJECTED");
  }
  throw new AgentSampleError("无法连接模型供应商", "PROVIDER_CONNECTION");
}

/** 创建只接收 V2 canonical 的 Anthropic Messages ModelSampler。 */
export function createAnthropicMessagesSampler(input: CreateAnthropicMessagesSamplerInput): ModelSampler {
  const { baseUrl, apiKey, authMode = "api_key", timeoutMs, sampleOptions, behaviorProfile = createDefaultModelBehaviorProfile() } = input;
  // 非官方兼容网关的 thinking 可能缺签名且不支持 redacted_thinking：提取与回放都启用容忍开关。
  const tolerateUnsignedThinking = !isOfficialAnthropicBaseUrl(baseUrl);
  return {
    behaviorProfile,
    async sample(messages, tools, options, onDelta) {
      const model = sampleOptions.model;
      if (!model || !apiKey) throw new AgentSampleError("Anthropic Messages 缺少模型或凭据", "PROVIDER_REQUEST_REJECTED");
      const client = new Anthropic({
        baseURL: baseUrl ?? "https://api.anthropic.com",
        apiKey: authMode === "api_key" ? apiKey : null,
        authToken: authMode === "bearer" ? apiKey : null,
        maxRetries: 0,
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      });
      try {
        const stream = client.messages.stream(
          createAnthropicMessagesRequest(model, messages, tools, { ...sampleOptions, toolChoice: options.toolChoice }, options.maxTokens ?? sampleOptions.maxTokens ?? 8_192, tolerateUnsignedThinking),
          { signal: options.signal },
        );
        stream.on("text", function collectTextDelta(delta) {
          recordPerformanceDiagnostic("provider_delta_arrived", "answer_delta");
          onDelta?.(delta);
        });
        const message = await stream.finalMessage();
        const result = extractAnthropicResult(message, tolerateUnsignedThinking);
        if (result.toolCalls.length === 0 && !result.content.trim()) {
          throw new AgentSampleError("模型未返回可显示正文或工具调用", "EMPTY_RESPONSE");
        }
        if (message.stop_reason === "max_tokens" && result.toolCalls.length === 0) {
          throw new AgentSampleError("模型输出达到上限，未形成完整可执行结果", "MODEL_OUTPUT_LIMIT");
        }
        const inputTokens = message.usage.input_tokens;
        const outputTokens = message.usage.output_tokens;
        return {
          ...result,
          reasoningSummary: result.toolCalls.length > 0 ? `模型请求调用 ${result.toolCalls.map(function getToolName(call) { return call.name; }).join("、")}` : "模型已完成当前步骤判断",
          finishReason: normalizeFinishReason(message.stop_reason),
          ...(Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) && inputTokens >= 0 && outputTokens >= 0
            ? { usage: { inputTokens, outputTokens, contextTokens: inputTokens + outputTokens } }
            : {}),
        };
      } catch (error) {
        normalizeProviderError(error, options.signal);
      }
    },
  };
}
