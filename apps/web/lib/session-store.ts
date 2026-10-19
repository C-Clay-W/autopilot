/**
 * Web 会话展示投影：所有数据均读写 Core Runtime Session，不再维护 .local/sessions JSONL。
 */
import crypto from "node:crypto";
import type { WebTurnFailure } from "./runtime-host/web-turn-failure";
import type { AgentRuntime, Session as CoreSession } from "@autopilot-agent/core";

export interface SessionPinnedSkill {
  skillRef: string;
  skillId: string;
  contentHash: string;
  pinnedAt: number;
}

export interface EditDiffRecord {
  callId: string;
  filePath: string;
  replacements: number;
  diff: string;
}

export interface ProcessStepRecord {
  stage: string;
  message: string;
}

export interface AgentTurnSegmentRecord {
  id: string;
  content: string;
  processSteps: ProcessStepRecord[];
}

/** 会话历史中只保留文件名和大小的知识上传记录。 */
export interface SessionKnowledgeFileRecord {
  name: string;
  size: number;
}

/** 会话历史中用于恢复入库结果卡片的安全终态。 */
export interface SessionKnowledgeIngestItem {
  name: string;
  status: "completed" | "partial" | "failed";
  contentCount?: number;
  failedPages?: number[];
  error?: string;
}

export interface SessionMessage {
  type: "message";
  id: string;
  role: "user" | "assistant" | "tool";
  turnId?: string;
  content: string;
  /** 宿主生成的安全失败提示，与回答分开保存以供实时和刷新后展示。 */
  failure?: WebTurnFailure;
  sources?: Array<{ id: string; score: number; text: string; metadata: Record<string, unknown> }>;
  attachments?: Array<{ id: string; name: string; mimeType: string; relativePath: string }>;
  editDiffs?: EditDiffRecord[];
  processSteps?: ProcessStepRecord[];
  turnSegments?: AgentTurnSegmentRecord[];
  knowledgeFiles?: SessionKnowledgeFileRecord[];
  knowledgeIngestItems?: SessionKnowledgeIngestItem[];
  clientRecordId?: string;
  createdAt: number;
}

export interface SessionCompactionRecord {
  type: "agent_compaction";
  compactId: string;
  trigger: "auto" | "manual" | "proactive" | "reactive";
  sourceFromId: string;
  sourceToId: string;
  preservedTailIds: string[];
  summary: string;
  summaryHash: string;
  preTokens: number;
  postTokens: number;
  status: "completed" | "failed";
  createdAt: number;
}

export interface SessionMeta {
  type: "session_meta";
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "archived";
  runtimeStatus: CoreSession["status"];
  activeTurnId?: string;
  pinnedSkills?: SessionPinnedSkill[];
}

/** 将 Core Session 的展示投影转换为 Web Meta，缺失投影时返回可重建空视图。 */
export function toSessionMeta(session: CoreSession): SessionMeta {
  return {
    type: "session_meta",
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

/** 从 Core Session 读取 Web 展示消息；不再访问 Web 本地 JSONL。 */
export function toSessionMessages(session: CoreSession): SessionMessage[] {
  return (session.presentation?.messages ?? []).map((message) => ({ type: "message", ...message }));
}

/** 读取并断言 Core Session 存在。 */
async function requireSession(runtime: AgentRuntime, sessionId: string): Promise<CoreSession> {
  return runtime.sessions.get(sessionId);
}

/** 创建 Core Session，并初始化可重建的空展示投影。 */
export async function createSession(runtime: AgentRuntime, input: { id?: string; title?: string; projectId?: string } = {}): Promise<SessionMeta> {
  const session = await runtime.sessions.create({
    id: input.id,
    title: input.title,
    projectId: input.projectId,
  });
  session.presentation = { messages: [] };
  await runtime.sessions.save(session);
  return toSessionMeta(session);
}

/** 读取 Core Session 展示消息。 */
export async function getSessionMessages(runtime: AgentRuntime, sessionId: string): Promise<SessionMessage[]> {
  return toSessionMessages(await requireSession(runtime, sessionId));
}

/** 追加 Web 展示消息到 Core Session 投影。 */
export async function appendMessage(
  runtime: AgentRuntime,
  sessionId: string,
  message: Omit<SessionMessage, "type" | "id" | "createdAt">,
): Promise<SessionMessage> {
  const session = await requireSession(runtime, sessionId);
  const fullMessage: SessionMessage = { type: "message", id: crypto.randomUUID(), createdAt: Date.now(), ...message };
  const { type: _messageType, ...presentationMessage } = fullMessage;
  void _messageType;
  const presentation = session.presentation ?? { messages: [] };
  presentation.messages.push(presentationMessage);
  session.presentation = presentation;
  await runtime.sessions.save(session);
  return fullMessage;
}

/** 更新 Core Session 标题。 */
export async function updateSessionTitle(runtime: AgentRuntime, sessionId: string, title: string): Promise<void> {
  const session = await requireSession(runtime, sessionId);
  session.title = title;
  await runtime.sessions.save(session);
}

/** 更新 Core Session 中的固定 Skill 展示投影。 */
export async function updatePinnedSkills(runtime: AgentRuntime, sessionId: string, pinnedSkills: SessionPinnedSkill[]): Promise<SessionMeta> {
  const session = await requireSession(runtime, sessionId);
  const presentation = session.presentation ?? { messages: [] };
  presentation.pinnedSkills = pinnedSkills;
  session.presentation = presentation;
  await runtime.sessions.save(session);
  return toSessionMeta(session);
}

/** 读取最近一次成功 compact 的 Core Session 展示投影。 */
export async function getLatestCompactionRecord(runtime: AgentRuntime, sessionId: string): Promise<SessionCompactionRecord | undefined> {
  const session = await requireSession(runtime, sessionId);
  const record = [...(session.presentation?.compactions ?? [])].reverse().find((item) => item.status === "completed");
  return record ? { type: "agent_compaction", ...record } : undefined;
}

/** 将 compact 投影写入 Core Session。 */
export async function appendCompactionRecord(
  runtime: AgentRuntime,
  sessionId: string,
  record: Omit<SessionCompactionRecord, "type" | "compactId" | "createdAt">,
): Promise<SessionCompactionRecord> {
  const session = await requireSession(runtime, sessionId);
  const fullRecord: SessionCompactionRecord = { type: "agent_compaction", compactId: crypto.randomUUID(), createdAt: Date.now(), ...record };
  const { type: _recordType, ...presentationRecord } = fullRecord;
  void _recordType;
  const presentation = session.presentation ?? { messages: [] };
  presentation.compactions = [...(presentation.compactions ?? []), presentationRecord];
  session.presentation = presentation;
  await runtime.sessions.save(session);
  return fullRecord;
}

/** 通过 Core Runtime 删除 Session；级联清理由 Runtime 统一执行。 */
export async function deleteSession(runtime: AgentRuntime, sessionId: string): Promise<boolean> {
  return runtime.sessions.delete(sessionId);
}

/** 读取 Core Session 的 Web Meta。 */
export async function getSessionMeta(runtime: AgentRuntime, sessionId: string): Promise<SessionMeta> {
  return toSessionMeta(await requireSession(runtime, sessionId));
}
