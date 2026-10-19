/** 当前思考进度汇总；只统计已发出的 tool_started，避免结果重复计数。 */

import { useEffect, useState, type ReactNode } from "react";
import { Text } from "ink";
import type { CliTurnStatus } from "../../types.js";
import { formatTuiDuration } from "../format.js";
import type { CliTuiTimelineEvent, CliTuiTurnMetrics } from "../types.js";

/** 汇总 Claude Code 风格的当前思考进度；只统计已发出的 tool_started，避免结果重复计数。 */
export function TuiLiveProgressSummary(props: { events: CliTuiTimelineEvent[]; status: CliTurnStatus; metrics?: CliTuiTurnMetrics; useColor: boolean; activeTodoForm?: string }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  const active = props.status === "running" || props.status === "waiting_approval";
  useEffect(function refreshProgressSummary() {
    if (!active) return;
    const timer = setInterval(function updateProgressSummaryClock(): void { setNow(Date.now()); }, 1_000);
    return function stopProgressSummaryClock(): void { clearInterval(timer); };
  }, [active]);

  if (!active || !props.metrics) return null;
  // Todo 的 activeForm 是模型声明的稳定活动文案，优先于宿主猜测的工具动词短语。
  if (props.activeTodoForm) {
    return <Text dimColor={props.useColor}>{props.activeTodoForm} · {formatTuiDuration(Math.max(0, now - props.metrics.startedAt))}…</Text>;
  }
  const counts = new Map<string, number>();
  for (const event of props.events) {
    if (event.type !== "tool_started") continue;
    counts.set(event.toolName, (counts.get(event.toolName) ?? 0) + 1);
  }
  const phrases: string[] = [];
  const phrase = function makePhrase(toolName: string, verb: string, singular: string): void {
    const count = counts.get(toolName) ?? 0;
    if (count === 0) return;
    phrases.push(`${verb} ${count} ${count === 1 ? singular : singular + "s"}`);
  };
  phrase("glob_files", "listing", "directory");
  phrase("grep_files", "searching", "code search");
  phrase("read_file", "reading", "file");
  phrase("run_command", "running", "shell command");
  phrase("write_file", "writing", "file");
  phrase("edit_file", "editing", "file");
  const thinking = `Thinking for ${formatTuiDuration(Math.max(0, now - props.metrics.startedAt))}`;
  return <Text dimColor={props.useColor}>{thinking}{phrases.length > 0 ? `, ${phrases.join(", ")}` : ""}…</Text>;
}
