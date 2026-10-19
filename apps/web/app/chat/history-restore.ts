/** Web Session History 的消息映射与失败重试策略。 */
import { getLegacyTurnFailure } from "@/lib/runtime-host/web-turn-failure";
import type { WebSessionMessageDto } from "@/lib/runtime-host/web-ui-dto";
import type { Message, SessionAgentState } from "./chat-page-types";

export type HistoryErrorPhase = "fetch" | "http" | "json" | "mapping";

/** 将持久化 History 消息映射为页面消息，并仅向精确匹配的 assistant Turn 附加 termination。 */
export function mapHistoryMessage(message: WebSessionMessageDto, agent: SessionAgentState | undefined, recoverableTurnId: string | undefined): Message {
  return {
    id: message.id,
    role: message.role === "tool" ? "assistant" : message.role,
    // 持久化投影可能同时包含已完成 segments 和最后一段 content；两者都必须保留。
    content: message.content,
    failure: message.failure ?? (message.role === "assistant" && message.turnId ? getLegacyTurnFailure(message.content) : undefined),
    termination: agent
      && message.role === "assistant"
      && typeof agent.turnId === "string"
      && agent.turnId.length > 0
      && typeof message.turnId === "string"
      && message.turnId.length > 0
      && agent.turnId === message.turnId
      ? agent.termination
      : undefined,
    attachments: message.attachments,
    knowledgeFiles: message.knowledgeFiles,
    knowledgeIngestItems: message.knowledgeIngestItems,
    clientRecordId: message.clientRecordId,
    createdAt: message.createdAt,
    turnId: message.turnId,
    sources: message.sources?.map(function mapSource(source) {
      return {
        metadata: {
          fileName: (source.metadata?.fileName as string) ?? "",
          pageNumber: source.metadata?.pageNumber as number | undefined,
          title: source.metadata?.title as string | undefined,
          imageFileName: source.metadata?.imageFileName as string | undefined,
        },
      };
    }),
    canContinue: Boolean(message.turnId && recoverableTurnId && message.turnId === recoverableTurnId),
  };
}

/** 仅对可能由短暂传输故障恢复的 History 请求失败自动重试。 */
export function shouldRetryHistoryFailure(phase: HistoryErrorPhase, status?: number): boolean {
  if (phase === "fetch" || phase === "json") return true;
  return phase === "http" && (status === 500 || status === 502 || status === 503 || status === 504);
}
