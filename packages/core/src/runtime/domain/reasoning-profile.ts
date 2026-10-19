/**
 * runtime/domain/reasoning-profile.ts — 推理强度配置
 *
 * Phase 3 只定义类型，不接入 sampler；P0 阶段才让明确协议 Adapter 消费此配置。
 * Talk-Plan0805 起：
 * - 持久化/冻结配置只保存 requested（none/high/max）；
 * - effective payload（thinking/reasoning_effort）由 provider resolver 结合模型能力生成，
 *   状态栏、/effort current 与 sampler 请求读取同一 effective 结果。
 */

import type { ReasoningEffort } from "./model-ref";

/**
 * 推理强度配置（requested 语义）。
 * - effort：思考强度意图，首批公开值域为 none/high/max
 * - maxTokens：本次推理的最大 token 数；缺省时由 sampler 默认值兜底
 */
export interface ReasoningProfile {
  effort: ReasoningEffort;
  maxTokens?: number;
}
