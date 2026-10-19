/** CLI TUI 语义色 token；组件只引用 token，不直接写危险态颜色。 */
export const CLI_TUI_COLORS = {
  accent: "ansi256(208)",
  permissionFullAccess: "#ff6b80",
  copilotBlue: "ansi256(33)",
  copilotBlueBright: "ansi256(39)",
  copilotPurple: "ansi256(99)",
  copilotGreen: "ansi256(77)",
  copilotInk: "ansi256(255)",
  copilotMuted: "ansi256(246)",
  copilotOutline: "ansi256(243)",
} as const;

/** Design.md 中橙色强调色的 ANSI 256 语义映射；NO_COLOR 时完全不输出颜色。 */
export const TUI_ACCENT_COLOR = CLI_TUI_COLORS.accent;
/** 工具徽标 chip 的强调背景色；与唯一强调色同源，只用于标注当前活动步骤。 */
export const TUI_ACCENT_BG_COLOR = CLI_TUI_COLORS.accent;
/** 工具徽标 chip 上的深色粗体文字色；对应 Web 的 text-ink-on-dark 槽位语义。 */
export const TUI_CHIP_TEXT_COLOR = "ansi256(16)";
/** 工具成功 glyph 的辅助绿；状态永远带文字标签，不靠颜色传达。 */
export const TUI_TOOL_SUCCESS_COLOR = "ansi256(46)";
/** 工具失败文字的辅助红；状态永远带文字标签，不靠颜色传达。 */
export const TUI_TOOL_ERROR_COLOR = "ansi256(196)";
/** 失败徽标的红色背景；与错误文字共用语义红，NO_COLOR 时仍显示状态文字。 */
export const TUI_TOOL_ERROR_BG_COLOR = TUI_TOOL_ERROR_COLOR;
/** 红底失败徽标使用深色粗体文字，便于和错误背景形成明确边界。 */
export const TUI_TOOL_ERROR_TEXT_COLOR = TUI_CHIP_TEXT_COLOR;
/** Skill 已启用开关的语义色。 */
export const TUI_SKILL_ON_COLOR = "ansi256(46)";
/** Skill 未启用开关的语义色。 */
export const TUI_SKILL_OFF_COLOR = "ansi256(196)";
/** 动态等待区（引导/排队输入）的背景色。 */
export const TUI_WAITING_BACKGROUND_COLOR = "ansi256(236)";
/** unified diff 新增行的语义色。 */
export const TUI_DIFF_ADDED_COLOR = "ansi256(46)";
/** unified diff 删除行的语义色。 */
export const TUI_DIFF_REMOVED_COLOR = "ansi256(196)";
/** 输入区（prompt）的背景色。 */
export const TUI_PROMPT_BACKGROUND_COLOR = "ansi256(236)";
