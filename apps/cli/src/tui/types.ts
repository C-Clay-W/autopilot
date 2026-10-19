/**
 * 仅 TUI 层自有类型。Controller / 投影 / 事件等宿主协议类型统一从
 * ../types.js 与 ../controller.js 复用，不在这里重复声明领域协议。
 */

import type { CliActivityState } from "../activity-animation.js";
import type { AgentPresentationState } from "@autopilot-agent/presentation";
import type { ContextUsageView } from "@autopilot-agent/core";
import type { CliController, CliControllerResult } from "../controller.js";
import type { TuiSgrMouseEvent } from "../tui-input-router.js";
import type {
  CliAction,
  CliExitCode,
  CliProjection,
  CliPublicEvent,
  CliQueuedInputStarted,
  CliTurnStatus,
} from "../types.js";

/** TUI 中可固化的 transcript 节点。 */
export type CliTuiTranscriptItem =
  | { kind: "prompt"; key: string; content: string }
  | { kind: "notice"; key: string; message: string }
  | {
      kind: "turn";
      key: string;
      turnId: string;
      events: CliTuiTimelineEvent[];
      presentation?: AgentPresentationState;
      status: CliTurnStatus;
      thoughtDurationMs?: number;
      totalDurationMs?: number;
    };

/** TUI 本地补充的时间线节点；不回流 Controller、Runtime 或持久化事件流。 */
export type CliTuiTimelineEvent =
  | CliPublicEvent
  | { type: "tui_input_consumed"; seq: number; turnId: string; inputId: string; content: string; delivery: "steer" | "queue"; consumed?: boolean; cancelled?: boolean; position?: CliTuiInputPosition }
  | { type: "tui_approval_submitted"; seq: number; turnId: string; approvalId: string; decision: Extract<CliAction, { type: "approve" }>["decision"] };

/** 动态区中尚未被 Core 消费的引导或排队输入。 */
export interface CliTuiPendingInput {
  key: string;
  content: string;
  inputId: string;
  delivery: "steer" | "queue";
}

/** 提交瞬间的本地位置；只引用安全展示节点，不保存附件展开或私有消息。 */
export interface CliTuiInputPosition {
  turnId?: string;
  eventCount: number;
  order?: number;
  items: Array<{ id: string; answerLength?: number }>;
}

/** Turn 的本地展示计时；只用于 TUI 文案，不进入 Runtime 或持久化事件。 */
export interface CliTuiTurnMetrics {
  startedAt: number;
  firstAnswerAt?: number;
  completedAt?: number;
}

/** 当前 Turn 的用户输入；动态区保留它，避免历史区固化时机导致 prompt 消失。 */
export interface CliTuiActivePrompt {
  key: string;
  content: string;
  turnId?: string;
}

/** TUI 的不可变快照；快照不包含 Runtime 私有字段。 */
export interface CliTuiSnapshot {
  transcript: CliTuiTranscriptItem[];
  activePrompt?: CliTuiActivePrompt;
  pendingInputs: CliTuiPendingInput[];
  liveTurnId?: string;
  liveEvents: CliTuiTimelineEvent[];
  /** 当前 Turn 的共享 Runtime Presentation 状态，供 inline 与备用屏使用同一 selector。 */
  livePresentation?: AgentPresentationState;
  liveMetrics?: CliTuiTurnMetrics;
  hasLiveApprovalEvent: boolean;
  activity: CliActivityState;
  status: CliTurnStatus;
  recoverable: boolean;
  pendingApproval?: CliProjection["pendingApproval"];
  activeSkills: Array<{ skillId: string; contentHash: string }>;
  /** 最近一次 context_usage 的安全 DTO；只驱动状态栏刷新，不进入时间线。 */
  contextUsage?: ContextUsageView | null;
  cancellationRequested: boolean;
  requestedExitCode?: CliExitCode;
}

/** TUI Store 只负责把安全事件转成 React 可订阅快照。 */
export interface CliTuiStore {
  getSnapshot(): CliTuiSnapshot;
  subscribe(listener: () => void): () => void;
  recordPrompt(content: string, displayAsActive?: boolean): string | undefined;
  captureInputPosition(): CliTuiInputPosition;
  addPendingPrompt(content: string, input: { inputId: string; delivery: "steer" | "queue" }, position?: CliTuiInputPosition): void;
  markQueuedInputStarted(input: CliQueuedInputStarted): void;
  recordApprovalSubmission(decision: Extract<CliAction, { type: "approve" }>["decision"]): void;
  addNotice(message: string): void;
  acceptEvent(event: CliPublicEvent, projection: CliProjection): void;
  syncProjection(projection: CliProjection): void;
  setCancellationRequested(requested: boolean): void;
  requestExit(code: CliExitCode): void;
}

/** TUI 的启动操作；resume 不把完整 checkpoint 传入 UI。 */
export type CliTuiInitialOperation =
  | { type: "start"; content: string }
  | { type: "resume" };

/** Ink TUI 的运行参数。 */
export interface RunCliTuiOptions {
  controller: CliController;
  /** 主机已知的只读会话标识；仅用于备用屏退出后的安全摘要。 */
  sessionId?: string;
  /** canonical 工作区根；仅用于 @ 文件候选索引预热。 */
  workspaceRoot?: string;
  streams: {
    stdout: TuiOutputStream;
    stderr: { write(chunk: string): void };
    stdin: NodeJS.ReadStream;
  };
  signalSource: {
    on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
    removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  };
  forceExit?(code: 130): void;
  initial?: CliTuiInitialOperation;
  closeWhenIdle: boolean;
  env?: NodeJS.ProcessEnv;
}

/** TUI 读取终端尺寸所需的最小宿主流接口；resize 监听保持可选以兼容测试 double。 */
export interface TuiTerminalSizeSource {
  columns?: number;
  rows?: number;
  on?(event: "resize", listener: () => void): void;
  off?(event: "resize", listener: () => void): void;
}

/** TUI 的最小输出流接口；Ink 渲染代理与真实 stdout 均实现此形状。 */
export type TuiOutputStream = TuiTerminalSizeSource & {
  write(chunk: string): void;
  isTTY?: boolean;
};

/** TUI 运行结果；退出码仍由宿主 Main 统一解释。 */
export interface RunCliTuiResult {
  result: CliControllerResult;
  exitCode: CliExitCode;
}

/** 退出备用屏后输出的最小安全会话摘要；不携带 Runtime 私有状态或存储位置。 */
export interface CliTuiRecap {
  sessionId: string;
  completedTurnCount: number;
  finalStatus: CliTurnStatus;
  recoverable: boolean;
}

/** TUI 启动期一次性解析的终端渲染模式。 */
export type TuiRenderMode = "inline" | "alternate-screen";

/** 可幂等恢复终端控制序列的最小生命周期对象。 */
export interface TuiTerminalLifecycle {
  enter(): void;
  reassert(): void;
  restore(): void;
}

/** 备用屏向应用视口转交的鼠标事件入口；只保存一个当前处理器。 */
export interface TuiMouseInputSink {
  setHandler(handler: ((event: TuiSgrMouseEvent, wheelNotches: number) => void) | undefined): void;
  dispatch(event: TuiSgrMouseEvent, wheelNotches?: number): void;
}
