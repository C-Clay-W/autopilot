/**
 * Diff 侧边栏纯函数派生模块：从共享 Presentation 的安全展示事实派生侧边栏数据。
 * 只消费已完成工具携带的 ToolDisplayFacts["diff"] 安全事实（Core 已脱敏并截断），
 * 按 Turn 分区、区内按文件路径合并多次编辑，统计行为与 ToolCard 的 getDiffStats 一致。
 */
import type { AgentPresentationItem, ToolCallItem } from "@autopilot-agent/presentation";

/** 单文件聚合行：同一 Turn 内同路径多次编辑合并。 */
export interface DiffFileEntry {
  key: string; // `${turnId}::${filePath}`，稳定折叠状态键
  turnId: string;
  filePath: string;
  diffText: string; // 同文件多次编辑按序拼接
  added: number; // 优先 diff.added，缺失时从 text 统计，合并求和
  removed: number;
  truncated: boolean; // 任一来源截断即为 true
}

/** Turn 分区。 */
export interface DiffTurnSection {
  turnId: string;
  files: DiffFileEntry[];
  added: number;
  removed: number;
}

/** 侧边栏范围：turn 仅显示最近 Turn，all 按 Turn 分区显示历史全部编辑。 */
export type DiffScope = "turn" | "all";

/** 统计单个安全 diff 来源的增删行数：优先 Core 字段，缺失时按行首 +/- 兜底（对齐 ToolCard getDiffStats 兼容逻辑，含 CRLF 归一与 ---/+++ 头排除）。 */
function countDiffStats(diff: NonNullable<ToolCallItem["diff"]>): { added: number; removed: number } {
  const lines = diff.text?.replace(/\r\n?/g, "\n").split("\n");
  const added = diff.added ?? lines?.filter(function countAdded(line) { return line.startsWith("+") && !line.startsWith("+++"); }).length;
  const removed = diff.removed ?? lines?.filter(function countRemoved(line) { return line.startsWith("-") && !line.startsWith("---"); }).length;
  return { added: added ?? 0, removed: removed ?? 0 };
}

/** 从 presentation items 派生侧边栏数据：过滤（completed + 有 diff.text + 有 target）→ scope 过滤 → 按 turnId 分区 → 区内按 filePath 合并 → 统计求和；分区顺序保持 items 首次出现顺序。 */
export function selectDiffSections(
  items: AgentPresentationItem[],
  scope: DiffScope,
  latestTurnId: string | undefined,
): DiffTurnSection[] {
  const sections = new Map<string, DiffTurnSection>();
  const entryByKey = new Map<string, DiffFileEntry>();

  for (const item of items) {
    if (item.kind !== "tool_call" || item.state !== "completed" || !item.target) continue;
    const diff = item.diff;
    if (!diff || !diff.text) continue;
    // scope="turn" 只保留最近 Turn；latestTurnId 由调用方按 activeTurnId（在途）或最后含 diff 的 Turn 计算后传入。
    if (scope === "turn" && item.turnId !== latestTurnId) continue;

    const key = `${item.turnId}::${item.target}`;
    let section = sections.get(item.turnId);
    if (!section) {
      section = { turnId: item.turnId, files: [], added: 0, removed: 0 };
      sections.set(item.turnId, section);
    }
    let entry = entryByKey.get(key);
    if (!entry) {
      entry = { key, turnId: item.turnId, filePath: item.target, diffText: "", added: 0, removed: 0, truncated: false };
      entryByKey.set(key, entry);
      section.files.push(entry);
    }
    const stats = countDiffStats(diff);
    entry.diffText = entry.diffText ? `${entry.diffText}\n${diff.text}` : diff.text;
    entry.added += stats.added;
    entry.removed += stats.removed;
    entry.truncated = entry.truncated || Boolean(diff.truncated);
    section.added += stats.added;
    section.removed += stats.removed;
  }

  return [...sections.values()];
}
