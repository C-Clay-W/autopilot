/**
 * internal/types/agent-message.ts — Provider 中立 V2 消息内容块、校验与工具配对扫描。
 *
 * 本模块不包含任何 Provider wire 字段；它只定义 Core 私有 checkpoint 可持久化的
 * canonical 结构，并在采样、恢复和 compact 接入前提供纯校验原语。
 */

/** V2 canonical 消息允许的角色。 */
export type AgentMessageRole = "system" | "user" | "assistant";

/** V2 内容块使用的 JSON 对象输入。 */
export type AgentJsonObject = Record<string, unknown>;

/** V2 canonical 的 Provider 中立内容块。 */
export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; input: AgentJsonObject }
  | { type: "tool-result"; toolCallId: string; content: Array<{ type: "text"; text: string }>; isError: boolean };

/** V2 canonical 消息；replay state 只允许同协议 Adapter 在私有边界读取。 */
export interface AgentMessage {
  role: AgentMessageRole;
  content: AgentContentBlock[];
  adapterReplayState?: {
    apiProtocol: "anthropic-messages" | "openai-chat-completions";
    value: unknown;
  };
}

/** canonical 校验失败时使用的稳定本地错误。 */
export class CanonicalMessageError extends Error {
  readonly code = "CANONICAL_MESSAGE_INVALID";

  /** 创建不会携带 Provider 原始正文的 canonical 校验错误。 */
  constructor(message: string) {
    super(message);
    this.name = "CanonicalMessageError";
  }
}

/** 判断值是否为普通 JSON 对象，避免从 class、数组或恶意原型读取 canonical 字段。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/** 判断对象是否只包含给定的必填字段和可选字段。 */
function hasAllowedKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(function hasRequiredKey(key) { return Object.prototype.hasOwnProperty.call(value, key); })
    && keys.every(function hasAllowedKey(key) { return allowed.has(key); });
}

/** 判断对象是否只包含给定字段且字段集合完整。 */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(function isExpectedKey(key) { return expected.includes(key); });
}

/** 判断字符串是否为可作为稳定 ID、名称或正文使用的非空值。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 判断递归值是否可作为 JSON 值，并只把当前递归路径用于循环检测。 */
function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  if (!Array.isArray(value) && !isPlainRecord(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.every(function validateArrayItem(item) { return isJsonValue(item, ancestors); });
    return Object.values(value).every(function validateObjectItem(item) { return isJsonValue(item, ancestors); });
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

/** 判断值是否为可 JSON 持久化的普通对象。 */
function isJsonObject(value: unknown): value is AgentJsonObject {
  return isPlainRecord(value) && isJsonValue(value, new Set<object>());
}

/** 以稳定错误拒绝不符合 canonical 结构的值。 */
function failCanonical(message: string): never {
  throw new CanonicalMessageError(message);
}

/** 将未知 replay state 归一化为严格的私有协议引用。 */
function normalizeReplayState(value: unknown, messageIndex: number): AgentMessage["adapterReplayState"] | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) || !hasExactKeys(value, ["apiProtocol", "value"])) {
    failCanonical(`第 ${messageIndex} 条消息的 replay state 非法`);
  }
  if ((value.apiProtocol !== "anthropic-messages" && value.apiProtocol !== "openai-chat-completions")
    || !isJsonValue(value.value, new Set<object>())) {
    failCanonical(`第 ${messageIndex} 条消息的 replay state 非法`);
  }
  return { apiProtocol: value.apiProtocol, value: value.value };
}

/** 将未知 block 归一化为严格的 V2 block；空文本只在此处被删除。 */
function normalizeContentBlock(value: unknown, messageIndex: number, blockIndex: number): AgentContentBlock | undefined {
  if (!isPlainRecord(value) || typeof value.type !== "string") {
    failCanonical(`第 ${messageIndex} 条消息的第 ${blockIndex} 个内容块非法`);
  }
  if (value.type === "text" || value.type === "reasoning") {
    if (!hasExactKeys(value, ["type", "text"]) || typeof value.text !== "string") {
      failCanonical(`第 ${messageIndex} 条消息包含非法文本块`);
    }
    return value.text.length > 0 ? { type: value.type, text: value.text } : undefined;
  }
  if (value.type === "tool-call") {
    if (!hasExactKeys(value, ["type", "id", "name", "input"])
      || !isNonEmptyString(value.id)
      || !isNonEmptyString(value.name)
      || !isJsonObject(value.input)) {
      failCanonical(`第 ${messageIndex} 条消息包含非法工具调用`);
    }
    return { type: "tool-call", id: value.id, name: value.name, input: value.input };
  }
  if (value.type === "tool-result") {
    if (!hasExactKeys(value, ["type", "toolCallId", "content", "isError"])
      || !isNonEmptyString(value.toolCallId)
      || typeof value.isError !== "boolean"
      || !Array.isArray(value.content)) {
      failCanonical(`第 ${messageIndex} 条消息包含非法工具结果`);
    }
    const content = value.content.flatMap(function normalizeResultText(result: unknown, resultIndex: number): Array<{ type: "text"; text: string }> {
      if (!isPlainRecord(result) || !hasExactKeys(result, ["type", "text"]) || result.type !== "text" || typeof result.text !== "string") {
        failCanonical(`第 ${messageIndex} 条消息的工具结果内容 ${resultIndex} 非法`);
      }
      return result.text.length > 0 ? [{ type: "text", text: result.text }] : [];
    });
    return { type: "tool-result", toolCallId: value.toolCallId, content, isError: value.isError };
  }
  failCanonical(`第 ${messageIndex} 条消息包含未知内容块类型`);
}

/** 校验单条已归一化消息的角色、字段和内容块归属。 */
function validateMessageShape(message: AgentMessage, index: number): void {
  if (!isPlainRecord(message)
    || !hasAllowedKeys(message, ["role", "content"], ["adapterReplayState"])
    || (message.role !== "system" && message.role !== "user" && message.role !== "assistant")) {
    failCanonical(`第 ${index} 条消息的 role 或字段非法`);
  }
  if (!Array.isArray(message.content) || message.content.length === 0) failCanonical(`第 ${index} 条消息没有可发送内容`);
  if (message.adapterReplayState !== undefined) {
    if (message.role !== "assistant") failCanonical(`第 ${index} 条消息的 replay state 角色非法`);
    normalizeReplayState(message.adapterReplayState, index);
  }

  const hasToolResult = message.content.some(function isToolResult(block) { return block.type === "tool-result"; });
  for (const block of message.content) {
    if (block.type === "text" || block.type === "reasoning") {
      if (typeof block.text !== "string") failCanonical(`第 ${index} 条消息包含非法文本块`);
      if (block.type === "reasoning" && message.role !== "assistant") failCanonical(`第 ${index} 条消息的 reasoning 角色非法`);
    }
    if (block.type === "tool-call") {
      if (message.role !== "assistant" || !isNonEmptyString(block.id) || !isNonEmptyString(block.name) || !isJsonObject(block.input)) {
        failCanonical(`第 ${index} 条消息包含非法工具调用`);
      }
    }
    if (block.type === "tool-result") {
      if (message.role !== "user"
        || !isNonEmptyString(block.toolCallId)
        || typeof block.isError !== "boolean"
        || block.content.length === 0
        || !block.content.every(function isTextResult(result) { return isPlainRecord(result) && hasExactKeys(result, ["type", "text"]) && result.type === "text" && typeof result.text === "string" && result.text.length > 0; })) {
        failCanonical(`第 ${index} 条消息包含非法工具结果`);
      }
    }
    if (block.type === "text" && hasToolResult) failCanonical(`第 ${index} 条工具结果消息混入普通文本`);
  }
  if (message.role === "system" && message.content.some(function isNotText(block) { return block.type !== "text"; })) failCanonical(`第 ${index} 条 system 消息只能包含文本`);
  if (message.role === "user" && hasToolResult && (message.content.length !== 1 || message.content[0]?.type !== "tool-result")) failCanonical(`第 ${index} 条工具结果消息必须独占一个 block`);
  if (message.role === "user" && !hasToolResult && message.content.some(function isNotText(block) { return block.type !== "text"; })) failCanonical(`第 ${index} 条普通 user 消息只能包含文本`);
  if (message.role === "assistant" && message.content.some(function isToolResultBlock(block) { return block.type === "tool-result"; })) failCanonical(`第 ${index} 条 assistant 消息不能包含工具结果`);
}

/** 删除空文本块、拒绝未知字段并复制消息，避免校验过程修改 checkpoint 输入。 */
export function normalizeAgentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages)) failCanonical("消息历史必须是数组");
  return (messages as readonly unknown[]).map(function normalizeMessage(rawMessage, index) {
    if (!isPlainRecord(rawMessage) || !hasAllowedKeys(rawMessage, ["role", "content"], ["adapterReplayState"])) {
      failCanonical(`第 ${index} 条消息字段非法`);
    }
    if (rawMessage.role !== "system" && rawMessage.role !== "user" && rawMessage.role !== "assistant") {
      failCanonical(`第 ${index} 条消息的 role 非法`);
    }
    if (!Array.isArray(rawMessage.content)) failCanonical(`第 ${index} 条消息内容必须是数组`);
    const content = rawMessage.content.flatMap(function normalizeBlock(block, blockIndex) {
      const normalized = normalizeContentBlock(block, index, blockIndex);
      return normalized ? [normalized] : [];
    });
    const adapterReplayState = normalizeReplayState(rawMessage.adapterReplayState, index);
    const message: AgentMessage = {
      role: rawMessage.role,
      content,
      ...(adapterReplayState ? { adapterReplayState } : {}),
    };
    validateMessageShape(message, index);
    return message;
  });
}

/** 从 assistant 内容块投影调度器需要的工具调用，避免消息与调度状态双写。 */
export function getAgentToolCalls(message: AgentMessage): Array<{ id: string; name: string; input: AgentJsonObject }> {
  return message.content.flatMap(function collectToolCalls(block) {
    return block.type === "tool-call" ? [{ id: block.id, name: block.name, input: block.input }] : [];
  });
}

/** 读取消息中的普通文本；工具结果与 reasoning 不属于普通可见正文。 */
export function getAgentMessageText(message: AgentMessage): string {
  return message.content.flatMap(function collectText(block) {
    return block.type === "text" ? [block.text] : [];
  }).join("");
}

/** 创建只含普通文本的 canonical 消息。 */
export function createAgentTextMessage(role: AgentMessageRole, text: string): AgentMessage {
  return { role, content: [{ type: "text", text }] };
}

/** 将调度终态投影为唯一的 user 工具结果内容块。 */
export function createAgentToolResultMessage(input: {
  toolCallId: string;
  text: string;
  isError: boolean;
}): AgentMessage {
  return {
    role: "user",
    content: [{ type: "tool-result", toolCallId: input.toolCallId, content: [{ type: "text", text: input.text }], isError: input.isError }],
  };
}

/** 配对扫描结果保留尚未闭合的工具调用，供暂停状态和完整历史校验分别使用。 */
export interface AgentToolPairingScan {
  messages: AgentMessage[];
  pendingCallIds: string[];
}

/** 扫描已验证消息的工具调用与结果，并严格按调用顺序保留末尾未闭合集合。 */
export function scanAgentToolPairing(messages: readonly AgentMessage[]): AgentToolPairingScan {
  const normalized = normalizeAgentMessages(messages);
  const pendingCallIds: string[] = [];
  const seenCallIds = new Set<string>();

  for (let index = 0; index < normalized.length; index += 1) {
    const message = normalized[index];
    const result = message.content[0];
    if (result?.type === "tool-result") {
      if (pendingCallIds[0] !== result.toolCallId) {
        failCanonical(`第 ${index} 条工具结果未按工具调用顺序闭合：${result.toolCallId}`);
      }
      pendingCallIds.shift();
      continue;
    }
    if (pendingCallIds.length > 0) failCanonical(`第 ${index} 条消息插入在工具调用和结果之间`);
    for (const block of message.content) {
      if (block.type !== "tool-call") continue;
      if (seenCallIds.has(block.id)) failCanonical(`工具调用 ID ${block.id} 重复`);
      seenCallIds.add(block.id);
      pendingCallIds.push(block.id);
    }
  }
  return { messages: normalized, pendingCallIds };
}

/** 校验完整可发送历史，拒绝任何未闭合工具调用。 */
export function validateAgentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const scan = scanAgentToolPairing(messages);
  if (scan.pendingCallIds.length > 0) failCanonical(`工具调用缺少结果：${scan.pendingCallIds.join(", ")}`);
  return scan.messages;
}

/** 判断给定位置之前不存在跨越切点的未闭合工具调用。 */
export function isAgentToolPairingBalancedBefore(messages: readonly AgentMessage[], cutIndex: number): boolean {
  if (!Number.isInteger(cutIndex) || cutIndex < 0 || cutIndex > messages.length) return false;
  return scanAgentToolPairing(messages.slice(0, cutIndex)).pendingCallIds.length === 0;
}

/** 判断给定位置不会把完整工具调用/结果对切成两半。 */
export function isAgentToolPairingBalancedAt(messages: readonly AgentMessage[], cutIndex: number): boolean {
  scanAgentToolPairing(messages);
  return isAgentToolPairingBalancedBefore(messages, cutIndex);
}
