/**
 * web_search 工具：将最小查询交给宿主注入的公开网络搜索能力，并生成有界结果。
 */

import { z } from "zod";
import { isWebSearchCapabilityError, type WebSearchCapabilityError, type WebSearchCapability, type WebSearchResult, type WebSearchSource } from "../../../runtime/protocol/web-capability";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { AgentToolDefinition, ToolActionFacts } from "../types";

const MAX_ANSWER_BYTES = 24 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SOURCE_COUNT = 10;
const MAX_SOURCE_TITLE_BYTES = 512;
const MAX_SOURCE_URL_BYTES = 2 * 1024;
const MAX_SOURCE_SNIPPET_BYTES = 2 * 1024;

const webSearchSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
}).strict();

type WebSearchInput = z.infer<typeof webSearchSchema>;

/** 在 UTF-8 字节预算内截断文本，并避免切断代理对。 */
function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  const suffix = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= budget) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value.charAt(low - 1))) low--;
  return { value: `${value.slice(0, low)}${suffix}`, truncated: true };
}

/** 只保留无 userinfo 的 HTTP(S) 来源 URL，并返回规范化字符串。 */
function normalizeSourceUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** 归一化一条不可信搜索来源；非法或空来源不会进入 Agent 观察。 */
function normalizeSource(source: WebSearchSource): { source?: WebSearchSource; truncated: boolean } {
  const normalizedUrl = normalizeSourceUrl(source.url);
  const title = truncateUtf8(source.title.trim(), MAX_SOURCE_TITLE_BYTES);
  if (!normalizedUrl || !title.value) return { truncated: true };
  const url = truncateUtf8(normalizedUrl, MAX_SOURCE_URL_BYTES);
  if (url.truncated) return { truncated: true };
  const snippet = source.snippet === undefined
    ? undefined
    : truncateUtf8(source.snippet.trim(), MAX_SOURCE_SNIPPET_BYTES);
  return {
    source: {
      title: title.value,
      url: url.value,
      ...(snippet?.value ? { snippet: snippet.value } : {}),
    },
    truncated: title.truncated || snippet?.truncated === true,
  };
}

/** 对 capability 结果执行第二层有界化，防止错误 Adapter 产生无界 Agent 输入。 */
function normalizeSearchResult(result: WebSearchResult): WebSearchResult {
  const answer = truncateUtf8(result.answer, MAX_ANSWER_BYTES);
  const sources: WebSearchSource[] = [];
  let truncated = result.truncated || answer.truncated || result.sources.length > MAX_SOURCE_COUNT;
  for (const candidate of result.sources.slice(0, MAX_SOURCE_COUNT)) {
    const normalized = normalizeSource(candidate);
    truncated = truncated || normalized.truncated;
    if (!normalized.source) continue;
    const next = { answer: answer.value, sources: [...sources, normalized.source], truncated };
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_OUTPUT_BYTES) {
      truncated = true;
      break;
    }
    sources.push(normalized.source);
  }
  return { answer: answer.value, sources, truncated };
}

/** 为已启用的搜索能力生成无需逐次审批的外部查询事实。 */
function createWebSearchActionFacts(): ToolActionFacts {
  return {
    toolName: "web_search",
    effect: "external",
    destructive: false,
    operation: "search_public_web",
    resource: "public web",
    risk: "external_side_effect",
  };
}

/** 判断异常是否已经携带 Core 认可的稳定 ToolError。 */
function hasStableToolError(error: unknown): error is Error & { toolError: { code: string; message: string } } {
  return Boolean(error && typeof error === "object" && "toolError" in error);
}

/** 将 capability 稳定错误码再次收敛为 Core 固定文案，禁止信任 Adapter 自带消息。 */
function getWebSearchCapabilityErrorMessage(code: WebSearchCapabilityError["code"]): string {
  if (code === "CAPABILITY_UNAVAILABLE") return "网络搜索能力不可用";
  if (code === "WEB_SEARCH_RATE_LIMITED") return "网络搜索服务当前限流";
  return "网络搜索请求被服务拒绝";
}

/** 创建绑定当前宿主搜索能力的只读外部工具。 */
export function createWebSearchTool(capability: WebSearchCapability): AgentToolDefinition<WebSearchInput, WebSearchResult> {
  /** 调用宿主能力并把未知异常收敛为不泄露 Provider 正文的稳定错误。 */
  async function executeWebSearch(input: WebSearchInput, context: Parameters<AgentToolDefinition<WebSearchInput, WebSearchResult>["execute"]>[1]): Promise<WebSearchResult> {
    try {
      return normalizeSearchResult(await capability.search({ query: input.query, signal: context.signal }));
    } catch (error) {
      if (context.signal?.aborted) throw createToolError(TOOL_ERROR_CODES.EXECUTION_CANCELLED, "用户已取消网络搜索");
      if (isWebSearchCapabilityError(error)) throw createToolError(error.code, getWebSearchCapabilityErrorMessage(error.code));
      if (hasStableToolError(error)) throw error;
      throw createToolError(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, "网络搜索失败");
    }
  }

  return {
    name: "web_search",
    description: "搜索当前或外部公开信息并返回有界答案与来源。需要最新事实时应先使用本工具；不要发送凭据、秘密或私有文档正文，也不要用 run_command、curl 或抓取搜索结果页代替。",
    inputSchema: webSearchSchema,
    metadata: {
      effect: "external",
      destructive: false,
      concurrency: { max: 1, resourceKey: "web:search" },
      retry: { safe: false },
      // 采用 CC 本地非流式 API 的 300 秒预算，覆盖服务端搜索与后续推理全过程。
      timeout: { defaultMs: 300_000, maxMs: 300_000 },
    },
    createActionFacts: createWebSearchActionFacts,
    execute: executeWebSearch,
    /** 输出已经过本地有界化，可直接作为 Agent 工具观察。 */
    serializeOutput(output) { return output; },
  };
}
