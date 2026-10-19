/**
 * runtime-host/web-compaction-projection.ts — CompactTurnResult → Web DTO 映射
 *
 * Phase 4 新增：把 Core Runtime 的 CompactTurnResult 映射为 Web `session-store.ts` 中
 * `CompactionRecord` 的字段，供 `/api/sessions/[id]/messages` 的 compact 操作返回。
 */

import crypto from "node:crypto";
import type { CompactTurnResult, AgentMessage, AgentRuntime } from "@autopilot-agent/core";
import { appendCompactionRecord, type SessionCompactionRecord, type SessionMessage } from "@/lib/session-store";

export interface WebCompactionRecord {
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
}

/** 压缩记录只消费 summary/preTokens/postTokens/preservedFromIndex；outcome/contextUsage 由调用方另行消费。 */
type CompactionRecordSource = Pick<CompactTurnResult, "summary" | "preTokens" | "postTokens" | "preservedFromIndex">;

/**
 * 根据 Core compact 结果与当前历史消息生成 Web CompactionRecord。
 *
 * @param result Core compact 结果（只读取压缩记录需要的字段）
 * @param history Web 历史消息（含 id）
 * @param trigger 触发原因
 */
export function toWebCompactionRecord(
  result: CompactionRecordSource,
  history: SessionMessage[],
  trigger: "auto" | "manual" | "proactive" | "reactive",
): WebCompactionRecord {
  const sourceMessages = history.slice(0, Math.max(0, result.preservedFromIndex - 1));
  const preservedTail = history.slice(Math.max(0, result.preservedFromIndex - 1));
  const firstId = sourceMessages[0]?.id ?? history[0]?.id ?? "none";
  const lastId = sourceMessages.at(-1)?.id ?? firstId;
  return {
    compactId: crypto.randomUUID(),
    trigger,
    sourceFromId: firstId,
    sourceToId: lastId,
    preservedTailIds: preservedTail.map((message) => message.id),
    summary: result.summary,
    summaryHash: crypto.createHash("sha256").update(result.summary).digest("hex"),
    preTokens: result.preTokens,
    postTokens: result.postTokens,
    status: "completed",
  };
}

/**
 * 把 Web 历史消息映射为 Core V2 AgentMessage；用于 compact 前构造 messages。
 */
export function toCoreMessages(history: SessionMessage[]): AgentMessage[] {
  return [
    { role: "system", content: [{ type: "text", text: "你是标准编码与知识助手。" }] },
    ...history
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: [{ type: "text", text: message.content }] }) as AgentMessage),
  ];
}

/** 将 Core compact 结果投影为 Web 记录并写入 Session UI 投影。 */
export async function persistCompactionRecord(
  runtime: AgentRuntime,
  sessionId: string,
  result: CompactionRecordSource,
  history: SessionMessage[],
  trigger: "auto" | "manual" | "proactive" | "reactive",
): Promise<SessionCompactionRecord> {
  return appendCompactionRecord(runtime, sessionId, toWebCompactionRecord(result, history, trigger));
}

/** 记录失败的 compact 投影，保留 Web 历史上的失败审计信息。 */
export async function persistFailedCompactionRecord(
  runtime: AgentRuntime,
  sessionId: string,
  history: SessionMessage[],
  trigger: "auto" | "manual" | "proactive" | "reactive",
): Promise<SessionCompactionRecord> {
  const summary = "";
  return appendCompactionRecord(runtime, sessionId, {
    trigger,
    sourceFromId: history[0]?.id ?? "none",
    sourceToId: history.at(-1)?.id ?? "none",
    preservedTailIds: [],
    summary,
    summaryHash: crypto.createHash("sha256").update(summary).digest("hex"),
    preTokens: 0,
    postTokens: 0,
    status: "failed",
  });
}
