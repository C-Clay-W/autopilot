/** Web连续工具活动投影，使用首调用稳定身份并保留共享安全时间线。 */
import type { TimelineItem, ToolCallItem } from "@autopilot-agent/presentation";

export interface WebToolActivity {
  id: string;
  kind: "web_tool_activity";
  turnId: string;
  toolCallIds: string[];
}
export type WebTimelineItem = TimelineItem | WebToolActivity;

/** 普通工具合并为单段，审批和失败保持原时间位置，真实正文与输入截断区段。 */
export function groupWebObservations(items: TimelineItem[], tools: ToolCallItem[] = []): WebTimelineItem[] {
  const result: WebTimelineItem[] = [];
  const byId = new Map(tools.map(function entry(tool) { return [`${tool.turnId}:${tool.callId}`, tool]; }));
  let activity: WebToolActivity | undefined;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === "thinking" && item.summary === "正在思考" && (activity || items[index + 1]?.kind === "tool_call" || items[index + 1]?.kind === "tool_group")) continue;
    let calls: ToolCallItem[] = [];
    if (item.kind === "tool_call") calls = [item];
    if (item.kind === "tool_group") {
      calls = item.toolCallIds.map(function find(id) {
        return byId.get(`${item.turnId}:${id}`);
      }).filter(function present(tool): tool is ToolCallItem { return Boolean(tool); });
    }
    if (calls.length && calls.every(function ordinary(call) { return call.state === "running" || call.state === "completed"; })) {
      if (!activity || activity.turnId !== calls[0].turnId) {
        activity = { id: `activity:${calls[0].turnId}:${calls[0].callId}`, kind: "web_tool_activity", turnId: calls[0].turnId, toolCallIds: [] };
        result.push(activity);
      }
      activity.toolCallIds.push(...calls.map(function id(call) { return call.callId; }));
    } else {
      activity = undefined;
      result.push(item);
    }
  }
  return result;
}
