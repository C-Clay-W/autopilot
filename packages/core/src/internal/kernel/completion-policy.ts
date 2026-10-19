/**
 * Agent 完成策略：把“是否可以结束当前 turn”的判断从 Kernel 循环中抽离。
 * 策略只处理完成状态与恢复动作，不执行工具，也不读取宿主或 Provider 配置。
 */

import type { AgentMessage } from "../types/agent-message";

/** 完成策略使用的写入事实快照；字段与 durable mutationGate 保持兼容。 */
export interface CompletionPolicyState {
  required: boolean;
  strong: boolean;
  changedPaths: ReadonlySet<string>;
  verifiedPaths: ReadonlySet<string>;
  recoveryAttempts: number;
}

/** 完成策略观察一条用户输入后得到的意图增量。 */
export interface CompletionIntentSignal {
  required: boolean;
  strong: boolean;
}

/** 完成策略的三种统一结果。 */
export type CompletionDecision =
  | { action: "accept" }
  | { action: "retry"; message: string; hard: boolean }
  | { action: "fail"; reason: string }
  | { action: "pause"; reason: string; message: string };

/** Agent Kernel 使用的完成策略端口。 */
export interface CompletionPolicy {
  /** 从当前消息投影计算新 turn 的初始意图信号。 */
  initialSignal(messages: readonly AgentMessage[]): CompletionIntentSignal;
  /** 从 steer/queue 注入的用户文本计算意图增量。 */
  observeInput(content: string): CompletionIntentSignal;
  /** 在没有工具调用的采样结束点决定接受、提醒重试或失败。 */
  evaluate(input: { state: CompletionPolicyState }): CompletionDecision;
}

/** 创建只依据真实文件写入路径执行写后验证的默认完成策略。 */
export function createMutationCompletionPolicy(maxRecoveryAttempts = 1): CompletionPolicy {
  const boundedRecoveryAttempts = Math.max(0, Math.floor(maxRecoveryAttempts));
  return {
    initialSignal(_messages) {
      return { required: false, strong: false };
    },

    observeInput(_content) {
      return { required: false, strong: false };
    },

    evaluate({ state }) {
      const missingPaths = [...state.changedPaths].filter(function missingVerification(path) { return !state.verifiedPaths.has(path); }).sort();
      if (missingPaths.length === 0) return { action: "accept" };
      const message = `以下修改文件尚未完成写后读回验证：\n${missingPaths.map(function listPath(path) { return JSON.stringify(path); }).join("\n")}\n下一步只能调用 read_file 验证这些文件，确认内容后再总结。不要重复写入或提前声明完成。`;
      if (state.recoveryAttempts >= boundedRecoveryAttempts) return { action: "pause", reason: "修改任务等待写后验证，可继续补充验证", message };
      return {
        action: "retry",
        hard: true,
        message,
      };
    },
  };
}
