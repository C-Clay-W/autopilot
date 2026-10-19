/**
 * runtime/protocol/compact-turn-input.ts — compact 命令输入协议
 *
 * Phase 4 新增：定义宿主调用 TurnService.compact() 时的输入参数。
 */

import type { AgentMessage } from "../../internal/types/agent-message";

/** 压缩一次 turn 的输入。 */
export interface CompactTurnInput {
  sessionId: string;
  turnId: string;
  /**
   * 可选的完整消息列表；省略时由 Runtime 从当前 checkpoint 读取，宿主不必接触
   * checkpoint 私有字段。旧 Web 迁移调用仍可暂时传入该字段。
   */
  messages?: AgentMessage[];
  /** 触发原因。 */
  trigger: "auto" | "manual" | "proactive" | "reactive";
  /**
   * 保留最近多少轮 user/assistant 消息不被压缩；省略时由 Runtime 读取该 Turn
   * 已冻结的 compactPolicy 或 Runtime 默认策略。
   */
  preserveRecentTurns?: number;
  /**
   * 压缩后目标 token 预算；省略时由 Runtime 读取该 Turn 已冻结的
   * compactPolicy 或 Runtime 默认策略。
   */
  targetTokens?: number;
  signal?: AbortSignal;
}

/** compact 完成后的事件负载。 */
export interface CompactTurnResult {
  /** changed 表示消息投影实际替换；skipped 表示无可压缩历史，checkpoint/anchor/usage 均不变。 */
  outcome: "changed" | "skipped";
  /** skipped 时的稳定原因；changed 时省略。 */
  reason?: "no_compactable_history";
  summary: string;
  messages: AgentMessage[];
  preTokens: number;
  postTokens: number;
  preservedFromIndex: number;
  /** compact 后的最新安全投影；changed 为 estimated 降级，skipped 保持原值，无冻结窗口时为 null。 */
  contextUsage: import("../../internal/kernel/context-budget").ContextUsageView | null;
}
