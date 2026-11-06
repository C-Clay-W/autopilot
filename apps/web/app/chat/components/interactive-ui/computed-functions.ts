/** 复用 Core 唯一计算实现；错误返回空值，由对应组件显示局部回退。 */
import { UI_COMPUTED_FUNCTIONS } from "@autopilot-agent/core/ui";

/** 把溢出、非法参数收敛为空值，不显示异常正文或 NaN/Infinity。 */
function safeCompute(name: string, args: Record<string, unknown>): unknown {
  try { return UI_COMPUTED_FUNCTIONS[name](args); } catch { return null; }
}

export const computedFunctions = Object.freeze({
  savingsGrowth: function savingsGrowth(args: Record<string, unknown>) { return safeCompute("savingsGrowth", args); },
  sum: function sum(args: Record<string, unknown>) { return safeCompute("sum", args); },
  weightedAverage: function weightedAverage(args: Record<string, unknown>) { return safeCompute("weightedAverage", args); },
});

/** 将输入限制为控件范围内的有限步进数，空输入由组件草稿保留。 */
export function readNumericInput(raw: string, min: number, max: number, step: number): number | undefined {
  if (!raw.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return undefined;
  const steps = (value - min) / step;
  if (Math.abs(steps - Math.round(steps)) > 1e-7 * Math.max(1, Math.abs(steps))) return undefined;
  return value;
}
