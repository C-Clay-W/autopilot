/** CLI 所需的安全 Markdown 子集渲染：段落、标题、代码块、引用、列表与对齐表格。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { TUI_ACCENT_COLOR } from "../../design-tokens.js";
import { renderMarkdownInline } from "./inline.js";
import {
  fitTuiMarkdownTableColumnWidths,
  getTuiMarkdownTableColumnWidths,
  hasMarkdownTableCells,
  isLooseMarkdownTable,
  isMarkdownBlockStart,
  isMarkdownTableDivider,
  normalizeMarkdownTableCells,
  splitMarkdownTableRow,
  wrapTuiMarkdownTableCell,
} from "./table.js";

/** 渲染已经按当前终端宽度适配列宽的对齐 Markdown 表格。 */
export function TuiMarkdownAlignedTable(props: { header: string[]; rows: string[][]; keyPrefix: string; useColor: boolean; maximumWidth: number }): ReactNode {
  const widths = fitTuiMarkdownTableColumnWidths(getTuiMarkdownTableColumnWidths([props.header, ...props.rows]), props.maximumWidth);
  const makeBorder = function makeBorder(left: string, join: string, right: string): string {
    return left + widths.map(function makeColumnBorder(width): string { return "─".repeat(width + 2); }).join(join) + right;
  };
  const renderRow = function renderRow(cells: string[], keyPrefix: string, header = false): ReactNode {
    const wrappedCells = cells.map(function wrapCell(cell, index): string[] { return wrapTuiMarkdownTableCell(cell, widths[index] ?? 3); });
    const rowHeight = Math.max(1, ...wrappedCells.map(function getCellHeight(cellLines): number { return cellLines.length; }));
    return (
      <Box key={keyPrefix} flexDirection="column">
        {Array.from({ length: rowHeight }, function renderLine(_unused, lineIndex): ReactNode {
          return <Box key={keyPrefix + ":line:" + String(lineIndex)}>
            <Text>│</Text>
            {wrappedCells.map(function renderCell(cellLines, index): ReactNode {
              const cellLine = cellLines[lineIndex] ?? "";
              const padding = " ".repeat(Math.max(0, (widths[index] ?? 3) - stringWidth(cellLine)));
              return <Box key={keyPrefix + ":cell:" + String(index)} width={(widths[index] ?? 3) + 2} paddingX={1}><Text bold={header}>{renderMarkdownInline(cellLine + padding, keyPrefix + ":cell:" + String(index) + ":line:" + String(lineIndex), props.useColor)}</Text></Box>;
            })}
            <Text>│</Text>
          </Box>;
        })}
      </Box>
    );
  };
  return (
    <Box flexDirection="column">
      <Text>{makeBorder("┌", "┬", "┐")}</Text>
      {renderRow(props.header, props.keyPrefix + ":header", true)}
      <Text>{makeBorder("├", "┼", "┤")}</Text>
      {props.rows.map(function renderTableRow(row, index): ReactNode { return renderRow(row, props.keyPrefix + ":row:" + String(index)); })}
      <Text>{makeBorder("└", "┴", "┘")}</Text>
    </Box>
  );
}

/** 渲染 CLI 所需的安全 Markdown 子集，不解析或执行 HTML。 */
export function TuiMarkdown(props: { content: string; keyPrefix: string; useColor: boolean; maximumWidth: number }): ReactNode {
  const nodes: ReactNode[] = [];
  const lines = props.content.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const key = props.keyPrefix + ":block:" + String(blockIndex++);
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s]*)/);
    if (fence) {
      const marker = fence[1];
      const closePattern = new RegExp("^\\s*" + marker[0] + "{" + String(marker.length) + ",}\\s*$");
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !closePattern.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        <Box key={key} flexDirection="column" borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1}>
          <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>code · {fence[2] || "text"}</Text>
          <Text wrap="wrap">{codeLines.join("\n") || " "}</Text>
        </Box>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      nodes.push(<Text key={key} bold color={props.useColor ? TUI_ACCENT_COLOR : undefined} wrap="wrap">{renderMarkdownInline(heading[2], key, props.useColor)}</Text>);
      index += 1;
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      nodes.push(<Text key={key} dimColor={props.useColor}>────────────────</Text>);
      index += 1;
      continue;
    }
    const tableHeader = splitMarkdownTableRow(line);
    const hasStrictTableDivider = line.includes("|") && isMarkdownTableDivider(lines[index + 1] ?? "");
    const hasLooseTableRows = isLooseMarkdownTable(lines, index);
    if (hasStrictTableDivider || hasLooseTableRows) {
      const tableRows: string[][] = [];
      let rowIndex = index + (hasStrictTableDivider ? 2 : 1);
      while (rowIndex < lines.length && hasMarkdownTableCells(lines[rowIndex] ?? "", tableHeader.length)) {
        const rowCells = normalizeMarkdownTableCells(lines[rowIndex] ?? "", tableHeader.length);
        if (!rowCells) break;
        tableRows.push(rowCells);
        rowIndex += 1;
      }
      if (tableRows.length > 0) {
        nodes.push(<TuiMarkdownAlignedTable key={key} header={tableHeader} rows={tableRows} keyPrefix={key} useColor={props.useColor} maximumWidth={props.maximumWidth} />);
        index = rowIndex;
        continue;
      }
      if (hasStrictTableDivider) {
        nodes.push(<Text key={key} wrap="wrap">{line}{"\n"}{lines[index + 1] ?? ""}</Text>);
        index += 2;
        continue;
      }
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const nextQuote = (lines[index] ?? "").match(/^\s*>\s?(.*)$/);
        if (!nextQuote) break;
        quoteLines.push(nextQuote[1]);
        index += 1;
      }
      nodes.push(<Box key={key} borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1}><Text wrap="wrap">{renderMarkdownInline(quoteLines.join(" "), key, props.useColor)}</Text></Box>);
      continue;
    }
    const list = line.match(/^(\s*)((?:[-+*])|(?:\d+[.)]))\s+(.+)$/);
    if (list) {
      nodes.push(<Text key={key} wrap="wrap">{list[1]}{list[2]} {renderMarkdownInline(list[3], key, props.useColor)}</Text>);
      index += 1;
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !isMarkdownBlockStart(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    nodes.push(<Text key={key} wrap="wrap">{renderMarkdownInline(paragraph.join(" "), key, props.useColor)}</Text>);
  }
  return <Box flexDirection="column">{nodes}</Box>;
}
