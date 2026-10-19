/**
 * runtime/provider/model-sample-resolver.ts — 通用 ModelRef/ReasoningProfile → 采样选项解析
 *
 * 将 FrozenRunConfig 中的 ModelRef 与 ReasoningProfile（requested 语义）解析为
 * Kernel 可透传的 ModelSampleOptions（协议层值）。
 *
 * 通用入口保留给非 settings 的内部调用；firstParty Messages 主链通过同文件中的
 * resolveFirstPartyModelSampleOptions 统一冻结 effective effort，不按第三方厂商分支。
 */

import type { ModelRef } from "../domain/model-ref";
import type { ReasoningProfile } from "../domain/reasoning-profile";
import type { ModelSampleOptions } from "../../internal/types";

/**
 * 根据 ModelRef 与 ReasoningProfile 生成协议层采样选项。
 * - model 直接取 ModelRef.modelId（缺省时由 sampler 用环境变量兜底）
 * - effort 按首批公开值域映射为 thinking / reasoning_effort：
 *   none → thinking=disabled（省略 reasoning_effort）
 *   high → thinking=enabled + reasoning_effort=high
 *   max  → thinking=enabled + reasoning_effort=max
 * @param ref 冻结的模型引用；可能为 undefined（表示使用 Runtime 默认 sampler）
 * @param profile 冻结的推理配置；可能为 undefined（表示不强制思考，由 sampler/provider 默认决定）
 * @returns 解析后的采样选项；无法解析的字段保持 undefined
 */
export function resolveModelSampleOptions(
  ref?: ModelRef,
  profile?: ReasoningProfile,
): ModelSampleOptions {
  const options: ModelSampleOptions = {
    model: ref?.modelId,
  };

  if (!profile?.effort) return options;

  switch (profile.effort) {
    case "none":
      options.thinking = "disabled";
      // reasoning_effort 省略：思考关闭时不发送该字段
      break;
    case "high":
      options.thinking = "enabled";
      options.reasoningEffort = "high";
      break;
    case "max":
      options.thinking = "enabled";
      options.reasoningEffort = "max";
      break;
  }

  return options;
}

/** firstParty effective effort 的来源；当前仅保留用户请求原样生效这一种结果。 */
export type FirstPartyEffortSource = "requested";

/** firstParty Messages 请求与展示共用的冻结解析结果。 */
export interface ResolvedFirstPartyModelSample {
  sampleOptions: ModelSampleOptions;
  effectiveReasoning?: {
    effort: "none" | "low" | "medium" | "high" | "max";
    source: FirstPartyEffortSource;
  };
}

/**
 * 将 firstParty 的 requested effort 解析为 Anthropic Messages 可发送字段。
 * 用户通过 CC 环境变量明确请求 max 时原样发送，由目标兼容端点决定是否接受；
 * alwaysThinkingEnabled=false 只关闭 thinking，不改变已明确请求的 output_config.effort。
 */
export function resolveFirstPartyModelSampleOptions(
  ref: ModelRef,
  profile?: ReasoningProfile,
  options: { thinkingEnabled?: boolean } = {},
): ResolvedFirstPartyModelSample {
  const sampleOptions: ModelSampleOptions = { model: ref.modelId };
  if (!profile) return { sampleOptions };
  if (profile.effort === "none") {
    return {
      sampleOptions: { ...sampleOptions, thinking: "disabled" },
      effectiveReasoning: { effort: "none", source: "requested" },
    };
  }
  const effectiveEffort = profile.effort;
  return {
    sampleOptions: {
      ...sampleOptions,
      ...(options.thinkingEnabled === false ? {} : { thinking: "enabled" }),
      reasoningEffort: effectiveEffort,
    },
    effectiveReasoning: {
      effort: effectiveEffort,
      source: "requested",
    },
  };
}
