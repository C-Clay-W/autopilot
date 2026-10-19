/**
 * @autopilot-agent/cli — Step 5.2 CLI 宿主壳公开出口。
 *
 * 这里只暴露 parser、Composition Root、Controller、事件投影和 Plain Renderer；
 * 不暴露 Core private 类型，不加载 React/Ink，也不在模块导入时启动 Runtime。
 */

export { createCliCompositionRoot } from "./composition-root.js";
export type { CliCapabilityLoader, CliCompositionRoot, CreateCliCompositionRootOptions } from "./composition-root.js";
export { exitCodeForSignal, main } from "./main.js";
export type { CliMainStreams } from "./main.js";
export { createCliController, commandToAction } from "./controller.js";
export type {
  CliApprovalSubmit,
  CliController,
  CliControllerResult,
  CreateCliControllerOptions,
} from "./controller.js";
export { createCliEventProjector, createInitialCliProjection, reduceCliEvent } from "./event-projector.js";
export { createPlainRenderer } from "./renderer.js";
export { parseArgv, parseSlashAction, renderHelp } from "./parser.js";
export type {
  CliAction,
  CliActionParseResult,
  CliCommand,
  CliEventEnvelope,
  CliEventListener,
  CliQueuedInputStarted,
  CliQueuedInputStartedListener,
  CliExitCode,
  CliHostOptions,
  CliInvocation,
  CliOutputFormat,
  CliPermissionMode,
  CliPermissionOption,
  CliParseResult,
  CliProjection,
  CliPublicEvent,
  CliRenderer,
  CliStatusView,
  CliRuntime,
  CliTurnStatus,
} from "./types.js";
export { createCliTuiStore, runCliTui } from "./tui.js";
export type {
  CliTuiInitialOperation,
  CliTuiRecap,
  CliTuiSnapshot,
  CliTuiStore,
  CliTuiTranscriptItem,
  RunCliTuiOptions,
  RunCliTuiResult,
} from "./tui.js";
export { formatCliTuiRecap } from "./tui.js";
