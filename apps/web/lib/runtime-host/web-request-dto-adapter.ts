/**
 * runtime-host/web-request-dto-adapter.ts — Web 请求 DTO → Runtime 命令映射
 *
 * Phase 4 新增：把 Next.js Request / params 转换为 Core Runtime 的 StartTurnInput。
 * 仅处理 start 路径；continue / steer / compact 在后续步骤扩展。
 */

import type { StartTurnInput, AgentMessage, InboxAttachmentRef, InboxSkillRef } from "@autopilot-agent/core";

export interface WebStartBody {
  content?: string;
  clientMessageId?: string;
  delivery?: "auto" | "steer" | "queue";
  attachmentIds?: string[];
  selectedSkills?: Array<{
    skillRef: string;
    arguments?: string;
    pinned?: boolean;
  }>;
  /** 前端传入的系统消息；可选。 */
  systemMessage?: string;
  /** 历史消息；start 路径通常由 Runtime 自行读取 checkpoint/session。 */
  messages?: AgentMessage[];
}

export interface StartRequestContext {
  sessionId: string;
  body: WebStartBody;
  signal?: AbortSignal;
}

/** 解析前端附件引用；当前仅保留 ID，Step 3 后接入真实文件解析。 */
function parseAttachmentRefs(_sessionId: string, attachmentIds?: string[]): InboxAttachmentRef[] {
  return (attachmentIds ?? []).map((id) => ({ id, name: id, mimeType: "application/octet-stream" }));
}

/** 解析前端 selectedSkills；当前做最小字段透传。 */
function parseSkillRefs(skills?: WebStartBody["selectedSkills"]): InboxSkillRef[] {
  return (skills ?? []).map((skill) => ({
    skillRef: skill.skillRef,
    skillId: skill.skillRef,
    contentHash: "",
    arguments: skill.arguments,
    pinned: skill.pinned,
  }));
}

/** 把 Web 请求转换为 Runtime StartTurnInput。 */
export function toStartTurnInput(context: StartRequestContext): StartTurnInput {
  const { sessionId, body, signal } = context;
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content && (!body.messages || body.messages.length === 0)) {
    throw new Error("StartTurnInput 必须提供 content 或 messages");
  }

  const messages: AgentMessage[] = [...(body.messages ?? [])];
  if (content) {
    messages.push({ role: "user", content: [{ type: "text", text: content }] });
  }

  return {
    sessionId,
    content,
    messages: messages.length > 0 ? messages : undefined,
    signal,
  };
}

/** 附件与 Skill 的宿主侧冻结结果；在 Step 3 中用于构造 system instructions。 */
export interface ResolvedStartAttachments {
  attachments: InboxAttachmentRef[];
  selectedSkills: InboxSkillRef[];
}

/** 解析附件与 Skill 引用。 */
export function resolveStartAttachments(body: WebStartBody, _sessionId: string): ResolvedStartAttachments {
  return {
    attachments: parseAttachmentRefs(_sessionId, body.attachmentIds),
    selectedSkills: parseSkillRefs(body.selectedSkills),
  };
}
