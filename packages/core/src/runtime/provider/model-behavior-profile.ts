/**
 * runtime/provider/model-behavior-profile.ts — 模型可见行为规范。
 * Profile 只描述模型如何使用 canonical tools 和判断完成，不携带凭据或 Provider 私有状态。
 */

import type { CompletionPolicy } from "../../internal/kernel/completion-policy";
import { createMutationCompletionPolicy } from "../../internal/kernel/completion-policy";

/** 绑定到 ModelSampler 的模型行为规范。 */
export interface ModelBehaviorProfile {
  /** 稳定标识，仅用于诊断与测试，不进入模型消息。 */
  id: string;
  /** 首次采样前注入的 Agent 行为基线；完整系统上下文由 Runtime 组合。 */
  instructions: string;
  /** 可替换的完成策略；未提供时由 Runtime 使用默认策略。 */
  completionPolicy?: CompletionPolicy;
}

/** 创建通用模型的最小行为基线；完整系统上下文由 Runtime 在 Turn 启动时组合。 */
export function createDefaultModelBehaviorProfile(): ModelBehaviorProfile {
  return {
    id: "autopilot-default",
    instructions: "你是 Autopilot 的执行模型。只把真实完成的工作报告为完成；需要工作区副作用时必须调用 canonical 工具，不能凭文字假设已经修改。先理解目标，再选择最小必要工具；工具返回错误时停止猜测并依据错误修正。已有文件优先使用 edit_file，新文件使用 write_file；每次 write_file 或 edit_file 成功后，立即对每个修改路径调用 read_file 验证，验证完成前不得输出完成结论。只读任务不调用写入工具。最终答复只总结已由工具结果证实的事实。",
    completionPolicy: createMutationCompletionPolicy(),
  };
}
