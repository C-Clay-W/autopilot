/** 文件读取输出预算：沿用上下文的 CJK/其他字符估算法，只选择预算内的连续完整行。 */

const CJK_CHARACTER = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

/** 按 JSON 字符串正文估算 token（含引号、转义和行间换行，不含 canonical/envelope/path 元数据）；不拆行或修改输入。 */
export function selectReadLinesWithinTokenBudget(lines: readonly string[], maxTokens = 25_000): { lines: string[]; estimatedTokens: number; truncated: boolean } {
  const selectedLines: string[] = [];
  let cjk = 0;
  let other = 2;
  for (const line of lines) {
    let lineCjk = 0;
    let lineOther = selectedLines.length > 0 ? 2 : 0;
    // 每行独立序列化后移除外围引号，与完整正文 JSON 字符串的转义一致。
    for (const character of JSON.stringify(line).slice(1, -1)) {
      if (CJK_CHARACTER.test(character)) lineCjk++;
      else lineOther++;
    }
    if (cjk + lineCjk + Math.ceil((other + lineOther) / 4) > maxTokens) break;
    selectedLines.push(line);
    cjk += lineCjk;
    other += lineOther;
  }
  return { lines: selectedLines, estimatedTokens: cjk + Math.ceil(other / 4), truncated: selectedLines.length < lines.length };
}
