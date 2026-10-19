/**
 * Node Context budget loader：只计算冻结上下文预算，不静默截断项目指令。
 */

/** Context 预算快照；额外字段用于宿主诊断，不进入 Core 业务规则。 */
export interface NodeContextBudgetSnapshot {
  estimatedTokens: number;
  sections: Record<string, number>;
  diagnostics: string[];
  compactNeeded: boolean;
  contextWindowTokens?: number;
  triggerTokens?: number;
  targetTokens?: number;
  usageRatio?: number;
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_COMPACT_TRIGGER_RATIO = 0.80;
export const DEFAULT_COMPACT_TARGET_RATIO = 0.55;

/** 以 CJK 单字约一 token、其他字符四字符约一 token 的方式粗估上下文。 */
export function estimateTokens(value: string): number {
  let cjkCharacters = 0;
  let otherCharacters = 0;
  for (const character of value) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjkCharacters++;
    else otherCharacters++;
  }
  return cjkCharacters + Math.ceil(otherCharacters / 4);
}

/** 读取上下文窗口和 compact 比率配置。 */
function readBudgetConfig(env: NodeJS.ProcessEnv): { contextWindowTokens: number; triggerRatio: number; targetRatio: number } {
  const contextWindowTokens = Number.parseInt(env.LOOP_LLM_CONTEXT_WINDOW_TOKENS || String(DEFAULT_CONTEXT_WINDOW_TOKENS), 10);
  const triggerRatio = Number.parseFloat(env.AGENT_COMPACT_TRIGGER_RATIO || String(DEFAULT_COMPACT_TRIGGER_RATIO));
  const targetRatio = Number.parseFloat(env.AGENT_COMPACT_TARGET_RATIO || String(DEFAULT_COMPACT_TARGET_RATIO));
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0 || !Number.isFinite(triggerRatio) || !Number.isFinite(targetRatio) || triggerRatio <= 0 || triggerRatio >= 1 || targetRatio <= 0 || targetRatio >= triggerRatio) {
    throw new Error("上下文窗口或 compact 比率配置无效");
  }
  return { contextWindowTokens, triggerRatio, targetRatio };
}

/** 生成完整 projected-token 预算；超预算只记录诊断，由 Runtime 决定是否 compact。 */
export function createContextBudget(sections: Record<string, string>, env: NodeJS.ProcessEnv = process.env): NodeContextBudgetSnapshot {
  const sizes = Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, value.length]));
  const estimatedTokens = estimateTokens(Object.values(sections).join("\n"));
  const { contextWindowTokens, triggerRatio, targetRatio } = readBudgetConfig(env);
  const triggerTokens = Math.floor(contextWindowTokens * triggerRatio);
  const targetTokens = Math.floor(contextWindowTokens * targetRatio);
  const diagnostics: string[] = [];
  if ((sizes.instructions ?? 0) > contextWindowTokens * 4) diagnostics.push("AGENTS.md 指令超过单轮预算，已拒绝注入而非静默截断");
  if (estimatedTokens >= triggerTokens) diagnostics.push("上下文达到 compact 触发阈值");
  return { estimatedTokens, sections: sizes, diagnostics, compactNeeded: estimatedTokens >= triggerTokens, contextWindowTokens, triggerTokens, targetTokens, usageRatio: estimatedTokens / contextWindowTokens };
}
