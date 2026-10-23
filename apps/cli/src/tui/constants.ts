/**
 * TUI 的非颜色常量：Autopilot 品牌像素几何、终端控制序列、输入相关常量与
 * 代理展示名。颜色语义 token 集中在 design-tokens.ts，这里不重复定义。
 */

import stringWidth from "string-width";

/** Autopilot 品牌版本号。 */
export const AUTOPILOT_VERSION = "0.2.0";
/** 品牌像素字母的完整单词。 */
export const AUTOPILOT_BRAND_WORD = "AUTOPILOT";
/** 开场动画总时长（毫秒）。 */
export const AUTOPILOT_INTRO_DURATION_MS = 4_500;
/** 品牌 logo 的像素宽度。 */
export const AUTOPILOT_LOGO_WIDTH = 9;
/** 品牌 logo 的像素高度。 */
export const AUTOPILOT_LOGO_HEIGHT = 7;
/** 品牌单词相对行首的起始列。 */
export const AUTOPILOT_WORD_START = 2;
/** 品牌单词与 logo 之间的像素间距。 */
export const AUTOPILOT_BRAND_GAP = 3;
/** 品牌像素单词的总显示宽度（每字母 6 列，减最后 1 列）。 */
export const AUTOPILOT_WORD_WIDTH = AUTOPILOT_BRAND_WORD.length * 6 - 1;
/** logo 最终落点：单词结束后再留品牌间距。 */
export const AUTOPILOT_LOGO_FINAL_X = AUTOPILOT_WORD_START + AUTOPILOT_WORD_WIDTH + AUTOPILOT_BRAND_GAP;
/** 开场动画的总宽度。 */
export const AUTOPILOT_INTRO_WIDTH = AUTOPILOT_LOGO_FINAL_X + AUTOPILOT_LOGO_WIDTH;

/** 代理在 TUI 中的展示名。 */
export const TUI_AGENT_LABEL = "Autopilot";

/** Node 20+ 的 Unicode grapheme 分词器，保证一个组合 emoji 只占一个输入光标位置。 */
export const TUI_INPUT_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** prompt 前缀字符。 */
export const TUI_PROMPT_PREFIX = "› ";
/** 输入光标的可视字符。 */
export const TUI_CURSOR_CHARACTER = "▏";
/** 输入光标的终端显示宽度。 */
export const TUI_CURSOR_WIDTH = stringWidth(TUI_CURSOR_CHARACTER);

/** 启用 bracketed paste 的控制序列。 */
export const TUI_BRACKETED_PASTE_ENABLE = "\u001b[?2004h";
/** 关闭 bracketed paste 的控制序列。 */
export const TUI_BRACKETED_PASTE_DISABLE = "\u001b[?2004l";
/** 启用终端 focus 报告的控制序列。 */
export const TUI_TERMINAL_FOCUS_ENABLE = "\u001b[?1004h";
/** 关闭终端 focus 报告的控制序列。 */
export const TUI_TERMINAL_FOCUS_DISABLE = "\u001b[?1004l";
/** 进入备用屏并清屏的控制序列。 */
export const TUI_ALTERNATE_SCREEN_ENABLE = "\u001b[?1049h\u001b[2J\u001b[H";
/** 退出备用屏的控制序列。 */
export const TUI_ALTERNATE_SCREEN_DISABLE = "\u001b[?1049l";
/** inline TUI 缩窄时清除当前视口和已保存的 scrollback，避免旧帧可被向上滚动看到。 */
export const TUI_INLINE_RESIZE_CLEAR = "\u001b[2J\u001b[3J\u001b[H";
/** 启用鼠标追踪（含 SGR 扩展模式）的控制序列。 */
export const TUI_MOUSE_TRACKING_ENABLE = "\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h";
/** 关闭鼠标追踪的控制序列。 */
export const TUI_MOUSE_TRACKING_DISABLE = "\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l";
/** Store 批量发布 answer delta 的间隔（毫秒）。 */
export const TUI_EVENT_PUBLISH_INTERVAL_MS = 32;
/** OSC 52 剪贴板的最大字节数。 */
export const TUI_OSC52_MAX_BYTES = 100_000;
