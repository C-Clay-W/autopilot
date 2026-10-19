/**
 * internal/tools/synthetic-tool-result.ts — 无法确认真实执行结果时的确定性工具错误终态。
 *
 * 该模块只生成不会伪造副作用成功的标准 ToolExecutionResult，供取消、拒绝后的未执行
 * sibling 与崩溃恢复闭合 canonical tool-call/result 配对。
 */

import type { AgentToolCall } from "../types";
import type { ToolExecutionResult } from "./types";

/** 为尚未产生可信终态的工具调用构造不可重试的合成错误结果。 */
export function createSyntheticToolErrorResult(
  call: AgentToolCall,
  code: "TOOL_ABORTED_BEFORE_DISPATCH" | "TOOL_NOT_EXECUTED_AFTER_DENIAL" | "TOOL_OUTCOME_UNKNOWN" | "WEB_INPUT_UNAVAILABLE",
  message: string,
): Extract<ToolExecutionResult, { status: "error" }> {
  return {
    status: "error",
    callId: call.id,
    toolName: call.name,
    error: { code, message },
  };
}
