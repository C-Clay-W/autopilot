/**
 * LLM 调用封装（OpenAI 兼容接口）
 *
 * - 支持 DeepSeek / OpenAI / 智谱 / 百炼 / 本地 LM Studio 等任何 OpenAI 兼容端点
 * - 配置通过环境变量注入，方便在 core 外部修改
 *
 * 环境变量（从项目根 .env 读取）：
 *   LLM_BASE_URL   — API 端点（默认 https://api.deepseek.com）
 *   LLM_API_KEY    — API Key（必填，未配置时调用 askLLM 会抛错）
 *   LLM_MODEL      — 模型名（默认 deepseek-v4-flash）
 */

const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.deepseek.com";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-v4-flash";

/** LOOP_LLM 配置供 Agent Loop、检索精排和 HyDE 复用。 */
const LOOP_LLM_BASE_URL = process.env.LOOP_LLM_BASE_URL || "";
const LOOP_LLM_API_KEY = process.env.LOOP_LLM_API_KEY || "";
const LOOP_LLM_MODEL = process.env.LOOP_LLM_MODEL || "";
/** Agent Loop 单次采样的输出 token 上限；未设置时按 8192 兜底，避免 write_file 等大输出被截断。 */
const LOOP_LLM_MAX_TOKENS = Number(process.env.LOOP_LLM_MAX_TOKENS) || 8192;

import type { AgentToolCall, ChatMessage, LLMOptions, LLMResponse } from "../types";

/** Agent 原生工具采样的模型可见定义。 */
export interface AgentModelToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
/** 流式采样完成后的完整结果；raw reasoning 永不向上层透传。 */
export interface AgentSampleResult {
  content: string;
  toolCalls: AgentToolCall[];
  reasoningSummary: string;
  /** OpenAI 兼容流的 finish_reason，用于诊断输出上限/截断 */
  finishReason?: string;
  /**
   * 思考模式工具调用续接专用内部字段（DeepSeek reasoning_content 原文）。
   * 仅在当前 Turn 内部消息/checkpoint 中保留并回传 Provider；不进入 CLI/JSONL/日志/公开 DTO。
   */
  reasoningContent?: string;
  /**
   * 同协议 Adapter 可重放的私有原始状态；Kernel 只透传到 V2 checkpoint，
   * 绝不读取内部 wire 字段或向事件、日志、Browser 投影。
   */
  adapterReplayState?: import("../types/agent-message").AgentMessage["adapterReplayState"];
  /**
   * 当前完整 Provider 响应的归一化用量；仅供 Core 内部锚点使用，绝不投影到 CLI、JSONL、日志或公共 DTO。
   * total_tokens 已包含 input/output，不能再次累加。
   */
  usage?: AgentSampleUsage;
}

/** 当前完整 Provider 响应的内部 context usage；字段名与 OpenAI 兼容字段一一对应。 */
export interface AgentSampleUsage {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
}


/** 结构化采样错误码，用于 Agent Loop 恢复决策 */
export type AgentSampleErrorCode =
  | "CONTEXT_OVERFLOW"
  | "MODEL_OUTPUT_LIMIT"
  | "TOOL_CALL_TRUNCATED"
  | "TOOL_CALL_INVALID_JSON"
  | "STREAM_INCOMPLETE"
  | "EMPTY_RESPONSE"
  | "PROVIDER_CONNECTION"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_SERVER_ERROR"
  | "PROVIDER_REQUEST_REJECTED";

/** Agent Provider 单次请求超时；用户取消仍由调用方 AbortSignal 独立控制。 */
const DEFAULT_AGENT_PROVIDER_TIMEOUT_MS = 120_000;

/** 结构化采样错误，携带错误码与脱敏诊断信息 */
export class AgentSampleError extends Error {
  constructor(
    message: string,
    public readonly code: AgentSampleErrorCode,
    /** 参数累计字节数（脱敏后仅保留数值） */
    public readonly argBytes?: number,
  ) {
    super(message);
    this.name = "AgentSampleError";
  }
}
/** OpenAI 兼容视觉消息中的图片内容块 */
interface VisionImageContent {
  type: "image_url";
  image_url: { url: string };
}

/** OpenAI 兼容视觉消息内容 */
type VisionMessageContent = { type: "text"; text: string } | VisionImageContent;

/** OpenAI 兼容视觉消息 */
interface VisionChatMessage {
  role: "system" | "user" | "assistant";
  content: string | VisionMessageContent[];
}

/**
 * 调用 LLM 聊天补全接口
 *
 * @param messages 对话消息列表
 * @param options 调用选项
 * @returns LLM 回复 + 用量信息
 * @throws 当 API Key 未配置或 API 调用失败时抛出
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: LLMOptions = {}
): Promise<LLMResponse> {
  if (!LLM_API_KEY) {
    throw new Error(
      "LLM_API_KEY 未配置。请在项目根 .env 文件中设置 LLM_API_KEY=你的key"
    );
  }

  const { temperature = 0.3, maxTokens = 1024, thinking, reasoningEffort, signal } = options;

  // 构建请求体：基础参数
  const body: Record<string, unknown> = {
    model: LLM_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  // DeepSeek 思考模式（配置了才添加到请求中）
  if (thinking) {
    body.thinking = { type: thinking };
  }
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `LLM API 调用失败 (${response.status}): ${errBody.slice(0, 300)}`
    );
  }

  const json = (await response.json()) as {
    choices: { message: { content: string; reasoning_content?: string } }[];
    model: string;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      completion_tokens_details?: {
        reasoning_tokens?: number;
      };
    };
  };

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM API 返回空内容");
  }

  return {
    answer: content,
    model: json.model || LLM_MODEL,
    usage: json.usage
      ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * 快捷方法：给定系统提示 + 用户消息，返回 LLM 回复文本
 *
 * @param systemPrompt 系统提示
 * @param userMessage 用户消息
 * @param options 调用选项
 * @param history 历史对话消息（可选，插在 system 和 user 之间，用于多轮对话）
 * @returns LLM 回复文本
 */
export async function askLLM(
  systemPrompt: string,
  userMessage: string,
  options: LLMOptions = {},
  history?: ChatMessage[]
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];
  if (history && history.length > 0) {
    messages.push(...history);
  }
  messages.push({ role: "user", content: userMessage });

  const { answer } = await chatCompletion(messages, options);
  return answer;
}

/** 使用 LOOP_LLM_* 的文本模型执行检索精排或 HyDE，不影响常规问答模型配置。 */
export async function askLoopLLM(
  systemPrompt: string,
  userMessage: string,
  options: LLMOptions = {}
): Promise<string> {
  if (!LOOP_LLM_BASE_URL || !LOOP_LLM_API_KEY || !LOOP_LLM_MODEL) {
    throw new Error("LOOP_LLM_BASE_URL、LOOP_LLM_API_KEY 或 LOOP_LLM_MODEL 未配置");
  }

  const { temperature = 0, maxTokens = 512, thinking, reasoningEffort, signal } = options;
  const body: Record<string, unknown> = {
    model: LOOP_LLM_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature,
    max_tokens: maxTokens,
  };
  if (thinking) body.thinking = { type: thinking };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const response = await fetch(`${LOOP_LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LOOP_LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`LOOP_LLM API 调用失败 (${response.status}): ${errorBody.slice(0, 300)}`);
  }

  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("LOOP_LLM API 返回空内容");
  return content;
}

/**
 * 将文本和受控图片 data URL 组装为 OpenAI 兼容的视觉用户消息。
 *
 * @param userMessage 用户问题与检索上下文
 * @param imageDataUrls 已通过存储路径校验的图片 data URL
 * @returns 可直接传给视觉聊天模型的 user message
 */
function createVisionUserMessage(userMessage: string, imageDataUrls: string[]): VisionChatMessage {
  if (imageDataUrls.length === 0) {
    return { role: "user", content: userMessage };
  }

  return {
    role: "user",
    content: [
      { type: "text", text: userMessage },
      ...imageDataUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ],
  };
}

/**
 * 调用视觉 LLM 完成文本或图文问答。
 *
 * @param systemPrompt 系统提示
 * @param userMessage 用户问题与检索上下文
 * @param imageDataUrls 已校验的图片 data URL；为空时自动降级为纯文本消息
 * @param options 调用选项
 * @param history 历史文本对话
 * @returns LLM 回复文本
 */
export async function askLLMWithImages(
  systemPrompt: string,
  userMessage: string,
  imageDataUrls: string[],
  options: LLMOptions = {},
  history?: ChatMessage[]
): Promise<string> {
  if (!LLM_API_KEY) {
    throw new Error("LLM_API_KEY 未配置。请在项目根 .env 文件中设置 LLM_API_KEY=你的key");
  }

  const { temperature = 0.3, maxTokens = 1024, thinking, reasoningEffort, signal } = options;
  const messages: VisionChatMessage[] = [{ role: "system", content: systemPrompt }];
  if (history && history.length > 0) {
    messages.push(...history);
  }
  messages.push(createVisionUserMessage(userMessage, imageDataUrls));

  const body: Record<string, unknown> = {
    model: LLM_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (thinking) body.thinking = { type: thinking };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`视觉 LLM API 调用失败 (${response.status})`);
  }

  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("视觉 LLM API 返回空内容");
  }
  return content;
}

/**
 * 流式调用 LLM，逐个 token 返回（SSE 解析，OpenAI 兼容）
 *
 * 原理：
 * 1. 向 LLM API 发起 stream: true 的 POST 请求
 * 2. 通过 ReadableStream 逐 chunk 读取 SSE 数据
 * 3. 解析每行 "data: ..." 中的 JSON，提取 content delta
 * 4. 通过 AsyncGenerator 逐个 yield token 文本
 *
 * @param systemPrompt 系统提示
 * @param userMessage 用户消息
 * @param options 调用选项
 * @param history 历史对话消息（可选，插在 system 和 user 之间，用于多轮对话）
 * @yields token 文本片段
 *
 * added by clayw on 20260709
 */
export async function* askLLMStream(
  systemPrompt: string,
  userMessage: string,
  options: LLMOptions = {},
  history?: ChatMessage[]
): AsyncGenerator<string, void, undefined> {
  if (!LLM_API_KEY) {
    throw new Error(
      "LLM_API_KEY 未配置。请在项目根 .env 文件中设置 LLM_API_KEY=你的key"
    );
  }

  const { temperature = 0.3, maxTokens = 1024, thinking, reasoningEffort, signal } = options;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];
  if (history && history.length > 0) {
    messages.push(...history);
  }
  messages.push({ role: "user", content: userMessage });

  const body: Record<string, unknown> = {
    model: LLM_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
  };

  if (thinking) {
    body.thinking = { type: thinking };
  }
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `LLM API 流式调用失败 (${response.status}): ${errBody.slice(0, 300)}`
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("LLM API 流式响应 body 不可读");
  }

  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    // 最后一行可能不完整，保留到下次
    buf = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") return;

      try {
        const json = JSON.parse(dataStr) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          yield delta;
        }
      } catch {
        // 解析失败的行跳过（某些中间 chunk 可能格式异常）
      }
    }
  }
}

/**
 * 流式调用视觉 LLM，兼容纯文本与图文消息并逐个返回 token。
 *
 * @param systemPrompt 系统提示
 * @param userMessage 用户问题与检索上下文
 * @param imageDataUrls 已校验的图片 data URL；为空时自动降级为纯文本消息
 * @param options 调用选项
 * @param history 历史文本对话
 * @yields token 文本片段
 */
export async function* askLLMStreamWithImages(
  systemPrompt: string,
  userMessage: string,
  imageDataUrls: string[],
  options: LLMOptions = {},
  history?: ChatMessage[]
): AsyncGenerator<string, void, undefined> {
  if (!LLM_API_KEY) {
    throw new Error("LLM_API_KEY 未配置。请在项目根 .env 文件中设置 LLM_API_KEY=你的key");
  }

  const { temperature = 0.3, maxTokens = 1024, thinking, reasoningEffort, signal } = options;
  const messages: VisionChatMessage[] = [{ role: "system", content: systemPrompt }];
  if (history && history.length > 0) {
    messages.push(...history);
  }
  messages.push(createVisionUserMessage(userMessage, imageDataUrls));

  const body: Record<string, unknown> = {
    model: LLM_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
  };
  if (thinking) body.thinking = { type: thinking };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`视觉 LLM API 流式调用失败 (${response.status})`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("视觉 LLM API 流式响应 body 不可读");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const data = line.trim();
      if (!data || !data.startsWith("data:")) continue;
      const payload = data.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const token = json.choices?.[0]?.delta?.content;
        if (token) yield token;
      } catch {
        // 仅跳过不符合 SSE JSON 格式的中间行，保持流不中断。
      }
    }
  }
}
