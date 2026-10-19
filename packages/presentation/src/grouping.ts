/** Tool grouping selector：只合并连续的成功或进行中探索工具，保留原始 ToolCall 节点。 */
import type { AgentPresentationItem, ToolCallItem, ToolGroupItem } from "./model.js";
import { getToolPresentationProfile } from "./tool-profiles.js";

export type TimelineItem = AgentPresentationItem | ToolGroupItem;

/** 判断工具是否符合第一版确定性的 exploration grouping 条件。 */
function isGroupableTool(item: AgentPresentationItem): item is ToolCallItem {
  return item.kind === "tool_call" && getToolPresentationProfile(item.toolName).explorationGroup && (item.state === "running" || item.state === "completed");
}

/** 将连续同 Turn 探索工具折叠为只读视图组；失败、拒绝、取消和超时保留独立节点。 */
export function groupToolCalls(items: AgentPresentationItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (!isGroupableTool(item)) {
      result.push(item);
      index += 1;
      continue;
    }
    const group = [item];
    while (true) {
      const nextItem = items[index + group.length];
      if (!nextItem || !isGroupableTool(nextItem) || nextItem.turnId !== item.turnId) break;
      group.push(nextItem);
    }
    if (group.length === 1) result.push(item);
    else result.push({ id: `group:exploration:${item.turnId}:${item.callId}`, kind: "tool_group", turnId: item.turnId, groupKey: "exploration", toolCallIds: group.map(function getCallId(tool) { return tool.callId; }), state: group.some(function isRunning(tool) { return tool.state === "running"; }) ? "running" : "completed" });
    index += group.length;
  }
  return result;
}
