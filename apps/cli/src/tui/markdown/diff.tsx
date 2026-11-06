/** unified diff 的逐行着色渲染；保持与 Web 的 edit_file 展示语义一致。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { TUI_ACCENT_COLOR, TUI_DIFF_ADDED_COLOR, TUI_DIFF_REMOVED_COLOR } from "../../design-tokens.js";

/** 字符串diff没有对象身份；只保留最多32项/2Mi字符及每项4个键/颜色变体。 */
const diffRenderCache = new Map<string, Map<string, ReactNode>>();
let cachedDiffCharacters = 0;

/** 复用既有逐行渲染元素，避免同一diff重挂载时重新split和创建节点。 */
export function TuiDiffBlock(props: { diff: string; keyPrefix: string; useColor: boolean }): ReactNode {
  const key = `${props.useColor}:${props.keyPrefix}`;
  let variants = diffRenderCache.get(props.diff);
  if (variants?.has(key)) return variants.get(key);
  const rendered = renderDiffBlock(props);
  if (props.diff.length > 2 * 1024 * 1024) return rendered;
  if (!variants) {
    while (diffRenderCache.size >= 32 || cachedDiffCharacters + props.diff.length > 2 * 1024 * 1024) {
      const oldest = diffRenderCache.keys().next().value!;
      cachedDiffCharacters -= oldest.length;
      diffRenderCache.delete(oldest);
    }
    variants = new Map();
    diffRenderCache.set(props.diff, variants);
    cachedDiffCharacters += props.diff.length;
  }
  if (variants.size >= 4) variants.delete(variants.keys().next().value!);
  variants.set(key, rendered);
  return rendered;
}

/** 将 Core 提供的最终 unified diff 逐行着色，保持与 Web 的 edit_file 展示语义一致。 */
function renderDiffBlock(props: { diff: string; keyPrefix: string; useColor: boolean }): ReactNode {
  return (
    <Box marginLeft={2} marginTop={1} flexDirection="column" borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1}>
      <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>diff</Text>
      {props.diff.split("\n").map(function renderDiffLine(line, index) {
        const isAdded = line.startsWith("+") && !line.startsWith("+++");
        const isRemoved = line.startsWith("-") && !line.startsWith("---");
        const isMeta = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@");
        const color = isAdded
          ? TUI_DIFF_ADDED_COLOR
          : isRemoved
            ? TUI_DIFF_REMOVED_COLOR
            : isMeta
              ? TUI_ACCENT_COLOR
              : undefined;
        return <Text key={props.keyPrefix + ":line:" + String(index)} color={props.useColor ? color : undefined} dimColor={props.useColor && isMeta}>{line || " "}</Text>;
      })}
    </Box>
  );
}
