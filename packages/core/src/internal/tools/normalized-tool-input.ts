/** 工具严格schema输入的唯一稳定哈希；沿用原ToolExecutor算法，审批与认领复用同一语义。 */
import { createHash } from "node:crypto";

/** 稳定序列化对象字段顺序，数组保持调用顺序。 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(function serializeItem(item) { return stableSerialize(item); }).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(function serializeField(key) { return `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`; }).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 为归一化输入计算既有 SHA-256；不以命令摘要代替完整callBinding。 */
export function hashNormalizedToolInput(input: unknown): string {
  return createHash("sha256").update(stableSerialize(input)).digest("hex");
}
