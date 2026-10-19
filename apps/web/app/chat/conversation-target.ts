/** 对话导航与传输身份：Chat 使用独立 UI 作用域，Work 始终绑定显式工作区；不创建虚拟 Project。 */
import type { ChatRetrievalMode } from "@autopilot-agent/core";

/** 仅用于浏览器 manager 的命名空间，不是 Workspace ID，也不会提交给 Work API。 */
export const CHAT_SCOPE = "@chat";
export type ProductMode = "chat" | "work";

/** 兼容旧 Work 深链；无参数默认 Chat，显式 mode 优先于遗留参数。 */
export function readConversationTarget(params: { get(name: string): string | null }) {
  const productMode: ProductMode = params.get("mode") === "work" || (params.get("mode") !== "chat" && Boolean(params.get("workspaceId"))) ? "work" : "chat";
  const retrieval = params.get("retrieval");
  const workspaceId = params.get("workspaceId") || "";
  const scope = productMode === "chat" ? CHAT_SCOPE : workspaceId === CHAT_SCOPE ? "" : workspaceId;
  return { productMode, scope, sessionId: scope ? params.get("sessionId") || "" : "", retrievalMode: (retrieval === "web" || retrieval === "rag" ? retrieval : "none") as ChatRetrievalMode };
}

/** 只生成所选产品的参数，不携带另一个产品的工作区或会话。 */
export function conversationUrl(scope: string, sessionId = "", retrievalMode: ChatRetrievalMode = "none", draftId?: string): string {
  const params = new URLSearchParams({ mode: scope === CHAT_SCOPE ? "chat" : "work" });
  if (scope && scope !== CHAT_SCOPE) params.set("workspaceId", scope);
  if (sessionId) params.set("sessionId", sessionId);
  else if (scope === CHAT_SCOPE && retrievalMode !== "none") params.set("retrieval", retrievalMode);
  if (draftId) params.set("draft", draftId);
  return `/chat?${params}`;
}

/** 把已绑定 UI 作用域转换为产品 API，Work 空工作区不生成请求地址。 */
export function sessionApiUrl(scope: string, sessionId?: string, suffix = ""): string | null {
  if (!scope) return null;
  const root = scope === CHAT_SCOPE ? "/api/chat/sessions" : `/api/workspaces/${encodeURIComponent(scope)}/sessions`;
  return sessionId ? `${root}/${encodeURIComponent(sessionId)}${suffix}` : `${root}${suffix}`;
}

/** 单一枚举保证互斥；再次点击当前来源回到普通聊天。 */
export function toggleChatRetrieval(current: ChatRetrievalMode, clicked: "web" | "rag"): ChatRetrievalMode {
  return current === clicked ? "none" : clicked;
}
