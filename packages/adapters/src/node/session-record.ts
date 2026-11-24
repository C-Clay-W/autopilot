/** Node Session 记录边界：严格校验当前格式身份，损坏记录不当作不存在。 */
import { NodeStateError, createNodeIdentityError } from "./node-errors";
import type { Session } from "@autopilot-agent/core";

/** 用固定错误码拒绝损坏记录，避免输出路径或原始 JSON。 */
export function normalizeNodeSession(value: unknown, id: string): Session {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NodeStateError("STATE_SESSION_CORRUPTED");
  const session = value as Session;
  if (session.id !== id || !Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt)) throw new NodeStateError("STATE_SESSION_CORRUPTED");
  const source = session.creationSource;
  const managed = session.managedExecution;
  if (managed !== undefined && (!managed || managed.threadPolicy !== "disabled" || typeof managed.hostId !== "string" || !/^[\w-]{1,128}$/.test(managed.hostId) || typeof managed.requestId !== "string" || !/^[\w-]{1,128}$/.test(managed.requestId) || session.productMode !== "work" || session.persistenceMode !== "durable")) throw new NodeStateError("STATE_SESSION_CORRUPTED");
  if (source !== undefined) {
    const actor = source?.actor;
    if (!session.collaborationCreationId || !source || typeof source.requestId !== "string" || !source.requestId
      || !actor || (actor.kind !== "human" && actor.kind !== "thread")
      || (actor.kind === "human" && (typeof actor.principalId !== "string" || !actor.principalId))
      || (actor.kind === "thread" && (typeof actor.threadId !== "string" || !actor.threadId || typeof actor.turnId !== "string" || !actor.turnId))) throw new NodeStateError("STATE_SESSION_CORRUPTED");
  }
  const mode = session.productMode;
  if (mode === "chat") {
    if (session.projectId !== undefined || !["none", "web", "rag"].includes(session.chatRetrievalMode ?? "")) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  } else if (mode !== "work" || session.chatRetrievalMode !== undefined || typeof session.projectId !== "string" || !session.projectId.trim()) {
    throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  }
  return { ...session, productMode: mode };
}

/** 磁盘写入也禁止产品、检索模式和既有 Project 归属改变。 */
export function assertNodeSessionIdentity(previous: Session, next: Session): void {
  if (JSON.stringify(previous.managedExecution) !== JSON.stringify(next.managedExecution)) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  if (JSON.stringify(previous.collaborationAllowedTools) !== JSON.stringify(next.collaborationAllowedTools)) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  if (JSON.stringify(previous.creationSource) !== JSON.stringify(next.creationSource)) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  if (previous.collaborationCreationId !== next.collaborationCreationId) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  if (previous.workContextVersion !== next.workContextVersion) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  if (previous.productMode !== next.productMode || previous.projectId !== next.projectId) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
  if (previous.chatRetrievalMode !== next.chatRetrievalMode) throw createNodeIdentityError("CHAT_RETRIEVAL_MODE_LOCKED");
}
