/**
 * TUI 纯函数格式化工具：状态/工具/审批/权限标签、耗时与进度、工具行文案、
 * 已消费输入文案和终端尺寸读取。本文件不依赖任何 React 组件。
 */

import type {
  CliAction,
  CliPublicEvent,
  CliStatusView,
  CliTurnStatus,
} from "../types.js";
import type { CliTuiTimelineEvent } from "./types.js";
import { formatAgentTermination } from "../termination-format.js";
import { isSandboxUnavailableErrorCode } from "@autopilot-agent/presentation";

/** 判断一个状态是否已经离开可继续执行的活动阶段；waiting_user_input 是可恢复等待，不算终态。 */
export function isTerminalStatus(status: CliTurnStatus): boolean {
  return status !== "idle" && status !== "running" && status !== "waiting_approval" && status !== "waiting_user_input";
}

/** 判断 Turn 是否仍可由 Ctrl+C 或 Esc 请求 Runtime 取消。 */
export function isActiveTuiStatus(status: CliTurnStatus): boolean {
  return status === "running" || status === "waiting_approval";
}

/** 将内部生命周期状态转换为用户视角的短状态。 */
export function getTuiStatusLabel(status: CliTurnStatus): string {
  switch (status) {
    case "idle": return "Ready";
    case "running": return "Working";
    case "waiting_approval": return "Waiting for approval";
    case "waiting_user_input": return "Waiting for Web answer";
    case "interrupted": return "Stopped";
    case "interrupted_recoverable": return "Paused — resume available";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "limit_reached": return "Limit reached — resume available";
  }
}

/** 从 CLI 安全事件中读取失败终态原因，不访问 Runtime 原始错误。 */
export function getTuiTurnFailureReason(events: CliTuiTimelineEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "status" && event.status === "failed" && event.reason) return event.reason;
  }
  return undefined;
}

/** 只有真实中断或失败终态才允许解释 termination；进行中与等待状态不得从旧事件复活终态。 */
function isRealTurnEndStatus(status: CliTurnStatus): boolean {
  return status === "interrupted" || status === "interrupted_recoverable" || status === "failed" || status === "limit_reached";
}

/** 从 CLI 安全状态事件读取终态原因、恢复性与预算摘要；只解释最新生命周期状态，当前状态非终态时不复活旧 pause 的 termination。 */
export function getTuiTerminationSummary(events: CliTuiTimelineEvent[], currentStatus?: CliTurnStatus): string | undefined {
  if (currentStatus !== undefined && !isRealTurnEndStatus(currentStatus)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "status") return event.termination && isRealTurnEndStatus(event.status) ? formatAgentTermination(event.termination) : undefined;
  }
  return undefined;
}

/** 将内部工具名映射为面向用户的动作名称。 */
export function getTuiToolLabel(toolName: string): string {
  switch (toolName) {
    case "glob_files": return "查找文件";
    case "grep_files": return "搜索代码";
    case "read_file": return "查看文件";
    case "write_file": return "写入文件";
    case "edit_file": return "修改文件";
    case "run_command": return "运行命令";
    default: return "处理任务";
  }
}

/** 清理工具摘要中的内部名称与重复前缀。 */
export function cleanTuiToolSummary(toolName: string, summary: string): string {
  // run_command 的 started summary 已由 Core 脱敏为 `$ command`，这是树状进度中唯一需要保留的命令细节。
  if (toolName === "run_command") return summary;
  const withoutToolName = summary.replace(new RegExp(`^${toolName}:\\s*`, "i"), "");
  if (toolName === "glob_files") return withoutToolName.replace(/^Searching files:\s*/i, "");
  if (toolName === "grep_files") return withoutToolName.replace(/^Searching code:\s*/i, "");
  if (toolName === "read_file") return withoutToolName.replace(/^Reading\s+/i, "");
  return withoutToolName;
}

/** 将 0..1 的动画进度限制在可渲染范围。 */
export function clampTuiProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 将耗时格式化为稳定的 h/m/s，避免长任务只显示一个不断增长的秒数。 */
export function formatTuiDuration(durationMs: number): string {
  const totalSeconds = Math.round(Math.max(0, durationMs) / 1000);
  if (totalSeconds === 0) return "<1s";
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** 工具结果行的分段：glyph 是状态文字标签，badge 是 [动作名] 徽标文本，rest 是徽标后的详情或失败原因。 */
export interface TuiToolLineParts {
  glyph?: string;
  badge: string;
  rest: string;
}

/** 将工具执行结果拆分为 glyph/徽标/详情三段；彩色 chip 渲染与纯文本出口共用同一份布局事实。 */
export function getTuiToolLineParts(toolName: string, summary: string, status?: Extract<CliPublicEvent, { type: "tool_result" }>["status"], errorCode?: string): TuiToolLineParts {
  const label = getTuiToolLabel(toolName);
  const detail = cleanTuiToolSummary(toolName, summary).trim();
  if (status === undefined) return { badge: `[${label}]`, rest: detail ? ` · ${detail}` : "" };
  if (status === "success") return { glyph: "✓", badge: `[${label}]`, rest: toolName === "run_command" ? "" : detail ? ` · ${detail}` : "" };
  return { glyph: "✗", badge: `[${label}]`, rest: ` · ${getTuiToolFailureMessage(status, errorCode, detail)}` };
}

/** 将工具执行结果映射为稳定、简短的用户视角结果行；徽标固定为 [动作名]，NO_COLOR 下即退化形态。 */
export function formatTuiToolLine(toolName: string, summary: string, status?: Extract<CliPublicEvent, { type: "tool_result" }>["status"], errorCode?: string): string {
  const parts = getTuiToolLineParts(toolName, summary, status, errorCode);
  return `${parts.glyph ? `${parts.glyph} ` : ""}${parts.badge}${parts.rest}`;
}

/** 读取 edit diff 的新增/删除行数，兼容旧事件只携带文本的情况。 */
export function getTuiDiffStats(diff?: { text?: string; added?: number; removed?: number }): { added: number; removed: number } | undefined {
  if (!diff) return undefined;
  const lines = diff.text?.replace(/\r\n?/g, "\n").split("\n");
  const added = diff.added ?? lines?.filter(function countAdded(line) { return line.startsWith("+") && !line.startsWith("+++"); }).length;
  const removed = diff.removed ?? lines?.filter(function countRemoved(line) { return line.startsWith("-") && !line.startsWith("---"); }).length;
  if (added === undefined && removed === undefined) return undefined;
  return { added: added ?? 0, removed: removed ?? 0 };
}

/** 将 edit diff 统计格式化为 NO_COLOR 与纯文本出口共用的稳定文本。 */
export function formatTuiDiffStats(diff?: { text?: string; added?: number; removed?: number }): string | undefined {
  const statistics = getTuiDiffStats(diff);
  return statistics ? `(+${statistics.added}, -${statistics.removed})` : undefined;
}

/** 将内部错误码收敛为用户能理解的结果，不把 Core/工具实现细节直接打印到终端。 */
export function getTuiToolFailureMessage(status: Extract<CliPublicEvent, { type: "tool_result" }>["status"], errorCode?: string, detail?: string): string {
  if (status === "approval_required") return "需要确认";
  if (status === "question_required") return "请在支持结构化回答的 Web 中处理";
  // 2.5：沙箱不可用类拒绝是环境阻塞而非用户拒绝，文案必须区分。
  if (status === "denied") return isSandboxUnavailableErrorCode(errorCode) ? "沙箱不可用，命令未启动" : "已拒绝";
  if (status === "cancelled") return "已取消";
  if (status === "timeout") return "执行超时";
  if (status === "error" && detail?.startsWith("Exit ")) return "命令执行失败";
  switch (errorCode) {
    case "FILE_NOT_READ": return "读取文件失败";
    case "FILE_NOT_WRITTEN": return "写入文件失败";
    case "FILE_EDIT_FAILED": return "修改文件失败";
    case "PERMISSION_DENIED": return "权限不足";
    case "TOOL_EXECUTION_FAILED":
    case "COMMAND_FAILED":
      return "工具执行失败";
    default:
      return detail && !/^[A-Z][A-Z0-9_]+$/.test(detail) ? detail : "工具执行失败";
  }
}

/** 将已由 Controller 成功投递的输入统一为可读的插入提示。 */
export function formatTuiInputConsumed(event: Extract<CliTuiTimelineEvent, { type: "tui_input_consumed" }>): string {
  const label = event.delivery === "queue" ? "[排队]" : "[引导]";
  return `${label} 已插入当前 turn`;
}

/** 将 Core 权限模式转换为状态栏可读的中文标签。 */
export function getTuiPermissionModeLabel(mode: CliStatusView["permissionMode"]): string {
  if (mode === "auto_approve") return "为我审批";
  if (mode === "full_access") return "完全访问";
  return "询问";
}

/** 将审批决定映射为稳定中文标签；历史时间线与动态时间线共用同一份映射。 */
export function getTuiApprovalDecisionLabel(decision: Extract<CliAction, { type: "approve" }>["decision"]): string {
  return decision === "allow_once" ? "本次" : decision === "allow_session" ? "本次会话" : decision === "allow_workspace" ? "此工作区" : "拒绝";
}

/** 将终端流尺寸收敛为 TUI 布局使用的列/行数；宽度保留最小 30、最大 120 的既有约束。 */
export function readTuiTerminalSize(stdout: { columns?: number; rows?: number }): { columns: number; rows: number } {
  return {
    columns: Math.max(30, Math.min(Number(stdout.columns ?? 80) - 2, 120)),
    rows: Math.max(8, Number(stdout.rows ?? 24)),
  };
}
