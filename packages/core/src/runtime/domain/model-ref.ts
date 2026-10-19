/**
 * runtime/domain/model-ref.ts — 模型引用
 *
 * 平台无关的模型标识；不含真实 Key，真实凭据通过 CredentialRef 在运行时解析。
 * Phase 3 引入，供 Project 默认配置、Session 默认配置、Turn 冻结配置共用。
 * CC-compatible Settings 起：ReasoningEffort 收敛为 none/low/medium/high/max；
 * protocol payload 只由 Provider adapter 从冻结 requested/effective 结果生成。
 */

/**
 * 推理强度意图（用户可见/可持久化的 requested 语义）。
 * - none：关闭思考（thinking.disabled，省略 reasoning_effort）
 * - medium：CC-compatible 的中等思考强度
 * - high：默认思考强度（thinking.enabled + reasoning_effort=high）
 * - max：最大思考强度（thinking.enabled + reasoning_effort=max）
 * 旧的扩展值不属于当前配置合同，本层不接受也不静默改写。
 */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "max";

/**
 * 将任意字符串解析为受支持的 ReasoningEffort。
 * 只接受当前公开值域；其余值返回 undefined，不在此处改写 durable 数据。
 * @param value 待解析的 effort 字符串
 * @returns 支持的 ReasoningEffort；未知或不支持时返回 undefined
 */
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === "none" || value === "low" || value === "medium" || value === "high" || value === "max") return value;
  return undefined;
}

/**
 * 模型引用；唯一标识一个 Provider 上的模型实例。
 * - provider：Provider 稳定标识，例如 firstParty
 * - modelId：Provider 内的原始模型 ID
 * 端点、凭据和采样策略属于 Turn 私有执行快照，不属于模型身份。
 */
export interface ModelRef {
  provider: string;
  modelId: string;
}
