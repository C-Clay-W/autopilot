/**
 * runtime-host/web-message-projection.ts — AgentEvent → Web UI 投影
 *
 * Phase 4 新增：在 Runtime AgentEvent 流之上累积 editDiff、processStep、answerSegment，
 * 生成与既有 `session-store.ts` DTO 兼容的投影结果，供 React UI 消费。
 *
 * 注意：这是 Web 宿主专属逻辑，不属于 Core Runtime。
 */

import type { AgentEvent, AgentEventEnvelope, AgentRuntime, VectorOutput } from "@autopilot-agent/core";
import { appendMessage, type SessionMessage } from "@/lib/session-store";

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

export interface MessageProjection {
  answer: string;
  sources: VectorOutput[];
  editDiffs: EditDiffRecord[];
  processSteps: ProcessStepRecord[];
  turnSegments: AgentTurnSegmentRecord[];
}

/** 创建空的投影状态。 */
export function createEmptyProjection(): MessageProjection {
  return { answer: "", sources: [], editDiffs: [], processSteps: [], turnSegments: [] };
}

/** 从同一 Turn 的完整 transcript 重建展示投影，供审批续跑和刷新恢复复用。 */
export function projectEvents(envelopes: AgentEventEnvelope[]): MessageProjection {
  let projection = createEmptyProjection();
  const seen = new Set<string>();
  for (const envelope of [...envelopes].sort(function compareEnvelope(left, right) { return left.seq - right.seq; })) {
    const identity = `${envelope.sessionId}:${envelope.turnId}:${envelope.seq}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    projection = applyEvent(projection, envelope.event);
  }
  return projection;
}

/** 将已完成的 Core 事件投影为 Web SessionMessage 并持久化。 */
export async function persistAssistantMessage(
  runtime: AgentRuntime,
  sessionId: string,
  turnId: string,
  projection: MessageProjection,
  content = projection.answer,
  failure?: SessionMessage["failure"],
): Promise<SessionMessage> {
  return appendMessage(runtime, sessionId, {
    role: "assistant",
    turnId,
    content,
    ...(failure ? { failure } : {}),
    sources: projection.sources.length ? projection.sources : undefined,
    editDiffs: projection.editDiffs.length ? projection.editDiffs : undefined,
    processSteps: projection.processSteps.length ? projection.processSteps : undefined,
    turnSegments: projection.turnSegments.length ? projection.turnSegments : undefined,
  });
}

/** 将 Web 请求中的用户消息写入 Session UI 投影。 */
export async function persistUserMessage(
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  attachments?: SessionMessage["attachments"],
  clientRecordId?: string,
): Promise<SessionMessage> {
  return appendMessage(runtime, sessionId, { role: "user", content, attachments, clientRecordId });
}

/** 将知识文件的安全文件名与大小写入 Session 展示历史，不进入 Agent transcript。 */
export async function persistKnowledgeUploadMessage(
  runtime: AgentRuntime,
  sessionId: string,
  clientRecordId: string,
  file: NonNullable<SessionMessage["knowledgeFiles"]>[number],
): Promise<SessionMessage> {
  return appendMessage(runtime, sessionId, { role: "user", content: "", clientRecordId, knowledgeFiles: [file] });
}

/** 将服务端确认的知识入库终态写入 Session 展示历史，供刷新后恢复结果卡片。 */
export async function persistKnowledgeIngestMessage(
  runtime: AgentRuntime,
  sessionId: string,
  clientRecordId: string,
  item: NonNullable<SessionMessage["knowledgeIngestItems"]>[number],
): Promise<SessionMessage> {
  return appendMessage(runtime, sessionId, { role: "assistant", content: "", clientRecordId, knowledgeIngestItems: [item] });
}

/** 从 tool_result 的 output 中安全读取 sources 数组。 */
function extractRagSources(output: unknown): VectorOutput[] {
  if (typeof output !== "object" || output === null) return [];
  const candidate = (output as Record<string, unknown>).sources;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((item): item is VectorOutput => typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).id === "string" && typeof (item as Record<string, unknown>).text === "string");
}

/** 从 edit_file 成功结果中安全读取 path 与 replacements。 */
function extractEditFileOutput(output: unknown): { path?: string; replacements?: number } {
  if (typeof output !== "object" || output === null) return {};
  const record = output as Record<string, unknown>;
  return {
    path: typeof record.path === "string" ? record.path : undefined,
    replacements: typeof record.replacements === "number" ? record.replacements : undefined,
  };
}

/** 把 Core AgentEvent 应用到投影状态；返回更新后的状态。 */
export function applyEvent(projection: MessageProjection, event: AgentEvent): MessageProjection {
  const next = { ...projection };

  switch (event.type) {
    case "answer_delta":
      next.answer += event.delta;
      break;
    case "answer_reset":
      appendTurnSegment(next);
      next.answer = "";
      break;
    case "answer_discard":
      next.answer = "";
      break;
    case "tool_result": {
      const { result, toolName, callId, summary, diff } = event;
      if (result.status === "success" && toolName === "rag_search") {
        const sources = extractRagSources(result.output);
        next.sources.splice(0, next.sources.length, ...sources);
      }
      if (result.status === "success" && toolName === "edit_file" && diff) {
        const out = extractEditFileOutput(result.output);
        appendEditDiff(next, {
          callId,
          filePath: out.path || "file",
          replacements: out.replacements || 0,
          diff,
        });
      }
      if (summary) {
        const stage = `tool-${callId}`;
        const idx = next.processSteps.findIndex((s) => s.stage === stage);
        const step: ProcessStepRecord = { stage, message: summary };
        if (idx >= 0) next.processSteps[idx] = step;
        else appendProcessStep(next, step);
      }
      break;
    }
    case "turn_started":
      appendProcessStep(next, { stage: "prepare", message: "任务已启动，正在理解指令" });
      break;
    case "reasoning_summary":
      if (event.summary) {
        appendProcessStep(next, { stage: `reasoning-${next.processSteps.length}`, message: event.summary });
      }
      break;
    case "tool_started": {
      const summary = event.summary || `正在执行 ${event.toolName}`;
      appendProcessStep(next, { stage: `tool-${event.callId}`, message: summary });
      break;
    }
    default:
      break;
  }

  return next;
}

/** 合并同一文件的多次 edit_file 记录。 */
function appendEditDiff(projection: MessageProjection, record: EditDiffRecord): void {
  const existingIndex = projection.editDiffs.findIndex((item) => item.filePath === record.filePath);
  if (existingIndex < 0) {
    projection.editDiffs.push(record);
    return;
  }
  const existing = projection.editDiffs[existingIndex];
  projection.editDiffs[existingIndex] = {
    ...existing,
    callId: record.callId,
    replacements: existing.replacements + record.replacements,
    diff: `${existing.diff}\n${record.diff}`,
  };
}

/** 去重添加过程步骤。 */
function appendProcessStep(projection: MessageProjection, step: ProcessStepRecord): void {
  if (projection.processSteps.some((item) => item.message === step.message)) return;
  const existingIndex = projection.processSteps.findIndex((item) => item.stage === step.stage);
  if (existingIndex >= 0) projection.processSteps[existingIndex] = step;
  else projection.processSteps.push(step);
}

/** 完成当前 answer 分段。 */
function appendTurnSegment(projection: MessageProjection): void {
  const normalizedContent = projection.answer.trim();
  if (!normalizedContent) return;
  projection.turnSegments.push({
    id: `segment-${projection.turnSegments.length}`,
    content: normalizedContent,
    processSteps: [...projection.processSteps],
  });
  projection.processSteps.splice(0, projection.processSteps.length);
}
