/** TUI 按键解析纯函数：归一化控制动作、删除方向、换行/粘贴/focus/滚动判断。 */

import type { Key } from "ink";
import { splitTuiInputGraphemes } from "./graphemes.js";

/** 将 Ink 键对象和终端控制字符归一为 TUI 控制动作，兼容真实 TTY 与测试 stdin。 */
export function parseTuiControlAction(value: string, key: Key): "eof" | "interrupt" | "cancel" | undefined {
  if (value === "\u0004" || (key.ctrl && value === "d")) return "eof";
  if ((key.ctrl && (value === "c" || value === "\u0003")) || value === "\u0003") return "interrupt";
  if (key.escape || value === "\u001b") return "cancel";
  return undefined;
}

/** 区分 Backspace 与前向 Delete，优先采用终端原始控制字符兼容 macOS Terminal。 */
export function resolveTuiDeleteDirection(value: string, key: Key, rawSequence = ""): "backspace" | "delete" | undefined {
  if (key.backspace || rawSequence === "\b" || rawSequence === "\u007f" || value === "\b" || value === "\u007f") return "backspace";
  if (/^\u001b\[3(?:;\d+)?[~$^]$/u.test(rawSequence)) return "delete";
  if (key.delete) return "delete";
  return undefined;
}

/** 识别 Claude Code/终端常见的 Shift+Enter 编码；普通回车仍由 key.return 单独处理。 */
export function isTuiMultilineEnter(value: string, key: Key, rawSequence = ""): boolean {
  if (key.return && (key.shift || key.meta)) return true;
  const sequencePattern = /(?:\u001b)?\[(?:13;2(?::\d+)?(?:;[\d:]+)?u|13;2~|27;2;13~)$/u;
  if (value && sequencePattern.test(value)) return true;
  // Ink 的测试 stdin 与 readable 事件先后顺序不同；只有当前事件确实是空输入的特殊键时才读取原始序列，避免复用上一枚按键。
  return value.length === 0 && key.shift && sequencePattern.test(rawSequence);
}

/** 识别 bracketed paste 边界；Ink 会去掉 CSI 序列的首个 ESC 后再交给 useInput。 */
export function resolveTuiBracketedPasteBoundary(value: string): "start" | "end" | undefined {
  if (value === "[200~" || value === "\u001b[200~") return "start";
  if (value === "[201~" || value === "\u001b[201~") return "end";
  return undefined;
}

/** 判断终端 focus in/out 报告，避免控制序列被误插入 prompt。 */
export function isTuiTerminalFocusSequence(value: string): boolean {
  return value === "[I" || value === "[O" || value === "\u001b[I" || value === "\u001b[O";
}

/** 判断按键是否属于备用屏滚动兜底，避免与普通 Home/End 输入语义混淆。 */
export function isTuiViewportScrollKey(key: Key): boolean {
  return key.pageUp || key.pageDown || Boolean(key.ctrl && (key.home || key.end));
}

/** 判断光标前的反斜线是否是未被另一枚反斜线转义的续行标记。 */
export function hasTuiUnescapedContinuation(input: string, cursorIndex: number): boolean {
  const characters = splitTuiInputGraphemes(input);
  if (cursorIndex <= 0 || characters[cursorIndex - 1] !== "\\") return false;
  let slashCount = 0;
  for (let index = cursorIndex - 1; index >= 0 && characters[index] === "\\"; index -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}
