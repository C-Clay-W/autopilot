/**
 * CLI TUI 活动状态与离散动画。
 *
 * 状态由安全事件类型归约得到，动画只消费显式状态和共享时钟；稳定文案始终
 * 可见。活动 glyph 采用 Claude Code 的单字符 ping-pong 形式，不把状态包装成
 * 调试风格的进度条。
 */

import { useEffect, useState, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { CliTurnStatus } from "./types.js";
import type { TuiAnimationClock } from "./animation-clock.js";
import { formatTuiDuration } from "./tui/format.js";

export type CliActivityPhase = "requesting" | "thinking" | "waiting" | "transition" | "responding" | "stalled" | "terminal";

export interface CliActivityState {
  phase: CliActivityPhase;
  lastProgressAt: number;
  transitionStartedAt?: number;
  hasActiveTool: boolean;
  stallable: boolean;
}

export interface CliActivityView {
  phase: CliActivityPhase;
  label: string;
  frame: string;
}

interface CliActivityEventLike {
  type: string;
}

export const CLI_ACTIVITY_STALLED_AFTER_MS = 20_000;
export const CLI_ACTIVITY_TRANSITION_MS = 2_000;

/** CC v2.1.88 的默认 spinner glyph；首尾重复保证 ping-pong 转向自然。 */
const CLI_ACTIVITY_SPINNER_FRAMES = ["·", "✢", "*", "✶", "✻", "✽", "✽", "✻", "✶", "*", "✢", "·"] as const;
/** 与 CC SpinnerGlyph 一致，glyph 每 120ms 前进一格；共享时钟仍可用 50ms tick。 */
export const CLI_ACTIVITY_SPINNER_FRAME_MS = 120;

/** 创建一个等待 Provider 首个事件的初始活动状态。 */
export function createInitialCliActivityState(now: number): CliActivityState {
  return {
    phase: "requesting",
    lastProgressAt: now,
    hasActiveTool: false,
    stallable: true,
  };
}

/** 将活动状态推进到指定稳定阶段，并记录本次可观察进展时间。 */
function advanceCliActivityState(previous: CliActivityState, phase: CliActivityPhase, now: number, options: { hasActiveTool?: boolean; stallable?: boolean; transitionStartedAt?: number } = {}): CliActivityState {
  return {
    ...previous,
    phase,
    lastProgressAt: now,
    hasActiveTool: options.hasActiveTool ?? previous.hasActiveTool,
    stallable: options.stallable ?? previous.stallable,
    transitionStartedAt: options.transitionStartedAt,
  };
}

/** 按安全事件类型归约活动状态，不读取事件文案或模型原始输出。 */
export function reduceCliActivityState(previous: CliActivityState, event: CliActivityEventLike, now: number): CliActivityState {
  switch (event.type) {
    case "turn_started":
      return createInitialCliActivityState(now);
    case "reasoning_summary":
    case "reasoning_hidden":
    case "model_recovery":
    case "context_overflow":
    case "context_compact_started":
    case "context_compacted":
      return advanceCliActivityState(previous, "thinking", now, { hasActiveTool: false, stallable: true });
    case "tool_started":
      return advanceCliActivityState(previous, "transition", now, { hasActiveTool: true, stallable: false, transitionStartedAt: now });
    case "tool_result":
      return advanceCliActivityState(previous, "transition", now, { hasActiveTool: false, stallable: true, transitionStartedAt: now });
    case "approval_required":
      return advanceCliActivityState(previous, "waiting", now, { hasActiveTool: false, stallable: false });
    case "answer_delta":
      return advanceCliActivityState(previous, "responding", now, { hasActiveTool: false, stallable: true });
    case "status":
      return previous;
    default:
      return previous;
  }
}

/** 把投影终态映射为不会继续驱动动画的活动状态。 */
export function settleCliActivityState(previous: CliActivityState, status: CliTurnStatus, now: number): CliActivityState {
  if (status === "idle" || status === "running" || status === "waiting_approval") return previous;
  return advanceCliActivityState(previous, "terminal", now, { hasActiveTool: false, stallable: false });
}

/** 返回指定活动阶段对应的单 glyph 帧；外层 Box 负责固定占位宽度。 */
export function getCliActivityFrame(phase: CliActivityPhase, now: number): string {
  if (phase === "terminal") return "";
  return CLI_ACTIVITY_SPINNER_FRAMES[Math.floor(Math.max(0, now) / CLI_ACTIVITY_SPINNER_FRAME_MS) % CLI_ACTIVITY_SPINNER_FRAMES.length] ?? "·";
}

function formatCliActivityElapsed(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(Math.max(0, durationMs) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

/** 返回活动阶段的稳定文案，供动画降级和 screen reader 使用。 */
function getCliActivityLabel(phase: CliActivityPhase, input: { idleForMs?: number; hasActiveTool?: boolean } = {}): string {
  switch (phase) {
    case "requesting": return "Preparing · waiting for first event";
    case "thinking": return "Thinking · planning next step";
    case "waiting": return input.hasActiveTool ? "Waiting · tool result" : "Waiting · provider response";
    case "transition": return "Running action · starting tool";
    case "responding": return "Answering · receiving output";
    case "stalled": return `Still working · no new event for ${formatCliActivityElapsed(input.idleForMs ?? 0)}`;
    case "terminal": return "Completed";
  }
}

/** 根据当前时间解析过场、stalled 和审批等待，形成最终可见活动状态。 */
export function resolveCliActivityView(input: { activity: CliActivityState; status: CliTurnStatus; now: number; waitingForApproval?: boolean }): CliActivityView | undefined {
  const { activity, status, now } = input;
  if (status === "idle") return undefined;
  if (status !== "running" && status !== "waiting_approval") return { phase: "terminal", label: status, frame: "" };
  if (input.waitingForApproval || status === "waiting_approval") {
    return { phase: "waiting", label: "Waiting for approval", frame: getCliActivityFrame("waiting", now) };
  }

  let phase = activity.phase;
  if (phase === "transition" && activity.transitionStartedAt !== undefined && now - activity.transitionStartedAt >= CLI_ACTIVITY_TRANSITION_MS) {
    phase = activity.hasActiveTool ? "waiting" : "thinking";
  }
  if (activity.hasActiveTool && phase !== "transition") phase = "waiting";
  if (activity.stallable && !activity.hasActiveTool && phase !== "waiting" && now - activity.lastProgressAt >= CLI_ACTIVITY_STALLED_AFTER_MS) {
    phase = "stalled";
  }
  return {
    phase,
    label: getCliActivityLabel(phase, { idleForMs: Math.max(0, now - activity.lastProgressAt), hasActiveTool: activity.hasActiveTool }),
    frame: getCliActivityFrame(phase, now),
  };
}

/** 渲染稳定活动文案和可选的固定宽度离散帧。 */
export function TuiActivityLine(props: { activity: CliActivityState; status: CliTurnStatus; waitingForApproval: boolean; useColor: boolean; screenReader: boolean; reducedMotion: boolean; animationActive: boolean; clock: TuiAnimationClock; startedAt?: number; activeForm?: string }): ReactNode {
  const [clockTime, setClockTime] = useState(props.clock.now());
  const view = resolveCliActivityView({ activity: props.activity, status: props.status, now: clockTime, waitingForApproval: props.waitingForApproval });
  const shouldAnimate = props.animationActive && !props.screenReader && !props.reducedMotion && view !== undefined && view.phase !== "terminal";
  const shouldTick = shouldAnimate || (props.startedAt !== undefined && (props.status === "running" || props.status === "waiting_approval"));

  useEffect(function subscribeActivityClock() {
    props.clock.setActive(shouldTick);
    if (!shouldTick) {
      setClockTime(props.clock.now());
      return;
    }
    setClockTime(props.clock.now());
    return props.clock.subscribe(function updateActivityClock(time: number): void {
      // 禁动画仍按秒刷新累计时间，复用同一枚时钟。
      setClockTime(function next(previous) { return shouldAnimate || Math.floor(previous / 1000) !== Math.floor(time / 1000) ? time : previous; });
    });
  }, [props.clock, shouldAnimate, shouldTick]);

  if (!view) return null;
  if (view.phase === "terminal") return null;
  const frame = shouldAnimate ? view.frame : "·";
  const isStalled = view.phase === "stalled";
  return (
    <Box flexDirection="row">
      <Box width={3} flexShrink={0}>
        <Text bold={isStalled} color={props.useColor ? "ansi256(208)" : undefined}>{frame}</Text>
      </Box>
      <Text bold={isStalled} dimColor={props.useColor && !isStalled}>{props.activeForm ?? view.label}{props.startedAt !== undefined ? ` · ${formatTuiDuration(Math.max(0, clockTime - props.startedAt))}` : ""}</Text>
    </Box>
  );
}
