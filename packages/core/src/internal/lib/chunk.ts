/**
 * 文本分块 — 滑动窗口分割，相邻块之间有 overlap 字符重叠
 *
 * 分块策略：
 * - 字符级切割（兼容中英文混合场景）
 * - 短文本（≤ chunkSize）原样返回，不额外填充
 * - 长文本按 chunkSize 切开，相邻块重叠 overlap 字符，确保语义连续
 *
 * @param text     输入文本
 * @param chunkSize  每块最大字符数（默认 512）
 * @param overlap    相邻块重叠字符数（默认 128，若 ≥ chunkSize 则自动 clamp 为 chunkSize/4）
 * @returns 分块后的字符串数组（单块也是数组）
 *
 * @example
 * chunkText("Hello World", 5, 2)  // → ["Hello", "lo Wo", "World"]
 * chunkText("短文本", 512)         // → ["短文本"]
 */
export function chunkText(
  text: string,
  chunkSize: number = 512,
  overlap: number = 128
): string[] {
  if (!text || chunkSize <= 0) return [];

  // 边界保护：overlap 不能 ≥ chunkSize，否则会死循环
  const safeOverlap = overlap >= chunkSize
    ? Math.max(1, Math.floor(chunkSize / 4))
    : overlap;

  // 短文本直接返回，不做无意义分块
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  const step = chunkSize - safeOverlap; // 每次前进的步长
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += step;

    // 防止最后一块过短时死循环（step 很小且已接近末尾）
    if (start >= text.length) break;
  }

  return chunks;
}
