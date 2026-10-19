/**
 * runtime/provider/frozen-provider-config.ts — Turn 私有 Provider 执行快照
 *
 * 保存同一 Turn 在 continue/retry/resume 时必须保持不变的端点、凭据引用和有效采样策略。
 * 此类型只能出现在内部 durable Turn 记录，不得进入公开 DTO、事件、日志或 Session 默认配置。
 */

import type { CredentialRef } from "../domain";
import type { ModelSampleOptions } from "../../internal/types";
import type { ModelRef } from "../domain/model-ref";
import type { FirstPartyEffortSource } from "./model-sample-resolver";
import type { ApiProtocol, ProtocolProfile } from "./api-protocol";

/** 当前 Turn 可用的视觉调用路由；仅私有 durable 配置使用。 */
export interface FrozenVisionConfig {
  ref: ModelRef;
  /** 新 Turn 必填；旧 checkpoint 缺失时仅兼容为 OpenAI 视觉协议。 */
  apiProtocol?: ApiProtocol;
  baseUrl?: string;
  credentialRef?: CredentialRef;
}

/** 同一 Turn 的私有 Provider 运行快照。 */
export interface FrozenProviderConfig {
  provider: string;
  /** 新 Turn 必填；旧 durable firstParty snapshot 在读取时版本化迁移。 */
  apiProtocol?: ApiProtocol;
  /** 由 route/model 解析后的封闭兼容 profile。 */
  protocolProfile?: ProtocolProfile;
  baseUrl?: string;
  credentialRef?: CredentialRef;
  /** 有效采样策略；兼容旧 checkpoint 缺失时由 factory 按 ModelRef/ReasoningProfile 回退。 */
  sampleOptions?: ModelSampleOptions;
  /** 当前 Turn 选中模型的完整上下文窗口；由 Context Usage 投影与 auto compact 共用。 */
  contextWindowTokens?: number;
  /** settings 指定的保守 auto-compact 阈值；未指定时沿用模型窗口推导。 */
  compactThresholdTokens?: number;
  /** 本次 Provider 请求的超时上限；只存在于私有 Turn 快照。 */
  timeoutMs?: number;
  /** 已冻结的 subagent 模型选择；当前 Runtime 尚未创建子 Agent，不作为主模型回退。 */
  subagentModelId?: string;
  /** 与实际请求 payload 同源的 effective effort，供安全状态视图展示。 */
  effectiveReasoning?: {
    effort: "none" | "low" | "medium" | "high" | "max";
    source: FirstPartyEffortSource;
  };
  /** 显式视觉角色优先，否则由声明 image 能力的主模型回退。 */
  vision?: FrozenVisionConfig;
}
