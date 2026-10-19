/** Fetch 重定向的进程内续接绑定；原始目标与跳数不进入任何公开结果或 durable checkpoint。 */
import type { AgentMessage, AgentJsonObject } from "../types/agent-message";
import type { AgentToolCall } from "../types";
import type { ToolExecutionResult } from "./types";

const budgets = new WeakMap<object, number>();
const pendingInputs = new WeakMap<ToolExecutionResult, AgentJsonObject>();

/** 将可信 Adapter 的重定向转换成必须重新经过 Schema/Policy 的工具输入。 */
export class WebFetchRedirect extends Error {
  readonly input: { url: string; prompt?: string };
  /** 绑定重定向剩余跳数；模型参数不能制造这项进程内授权。 */
  constructor(url: string, prompt: string | undefined, remainingRedirects: number) {
    super("网页重定向需要重新校验目标域名");
    this.input = { url, ...(prompt ? { prompt } : {}) };
    budgets.set(this.input, remainingRedirects);
  }
}

/** 只从原始请求对象的私有绑定中读取剩余重定向预算。 */
export function getWebFetchRedirectBudget(input: unknown): number | undefined {
  return input !== null && typeof input === "object" ? budgets.get(input) : undefined;
}

/** 为待审批结果保留最终目标输入；多次自动授权跳转不能覆盖更深一跳的绑定。 */
export function bindWebFetchRedirect(result: ToolExecutionResult, input: AgentJsonObject): void {
  if (result.status === "approval_required" && !pendingInputs.has(result)) pendingInputs.set(result, input);
}

/** 冻结待审批目标并丢弃旧 wire replay；保留 call ID 和工具配对，审批哈希绑定新目标。 */
export function applyWebFetchRedirect(call: AgentToolCall, result: ToolExecutionResult, messages: AgentMessage[]): void {
  const input = pendingInputs.get(result);
  if (!input || call.name !== "web_fetch") return;
  call.input = input;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message.content.some(function matchesCall(block) { return block.type === "tool-call" && block.id === call.id; })) continue;
    messages[index] = { role: message.role, content: message.content.flatMap(function rebindCall(block) {
      if (block.type === "reasoning") return [];
      return [block.type === "tool-call" && block.id === call.id ? { ...block, input } : block];
    }) };
  }
}
