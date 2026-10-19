/**
 * CLI Ink TUI 公开出口（barrel）。
 * 实现已按领域拆分到 tui/ 目录；这里只 re-export 对外契约符号，
 * 保证 index.ts、main.ts 与既有测试的 import 零改动。
 */

export type {
  CliTuiActivePrompt,
  CliTuiInitialOperation,
  CliTuiPendingInput,
  CliTuiRecap,
  CliTuiSnapshot,
  CliTuiStore,
  CliTuiTimelineEvent,
  CliTuiTranscriptItem,
  CliTuiTurnMetrics,
  RunCliTuiOptions,
  RunCliTuiResult,
  TuiMouseInputSink,
  TuiOutputStream,
  TuiRenderMode,
  TuiTerminalSizeSource,
  TuiTerminalLifecycle,
} from "./tui/types.js";
export { createCliTuiStore } from "./tui/store.js";
export { formatCliTuiRecap, runCliTui } from "./tui/run.js";
export { createRoutedTuiStdin, createTuiMouseInputSink, createTuiRenderStdout, createTuiTerminalLifecycle } from "./tui/lifecycle.js";
export { createTuiViewportDiffSource, formatTuiViewportMarkdown } from "./tui/viewport/sources.js";
export { getTuiRenderModeFallbackNotice, resolveTuiRenderMode, resolveTuiRenderModePolicy } from "./tui/render-mode.js";
export { parseTuiControlAction, resolveTuiDeleteDirection } from "./tui/input/keys.js";
export { CliTuiApp } from "./tui/app.js";
export { resolveTrustDialogNavigation, runCliTrustDialog, TuiTrustDialog, TRUST_DIALOG_OPTIONS } from "./tui/trust-dialog.js";
export type { CliTrustDecision, CliTrustDialogOptions, CliTrustDialogSignalSource } from "./tui/trust-dialog.js";
