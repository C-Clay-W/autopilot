/** Node Session 记录边界：校验磁盘身份并规范化旧 Work，损坏记录不当作不存在。 */
import { NodeStateError, createNodeIdentityError } from "./node-errors";
import type { Session } from "@autopilot-agent/core";

/** 用固定错误码拒绝损坏记录，避免输出路径或原始 JSON。 */
export function normalizeNodeSession(value: unknown, id: string): Session {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NodeStateError("STATE_SESSION_CORRUPTED");
  const session = value as Session;
  if (session.id !== id || !Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt)) throw new NodeStateError("STATE_SESSION_CORRUPTED");
  const mode = session.productMode ?? "work";
  if (mode === "chat") {
    if (session.projectId !== undefined || !["none", "web", "rag"].includes(session.chatRetrievalMode ?? "")) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  } else if (mode !== "work" || session.chatRetrievalMode !== undefined || typeof session.projectId !== "string" || !session.projectId.trim()) {
    throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  }
  return { ...session, productMode: mode };
}

/** 磁盘写入也禁止产品、检索模式和既有 Project 归属改变。 */
export function assertNodeSessionIdentity(previous: Session, next: Session): void {
  if (previous.workContextVersion !== next.workContextVersion) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  if (previous.productMode !== next.productMode || previous.projectId !== next.projectId) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  if (previous.chatRetrievalMode !== next.chatRetrievalMode) throw createNodeIdentityError("CHAT_RETRIEVAL_MODE_LOCKED");
}
