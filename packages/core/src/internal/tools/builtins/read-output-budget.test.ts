/** 读取输出预算的行为测试：覆盖默认读取粒度、中文、转义、完整行和 Unicode 边界。 */
import { describe, expect, it } from "vitest";
import { selectReadLinesWithinTokenBudget } from "./read-output-budget";

describe("selectReadLinesWithinTokenBudget", function readOutputBudgetTests() {
  // 默认预算应容纳通常的 2000 行读取，不能无故退回小页。
  it("默认保留预算内全部 2000 行且不修改输入", function preservesNormalRead() {
    const lines = Object.freeze(Array.from({ length: 2000 }, function createLine() { return "const value = 1;"; }));
    const result = selectReadLinesWithinTokenBudget(lines);
    expect(result.lines).toEqual(lines);
    expect(result.lines).not.toBe(lines);
    expect(result.truncated).toBe(false);
    expect(result.estimatedTokens).toBeLessThanOrEqual(25_000);
  });

  // 中日韩每个字符按一个 token 粗估，包含 JSON 引号和换行转义开销。
  it("在中文精确估算边界选择连续完整行", function respectsCjkBoundary() {
    expect(selectReadLinesWithinTokenBudget(["中文", "汉字", "后续"], 5)).toEqual({ lines: ["中文", "汉字"], estimatedTokens: 5, truncated: true });
    expect(selectReadLinesWithinTokenBudget(["中文", "汉字"], 4)).toEqual({ lines: ["中文"], estimatedTokens: 3, truncated: true });
  });

  // 前缀选择不能跳过超预算首行，也不能返回该行的半截。
  it("首行超过默认预算时返回空前缀", function rejectsOversizedFirstLine() {
    expect(selectReadLinesWithinTokenBudget(["汉".repeat(25_000), "short"])).toEqual({ lines: [], estimatedTokens: 1, truncated: true });
  });

  // 预算恰好容纳完整长行时应纳入，下一行仍不能截断。
  it("完整保留长行及 UTF-16 代理对", function preservesLongLineAndSurrogatePairs() {
    const line = "😀".repeat(4000);
    expect(selectReadLinesWithinTokenBudget([line, "后续"], 1001)).toEqual({ lines: [line], estimatedTokens: 1001, truncated: true });
  });

  // JSON 转义可能比原始正文长，估算必须覆盖控制字符与反斜线。
  it("计入引号反斜线和控制字符的 JSON 转义", function countsSerializedBody() {
    expect(selectReadLinesWithinTokenBudget(['"\\\t', "尾"], 2)).toEqual({ lines: ['"\\\t'], estimatedTokens: 2, truncated: true });
  });

  // 空正文仍有 JSON 双引号常数开销，空行之间保留换行而不丢失范围。
  it("区分空输入和预算内空行", function handlesEmptyText() {
    expect(selectReadLinesWithinTokenBudget([])).toEqual({ lines: [], estimatedTokens: 1, truncated: false });
    expect(selectReadLinesWithinTokenBudget(["", "", ""], 1)).toEqual({ lines: ["", ""], estimatedTokens: 1, truncated: true });
  });
});
