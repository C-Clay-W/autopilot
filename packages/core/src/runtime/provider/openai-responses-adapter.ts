/**
 * runtime/provider/openai-responses-adapter.ts — 主模型 Responses 请求、终态校验和私有历史回放。
 * 只消费 Turn 冻结配置与受信 imageData，输出既有中立采样结果。
 */
import { AgentSampleError, type AgentModelToolDefinition, type AgentSampleResult, type AgentSampleUsage } from "../../internal/lib/llm";
import type { ModelSampler, ModelImageData } from "../../internal/kernel/model-sampler";
import type { ModelSampleOptions } from "../../internal/types";
import { CanonicalMessageError, getAgentMessageText, validateAgentMessages, type AgentMessage, type AgentContentBlock } from "../../internal/types/agent-message";
import type { CompatibilityPreset, OpenAiResponsesProtocolProfile } from "./api-protocol";
import { getCompatibilityPresetPolicy } from "./compatibility-presets";
import { createDefaultModelBehaviorProfile } from "./model-behavior-profile";
import { normalizeProviderHttpFailure, parseRetryAfterMs } from "./provider-failure-normalization";

/** 回放身份仅使用非凭据的精确冻结路由。 */
interface ReplayBinding { apiProtocol: "openai-responses"; routeId: string; baseUrl: string; modelId: string }
/** Responses 输出项只在私有 Adapter 边界存在。 */
type OutputItem = Record<string, unknown>;
/** 单个已冻结 Responses sampler 的输入。 */
export interface CreateOpenAiResponsesSamplerInput {
  routeId: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  sampleOptions: ModelSampleOptions;
  protocolProfile?: OpenAiResponsesProtocolProfile;
  compatibilityPreset?: CompatibilityPreset;
}

/** 将受信图片引用转换为协议图片，拒绝缺失的图片数据。 */
function imagePart(reference: { id: string }, imageData?: ModelImageData): Record<string, unknown> {
  const image = imageData?.[reference.id];
  if (!image) throw new CanonicalMessageError("会话图片不可用");
  return { type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` };
}

/** 从完整输出项提取公共文本和工具调用，拒绝不支持的托管工具或未完成参数。 */
function projectOutput(items: OutputItem[]): Pick<AgentSampleResult, "content" | "toolCalls"> {
  let content = "";
  const toolCalls: AgentSampleResult["toolCalls"] = [];
  for (const item of items) {
    if (item.status !== undefined && item.status !== "completed") throw new AgentSampleError("Responses 输出项尚未完成", "STREAM_INCOMPLETE");
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content)) throw new AgentSampleError("Responses 消息非法", "STREAM_INCOMPLETE");
      for (const part of item.content) {
        if (part?.type !== "output_text" || typeof part.text !== "string") throw new AgentSampleError("Responses 消息内容不受支持", "PROVIDER_REQUEST_REJECTED");
        content += part.text;
      }
    } else if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") throw new AgentSampleError("Responses 工具调用未完成", "TOOL_CALL_TRUNCATED");
      let args: unknown;
      try { args = JSON.parse(item.arguments); } catch { throw new AgentSampleError("Responses 工具参数 JSON 非法", "TOOL_CALL_INVALID_JSON"); }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new AgentSampleError("Responses 工具参数必须为对象", "TOOL_CALL_INVALID_JSON");
      if (toolCalls.some(function duplicate(call) { return call.id === item.call_id; })) throw new AgentSampleError("Responses 工具 call_id 重复", "TOOL_CALL_TRUNCATED");
      toolCalls.push({ id: item.call_id, name: item.name, input: args });
    } else if (item.type !== "reasoning") {
      throw new AgentSampleError("Responses 返回了不支持的输出项", "PROVIDER_REQUEST_REJECTED");
    }
  }
  return { content, toolCalls };
}

/** 校验 reasoning 回放策略，仅保留服务端原始值而不生成或解释思考。 */
function validateReasoning(items: OutputItem[], profile: OpenAiResponsesProtocolProfile): void {
  for (const item of items) {
    if (item.type !== "reasoning") continue;
    const encrypted = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;
    const content = Array.isArray(item.content) && item.content.length > 0;
    if (profile.reasoningReplay === "encrypted" && encrypted && !content) continue;
    if (profile.reasoningReplay === "content" && content && !encrypted) continue;
    // 没有必要私有负载的 summary-only 项无需回传。
    if (!encrypted && !content) continue;
    throw new AgentSampleError("当前 replay 策略无法保留 Responses 推理状态", "PROVIDER_REQUEST_REJECTED");
  }
}

/** 比较回放绑定，路由、规范化端点或精确模型变化时仅发送 canonical 公共内容。 */
function matchesBinding(value: unknown, binding: ReplayBinding): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.apiProtocol === binding.apiProtocol && candidate.routeId === binding.routeId && candidate.baseUrl === binding.baseUrl && candidate.modelId === binding.modelId;
}

/** 校验私有回放与所属公共消息一致，避免双发、错配或恢复后改变工具身份。 */
function replayItems(message: AgentMessage, binding: ReplayBinding, profile: OpenAiResponsesProtocolProfile): OutputItem[] | undefined {
  if (message.adapterReplayState?.apiProtocol !== "openai-responses") return undefined;
  const value = message.adapterReplayState.value as { binding?: unknown; items?: unknown } | null;
  if (!value || !matchesBinding(value.binding, binding)) return undefined;
  if (!Array.isArray(value.items) || value.items.some(function invalid(item) { return !item || typeof item !== "object" || Array.isArray(item); })) throw new CanonicalMessageError("Responses replay 项非法");
  const items = value.items as OutputItem[];
  validateReasoning(items, profile);
  const projected = projectOutput(items);
  const canonicalCalls = message.content.flatMap(function calls(block) { return block.type === "tool-call" ? [{ id: block.id, name: block.name, input: block.input }] : []; });
  if (projected.content !== getAgentMessageText(message) || JSON.stringify(projected.toolCalls) !== JSON.stringify(canonicalCalls)) throw new CanonicalMessageError("Responses replay 与公共消息不一致");
  return items;
}

/** 将规范历史逐项转换，工具结果保留 call_id，与输出 item ID 分离。 */
export function createOpenAiResponsesRequest(input: CreateOpenAiResponsesSamplerInput & { messages: AgentMessage[]; tools: AgentModelToolDefinition[]; options?: ModelSampleOptions; imageData?: ModelImageData }): Record<string, unknown> {
  const binding: ReplayBinding = { apiProtocol: "openai-responses", routeId: input.routeId, baseUrl: normalizeBaseUrl(input.baseUrl ?? ""), modelId: input.sampleOptions.model ?? "" };
  const profile = input.protocolProfile ?? { apiProtocol: "openai-responses", reasoningReplay: "none" };
  const items: OutputItem[] = [];
  for (const message of validateAgentMessages(input.messages)) {
    const replay = replayItems(message, binding, profile);
    if (replay) { items.push(...replay); continue; }
    const result = message.content[0];
    if (result?.type === "tool-result") {
      const text = (result.isError ? "工具执行失败：\n" : "") + result.content.map(function text(part) { return part.text; }).join("\n");
      const output = result.images?.length ? [{ type: "input_text", text }, ...result.images.map(function image(reference) { return imagePart(reference, input.imageData); })] : text;
      items.push({ type: "function_call_output", call_id: result.toolCallId, output });
      continue;
    }
    if (message.role !== "assistant") {
      items.push({ role: message.role, content: message.content.map(function part(block) { return block.type === "image-ref" ? imagePart(block, input.imageData) : { type: "input_text", text: (block as Extract<AgentContentBlock, { type: "text" }>).text }; }) });
      continue;
    }
    // 按 canonical 顺序输出正文和工具，私有 reasoning 只允许走绑定 replay。
    for (const block of message.content) {
      if (block.type === "text") items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: block.text }] });
      if (block.type === "tool-call") items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
    }
  }
  const options = { ...input.sampleOptions, ...input.options };
  const body: Record<string, unknown> = { model: binding.modelId, input: items, stream: true };
  if (input.tools.length) {
    body.tools = input.tools.map(function tool(definition) { return { type: "function", ...definition.function, strict: false }; });
    body.tool_choice = options.toolChoice ? { type: "function", name: options.toolChoice.name } : "auto";
  }
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.reasoningEffort !== undefined) body.reasoning = { effort: options.reasoningEffort };
  if (getCompatibilityPresetPolicy(input.compatibilityPreset).responses.samplingWithoutReasoning && options.reasoningEffort === "none") {
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
  }
  if (profile.reasoningReplay === "encrypted") { body.store = false; body.include = ["reasoning.encrypted_content"]; }
  return body;
}

/** 规范化回放端点，不依赖 route 名称或凭据。 */
function normalizeBaseUrl(baseUrl: string): string {
  try { const url = new URL(baseUrl); url.pathname = url.pathname.replace(/\/+$/, ""); return url.toString().replace(/\/+$/, ""); } catch { return baseUrl.replace(/\/+$/, ""); }
}

/** usage 总量已包含缓存与 reasoning 子项，不重复相加。 */
function normalizeUsage(value: unknown): AgentSampleUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const contextTokens = usage.total_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number" || typeof contextTokens !== "number" || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || !Number.isSafeInteger(contextTokens) || inputTokens < 0 || outputTokens < 0 || contextTokens !== inputTokens + outputTokens) return undefined;
  const reasoningTokens = (usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens;
  return { inputTokens, outputTokens, contextTokens, ...(typeof reasoningTokens === "number" && Number.isSafeInteger(reasoningTokens) && reasoningTokens >= 0 && reasoningTokens <= outputTokens ? { reasoningTokens } : {}) };
}

/** 创建复用 fetch、取消和既有错误归一化机制的 Responses sampler。 */
export function createOpenAiResponsesSampler(input: CreateOpenAiResponsesSamplerInput): ModelSampler {
  return {
    behaviorProfile: createDefaultModelBehaviorProfile(),
    async sample(messages, tools, options, onDelta) {
      if (!input.baseUrl || !input.apiKey || !input.sampleOptions.model) throw new AgentSampleError("Responses 缺少模型、端点或凭据", "PROVIDER_REQUEST_REJECTED");
      const controller = new AbortController();
      let timedOut = false;
      let started = false;
      /** 转发用户取消，不将取消改写为供应商错误。 */
      function abort(): void { controller.abort(); }
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(function timeout() { timedOut = true; abort(); }, input.timeoutMs ?? 600_000);
      timer.unref?.();
      try {
        const body = createOpenAiResponsesRequest({ ...input, messages, tools, options: { ...input.sampleOptions, toolChoice: options.toolChoice, maxTokens: Math.min(options.maxTokens ?? input.sampleOptions.maxTokens ?? input.maxOutputTokens ?? 8_192, input.sampleOptions.maxTokens ?? Infinity, input.maxOutputTokens ?? Infinity) }, imageData: options.imageData });
        const response = await fetch(`${normalizeBaseUrl(input.baseUrl)}/responses`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` }, body: JSON.stringify(body), signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!response.ok) {
          const errorBody = await response.text();
          if (/(context[_\s-]?(length|window)|maximum context|too many tokens)/i.test(errorBody) && [400, 413, 422].includes(response.status)) throw new AgentSampleError("模型上下文超过供应商窗口", "CONTEXT_OVERFLOW");
          const failure = normalizeProviderHttpFailure(input.baseUrl, response.status, errorBody);
          throw new AgentSampleError("供应商请求失败", failure.code, undefined, response.status, failure.reason, failure.detail, parseRetryAfterMs(response.headers.get("retry-after")));
        }
        const reader = response.body?.getReader();
        if (!reader) throw new AgentSampleError("Responses 流不可读", "STREAM_INCOMPLETE");
        started = true;
        const decoder = new TextDecoder();
        let buffer = "";
        let terminal: Record<string, unknown> | undefined;
        const completedItems = new Map<number, OutputItem>();
        const textDeltas = new Map<number, string>();
        const argumentDeltas = new Map<number, string>();
        /** 消费完整 SSE 事件，delta 只展示，完整 item 与终态决定可执行结果。 */
        function consume(event: string): void {
          const data = event.split("\n").filter(function dataLine(line) { return line.startsWith("data:"); }).map(function payload(line) { return line.slice(5).trimStart(); }).join("\n");
          if (!data) return;
          let payload: Record<string, any>;
          try { payload = JSON.parse(data); } catch { throw new AgentSampleError("Responses SSE JSON 非法", "STREAM_INCOMPLETE"); }
          if (!payload || typeof payload !== "object") throw new AgentSampleError("Responses SSE 事件非法", "STREAM_INCOMPLETE");
          if (terminal) throw new AgentSampleError("Responses 终态后存在额外事件", "STREAM_INCOMPLETE");
          const index = payload.output_index;
          if (payload.type === "response.output_text.delta") {
            if (!Number.isSafeInteger(index) || index < 0 || typeof payload.delta !== "string") throw new AgentSampleError("Responses 文本分片非法", "STREAM_INCOMPLETE");
            textDeltas.set(index, (textDeltas.get(index) ?? "") + payload.delta);
            onDelta?.(payload.delta);
          } else if (payload.type === "response.function_call_arguments.delta") {
            if (!Number.isSafeInteger(index) || index < 0 || typeof payload.delta !== "string") throw new AgentSampleError("Responses 参数分片非法", "STREAM_INCOMPLETE");
            argumentDeltas.set(index, (argumentDeltas.get(index) ?? "") + payload.delta);
          } else if (payload.type === "response.output_item.done") {
            if (!Number.isSafeInteger(index) || index < 0 || !payload.item || typeof payload.item !== "object" || completedItems.has(index)) throw new AgentSampleError("Responses 完整输出项非法", "STREAM_INCOMPLETE");
            completedItems.set(index, payload.item);
          } else if (["response.completed", "response.incomplete", "response.failed"].includes(payload.type)) {
            if (!payload.response || typeof payload.response !== "object") throw new AgentSampleError("Responses 终态非法", "STREAM_INCOMPLETE");
            terminal = { ...payload.response, eventType: payload.type };
          } else if (payload.type === "error") {
            const failure = normalizeProviderHttpFailure(input.baseUrl!, undefined, JSON.stringify({ error: payload.error ?? payload }));
            throw new AgentSampleError("供应商流返回错误", failure.code, undefined, undefined, failure.reason, failure.detail);
          }
        }
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) { buffer += decoder.decode(); break; }
            buffer += decoder.decode(chunk.value, { stream: true });
            buffer = buffer.replace(/\r\n/g, "\n");
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); boundary = buffer.indexOf("\n\n"); }
            if (terminal) break;
          }
          if (!terminal && buffer.trim()) consume(buffer.replace(/\r\n/g, "\n"));
        } finally { await reader.cancel().catch(function ignoreCancel() {}); reader.releaseLock(); }
        if (!terminal) throw new AgentSampleError("Responses 缺少协议终态", "STREAM_INCOMPLETE");
        if (terminal.eventType === "response.incomplete" || terminal.status === "incomplete") {
          const reason = (terminal.incomplete_details as { reason?: string } | undefined)?.reason;
          throw new AgentSampleError("Responses 未形成完整结果", reason === "max_output_tokens" ? "MODEL_OUTPUT_LIMIT" : "STREAM_INCOMPLETE");
        }
        controller.signal.throwIfAborted();
        if (terminal.eventType === "response.failed" || terminal.status === "failed") {
          if ((terminal.error as { code?: string } | undefined)?.code === "context_length_exceeded") throw new AgentSampleError("模型上下文超过供应商窗口", "CONTEXT_OVERFLOW");
          const failure = normalizeProviderHttpFailure(input.baseUrl, undefined, JSON.stringify({ error: terminal.error }));
          throw new AgentSampleError("供应商响应失败", failure.code, undefined, undefined, failure.reason, failure.detail);
        }
        if (terminal.status !== "completed" || !Array.isArray(terminal.output)) throw new AgentSampleError("Responses 完成事件缺少完整输出", "STREAM_INCOMPLETE");
        const items = terminal.output as OutputItem[];
        if (items.some(function invalid(item) { return !item || typeof item !== "object" || Array.isArray(item); })) throw new AgentSampleError("Responses 最终输出非法", "STREAM_INCOMPLETE");
        // 最终 output 可以单独携带完整项；已收到的 done 和 delta 必须与之相符。
        for (const [index, item] of completedItems) {
          const final = items[index];
          if (!final || item.type !== final.type || item.id !== final.id || JSON.stringify(projectOutput([item])) !== JSON.stringify(projectOutput([final]))) throw new AgentSampleError("Responses 完整输出项不一致", "STREAM_INCOMPLETE");
          // output_item.done 是流式回放的完整权威项，added 或终态摘要可能不带完整加密负载。
          items[index] = item;
        }
        for (const [index, text] of textDeltas) {
          if (!items[index] || projectOutput([items[index]]).content !== text) throw new AgentSampleError("Responses 文本分片未完成", "STREAM_INCOMPLETE");
        }
        for (const [index, args] of argumentDeltas) {
          if (!items[index] || items[index].type !== "function_call" || items[index].arguments !== args) throw new AgentSampleError("Responses 工具参数分片未完成", "TOOL_CALL_TRUNCATED");
        }
        const profile = input.protocolProfile ?? { apiProtocol: "openai-responses", reasoningReplay: "none" };
        validateReasoning(items, profile);
        const projected = projectOutput(items);
        if (!projected.content.trim() && !projected.toolCalls.length) throw new AgentSampleError("Responses 未返回正文或工具调用", "EMPTY_RESPONSE");
        if (!textDeltas.size && projected.content) onDelta?.(projected.content);
        const usage = normalizeUsage(terminal.usage);
        return { ...projected, reasoningSummary: projected.toolCalls.length ? "模型请求调用工具" : "模型已完成当前步骤判断", finishReason: projected.toolCalls.length ? "tool_calls" : "stop", ...(usage ? { usage } : {}), adapterReplayState: { apiProtocol: "openai-responses", value: { binding: { apiProtocol: "openai-responses", routeId: input.routeId, baseUrl: normalizeBaseUrl(input.baseUrl), modelId: input.sampleOptions.model }, items } } };
      } catch (error) {
        if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
        if (timedOut) throw new AgentSampleError("供应商请求超时", "PROVIDER_TIMEOUT");
        if (error instanceof AgentSampleError || error instanceof CanonicalMessageError) throw error;
        throw new AgentSampleError(started ? "Responses 流提前结束" : "无法连接模型供应商", started ? "STREAM_INCOMPLETE" : "PROVIDER_CONNECTION");
      } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
    },
  };
}
