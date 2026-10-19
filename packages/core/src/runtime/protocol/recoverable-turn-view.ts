/**
 * runtime/protocol/recoverable-turn-view.ts — 宿主可消费的脱敏恢复视图。
 *
 * 该 DTO 只描述恢复所需的生命周期和审批摘要，不暴露 checkpoint、消息、
 * pending call、lease、输入 hash、凭据或其他 Runtime 私有字段。
 */

/** CLI/Web 等宿主可以观察到的恢复状态。 */
export type RecoverableTurnStatus =
  | "running"
  | "awaiting_approval"
  | "awaiting_user_input"
  | "interrupted_recoverable"
  | "limit_reached"
  | "completed"
  | "failed";

/** 可向宿主展示的终态原因枚举；不得把 Provider 或内部错误文本放进原因字段。 */
export type AgentTerminationReason =
  | "runtime_budget"
  | "token_budget"
  | "repeated_tool_calls"
  | "write_verification"
  | "stale_lease"
  | "turn_limit_reached";

/** 与终态原因匹配的有限数值摘要；数值单位只能是毫秒或 Provider token。 */
export interface AgentTerminationBudget {
  used: number;
  limit: number;
  unit: "ms" | "tokens";
}

/** Core 确认的终态恢复能力及可选的白名单原因/预算。 */
export interface AgentTerminationView {
  reason?: AgentTerminationReason;
  recoverable: boolean;
  budget?: AgentTerminationBudget;
}

/** 只复制终态协议白名单字段；未知原因、畸形数值与额外字段被丢弃。 */
export function sanitizeAgentTerminationView(value: unknown, recoverableOverride?: boolean): AgentTerminationView | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return recoverableOverride === undefined ? undefined : { recoverable: recoverableOverride };
  }
  const source = value as Record<string, unknown>;
  const recoverable = recoverableOverride ?? (typeof source.recoverable === "boolean" ? source.recoverable : undefined);
  if (recoverable === undefined) return undefined;
  const allowedKeys = new Set(["reason", "recoverable", "budget"]);
  if (Object.keys(source).some(function hasExtraKey(key) { return !allowedKeys.has(key); })) return { recoverable };

  const reasons: AgentTerminationReason[] = ["runtime_budget", "token_budget", "repeated_tool_calls", "write_verification", "stale_lease", "turn_limit_reached"];
  const reason = reasons.find(function isKnownReason(item) { return source.reason === item; });
  const view: AgentTerminationView = { recoverable };
  if (!reason) return view;
  view.reason = reason;

  const rawBudget = source.budget;
  if (!rawBudget || typeof rawBudget !== "object" || Array.isArray(rawBudget)) return view;
  const budget = rawBudget as Record<string, unknown>;
  const expectedUnit = reason === "runtime_budget" ? "ms" : reason === "token_budget" ? "tokens" : undefined;
  const budgetKeys = Object.keys(budget);
  if (!expectedUnit || budgetKeys.length !== 3 || budgetKeys.some(function hasUnknownBudgetKey(key) {
    return key !== "used" && key !== "limit" && key !== "unit";
  })) return view;
  if (budget.unit !== expectedUnit
    || typeof budget.used !== "number"
    || !Number.isSafeInteger(budget.used)
    || budget.used < 0
    || typeof budget.limit !== "number"
    || !Number.isSafeInteger(budget.limit)
    || budget.limit < 0) return view;

  view.budget = { used: budget.used, limit: budget.limit, unit: expectedUnit };
  return view;
}

/** 宿主提交审批前可以显示的安全摘要。 */
export interface RecoverableApprovalView {
  approvalId: string;
  toolName: string;
  reason: string;
  risk?: string;
}

/** Runtime 为恢复入口提供的最小脱敏状态。 */
export interface RecoverableTurnView {
  sessionId: string;
  turnId: string;
  status: RecoverableTurnStatus;
  /** 由 Core 的 Continue 状态规则计算；宿主不得从展示文案自行推断。 */
  recoverable: boolean;
  /** 只包含当前终态事件已投影的白名单原因和数值；旧数据可缺省。 */
  termination?: AgentTerminationView;
  approval?: RecoverableApprovalView;
  lastSeq?: number;
  activeSkills: Array<{ skillId: string; contentHash: string }>;
}
