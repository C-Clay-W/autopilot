/**
 * Web Context budget 兼容入口；实现统一位于 @autopilot-agent/adapters。
 */

export { createContextBudget, estimateTokens, DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_COMPACT_TRIGGER_RATIO, DEFAULT_COMPACT_TARGET_RATIO } from "@autopilot-agent/adapters";
export type { NodeContextBudgetSnapshot as ContextBudgetSnapshot } from "@autopilot-agent/adapters";
