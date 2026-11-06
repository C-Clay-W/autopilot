/** Web Chat 本地实时消息与较旧 History 快照的合并规则。 */

export interface RealtimeChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  turnId?: string;
  optimistic?: boolean;
  clientRecordId?: string;
  createdAt?: number;
}

/**
 * 将 History 投影合并到当前页面消息；较旧快照不得丢弃仍在实时流中的本地消息。
 * 已经出现在 History 的乐观消息会被持久化版本替换，避免重复渲染。
 */
export function mergeHistoryIntoChatMessages<T extends RealtimeChatMessage>(current: readonly T[], history: readonly T[]): T[] {
  const syntheticHistoryTurns = new Set(history.filter(function synthetic(message) { return message.role === "assistant" && message.turnId && message.id === `agent-turn-${message.turnId}`; }).map(function turn(message) { return message.turnId; }));
  const realTurns = new Set([...current, ...history].filter(function realAssistant(message) { return message.role === "assistant" && message.turnId && message.id !== `agent-turn-${message.turnId}`; }).map(function turn(message) { return message.turnId; }));
  const retainedRealSegments = current.filter(function retainLateHistory(message) { return !message.optimistic && message.role === "assistant" && message.turnId && message.id !== `agent-turn-${message.turnId}` && syntheticHistoryTurns.has(message.turnId) && !history.some(function same(item) { return item.id === message.id; }); });
  // 只淘汰明确合成的空展示容器；同Turn的真实持久分段仍完整参与原合并。
  history = history.filter(function retainReal(message) { return !(message.role === "assistant" && message.turnId && message.id === `agent-turn-${message.turnId}` && realTurns.has(message.turnId)); });
  current = current.filter(function retainReal(message) { return !(message.role === "assistant" && message.turnId && message.id === `agent-turn-${message.turnId}` && realTurns.has(message.turnId)); });
  const matchedOptimisticIndexes = new Set<number>();
  const persistedIds = new Set(current.filter(function persisted(message) { return !message.optimistic; }).map(function id(message) { return message.id; }));
  const mergedHistory = history.map(function replaceOptimisticMessage(historyMessage) {
    if (persistedIds.has(historyMessage.id)) {
      const previous = current.find(function same(message) { return message.id === historyMessage.id; });
      return { ...historyMessage, createdAt: previous?.createdAt ?? historyMessage.createdAt };
    }
    const optimisticIndex = current.findIndex(function findMatchingOptimisticMessage(currentMessage, index) {
      if (matchedOptimisticIndexes.has(index) || !currentMessage.optimistic || currentMessage.role !== historyMessage.role) return false;
      if (currentMessage.clientRecordId && historyMessage.clientRecordId) return currentMessage.clientRecordId === historyMessage.clientRecordId;
      if (currentMessage.turnId && historyMessage.turnId) return currentMessage.turnId === historyMessage.turnId;
      if (currentMessage.role === "assistant" && !currentMessage.turnId && !historyMessage.turnId) return false;
      return currentMessage.content === historyMessage.content;
    });
    if (optimisticIndex < 0) return historyMessage;
    matchedOptimisticIndexes.add(optimisticIndex);
    return { ...historyMessage, createdAt: current[optimisticIndex].createdAt ?? historyMessage.createdAt };
  });
  const stillRealtime = current.filter(function keepUnpersistedOptimisticMessage(message, index) {
    return message.optimistic && !matchedOptimisticIndexes.has(index);
  });
  return [...mergedHistory, ...stillRealtime, ...retainedRealSegments]
    .map(function retainStableOrder(message, index) { return { message, index }; })
    .sort(function compareCreatedAt(left, right) {
      if (left.message.turnId && left.message.turnId === right.message.turnId && left.message.role !== right.message.role) return left.message.role === "user" ? -1 : 1;
      if (left.message.createdAt === undefined || right.message.createdAt === undefined) return left.index - right.index;
      return left.message.createdAt - right.message.createdAt || left.index - right.index;
    })
    .map(function unwrapMessage(entry) { return entry.message; });
}

/** 同Turn共享Presentation只挂在一个容器；保留所有真实分段数据，优先选择真实消息承载完整时间线。 */
export function getTurnPresentationMessageIds(messages: readonly RealtimeChatMessage[]): ReadonlySet<string> {
  const containers = new Map<string, RealtimeChatMessage>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.turnId) continue;
    const previous = containers.get(message.turnId);
    if (!previous || previous.id === `agent-turn-${message.turnId}`) containers.set(message.turnId, message);
  }
  return new Set([...containers.values()].map(function id(message) { return message.id; }));
}
