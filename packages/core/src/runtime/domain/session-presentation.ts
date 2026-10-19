/**
 * runtime/domain/session-presentation.ts — 宿主可重建的会话展示投影
 *
 * 展示投影与 Session 一同由 Core SessionStore 持久化，不单独成为宿主状态源。
 */

/** 会话展示层固定 Skill 引用；正文仍由宿主受控 catalog 按需加载。 */
export interface SessionPresentationPinnedSkill {
  skillRef: string;
  skillId: string;
  contentHash: string;
  pinnedAt: number;
}

/** 会话展示层单条消息；只保存 UI 恢复需要的脱敏字段。 */
export interface SessionPresentationMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  /** Agent 生成的 assistant 投影绑定对应 Runtime Turn；普通用户消息不填写。 */
  turnId?: string;
  content: string;
  sources?: Array<{ id: string; score: number; text: string; metadata: Record<string, unknown> }>;
  attachments?: Array<{ id: string; name: string; mimeType: string; relativePath: string }>;
  editDiffs?: Array<{ callId: string; filePath: string; replacements: number; diff: string }>;
  processSteps?: Array<{ stage: string; message: string }>;
  turnSegments?: Array<{ id: string; content: string; processSteps: Array<{ stage: string; message: string }> }>;
  createdAt: number;
}

/** 会话展示层 compact 结果；原始 Runtime checkpoint 与 transcript 仍是执行事实。 */
export interface SessionPresentationCompaction {
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

/** 宿主展示缓存；删除后可由 Core transcript/checkpoint 重建最小会话视图。 */
export interface SessionPresentation {
  messages: SessionPresentationMessage[];
  pinnedSkills?: SessionPresentationPinnedSkill[];
  compactions?: SessionPresentationCompaction[];
}
