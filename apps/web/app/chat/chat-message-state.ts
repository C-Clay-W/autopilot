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
  const matchedOptimisticIndexes = new Set<number>();
  const persistedIds = new Set(current.filter(function persisted(message) { return !message.optimistic; }).map(function id(message) { return message.id; }));
  const mergedHistory = history.map(function replaceOptimisticMessage(historyMessage) {
    if (persistedIds.has(historyMessage.id)) return historyMessage;
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
  return [...mergedHistory, ...stillRealtime]
    .map(function retainStableOrder(message, index) { return { message, index }; })
    .sort(function compareCreatedAt(left, right) {
      if (left.message.createdAt === undefined || right.message.createdAt === undefined) return left.index - right.index;
      return left.message.createdAt - right.message.createdAt || left.index - right.index;
    })
    .map(function unwrapMessage(entry) { return entry.message; });
}
