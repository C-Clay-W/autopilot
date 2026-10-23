/**
 * CLI Plain/text/JSONL Renderer。
 *
 * Renderer 只消费 event-projector 产生的安全事件，不读取 AgentEvent 原文、
 * Store、checkpoint 或 Web SSE DTO；因此 text 与 JSONL 的语义来源一致。
 */

import type { CliPublicEvent, CliRenderer } from "./types.js";
import { formatAgentTermination } from "./termination-format.js";

/** 判断审批约束是否为无沙箱直接执行；与 Web 审批卡同一字符串判定，休眠底座不签发，历史记录仍可能携带。 */
function isNoSandboxApproval(constraint: string | undefined): boolean {
  return constraint === "no-sandbox-exec:v1";
}

/** 将安全事件渲染为不带 ANSI 的 Plain 文本行。 */
function renderTextEvent(event: CliPublicEvent): string {
  switch (event.type) {
    case "turn_started": return `turn started (${event.turnId})`;
    case "reasoning_summary": return `reasoning: ${event.summary}`;
    case "reasoning_hidden": return "reasoning: [hidden]";
    case "answer_delta": return `answer: ${event.delta}`;
    case "answer_reset": return "answer reset";
    case "tool_started": return `tool ${event.toolName}: ${event.summary}`;
    case "tool_progress": return `tool ${event.toolName}: ${event.tail}`;
    case "tool_result": {
      const isolation = event.display?.executionMode === "unisolated" ? " · 未隔离：宿主直接执行" : "";
      const diagnostics = event.display?.diagnostics?.length ? ` · 诊断：${event.display.diagnostics.join("；")}` : "";
      return `tool ${event.toolName} [${event.status}]: ${event.summary}${event.errorCode ? ` (${event.errorCode})` : ""}${diagnostics}${isolation}${event.diff ? `\n${event.diff}` : ""}`;
    }
    case "approval_required": {
      const cwd = event.display?.cwd ? ` · 工作目录：${event.display.cwd}` : "";
      const noSandbox = isNoSandboxApproval(event.constraint) ? " · 无沙箱直接执行，仅本次有效" : "";
      // Talk-Plan1022 S3：宿主执行审批卡按"将采用"措辞说明无隔离事实，待审批不显示成已执行。
      const hostExecution = event.display?.executionMode === "unisolated" ? " · 将在当前用户权限下运行（未启用沙箱隔离）" : "";
      return `approval ${event.approvalId}: ${event.toolName} ${event.reason}${cwd}${noSandbox}${hostExecution}`;
    }
    case "input_queued": return `input queued: ${event.inputId} (${event.delivery})`;
    case "todo_updated": {
      const total = event.todos.length;
      const inProgress = event.todos.find(function findActiveTodo(todo): boolean { return todo.status === "in_progress"; });
      return `todo: ${event.counts.completed}/${total} completed${inProgress ? ` · in progress: ${inProgress.activeForm}` : ""}`;
    }
    case "input_joined": return `input joined: ${event.inputId}`;
    case "input_consumed": return `input consumed: ${event.inputId}`;
    case "model_recovery": return `model recovery: ${event.reason} (${event.attempt}/${event.maxAttempts})`;
    case "context_overflow": return "context overflow: recovery required";
    case "context_compact_started": return "context compact started";
    case "context_compacted": return `context compacted: ${event.preTokens} -> ${event.postTokens}`;
    case "context_compact_failed": return "context compact failed";
    case "context_compact_circuit_open": return "context compact circuit open";
    // 用量变化只属于动态状态栏；text 输出空行跳过，JSONL 仍输出结构化安全 DTO。
    case "context_usage": return "";
    case "active_skills": return `active skills: ${event.skills.map(function skillId(skill) { return skill.skillId; }).join(", ") || "none"}`;
    case "status": return `status: ${event.status}${event.code ? ` (${event.code})` : ""}${event.reason ? ` · ${event.reason}` : ""}${event.termination ? ` · ${formatAgentTermination(event.termination)}` : ""}`;
  }
}

/** 创建 Plain Renderer；jsonl 模式只输出稳定安全事件 JSON。 */
export function createPlainRenderer(format: "text" | "jsonl"): CliRenderer {
  return {
    format,
    render(event: CliPublicEvent): string {
      return format === "jsonl" ? JSON.stringify(event) : renderTextEvent(event);
    },
  };
}
