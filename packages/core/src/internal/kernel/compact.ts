/**
 * Agent 上下文压缩：只处理 V2 canonical 消息，并在工具调用/结果完整配对边界切分。
 */

import { createAgentTextMessage, isAgentToolPairingBalancedAt, validateAgentMessages, type AgentMessage } from "../types/agent-message";
import type { AgentCompactInput, AgentCompactionResult } from "../agent-runtime";
import type { ModelSampler } from "./model-sampler";

const COMPACTION_SYSTEM_PROMPT = "你是 Agent 上下文压缩器。不得调用工具。以固定八项输出：目标与方向、用户约束、确认决策、完成工作、文件与来源、错误与修复、待办与阻塞、安全与审批范围。只保留可执行事实，不要虚构。";
const MAX_SUMMARY_CHARACTERS = 24_000;
const MAX_TOOL_RESULT_CHARACTERS = 800;
const MAX_MESSAGE_CHARACTERS = 2_000;

interface MessageGroup {
  messages: AgentMessage[];
  startsWithUser: boolean;
}

/** 将 canonical 结构序列化为中立签名，不能复用任一 Provider 的 wire 字段。 */
export function serializeCanonicalMessagesForSignature(messages: AgentMessage[]): string {
  return JSON.stringify(messages.map(function serializeMessage(message) { return { role: message.role, content: message.content }; }));
}

/** 对 canonical 内容做保守 token 粗估；实际 usage 仍以 Provider 响应为准。 */
export function estimateMessageTokens(messages: AgentMessage[]): number {
  const text = serializeCanonicalMessagesForSignature(messages);
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 为摘要正文及其 system 消息协议开销预留保守 token 预算。 */
function summaryTokenReserve(targetTokens: number): number {
  const maxSummaryTokens = Math.min(4_000, Math.max(512, Math.floor(targetTokens / 8)));
  return maxSummaryTokens + estimateMessageTokens([createAgentTextMessage("system", "已压缩历史摘要：\n")]);
}

/** 将工具结果正文安全瘦身后投影为摘要文本。 */
function projectMessageForSummary(message: AgentMessage): string {
  const content = message.content.map(function projectBlock(block) {
    if (block.type === "tool-call") return `tool-call:${block.id}:${block.name}`;
    if (block.type === "tool-result") return `tool-result:${block.toolCallId}:${block.isError ? "error" : "success"}:${block.content.map(function joinText(item) { return item.text; }).join("").slice(0, MAX_TOOL_RESULT_CHARACTERS)}`;
    return block.text.slice(0, MAX_MESSAGE_CHARACTERS);
  }).join("\n");
  return `[${message.role}] ${content}`;
}

/** 生成摘要输入，保持调用/结果顺序但不重新发送大工具正文。 */
export function projectMessagesForSummary(messages: AgentMessage[]): string {
  return groupMessages(messages).map(function formatGroup(group) { return group.messages.map(projectMessageForSummary).join("\n"); }).join("\n\n");
}

/** 将普通 user 输入开新回合；tool-result 仍属于前一个 assistant 工具批次。 */
function groupMessages(messages: AgentMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let current: MessageGroup | undefined;
  for (const message of messages) {
    const isToolResult = message.content.length === 1 && message.content[0]?.type === "tool-result";
    if (!current || (message.role === "user" && !isToolResult)) {
      current = { messages: [], startsWithUser: message.role === "user" && !isToolResult };
      groups.push(current);
    }
    current.messages.push(message);
  }
  return groups;
}

/** 从完整普通 user 回合边界选择保留尾部，工具调用和结果永远同组。 */
function splitMessagesForCompaction(messages: AgentMessage[], preserveRecentTurns: number, targetTokens: number): { oldMessages: AgentMessage[]; preservedTail: AgentMessage[]; preservedFromIndex: number } {
  validateAgentMessages(messages);
  const systemMessages = messages.filter(function isSystem(message) { return message.role === "system"; });
  const groups = groupMessages(messages.filter(function isNotSystem(message) { return message.role !== "system"; }));
  const maxPreservedTurns = Math.min(preserveRecentTurns, groups.filter(function hasUser(group) { return group.startsWithUser; }).length);
  const tailBudget = targetTokens - summaryTokenReserve(targetTokens);
  let preservedGroupStart = groups.length;
  let preservedTurns = 0;
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const group = groups[groupIndex]!;
    const nextPreservedTurns = preservedTurns + (group.startsWithUser ? 1 : 0);
    if (nextPreservedTurns > maxPreservedTurns) break;
    const candidate = groups.slice(groupIndex).flatMap(function flattenGroup(item) { return item.messages; });
    if (estimateMessageTokens([...systemMessages, ...candidate]) > tailBudget) break;
    preservedGroupStart = groupIndex;
    preservedTurns = nextPreservedTurns;
  }
  const preservedTail = groups.slice(preservedGroupStart).flatMap(function flattenGroup(group) { return group.messages; });
  const oldMessages = groups.slice(0, preservedGroupStart).flatMap(function flattenGroup(group) { return group.messages; });
  const preservedFirstMessage = preservedTail[0];
  const preservedFromIndex = preservedFirstMessage ? messages.indexOf(preservedFirstMessage) : messages.length;
  if (!isAgentToolPairingBalancedAt(messages, preservedFromIndex)) throw new Error("compact 切点穿过工具调用与结果配对");
  return { oldMessages, preservedTail, preservedFromIndex };
}

/** 使用当前 Turn 的无工具采样器生成摘要。 */
async function sampleSummary(input: AgentCompactInput, sampler: ModelSampler): Promise<string> {
  const sampled = await sampler.sample([createAgentTextMessage("system", COMPACTION_SYSTEM_PROMPT), createAgentTextMessage("user", projectMessagesForSummary(input.messages))], [], { signal: input.signal, maxTokens: Math.min(4_000, Math.max(512, Math.floor(input.targetTokens / 8))) });
  if (sampled.toolCalls.length > 0) throw new Error("compact 摘要采样器不允许工具调用");
  const summary = sampled.content.trim();
  if (!summary || summary.length > MAX_SUMMARY_CHARACTERS) throw new Error("compact 摘要为空或超过安全长度");
  return summary;
}

/** 压缩 V2 canonical 历史，并在返回前再次验证完整工具配对。 */
export async function compactMessages(input: AgentCompactInput): Promise<AgentCompactionResult> {
  const normalized = validateAgentMessages(input.messages);
  const preTokens = estimateMessageTokens(normalized);
  const systemMessages = normalized.filter(function isSystem(message) { return message.role === "system"; });
  const { oldMessages, preservedTail, preservedFromIndex } = splitMessagesForCompaction(normalized, input.preserveRecentTurns, input.targetTokens);
  if (!oldMessages.length) {
    if (preTokens > input.targetTokens) throw new Error("compact 后上下文仍超过目标预算");
    // 无可压缩历史：消息投影保持原样，显式标记 skipped，宿主不得再以空 summary 推断。
    return { outcome: "skipped", reason: "no_compactable_history", summary: "", messages: normalized, preTokens, postTokens: preTokens, preservedFromIndex };
  }
  if (!input.sampler) throw new Error("compact 缺少当前 Turn 的摘要采样器");
  const summary = await sampleSummary({ ...input, messages: oldMessages }, input.sampler);
  const messages = validateAgentMessages([...systemMessages, createAgentTextMessage("system", `已压缩历史摘要（${input.trigger}）：\n${summary}`), ...preservedTail]);
  const postTokens = estimateMessageTokens(messages);
  if (postTokens > input.targetTokens) throw new Error("compact 后上下文仍超过目标预算");
  return { outcome: "changed", summary, messages, preTokens, postTokens, preservedFromIndex };
}
