/**
 * runtime/domain/session-run-config.ts — Session 级运行配置
 *
 * 表示 Session 的默认运行配置；可被 Project 默认值覆盖，也可被单次 Turn 调用覆盖。
 * Phase 3 引入三层优先级：
 *   Project.defaultRunConfig（最低）→ Session.defaultRunConfig → Turn.input.runConfig（最高，仅 start 接受）
 * Turn 开始后冻结为 FrozenRunConfig，整个 turn 生命周期不可变。
 */

import type { ToolPermissionMode } from "../../internal/tools/types";
import type { ModelRef } from "./model-ref";
import type { ReasoningProfile } from "./reasoning-profile";
import type { CredentialRef } from "./index";

/**
 * Session 级运行配置；所有字段可选，缺省时由 Project 默认值或 Runtime 默认值兜底。
 */
export interface SessionRunConfig {
  /** 模型引用；缺省时由 Project 默认值或 Runtime 默认 sampler 兜底。 */
  modelRef?: ModelRef;
  /** 推理强度配置；Phase 3 只定义类型，P0 才真正接入 sampler。 */
  reasoningProfile?: ReasoningProfile;
  /** 凭据引用；真实 Key 不进入 Session、checkpoint 或事件。 */
  credentialRef?: CredentialRef;
  /** 工具权限模式；与 RunConfig.permissionMode 同枚举。 */
  permissionMode?: ToolPermissionMode;
  /** 每个执行段的采样/工具循环轮数；缺省关闭，显式正整数无固定平台封顶。 */
  maxSteps?: number;
  /** 单个安全可重试工具调用的最大重试次数；缺省使用 AGENT_MAX_TOOL_RETRIES 默认值。 */
  maxToolRetries?: number;
  /** 当前 Turn 每个执行段的时长上限；缺省关闭，环境变量可显式启用。 */
  maxDurationMs?: number;
  /** 当前 Turn 的累计 Provider token 安全上限；缺省使用 AGENT_MAX_TOTAL_TOKENS 默认值。 */
  maxTotalTokens?: number;
}
