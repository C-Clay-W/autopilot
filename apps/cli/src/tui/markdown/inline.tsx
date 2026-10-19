/** 行内 Markdown 到 Ink Text 节点的纯函数渲染；不支持的语法保留原文。 */

import { type ReactNode } from "react";
import { Text } from "ink";
import { TUI_ACCENT_COLOR } from "../../design-tokens.js";

/** 将常用行内 Markdown 转为 Ink Text 节点；不支持的语法保留原文，确保流式半截内容不丢失。 */
export function renderMarkdownInline(content: string, keyPrefix: string, useColor: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`\n]*`)|(\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)/g;
  let offset = 0;
  let tokenIndex = 0;

  for (const match of content.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > offset) nodes.push(content.slice(offset, index));
    const key = keyPrefix + ":inline:" + String(tokenIndex++);
    if (match[1]) {
      nodes.push(<Text key={key} bold color={useColor ? TUI_ACCENT_COLOR : undefined}>{match[1].slice(1, -1)}</Text>);
    } else if (match[2]) {
      nodes.push(<Text key={key} underline color={useColor ? TUI_ACCENT_COLOR : undefined}>{match[3]} ({match[4]})</Text>);
    } else if (match[5]) {
      nodes.push(<Text key={key} bold>{match[5].slice(2, -2)}</Text>);
    } else if (match[6]) {
      nodes.push(<Text key={key} italic>{match[6].slice(1, -1)}</Text>);
    }
    offset = index + match[0].length;
  }
  if (offset < content.length) nodes.push(content.slice(offset));
  return nodes;
}
