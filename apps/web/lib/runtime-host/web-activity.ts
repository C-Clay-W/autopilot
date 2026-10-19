/** Web Agent 活动状态：按 CLI 的显式事件状态机提供实时安全状态，不从过程文案猜测阶段。 */

export type WebActivityPhase = "requesting" | "thinking" | "waiting" | "transition" | "responding" | "stalled" | "terminal";

export interface WebActivityState {
  turnId?: string;
  phase: WebActivityPhase;
  lastProgressAt: number;
  startedAt?: number;
  transitionStartedAt?: number;
  hasActiveTool: boolean;
  stallable: boolean;
  /** 最近一次 tool_progress 的输出尾部；运行中的长时命令实时展示用。 */
  progressTail?: string;
}

export interface WebActivityView {
  phase: WebActivityPhase;
  label: string;
}

interface WebActivityEvent {
  type?: unknown;
  turnId?: unknown;
  timestamp?: unknown;
}

export const WEB_ACTIVITY_STALLED_AFTER_MS = 20_000;
export const WEB_ACTIVITY_TRANSITION_MS = 2_000;

/** 读取 Runtime 事件的可信时间戳；缺失或非法时间只回退到当前宿主时钟。 */
function getEventTime(event: WebActivityEvent): number {
  if (typeof event.timestamp === "string") {
    const parsed = Date.parse(event.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** 创建等待 Runtime 首个事件的初始活动状态。 */
export function createInitialWebActivityState(now = Date.now(), turnId?: string): WebActivityState {
  return { turnId, phase: "requesting", lastProgressAt: now, startedAt: now, hasActiveTool: false, stallable: true };
}

/** 推进 Web 活动状态并记录最近一次可观察进展时间。 */
function advanceWebActivityState(previous: WebActivityState, phase: WebActivityPhase, now: number, options: { hasActiveTool?: boolean; stallable?: boolean; transitionStartedAt?: number; progressTail?: string } = {}): WebActivityState {
  return {
    ...previous,
    phase,
    lastProgressAt: now,
    hasActiveTool: options.hasActiveTool ?? previous.hasActiveTool,
    stallable: options.stallable ?? previous.stallable,
    transitionStartedAt: options.transitionStartedAt,
    progressTail: options.progressTail ?? previous.progressTail,
  };
}

/** 按 CLI 相同的事件语义归约 Web 活动阶段，answer_delta 会立即进入 responding。 */
export function reduceWebActivityState(previous: WebActivityState | undefined, event: WebActivityEvent): WebActivityState | undefined {
  const type = typeof event.type === "string" ? event.type : undefined;
  const turnId = typeof event.turnId === "string" ? event.turnId : previous?.turnId;
  const now = getEventTime(event);
  if (type === "turn_started") return createInitialWebActivityState(now, turnId);
  if (!previous && !turnId) return undefined;
  const base = previous && previous.turnId === turnId ? previous : createInitialWebActivityState(now, turnId);
  if (type === "reasoning_summary" || type === "model_recovery" || type === "context_overflow" || type === "context_compact_started" || type === "context_compacted") {
    return advanceWebActivityState(base, "thinking", now, { hasActiveTool: false, stallable: true });
  }
  if (type === "tool_progress") {
    const progressTail = typeof (event as { tail?: unknown }).tail === "string" ? (event as { tail: string }).tail : undefined;
    return advanceWebActivityState(base, "thinking", now, { hasActiveTool: base.hasActiveTool, stallable: true, transitionStartedAt: base.transitionStartedAt, progressTail });
  }
  if (type === "tool_started") return advanceWebActivityState(base, "transition", now, { hasActiveTool: true, stallable: false, transitionStartedAt: now });
  if (type === "tool_result") return advanceWebActivityState(base, "transition", now, { hasActiveTool: false, stallable: true, transitionStartedAt: now });
  if (type === "approval_required") return advanceWebActivityState(base, "waiting", now, { hasActiveTool: false, stallable: false });
  if (type === "answer_delta") return advanceWebActivityState(base, "responding", now, { hasActiveTool: false, stallable: true });
  if (type === "turn_paused") return advanceWebActivityState(base, "waiting", now, { hasActiveTool: false, stallable: false });
  if (type === "turn_completed" || type === "turn_interrupted" || type === "turn_failed" || type === "turn_limit_reached") {
    return advanceWebActivityState(base, "terminal", now, { hasActiveTool: false, stallable: false });
  }
  return previous;
}

/** 将等待时长格式化为稳定的活动提示，避免显示虚假的百分比进度。 */
function formatWebActivityElapsed(durationMs: number): string {
  const seconds = Math.max(1, Math.floor(Math.max(0, durationMs) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分钟`;
}

/** 返回活动阶段对应的稳定中文文案。 */
function getWebActivityLabel(phase: WebActivityPhase, input: { idleForMs?: number; hasActiveTool?: boolean } = {}): string {
  if (phase === "requesting") return "正在准备任务";
  if (phase === "thinking") return "正在分析下一步";
  if (phase === "waiting") return input.hasActiveTool ? "正在等待工具结果" : "正在等待模型响应";
  if (phase === "transition") return "正在启动工具";
  if (phase === "responding") return "正在输出回答";
  if (phase === "stalled") return `仍在执行 · 已等待 ${formatWebActivityElapsed(input.idleForMs ?? 0)}`;
  return "已完成";
}

/** 根据当前时间解析工具过场和 stalled 状态，保持与 CLI 的活动边界一致。 */
export function resolveWebActivityView(input: { activity: WebActivityState; running: boolean; now: number }): WebActivityView | undefined {
  const { activity, running, now } = input;
  if (!running || activity.phase === "terminal") return undefined;
  let phase = activity.phase;
  if (phase === "transition" && activity.transitionStartedAt !== undefined && now - activity.transitionStartedAt >= WEB_ACTIVITY_TRANSITION_MS) {
    phase = activity.hasActiveTool ? "waiting" : "thinking";
  }
  if (activity.hasActiveTool && phase !== "transition") phase = "waiting";
  if (activity.stallable && !activity.hasActiveTool && phase !== "waiting" && now - activity.lastProgressAt >= WEB_ACTIVITY_STALLED_AFTER_MS) {
    phase = "stalled";
  }
  return {
    phase,
    label: getWebActivityLabel(phase, { idleForMs: Math.max(0, now - activity.lastProgressAt), hasActiveTool: activity.hasActiveTool }),
  };
}
