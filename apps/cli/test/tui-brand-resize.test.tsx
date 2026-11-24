/** TUI 品牌头 resize 定向回归：Logo 必须按可用列宽裁剪且保持固定视觉行数。 */

import { createElement } from "react";
import { renderToString } from "ink";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { TuiBrandHeader } from "../src/tui/brand/brand-header.js";
import { createAgentLogoRows } from "../src/tui/brand/logo.js";
import { createAutopilotStaticWordRows } from "../src/tui/brand/pixel.js";
import { createTuiRenderStdout } from "../src/tui/lifecycle.js";
import { AUTOPILOT_VERSION } from "../src/tui/constants.js";

/** 渲染指定虚拟终端宽度下的品牌头。 */
function renderBrandHeader(columns: number): string {
  return renderToString(createElement(TuiBrandHeader, {
    columns,
    useColor: false,
    screenReader: false,
    reducedMotion: false,
    animationActive: false,
  }), { columns });
}

/** 从品牌头中提取版本信息上方的像素 Logo 行。 */
function getLogoLines(frame: string): string[] {
  const lines = frame.split("\n");
  const infoIndex = lines.findIndex(function findBrandInfo(line): boolean { return line.includes(`Autopilot v${AUTOPILOT_VERSION}`); });
  expect(infoIndex).toBeGreaterThan(0);
  const separatorIndex = lines.slice(0, infoIndex).lastIndexOf("");
  expect(separatorIndex).toBeGreaterThan(0);
  return lines.slice(1, separatorIndex);
}

describe("TUI brand header resize", function tuiBrandResizeSuite() {
  it("按宽→窄→宽顺序重渲染时始终保持 7 行 Logo，不触发文本折行", function keepsLogoRowsStableAcrossNarrowWidths() {
    for (const columns of [80, 30, 52, 53, 80]) {
      const logoLines = getLogoLines(renderBrandHeader(columns));
      expect(logoLines).toHaveLength(7);
      expect(logoLines.every(function fitsAvailableColumns(line): boolean { return stringWidth(line) <= columns; })).toBe(true);
      expect(logoLines.every(function containsPixel(line): boolean { return line.trim().length > 0; })).toBe(true);
    }
  });

  it("缩窄尺寸仅通知 Ink 失效缓存并重算，不旁路清屏", function clearsReflowedFrameBeforeInkResize() {
    const writes: string[] = [];
    const source = {
      columns: 80,
      rows: 24,
      write(chunk: string): void { writes.push(chunk); },
    };
    const renderStdout = createTuiRenderStdout(source, { columns: 80, rows: 24 });
    let resizeCount = 0;
    renderStdout.stdout.on?.("resize", function countResize(): void { resizeCount += 1; });

    renderStdout.setSize({ columns: 30, rows: 24 });
    expect(writes).toEqual([]);
    expect(resizeCount).toBe(1);

    renderStdout.setSize({ columns: 80, rows: 24 });
    expect(resizeCount).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it("字标在 Logo 右侧，沿用原尺寸像素和两列间距", function keepsWordmarkBesideLogo() {
    const logo = createAgentLogoRows(14, 7);
    const word = createAutopilotStaticWordRows();
    const expected = logo.map(function brandRow(row, index) { return `${row}  ${word[index]}`.trimEnd(); });
    for (const columns of [69, 104, 128]) {
      expect(getLogoLines(renderBrandHeader(columns))).toEqual(expected);
    }
  });

  it("横幅下只保留版本行", function showsVersionBelowBrand() {
    const lines = renderBrandHeader(128).trimEnd().split("\n");
    expect(lines.at(-1)?.trim()).toBe(`Autopilot v${AUTOPILOT_VERSION}`);
  });
});
