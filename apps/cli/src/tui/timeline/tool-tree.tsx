/** 工具进度树节点：父节点是徽标 chip 与参数 chip，子节点是结果行与 unified diff。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { TUI_ACCENT_BG_COLOR, TUI_ACCENT_COLOR, TUI_CHIP_TEXT_COLOR, TUI_TOOL_ERROR_COLOR, TUI_TOOL_SUCCESS_COLOR } from "../../design-tokens.js";
import { TuiDiffStats } from "../diff-stats.js";
import { cleanTuiToolSummary, getTuiDiffStats, getTuiToolLabel, getTuiToolLineParts } from "../format.js";
import { TuiDiffBlock } from "../markdown/diff.js";
import type { CliTuiTimelineEvent } from "../types.js";

/** 渲染工具徽标 chip：强调背景 + 深色粗体在活动与完成态持久显示；NO_COLOR 退化为纯方括号文本。 */
function TuiToolBadge(props: { badge: string; useColor: boolean }): ReactNode {
  if (!props.useColor) return <Text>{props.badge}</Text>;
  return <Text backgroundColor={TUI_ACCENT_BG_COLOR} color={TUI_CHIP_TEXT_COLOR} bold>{props.badge}</Text>;
}

/** 按进度树展示工具：徽标持久强调，参数 chip 与徽标同行并右端截断，结果行保留 └─ 连线与 ✓/✗ 文字标签。 */
export function renderTuiToolTreeEvent(event: Extract<CliTuiTimelineEvent, { type: "tool_started" | "tool_result" }>, useColor: boolean): ReactNode {
  if (event.type === "tool_started") {
    const detail = cleanTuiToolSummary(event.toolName, event.summary).trim();
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {"├─ "}
          <TuiToolBadge badge={`[${getTuiToolLabel(event.toolName)}]`} useColor={useColor} />
          {detail ? <>{" "}<Text color={useColor ? TUI_ACCENT_COLOR : undefined}>[{detail}]</Text></> : null}
        </Text>
      </Box>
    );
  }
  const diffStats = getTuiDiffStats(event.diff ? { text: event.diff } : undefined);
  const parts = getTuiToolLineParts(event.toolName, event.summary, event.status, event.errorCode);
  if (event.status !== "success") {
    return (
      <Box flexDirection="column">
        <Text color={useColor ? TUI_TOOL_ERROR_COLOR : undefined}>{`└─ ${parts.glyph ? `${parts.glyph} ` : ""}${parts.badge}${parts.rest}`}</Text>
        {event.diff ? <TuiDiffBlock diff={event.diff} keyPrefix={String(event.seq)} useColor={useColor} /> : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>
        {"└─ "}
        <Text color={useColor ? TUI_TOOL_SUCCESS_COLOR : undefined}>{parts.glyph}</Text>
        {" "}
        <TuiToolBadge badge={parts.badge} useColor={useColor} />
        {parts.rest}
        {diffStats ? <>{" "}<TuiDiffStats {...diffStats} useColor={useColor} /></> : null}
      </Text>
      {event.diff ? <TuiDiffBlock diff={event.diff} keyPrefix={String(event.seq)} useColor={useColor} /> : null}
    </Box>
  );
}
