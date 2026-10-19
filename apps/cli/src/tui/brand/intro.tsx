/** 品牌开场动画：logo 帧、运动位置、像素字母逐列显现与着色渲染。 */

import { type ReactNode } from "react";
import { CLI_TUI_COLORS } from "../../design-tokens.js";
import { clampTuiProgress } from "../format.js";
import {
  AUTOPILOT_BRAND_WORD,
  AUTOPILOT_INTRO_WIDTH,
  AUTOPILOT_LOGO_FINAL_X,
  AUTOPILOT_LOGO_HEIGHT,
  AUTOPILOT_WORD_START,
  AUTOPILOT_WORD_WIDTH,
} from "../constants.js";
import { AUTOPILOT_PIXEL_FONT, renderAutopilotColoredRows } from "./pixel.js";

/** Autopilot 启动画面的侧脸、转头和眨眼帧。 */
export function getAutopilotLogoRows(elapsedMs: number): string[] {
  if (elapsedMs < 2_100) return ["   ▄▄▄  ", "  █   █ ", " █  · █ ", " █▄▄▄██ ", "  ███   ", "  ▀▀    ", "        "];
  if (elapsedMs < 2_550) return ["   ▄▄▄  ", "  █   █ ", " █  · █ ", " █▄▄▄██ ", "  ███   ", "  ▀▀    ", "        "];
  if (elapsedMs < 2_800) return ["  ▄▄▄▄▄ ", " █     █", "█  · ·  █", "█   ▀   █", "█  ───  █", " █▄▄▄▄▄█ ", "   ▀▀▀   "];
  if (elapsedMs < 3_050) return ["  ▄▄▄▄▄ ", " █     █", "█  ─ ─  █", "█   ▀   █", "█  ───  █", " █▄▄▄▄▄█ ", "   ▀▀▀   "];
  return ["  ▄▄▄▄▄ ", " █     █", "█  ● ●  █", "█   ▀   █", "█  ───  █", " █▄▄▄▄▄█ ", "   ▀▀▀   "];
}

/** 计算 logo 的运动位置；终点固定在像素字母末尾之后，避免覆盖最后几个字母。 */
export function getAutopilotLogoX(elapsedMs: number): number {
  return Math.round(AUTOPILOT_LOGO_FINAL_X * clampTuiProgress(elapsedMs / 1_350));
}

/** 生成启动动画的像素字母：字母逐列出现，最后用亮色字符扫过。 */
export function createAutopilotBrandRows(elapsedMs: number): string[] {
  const wordWidth = AUTOPILOT_WORD_WIDTH;
  const totalWidth = AUTOPILOT_INTRO_WIDTH;
  const revealColumns = Math.round(wordWidth * clampTuiProgress((elapsedMs - 180) / 1_050));
  const scanProgress = clampTuiProgress((elapsedMs - 1_650) / 850);
  const scanColumn = elapsedMs < 1_650 ? -1 : Math.round((wordWidth - 1) * scanProgress);
  const logoX = getAutopilotLogoX(elapsedMs);
  const logoRows = getAutopilotLogoRows(elapsedMs);
  const rows = Array.from({ length: AUTOPILOT_LOGO_HEIGHT }, function createBlankRow(): string[] {
    return Array.from({ length: totalWidth }, function createBlankCell(): string { return " "; });
  });

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const logoRow = logoRows[rowIndex] ?? "";
    const letters = AUTOPILOT_BRAND_WORD.split("");
    for (let letterIndex = 0; letterIndex < letters.length; letterIndex += 1) {
      const glyph = AUTOPILOT_PIXEL_FONT[letters[letterIndex] ?? ""];
      const glyphRow = glyph?.[rowIndex] ?? "00000";
      for (let pixelIndex = 0; pixelIndex < glyphRow.length; pixelIndex += 1) {
        const wordColumn = letterIndex * 6 + pixelIndex;
        if (wordColumn >= revealColumns || glyphRow[pixelIndex] !== "1") continue;
        const outputColumn = AUTOPILOT_WORD_START + wordColumn;
        row[outputColumn] = Math.abs(wordColumn - scanColumn) <= 1 ? "▐" : "▌";
      }
    }
    for (let logoIndex = 0; logoIndex < logoRow.length; logoIndex += 1) {
      const logoCell = logoRow[logoIndex];
      if (logoCell && logoCell !== " ") row[logoX + logoIndex] = logoCell;
    }
  }

  // 每一帧都返回相同宽度；trimEnd 会让右侧内容随像素字母显现而横向移动。
  return rows.map(function padBrandRow(row) { return row.join("").padEnd(totalWidth, " "); });
}

/** 渲染静态 logo；眼睛保持绿色，其余轮廓使用紫色品牌 token。 */
export function renderAutopilotLogo(rows: string[], useColor: boolean): ReactNode {
  return renderAutopilotColoredRows(rows, function colorAutopilotLogoCell(char): string | undefined {
    if (!useColor || char === " ") return undefined;
    if (char === "·" || char === "●") return CLI_TUI_COLORS.copilotGreen;
    if (char === "─" || char === "▀" || char === "▄") return CLI_TUI_COLORS.copilotBlue;
    return CLI_TUI_COLORS.copilotPurple;
  });
}

/** 渲染开场动画；像素字母为蓝色，运动中的 logo 为紫色，眼睛为绿色。 */
export function renderAutopilotIntroRows(elapsedMs: number, useColor: boolean): ReactNode {
  const rows = createAutopilotBrandRows(elapsedMs);
  const logoRows = getAutopilotLogoRows(elapsedMs);
  const logoX = getAutopilotLogoX(elapsedMs);
  return renderAutopilotColoredRows(rows, function colorAutopilotIntroCell(char, column, rowIndex): string | undefined {
    if (!useColor || char === " ") return undefined;
    const logoCell = logoRows[rowIndex]?.[column - logoX];
    if (logoCell && logoCell !== " ") {
      if (logoCell === "·" || logoCell === "●") return CLI_TUI_COLORS.copilotGreen;
      if (logoCell === "─" || logoCell === "▀" || logoCell === "▄") return CLI_TUI_COLORS.copilotBlue;
      return CLI_TUI_COLORS.copilotPurple;
    }
    return char === "▐" ? CLI_TUI_COLORS.copilotBlueBright : CLI_TUI_COLORS.copilotBlue;
  });
}
