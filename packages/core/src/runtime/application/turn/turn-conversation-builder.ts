/**
 * runtime/application/turn/turn-conversation-builder.ts — Turn 会话上下文构建
 *
 * 负责首轮输入、Trust 后上下文刷新、跨宿主 canonical 会话重建和 usage anchor 继承；
 * 不创建 Turn、不读写 lease，也不执行模型或工具。
 */

import type { AgentCheckpoint, RunConfig, StartTurnInput } from "../../protocol";
import { AgentRuntimeError as RuntimeError, migrateAgentMessages, validateAgentMessages } from "../../protocol";
import { createAgentTextMessage, getAgentMessageText, type AgentMessage } from "../../../internal/types/agent-message";
import type { TodoItem } from "../../domain";
import type { Turn } from "../../domain";
import type { RuntimePorts } from "../../ports";

/** Turn 会话构建器公开的内部职责。 */
export interface TurnConversationBuilder {
  buildInitialMessages(input: StartTurnInput): AgentMessage[];
  refreshContext(capabilities: RunConfig, content: string | undefined): Promise<void>;
  getLatestCompletedTurn(sessionId: string): Promise<Turn | undefined>;
  buildCanonicalSessionMessages(latestCompleted: Turn | undefined, initial: AgentMessage[]): Promise<AgentMessage[]>;
  inheritPreviousUsageAnchor(sessionId: string, latestCompleted: Turn | undefined, canonical: AgentMessage[], initial: AgentMessage[]): Promise<AgentCheckpoint["usageAnchor"]>;
  injectTodoSnapshot(sessionId: string, todoChainId: string, messages: AgentMessage[]): Promise<AgentMessage[]>;
}

/** 创建只处理 canonical conversation 的构建器。 */
export function createTurnConversationBuilder(ports: RuntimePorts): TurnConversationBuilder {
  /** 从 start 输入构造首轮消息，拒绝空输入。 */
  function buildInitialMessages(input: StartTurnInput): AgentMessage[] {
    if (input.messages && input.messages.length > 0) return input.messages;
    if (input.content) return [createAgentTextMessage("user", input.content)];
    throw new RuntimeError("RUNTIME_ERROR", "StartTurnInput 必须提供 content 或 messages");
  }

  /** 在新 Turn 开始时刷新可选的 instructions/Memory 快照，失败时保留 bootstrap 快照。 */
  async function refreshContext(capabilities: RunConfig, content: string | undefined): Promise<void> {
    if (!capabilities.contextLoader || !content) return;
    try {
      capabilities.context = await capabilities.contextLoader(content);
    } catch {
      // Context 是辅助能力；失败不阻止基础会话。
    }
  }

  /** 查找上一安全完成的 Turn。 */
  async function getLatestCompletedTurn(sessionId: string): Promise<Turn | undefined> {
    return (await ports.turnStore.list(sessionId))
      .filter((turn) => turn.status === "completed")
      .sort((left, right) => right.startedAt - left.startedAt)[0];
  }

  /** 重建不含 provider 私有状态的跨宿主 canonical conversation。 */
  async function buildCanonicalSessionMessages(latestCompleted: Turn | undefined, initial: AgentMessage[]): Promise<AgentMessage[]> {
    if (!latestCompleted) return initial;
    const checkpoint = await ports.checkpointStore.getByTurn(latestCompleted.sessionId, latestCompleted.id);
    if (!checkpoint || checkpoint.turnId !== latestCompleted.id) return initial;
    const systemMessages = initial.filter((message) => message.role === "system");
    const remainingMessages = initial.filter((message) => message.role !== "system");
    const migrated = migrateAgentMessages({
      messageSchemaVersion: checkpoint.messageSchemaVersion,
      messages: checkpoint.messages,
    });
    if (!migrated.ok) throw new RuntimeError("CANONICAL_MESSAGE_INVALID", `历史会话消息迁移失败：${migrated.message}`);
    return [...systemMessages, ...normalizeConversationMessages(migrated.messages), ...remainingMessages];
  }

  /** 在消息完整重建时继承上一 Turn 的私有 usage anchor，否则安全回退估算。 */
  async function inheritPreviousUsageAnchor(
    sessionId: string,
    latestCompleted: Turn | undefined,
    canonical: AgentMessage[],
    initial: AgentMessage[],
  ): Promise<AgentCheckpoint["usageAnchor"]> {
    if (!latestCompleted) return undefined;
    const previous = await ports.checkpointStore.getLatest(sessionId);
    if (!previous || previous.turnId !== latestCompleted.id || !previous.usageAnchor) return undefined;
    const previousConversationCount = (previous.messages ?? []).filter((message) => message.role !== "system").length;
    const inheritedConversationCount = canonical.filter((message) => message.role !== "system").length
      - initial.filter((message) => message.role !== "system").length;
    if (inheritedConversationCount !== previousConversationCount) return undefined;
    if (previous.usageAnchor.messageCount !== previous.messages.length) return undefined;
    return previous.usageAnchor;
  }

  /** 从指定任务链的安全 todo_updated 事件重建最近快照；旧事件仅兼容其所属 Turn。 */
  async function getLatestTodoSnapshot(sessionId: string, todoChainId: string): Promise<TodoItem[] | undefined> {
    const events = await ports.transcriptStore.getEvents(sessionId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const envelope = events[index];
      const event = envelope.event;
      if (event.type === "todo_updated" && (event.todoChainId === todoChainId || (!event.todoChainId && envelope.turnId === todoChainId))) return event.todos;
    }
    return undefined;
  }

  /** claimed queue 连续启动时在消息末尾注入同一任务链快照；普通新 Turn 不调用。 */
  async function injectTodoSnapshot(sessionId: string, todoChainId: string, messages: AgentMessage[]): Promise<AgentMessage[]> {
    const todos = await getLatestTodoSnapshot(sessionId, todoChainId);
    if (!todos || todos.length === 0) return messages;
    const lines = todos.map(function formatTodo(todo, index) {
      return `${index + 1}. [${todo.status}] ${todo.content}${todo.status === "in_progress" ? ` —— ${todo.activeForm}` : ""}`;
    });
    return [...messages, createAgentTextMessage("system", `【Todo 快照】上一任务链最近待办（来自本 Session durable 事件）：\n${lines.join("\n")}\n若新任务与上一任务链连续，请在此基础上用 todo_write 整表替换更新；若是独立任务，请直接用全新列表整表替换。`)];
  }

  return { buildInitialMessages, refreshContext, getLatestCompletedTurn, buildCanonicalSessionMessages, inheritPreviousUsageAnchor, injectTodoSnapshot };
}

/** 只保留已通过 V2 配对校验的历史；新 V2 损坏不得静默丢弃。 */
function normalizeConversationMessages(messages: AgentMessage[]): AgentMessage[] {
  return validateAgentMessages(messages)
    .filter(function dropPreviousTodoReminder(message) {
      return message.role !== "system" || !getAgentMessageText(message).startsWith("【Todo 快照】");
    })
    .map(function stripPrivateMessageData(message) {
      return {
        role: message.role,
        content: message.content.filter(function dropReasoning(block) { return block.type !== "reasoning"; }),
      };
    });
}
