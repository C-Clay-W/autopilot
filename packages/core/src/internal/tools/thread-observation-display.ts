/** 为协作观察生成有界安全展示，分组身份只含哈希，不导出原始参数或消息正文。 */
import { createHash } from "node:crypto";
import type { ToolDisplayFacts } from "./types";

/** 只读取本地协作工具已校验的目标与任务身份，游标和等待时长不改变分组。 */
export function createThreadObservationDisplay(toolName: string, input: unknown, output?: unknown): ToolDisplayFacts["observation"] {
  if (!["wait_threads", "read_thread", "read_progress"].includes(toolName) || !input || typeof input !== "object") return undefined;
  const request = input as Record<string, unknown>;
  const targets = toolName === "wait_threads" ? request.targets : [{ threadId: request.threadId, taskId: request.taskId }];
  if (!Array.isArray(targets) || !targets.length) return undefined;
  const identities = targets.map(function identity(target: { threadId?: unknown; taskId?: unknown }) { return [target.threadId, target.taskId ?? null]; });
  const key = createHash("sha256").update(JSON.stringify([toolName, identities.sort(function order(a, b) { return JSON.stringify(a).localeCompare(JSON.stringify(b)); })])).digest("hex");
  if (!output || typeof output !== "object") return { key, phase: "pending", lines: [] };
  const result = output as Record<string, unknown>;
  const rows = Array.isArray(result.results) ? result.results : [result];
  const phases: unknown[] = [];
  const lines: string[] = [];
  const approvalTargets: string[] = [];
  for (const row of rows.slice(0, 8)) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const thread = record.thread as { status?: string } | undefined;
    const turn = record.turn as { status?: string } | undefined;
    const summary = record.summary && typeof record.summary === "object" ? record.summary as Record<string, unknown> : { ...record, ...(thread ? { sessionStatus: thread.status, turnStatus: turn?.status } : {}) };
    const targetId = record.threadId ?? (record.thread as { threadId?: unknown } | undefined)?.threadId;
    if ((summary.waiting === "approval" && summary.interactionState === "pending") && typeof targetId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(targetId) && identities.some(function requested(identity) { return identity[0] === targetId; })) approvalTargets.push(targetId);
    // 固定状态和显式进展摘要按白名单投影；路径、消息与游标不进入展示正文。
    const fields = ["reason", "sessionStatus", "turnStatus", "execution", "waiting", "result", "deliveryStatus", "interactionState", "continuationState", "interactionDecision", "attentionKind", "unconfirmedReason"];
    const values = fields.map(function field(name) {
      const value = name === "reason" ? record[name] : summary[name];
      return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? `${name}=${value}` : undefined;
    }).filter(function present(value): value is string { return Boolean(value); });
    const progress = typeof summary.progressCount === "number" ? summary.progressCount : Array.isArray(record.items) ? record.items.length : undefined;
    if (progress !== undefined) values.push(`progress=${progress}`);
    const entries = Array.isArray(record.items) ? record.items.slice(0, 20) as Array<{ kind?: string; summary?: string; progressSeq?: number }> : [];
    const kind = entries.filter(function substantial(item) { return item.kind !== "progress"; }).map(function entry(item) { return [item.kind, item.progressSeq]; });
    for (const entry of entries) {
      if (["progress", "milestone", "blocked", "completed", "failed"].includes(entry.kind ?? "") && typeof entry.summary === "string") lines.push(`${entry.kind} · ${entry.summary.slice(0, 256)}`);
    }
    phases.push([record.reason === "attention" ? record.cursor : undefined, record.reason === "terminal" || record.reason === "attention" ? record.reason : undefined, values.filter(function stage(value) { return !value.startsWith("reason=") && !value.startsWith("progress="); }), kind]);
    lines.push(values.join(" · ") || "观察结果已返回");
  }
  return { key, phase: createHash("sha256").update(JSON.stringify(phases)).digest("hex"), lines, ...(approvalTargets.length ? { approvalTargets: [...new Set(approvalTargets)] } : {}) };
}
