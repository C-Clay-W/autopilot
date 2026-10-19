/** edit diff 统计渲染：新增和删除复用 unified diff 的既有语义色。 */

import { type ReactNode } from "react";
import { Text } from "ink";
import { TUI_DIFF_ADDED_COLOR, TUI_DIFF_REMOVED_COLOR } from "../design-tokens.js";

/** 渲染带有文本标记的新增/删除统计；NO_COLOR 下仍保留完整正负号。 */
export function TuiDiffStats(props: { added: number; removed: number; useColor: boolean }): ReactNode {
  return <Text>(<Text color={props.useColor ? TUI_DIFF_ADDED_COLOR : undefined}>+{props.added}</Text>, <Text color={props.useColor ? TUI_DIFF_REMOVED_COLOR : undefined}>-{props.removed}</Text>)</Text>;
}
