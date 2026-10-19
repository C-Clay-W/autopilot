/**
 * runtime/config/runtime-limits.ts — Agent 运行限制的唯一解析层。
 *
 * 环境变量只提供显式默认值，Project / Session / Turn 请求值按既定优先级选出后，
 * 仅保留工具重试与 token 的硬上限；未配置时长或 maxSteps 表示不启用对应闸门。
 */

/** 单项运行限制的最终解析输入。 */
export interface LimitConfig {
  defaultValue?: number;
  hardLimit?: number;
  requestOverride?: number;
}

/** Agent 运行限制的已归一化结果。 */
export interface ResolvedAgentRuntimeLimits {
  maxSteps?: number;
  maxToolRetries: number;
}

/** Agent 单个 Turn 的独立累计安全预算；不依赖总 step 闸门。 */
export interface AgentRuntimeSafetyLimits {
  maxDurationMs?: number;
  maxTotalTokens?: number;
}

/** 显式 token 预算的硬上限。 */
export interface AgentRuntimeSafetyHardLimits {
  maxTotalTokens: number;
}

/** 读取正整数环境变量；未配置或非法值回退到传入默认值。 */
function readPositiveIntEnvironment(name: string, defaultValue: number): number;
function readPositiveIntEnvironment(name: string, defaultValue?: number): number | undefined;
function readPositiveIntEnvironment(name: string, defaultValue?: number): number | undefined {
  const raw = process.env[name];
  const parsed = raw && /^[1-9]\d*$/u.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

/** 统一解析一项运行限制；缺省值与请求值都未配置时返回 undefined。 */
export function resolveLimitConfig(config: LimitConfig & { defaultValue: number }): number;
export function resolveLimitConfig(config: LimitConfig): number | undefined;
export function resolveLimitConfig(config: LimitConfig): number | undefined {
  const candidate = config.requestOverride ?? config.defaultValue;
  if (candidate === undefined) return undefined;
  const normalized = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : config.defaultValue;
  if (normalized === undefined) return undefined;
  return config.hardLimit === undefined ? normalized : Math.min(normalized, config.hardLimit);
}

const configuredMaxSteps = readPositiveIntEnvironment("AGENT_MAX_STEPS");

/** 可选执行段时长；此层不读取 Goal，跨 Turn 的 Goal 预算需由 Goal 域另行聚合。 */
const configuredMaxDurationMs = readPositiveIntEnvironment("AGENT_MAX_DURATION_MS");
/** 只有显式设置环境变量时才启用累计 token 预算；默认交由当前上下文水位与 auto compact 管理。 */
const configuredMaxTotalTokens = readPositiveIntEnvironment("AGENT_MAX_TOTAL_TOKENS");

/** 环境变量可显式启用默认值；未配置 maxSteps 时保持关闭。 */
export const AGENT_RUNTIME_LIMIT_DEFAULTS = {
  maxSteps: configuredMaxSteps,
  maxToolRetries: Math.min(readPositiveIntEnvironment("AGENT_MAX_TOOL_RETRIES", 5), 10),
} as const;

/** 所有 Agent 限制的唯一硬上限声明。 */
export const AGENT_RUNTIME_LIMIT_HARD_LIMITS = {
  maxToolRetries: 10,
} as const;

/** 时长与 token 的可选默认值；与 maxSteps 分开解析和触发。 */
export const AGENT_RUNTIME_SAFETY_DEFAULTS: AgentRuntimeSafetyLimits = {
  maxDurationMs: configuredMaxDurationMs,
  maxTotalTokens: configuredMaxTotalTokens,
};

/** token 安全预算硬上限；时长由用户显式值决定，不替 Goal 域提供跨 Turn 预算。 */
export const AGENT_RUNTIME_SAFETY_HARD_LIMITS: AgentRuntimeSafetyHardLimits = {
  maxTotalTokens: 10_000_000,
};

/** 从已选中的请求值解析 Kernel 可直接消费的最终运行限制。 */
export function resolveAgentRuntimeLimits(request: Partial<ResolvedAgentRuntimeLimits> = {}): ResolvedAgentRuntimeLimits {
  return {
    maxSteps: resolveLimitConfig({ defaultValue: AGENT_RUNTIME_LIMIT_DEFAULTS.maxSteps, requestOverride: request.maxSteps }),
    maxToolRetries: resolveLimitConfig({ defaultValue: AGENT_RUNTIME_LIMIT_DEFAULTS.maxToolRetries, hardLimit: AGENT_RUNTIME_LIMIT_HARD_LIMITS.maxToolRetries, requestOverride: request.maxToolRetries }),
  };
}

/** 解析宿主级累计时长与 token 安全预算；不改变 maxSteps/工具重试的既有返回契约。 */
export function resolveAgentRuntimeSafetyLimits(request: Partial<AgentRuntimeSafetyLimits> = {}): AgentRuntimeSafetyLimits {
  const defaultMaxTotalTokens = AGENT_RUNTIME_SAFETY_DEFAULTS.maxTotalTokens;
  return {
    maxDurationMs: resolveLimitConfig({ defaultValue: AGENT_RUNTIME_SAFETY_DEFAULTS.maxDurationMs, requestOverride: request.maxDurationMs }),
    maxTotalTokens: resolveLimitConfig({
      ...(defaultMaxTotalTokens !== undefined ? { defaultValue: defaultMaxTotalTokens } : {}),
      hardLimit: AGENT_RUNTIME_SAFETY_HARD_LIMITS.maxTotalTokens,
      requestOverride: request.maxTotalTokens,
    }),
  };
}
