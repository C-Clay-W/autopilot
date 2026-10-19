/**
 * runtime/protocol/migrate-agent-messages.ts — V1 checkpoint 消息到 V2 canonical 的纯迁移器。
 *
 * 迁移只在 durable 读取边界使用；它不修改输入记录，无法证明安全配对时返回稳定本地错误。
 */

import {
  CanonicalMessageError,
  scanAgentToolPairing,
  validateAgentMessages,
  type AgentContentBlock,
  type AgentJsonObject,
  type AgentMessage,
} from "../../internal/types/agent-message";

/** 成功迁移后的 V2 durable 消息快照。 */
export interface AgentMessageMigrationSuccess {
  ok: true;
  messageSchemaVersion: 2;
  messages: AgentMessage[];
}

/** 无法安全迁移时保留原始记录的稳定本地失败结果。 */
export interface AgentMessageMigrationFailure {
  ok: false;
  code: "CANONICAL_MESSAGE_INVALID";
  message: string;
  originalMessages: unknown;
}

/** V1/V2 durable 消息迁移结果。 */
export type AgentMessageMigrationResult = AgentMessageMigrationSuccess | AgentMessageMigrationFailure;

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 读取旧工具结果正文中的 success 状态；无法识别时保守标记为 error。 */
function isLegacyToolResultSuccess(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) && parsed.status === "success";
  } catch {
    return false;
  }
}

/** 将旧 assistant 的 toolCalls 投影为同序 V2 tool-call blocks。 */
function migrateLegacyToolCalls(value: unknown): Extract<AgentContentBlock, { type: "tool-call" }>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CanonicalMessageError("旧 assistant.toolCalls 不是数组");
  return value.map(function migrateLegacyToolCall(call) {
    if (!isRecord(call) || typeof call.id !== "string" || typeof call.name !== "string" || !isRecord(call.input)) {
      throw new CanonicalMessageError("旧工具调用缺少合法 ID、名称或对象输入");
    }
    return { type: "tool-call", id: call.id, name: call.name, input: call.input as AgentJsonObject };
  });
}

/** 将单条 V1 消息转换为 V2 内容块消息。 */
function migrateLegacyMessage(value: unknown): AgentMessage {
  if (!isRecord(value) || typeof value.role !== "string") throw new CanonicalMessageError("旧消息缺少 role");
  const content = typeof value.content === "string" ? value.content : "";
  if (value.role === "tool") {
    if (typeof value.toolCallId !== "string") throw new CanonicalMessageError("旧工具结果缺少 toolCallId");
    return {
      role: "user",
      content: [{ type: "tool-result", toolCallId: value.toolCallId, content: [{ type: "text", text: content }], isError: !isLegacyToolResultSuccess(content) }],
    };
  }
  if (value.role === "system" || value.role === "user") return { role: value.role, content: [{ type: "text", text: content }] };
  if (value.role !== "assistant") throw new CanonicalMessageError("旧消息 role 非法");
  const blocks: AgentContentBlock[] = [];
  if (content) blocks.push({ type: "text", text: content });
  if (typeof value.reasoningContent === "string" && value.reasoningContent) blocks.push({ type: "reasoning", text: value.reasoningContent });
  blocks.push(...migrateLegacyToolCalls(value.toolCalls));
  return { role: "assistant", content: blocks };
}

/** 执行 V1 到 V2 的纯迁移，并使合法 V2 输入幂等通过。 */
export function migrateAgentMessages(input: { messageSchemaVersion?: unknown; messages: unknown; allowPending?: boolean }): AgentMessageMigrationResult {
  const originalMessages = input.messages;
  try {
    if (input.messageSchemaVersion === 2) {
      if (!Array.isArray(input.messages)) throw new CanonicalMessageError("V2 messages 不是数组");
      return { ok: true, messageSchemaVersion: 2, messages: input.allowPending
        ? scanAgentToolPairing(input.messages as AgentMessage[]).messages
        : validateAgentMessages(input.messages as AgentMessage[]) };
    }
    if (input.messageSchemaVersion !== undefined && input.messageSchemaVersion !== 1) throw new CanonicalMessageError("未知消息 schema 版本");
    if (!Array.isArray(input.messages)) throw new CanonicalMessageError("V1 messages 不是数组");
    const messages = input.messages.map(migrateLegacyMessage);
    return { ok: true, messageSchemaVersion: 2, messages: input.allowPending
      ? scanAgentToolPairing(messages).messages
      : validateAgentMessages(messages) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法迁移消息";
    return { ok: false, code: "CANONICAL_MESSAGE_INVALID", message, originalMessages };
  }
}
