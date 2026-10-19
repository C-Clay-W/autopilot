/**
 * runtime-host/web-ui-dto.ts — Core Runtime DTO 到 Web UI DTO 的映射
 *
 * 负责把 Core 的 Session、AgentEventEnvelope、Turn 转换为 Web UI 能消费的
 * 稳定 DTO；Web 专属的消息投影字段仍由 session-store 和 message projection 管理。
 */

import { sanitizeAgentTerminationView, type AgentEventEnvelope, type Session as CoreSession, type SessionStatus, type Turn } from "@autopilot-agent/core";
import type { SessionMessage, SessionPinnedSkill } from "@/lib/session-store";

/** Web UI 使用的会话 DTO；只投影安全的 Core 运行状态摘要。 */
export interface WebSessionDto {
  productMode?: "chat" | "work";
  chatRetrievalMode?: "none" | "web" | "rag";
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "archived";
  runtimeStatus: SessionStatus;
  activeTurnId?: string;
  pinnedSkills?: SessionPinnedSkill[];
}

/** Web UI 使用的固定 Skill DTO。 */
export type WebSessionPinnedSkill = SessionPinnedSkill;

/** Web UI 恢复历史时读取的持久消息 DTO。 */
export type WebSessionMessageDto = SessionMessage;

/** Web UI 可消费的 Turn 元数据 DTO。 */
export interface WebTurnDto {
  turnId: string;
  sessionId: string;
  status: Turn["status"];
  startedAt: number;
  completedAt?: number;
}

/** 把 Core Session 与已有 Web 投影合并为 UI 会话 DTO。 */
export function toWebSessionDto(session: CoreSession): WebSessionDto {
  return {
    id: session.id,
    title: session.title ?? "新对话",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: "active",
    runtimeStatus: session.status,
    activeTurnId: session.activeTurnId,
    pinnedSkills: session.presentation?.pinnedSkills,
  };
}

/** 把 Core AgentEventEnvelope 展平为既有 Web SSE 事件 DTO。 */
export function toWebAgentEventDto(envelope: AgentEventEnvelope, turnId = envelope.turnId): Record<string, unknown> {
  const { checkpoint: _checkpoint, error: _error, termination: rawTermination, ...event } = envelope.event as unknown as Record<string, unknown>;
  const termination = sanitizeAgentTerminationView(rawTermination);
  return { seq: envelope.seq, turnId, ...event, ...(termination ? { termination } : {}) };
}

/** 把 Core Turn 映射为 Web 恢复/取消路由使用的稳定 Turn DTO。 */
export function toWebTurnDto(turn: Turn | null): WebTurnDto | null {
  if (!turn) return null;
  return {
    turnId: turn.id,
    sessionId: turn.sessionId,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
  };
}
