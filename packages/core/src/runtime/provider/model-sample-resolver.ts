/**
 * runtime/provider/model-sample-resolver.ts — 通用 ModelRef/ReasoningProfile → 采样选项解析
 *
 * 将 FrozenRunConfig 中的 ModelRef 与 ReasoningProfile（requested 语义）解析为
 * Kernel 可透传的 ModelSampleOptions（协议层值）。
 *
 * 通用入口保留给非 settings 的内部调用；firstParty Messages 主链通过同文件中的
 * resolveFirstPartyModelSampleOptions 统一冻结 effective effort，不按第三方厂商分支。
 */

import { AgentRuntimeError } from "../protocol/error-code";
import { resolveRouteModelCapability } from "./model-capability-catalog";
import type { ModelRef } from "../domain/model-ref";
import type { ReasoningProfile } from "../domain/reasoning-profile";
import type { ModelSampleOptions } from "../../internal/types";

/** 兼容旧冻结快照的 Chat 解析入口，完整保留六档意图，Anthropic 使用独立原映射。 */
export function resolveModelSampleOptions(ref?: ModelRef, profile?: ReasoningProfile): ModelSampleOptions {
  const options: ModelSampleOptions = { model: ref?.modelId };
  if (!profile) return options;
  return {
    ...options,
    thinking: profile.effort === "none" ? "disabled" : "enabled",
    reasoningEffort: profile.effort,
    ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {}),
  };
}

/** firstParty effective effort 的来源；当前仅保留用户请求原样生效这一种结果。 */
export type FirstPartyEffortSource = "requested" | "default";

/** firstParty Messages 请求与展示共用的冻结解析结果。 */
export interface ResolvedFirstPartyModelSample {
  sampleOptions: ModelSampleOptions;
  effectiveReasoning?: {
    effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
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
  if (profile.effort === "xhigh") throw new AgentRuntimeError("REASONING_EFFORT_NOT_SUPPORTED", "Anthropic 不支持 xhigh");
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


/** 为两种 OpenAI 协议生成同一能力来源的冻结采样值，保留 Anthropic 原映射。 */
export function resolveRouteModelSample(route: import("./api-protocol").ProviderRouteProfile, ref: ModelRef, profile?: ReasoningProfile): ResolvedFirstPartyModelSample {
  const capability = resolveRouteModelCapability(route, ref.modelId);
  if (route.apiProtocol === "anthropic-messages") return resolveFirstPartyModelSampleOptions(ref, profile);
  if (capability.supportsToolCalls === false) throw new AgentRuntimeError("MODEL_NOT_SUPPORTED", "当前模型协议不支持 Agent 工具，请选择支持工具的 Responses 模型");
  const effort = profile?.effort ?? capability.defaultReasoningEffort;
  if (effort && !capability.supportedReasoningEfforts?.includes(effort)) throw new AgentRuntimeError("REASONING_EFFORT_NOT_SUPPORTED", `请配置模型能力并选择合法 effort：${capability.supportedReasoningEfforts?.join("/") ?? "能力未知"}`);
  const sampleOptions: ModelSampleOptions = { model: ref.modelId, ...(effort ? { reasoningEffort: effort } : {}) };
  // 旧无预设 Chat 仍保留 thinking 兼容字段，但所有强度都保留 wire 值。
  if (route.apiProtocol === "openai-chat-completions" && !route.compatibilityPreset && effort) sampleOptions.thinking = effort === "none" ? "disabled" : "enabled";
  return { sampleOptions, ...(effort ? { effectiveReasoning: { effort, source: profile ? "requested" : "default" } } : {}) };
}
