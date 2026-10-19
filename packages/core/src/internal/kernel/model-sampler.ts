/**
 * 模型采样端口：将 Agent Loop 与具体的 LLM 采样实现解耦。
 * Kernel 只依赖此端口，不直接读取 LOOP_LLM_* 环境变量，也不依赖任何 UI 框架。
 */

import type { ModelSampleOptions } from "../types";
import type { AgentMessage } from "../types/agent-message";
import type { AgentModelToolDefinition, AgentSampleResult } from "../lib/llm";
import { AgentSampleError } from "../lib/llm";
import { createDefaultModelBehaviorProfile, type ModelBehaviorProfile } from "../../runtime/provider/model-behavior-profile";

/**
 * 模型采样器端口。
 * 实现者负责完成一次完整的模型采样，并在采样过程中通过 onDelta 回调流式输出正文增量。
 */
export interface ModelSampler {
  /** Provider/模型绑定的行为规范；Runtime 首轮将其注入 system messages。 */
  readonly behaviorProfile?: ModelBehaviorProfile;

  /**
   * 对给定消息和工具执行一次模型采样。
   *
   * @param messages 当前上下文消息
   * @param tools 模型可见工具定义
   * @param options 采样选项；Kernel 透传 signal/maxTokens 与已解析的 Provider 采样选项
   *                （model/thinking/reasoningEffort，来自 ModelRef/ReasoningProfile）
   * @param onDelta 可选回调，用于流式接收正文增量；采样器应仅在产生可见文本时调用
   * @returns 完整采样结果（content / toolCalls / reasoningSummary / finishReason / usage）
   */
  sample(
    messages: AgentMessage[],
    tools: AgentModelToolDefinition[],
    options: { signal?: AbortSignal; maxTokens?: number } & ModelSampleOptions,
    onDelta?: (delta: string) => void,
  ): Promise<AgentSampleResult>;
}

/**
 * 未配置 Provider 时的安全采样器；CC settings 主链必须通过 firstParty factory 注入真实 sampler。
 */

/**
 * 创建拒绝隐式环境变量回退的默认采样器，避免未冻结的旧 Provider 配置进入 Turn。
 * @returns 仅用于缺失配置的稳定失败采样器
 */
export function createDefaultModelSampler(): ModelSampler {
  const behaviorProfile = createDefaultModelBehaviorProfile();
  return {
    behaviorProfile,
    async sample() {
      throw new AgentSampleError("AUTOPILOT_CONFIGURATION_REQUIRED: 缺少 firstParty Anthropic Messages 配置", "PROVIDER_REQUEST_REJECTED");
    },
  };
}
