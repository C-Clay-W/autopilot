/** CLI 终态投影的稳定文案；只消费 Core 白名单原因与预算数值。 */
import type { AgentTerminationView } from "@autopilot-agent/core";

/** 将白名单终态事实格式化为 Plain、JSONL 辅助展示与 TUI 共用的短文案。 */
export function formatAgentTermination(view: AgentTerminationView): string {
  const labels: Record<NonNullable<AgentTerminationView["reason"]>, string> = {
    runtime_budget: "执行时长达到上限",
    token_budget: "Token 预算耗尽",
    repeated_tool_calls: "检测到重复工具调用",
    write_verification: "等待修改文件读回验证",
    stale_lease: "执行租约已过期",
    turn_limit_reached: "达到执行步数上限",
  };
  // 旧版本可能对可恢复暂停发送无 reason 的 termination；recoverable 时的安全兜底是“执行已暂停”，不是“任务已停止”。
  const reason = view.reason ? labels[view.reason] : view.recoverable ? "执行已暂停" : "任务已停止";
  const recovery = view.recoverable ? "可继续" : "不可继续";
  const budget = view.budget
    ? `${view.budget.used}/${view.budget.limit} ${view.budget.unit}`
    : undefined;
  return [reason, recovery, budget].filter(Boolean).join(" · ");
}
