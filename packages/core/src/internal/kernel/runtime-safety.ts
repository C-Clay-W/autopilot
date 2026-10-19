/**
 * Agent 长调用链的独立安全护栏：只保存脱敏哈希与计数，不保存工具参数或结果正文。
 */

import { createHash } from "node:crypto";
import type { AgentToolCall } from "../types";
import type { ToolExecutionResult } from "../tools/types";
import { serializeToolResultForModel } from "../tool-scheduler";

/** 重复调用按连续次数分级提醒，最终进入可恢复暂停。 */
export const AGENT_REPETITION_GUARDRAIL = {
  reminderAt: 3,
  strongReminderAt: 5,
  pauseAt: 8,
} as const;

/** 递归排序对象键，保证同一参数不同键序得到同一签名。 */
function normalizeForSignature(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeForSignature);
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce<Record<string, unknown>>(function addKey(result, key) {
    const normalized = normalizeForSignature(record[key]);
    if (normalized !== undefined) result[key] = normalized;
    return result;
  }, {});
}

/** 只记录稳定的结果状态、错误码和正文摘要；动态展示指标不能进入连续指纹。 */
function summarizeResult(result: ToolExecutionResult): Record<string, unknown> {
  const error = "error" in result ? result.error : undefined;
  return {
    status: result.status,
    errorCode: error && typeof error === "object" ? (error as { code?: unknown }).code : undefined,
    resultDigest: createHash("sha256").update(serializeToolResultForModel(result)).digest("hex"),
  };
}

/** 生成工具名、规范化参数和结果摘要的脱敏连续调用指纹。 */
export function getToolProgressFingerprint(call: AgentToolCall, result: ToolExecutionResult): string {
  return createHash("sha256").update(JSON.stringify({
    toolName: call.name,
    input: normalizeForSignature(call.input),
    result: summarizeResult(result),
  })).digest("hex");
}
