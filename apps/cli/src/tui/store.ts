/** TUI 外部 Store：把安全事件归约为 React 可订阅快照，不读取 Core Store 或 checkpoint。 */

import {
  createInitialCliActivityState,
  reduceCliActivityState,
  settleCliActivityState,
} from "../activity-animation.js";
import type {
  CliAction,
  CliExitCode,
  CliProjection,
  CliPublicEvent,
  CliQueuedInputStarted,
  CliTurnStatus,
} from "../types.js";
import { TUI_EVENT_PUBLISH_INTERVAL_MS } from "./constants.js";
import { isTerminalStatus } from "./format.js";
import { recordTuiPerformanceDiagnostic } from "./performance-diagnostics.js";
import { captureTuiInputPosition } from "./timeline/turn-items.js";
import type { CliTuiSnapshot, CliTuiStore, CliTuiTimelineEvent, CliTuiTurnMetrics } from "./types.js";

/** 创建 TUI 初始快照。 */
function createInitialTuiSnapshot(now = Date.now()): CliTuiSnapshot {
  return {
    transcript: [],
    pendingInputs: [],
    liveEvents: [],
    hasLiveApprovalEvent: false,
    activity: createInitialCliActivityState(now),
    status: "idle",
    recoverable: false,
    activeSkills: [],
    contextUsage: undefined,
    cancellationRequested: false,
  };
}

/** 创建 Ink TUI 的外部 Store。 */
export function createCliTuiStore(): CliTuiStore {
  let snapshot = createInitialTuiSnapshot();
  let noticeIndex = 0;
  let promptIndex = 0;
  let scheduledNotify: ReturnType<typeof setTimeout> | undefined;
  const settledInputIds = new Set<string>();
  const consumedPositions = new Map<string, ReturnType<typeof captureTuiInputPosition>>();
  const cancelledTurns = new Set<string>();
  let submissionOrder = 0;
  const submittedInputIds = new Set<string>();
  const submittedApprovalIds = new Set<string>();
  const listeners = new Set<() => void>();
  const eventsByTurn = new Map<string, CliTuiTimelineEvent[]>();
  const presentationByTurn = new Map<string, CliProjection["presentation"]>();
  const metricsByTurn = new Map<string, CliTuiTurnMetrics>();
  const finalizedTurns = new Set<string>();

  function publish(nextSnapshot: CliTuiSnapshot): void {
    flushScheduledNotify();
    snapshot = nextSnapshot;
    notifyListeners();
  }

  function flushScheduledNotify(): void {
    if (scheduledNotify === undefined) return;
    clearTimeout(scheduledNotify);
    scheduledNotify = undefined;
  }

  function scheduleNotify(): void {
    if (scheduledNotify !== undefined) return;
    scheduledNotify = setTimeout(function publishAnswerBatch(): void {
      scheduledNotify = undefined;
      notifyListeners();
    }, TUI_EVENT_PUBLISH_INTERVAL_MS);
  }

  function notifyListeners(): void {
    const startedAt = performance.now();
    for (const listener of listeners) listener();
    recordTuiPerformanceDiagnostic("tui_store_published", "snapshot", performance.now() - startedAt);
  }

  /** 更新所属轮的宿主输入事实；晚到回调同时刷新历史快照，不挪到当前另一轮。 */
  function putInput(content: string, input: { inputId: string; delivery: "steer" | "queue" }, position: ReturnType<typeof captureTuiInputPosition>, consumed: boolean): void {
    const turnId = position.turnId;
    if (!turnId) return;
    const events = [...(eventsByTurn.get(turnId) ?? [])];
    const priorIndex = events.findIndex(function same(event) { return event.type === "tui_input_consumed" && event.inputId === input.inputId; });
    const prior = priorIndex >= 0 ? events[priorIndex] : undefined;
    const event: CliTuiTimelineEvent = { type: "tui_input_consumed", seq: 0, turnId, ...input, content, consumed, cancelled: !consumed && cancelledTurns.has(turnId), position: prior?.type === "tui_input_consumed" ? prior.position : position };
    if (priorIndex >= 0) events[priorIndex] = event;
    else {
      let publicCount = 0;
      let insertAt = events.length;
      for (let index = 0; index < events.length; index += 1) {
        const current = events[index]!;
        if (current.type === "tui_input_consumed") {
          if (publicCount >= position.eventCount && (current.position?.order ?? 0) > (position.order ?? 0)) { insertAt = index; break; }
        } else {
          if (publicCount >= position.eventCount) { insertAt = index; break; }
          publicCount += 1;
        }
      }
      events.splice(insertAt, 0, event);
    }
    eventsByTurn.set(turnId, events);
    snapshot = { ...snapshot, liveEvents: snapshot.liveTurnId === turnId ? events : snapshot.liveEvents, transcript: snapshot.transcript.map(function update(item) { return item.kind === "turn" && item.turnId === turnId ? { ...item, events } : item; }) };
  }

  function finalizeTurn(turnId: string, status: CliTurnStatus): void {
    if (finalizedTurns.has(turnId)) return;
    const events = eventsByTurn.get(turnId) ?? [];
    if (events.length === 0) return;
    finalizedTurns.add(turnId);
    const metrics = metricsByTurn.get(turnId);
    const thoughtDurationMs = metrics?.firstAnswerAt === undefined
      ? undefined
      : Math.max(0, metrics.firstAnswerAt - metrics.startedAt);
    const totalDurationMs = metrics?.completedAt === undefined
      ? undefined
      : Math.max(0, metrics.completedAt - metrics.startedAt);
    // 终态先保留当前 live Turn，让这一帧同时接住最后的 answer/status block；
    // 立即清空会让外层历史区过滤掉同一 Turn，导致最后一段回答不可见。
    snapshot = {
      ...snapshot,
      transcript: [
        ...snapshot.transcript,
        {
          kind: "turn",
          key: "turn:" + turnId + ":" + String(events[events.length - 1]?.seq ?? 0),
          turnId,
          events: [...events],
          presentation: presentationByTurn.get(turnId),
          status,
          thoughtDurationMs,
          totalDurationMs,
        },
      ],
    };
  }

  return {
    getSnapshot(): CliTuiSnapshot {
      return snapshot;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return function unsubscribe(): void {
        listeners.delete(listener);
      };
    },
    recordPrompt(content: string, displayAsActive = true): string | undefined {
      const trimmed = content.trim();
      if (!trimmed) return undefined;
      // 运行中的 steer/queue 由已确认的 inputId 单独记录，避免发送前伪造成功展示。
      if (!displayAsActive) return undefined;
      const key = "prompt:" + String(promptIndex++);
      publish({
        ...snapshot,
        // info 是下一次 Turn 之前的临时反馈；新 prompt 被接收后必须立即消费，不能留在新 Turn 的输入区上方。
        transcript: [
          ...snapshot.transcript.filter(function omitConsumedNotice(item): boolean { return item.kind !== "notice"; }),
          { kind: "prompt", key, content: trimmed },
        ],
        activePrompt: displayAsActive ? { key, content: trimmed } : snapshot.activePrompt,
      });
      return key;
    },
    /** 在异步投递之前捕获真实提交位置。 */
    captureInputPosition() { return { ...captureTuiInputPosition(snapshot.liveTurnId, snapshot.liveEvents, snapshot.livePresentation), order: submissionOrder++ }; },
    /** 成功投递后才外显原文，消费与回调的先后次序不改变所属轮。 */
    addPendingPrompt(content: string, input: { inputId: string; delivery: "steer" | "queue" }, position = captureTuiInputPosition(snapshot.liveTurnId, snapshot.liveEvents, snapshot.livePresentation)): void {
      if (!content.trim() || submittedInputIds.has(input.inputId)) return;
      submittedInputIds.add(input.inputId);
      const consumed = settledInputIds.has(input.inputId);
      const settledPosition = consumedPositions.get(input.inputId);
      const target = input.delivery === "steer" && position.turnId && (!settledPosition || settledPosition.turnId === position.turnId) ? position : settledPosition;
      if (target) putInput(content, input, target, consumed);
      if (consumed || (position.turnId && cancelledTurns.has(position.turnId))) { publish(snapshot); return; }
      publish({
        ...snapshot,
        pendingInputs: [
          ...snapshot.pendingInputs,
          {
            key: "pending:" + String(promptIndex++),
            content,
            inputId: input.inputId,
            delivery: input.delivery,
          },
        ],
      });
    },
    /** 在自动 queue Turn 开始前，将 prompt 放进目标 Turn 的事件序列并清除等待态。 */
    markQueuedInputStarted(input: CliQueuedInputStarted): void {
      if (settledInputIds.has(input.inputId)) return;
      settledInputIds.add(input.inputId);
      const position = { turnId: input.turnId, eventCount: 0, items: [] };
      consumedPositions.set(input.inputId, position);
      const pending = snapshot.pendingInputs.find(function same(item) { return item.inputId === input.inputId; });
      // 领取回调的 content 可能带附件展开，只在原文已经确认时输出正文。
      if (pending) putInput(pending.content, input, position, true);
      publish({
        ...snapshot,
        pendingInputs: snapshot.pendingInputs.filter(function keepUnstartedInput(item): boolean { return item.inputId !== input.inputId; }),
        liveTurnId: snapshot.liveTurnId === input.turnId ? input.turnId : snapshot.liveTurnId,
        liveEvents: snapshot.liveEvents,
      });
    },
    /** 用户选择审批范围后立即将等待卡收束为已提交结果；Runtime 后续事件仍是最终执行依据。 */
    recordApprovalSubmission(decision: Extract<CliAction, { type: "approve" }>["decision"]): void {
      const approval = snapshot.pendingApproval;
      const turnId = snapshot.liveTurnId;
      if (!approval || !turnId) return;
      submittedApprovalIds.add(approval.approvalId);
      const currentEvents = eventsByTurn.get(turnId) ?? [];
      if (currentEvents.some(function hasSubmission(event): boolean {
        return event.type === "tui_approval_submitted" && event.approvalId === approval.approvalId;
      })) return;
      const nextEvents: CliTuiTimelineEvent[] = [
        ...currentEvents,
        { type: "tui_approval_submitted", seq: Number.MAX_SAFE_INTEGER, turnId, approvalId: approval.approvalId, decision },
      ];
      eventsByTurn.set(turnId, nextEvents);
      publish({ ...snapshot, liveEvents: snapshot.liveTurnId === turnId ? nextEvents : snapshot.liveEvents, pendingApproval: undefined });
    },
    addNotice(message: string): void {
      const trimmed = message.trim();
      if (!trimmed) return;
      publish({
        ...snapshot,
        transcript: [
          ...snapshot.transcript,
          { kind: "notice", key: "notice:" + String(noticeIndex++), message: trimmed },
        ],
      });
    },
    acceptEvent(event: CliPublicEvent, projection: CliProjection): void {
      // 用量变化只刷新动态状态栏事实，不进入 transcript 时间线或 scrollback。
      if (event.type === "context_usage") {
        if (snapshot.contextUsage === event.usage) return;
        publish({ ...snapshot, contextUsage: event.usage });
        return;
      }
      // Esc 后只等待 Runtime 的终态；取消请求之后已经在途的回答/工具尾部事件不再进入可见时间线。
      if (snapshot.cancellationRequested && !(event.type === "status" && isTerminalStatus(event.status))) return;
      const currentEvents = eventsByTurn.get(event.turnId) ?? [];
      if (currentEvents.some(function hasSequence(item): boolean { return item.type === event.type && item.seq === event.seq; })) return;
      const nextEvents: CliTuiTimelineEvent[] = [...currentEvents, event];
      eventsByTurn.set(event.turnId, nextEvents);
      presentationByTurn.set(event.turnId, projection.presentation);
      const isNewTurn = snapshot.liveTurnId !== event.turnId;
      const activePrompt = snapshot.activePrompt && snapshot.activePrompt.turnId === undefined
        ? { ...snapshot.activePrompt, turnId: event.turnId }
        : snapshot.activePrompt;
      const eventTime = Date.now();
      const previousMetrics = metricsByTurn.get(event.turnId);
      const nextMetrics: CliTuiTurnMetrics = {
        startedAt: event.type === "turn_started" ? eventTime : previousMetrics?.startedAt ?? eventTime,
        firstAnswerAt: previousMetrics?.firstAnswerAt,
        completedAt: previousMetrics?.completedAt,
      };
      if (event.type === "answer_delta" && nextMetrics.firstAnswerAt === undefined) nextMetrics.firstAnswerAt = eventTime;
      // Core 的 reset/discard 表示当前采样的暂定文字不能展示；下一次真正回答重新计时。
      if (event.type === "answer_reset") nextMetrics.firstAnswerAt = undefined;
      if (event.type === "status" && isTerminalStatus(event.status)) nextMetrics.completedAt = eventTime;
      metricsByTurn.set(event.turnId, nextMetrics);
      const nextActivity = settleCliActivityState(reduceCliActivityState(snapshot.activity, event, eventTime), projection.status, eventTime);
      const nextSnapshot: CliTuiSnapshot = {
        ...snapshot,
        activePrompt,
        liveTurnId: event.turnId,
        liveEvents: nextEvents,
        livePresentation: projection.presentation,
        liveMetrics: { ...nextMetrics },
        hasLiveApprovalEvent: isNewTurn ? event.type === "approval_required" : snapshot.hasLiveApprovalEvent || event.type === "approval_required",
        activity: nextActivity,
        status: projection.status,
        recoverable: projection.recoverable,
        pendingApproval: projection.pendingApproval && !submittedApprovalIds.has(projection.pendingApproval.approvalId)
          ? { ...projection.pendingApproval }
          : undefined,
        activeSkills: projection.activeSkills.map(function copySkill(skill) { return { ...skill }; }),
        cancellationRequested: event.type === "status" && isTerminalStatus(event.status) ? false : snapshot.cancellationRequested,
      };
      if (event.type === "input_consumed") {
        settledInputIds.add(event.inputId);
        if (!consumedPositions.has(event.inputId)) consumedPositions.set(event.inputId, captureTuiInputPosition(event.turnId, currentEvents, snapshot.livePresentation));
        const pending = nextSnapshot.pendingInputs.find(function same(item) { return item.inputId === event.inputId; });
        nextSnapshot.pendingInputs = nextSnapshot.pendingInputs.filter(function keepPendingInput(item) { return item.inputId !== event.inputId; });
        const host = nextEvents.find(function same(item) { return item.type === "tui_input_consumed" && item.inputId === event.inputId; });
        if (host?.type === "tui_input_consumed") nextSnapshot.liveEvents = nextEvents.map(function consume(item) { return item === host ? { ...host, consumed: true } : item; });
        eventsByTurn.set(event.turnId, nextSnapshot.liveEvents);
        if (!host && pending) {
          snapshot = nextSnapshot;
          const position = pending.delivery === "queue" ? { turnId: event.turnId, eventCount: 0, items: [] } : consumedPositions.get(event.inputId)!;
          consumedPositions.set(event.inputId, position);
          putInput(pending.content, pending, position, true);
          nextSnapshot.liveEvents = snapshot.liveEvents;
          nextSnapshot.transcript = snapshot.transcript;
        }
      }
      snapshot = nextSnapshot;
      if (event.type === "status" && isTerminalStatus(event.status)) {
        finalizeTurn(event.turnId, event.status);
      }
      if (event.type === "answer_delta") {
        scheduleNotify();
      } else {
        flushScheduledNotify();
        notifyListeners();
      }
    },
    syncProjection(projection: CliProjection): void {
      if (projection.turnId && !eventsByTurn.has(projection.turnId) && projection.events.length > 0) eventsByTurn.set(projection.turnId, projection.events.filter(function belongs(event) { return event.turnId === projection.turnId; }));
      const turnIsFinalized = projection.turnId ? finalizedTurns.has(projection.turnId) : false;
      const isNewTurn = projection.turnId !== undefined && projection.turnId !== snapshot.liveTurnId;
      const activePrompt = snapshot.activePrompt && snapshot.activePrompt.turnId === undefined && projection.turnId
        ? { ...snapshot.activePrompt, turnId: projection.turnId }
        : snapshot.activePrompt;
      const keepFinalizedLiveTurn = Boolean(projection.turnId && turnIsFinalized && projection.turnId === snapshot.liveTurnId);
      const keepLiveTurn = Boolean(projection.turnId && (!turnIsFinalized || keepFinalizedLiveTurn));
      if (projection.turnId) presentationByTurn.set(projection.turnId, projection.presentation);
      let activity = isNewTurn ? createInitialCliActivityState(Date.now()) : snapshot.activity;
      if (projection.pendingApproval || projection.status === "waiting_approval") {
        activity = reduceCliActivityState(activity, { type: "approval_required" }, Date.now());
      } else {
        activity = settleCliActivityState(activity, projection.status, Date.now());
      }
      snapshot = {
        ...snapshot,
        activePrompt,
        liveTurnId: keepLiveTurn ? projection.turnId : undefined,
        liveEvents: keepLiveTurn ? [...(eventsByTurn.get(projection.turnId!) ?? [])] : [],
        livePresentation: keepLiveTurn ? projection.presentation : undefined,
        liveMetrics: keepLiveTurn && projection.turnId ? metricsByTurn.get(projection.turnId) : undefined,
        hasLiveApprovalEvent: Boolean(keepLiveTurn && !isNewTurn && snapshot.hasLiveApprovalEvent),
        activity,
        status: projection.status,
        recoverable: projection.recoverable,
        pendingApproval: projection.pendingApproval && !submittedApprovalIds.has(projection.pendingApproval.approvalId)
          ? { ...projection.pendingApproval }
          : undefined,
        activeSkills: projection.activeSkills.map(function copySkill(skill) { return { ...skill }; }),
        cancellationRequested: isTerminalStatus(projection.status) ? false : snapshot.cancellationRequested,
      };
      if (projection.turnId && isTerminalStatus(projection.status)) {
        finalizeTurn(projection.turnId, projection.status);
      }
      notifyListeners();
    },
    setCancellationRequested(requested: boolean): void {
      if (snapshot.cancellationRequested === requested) return;
      if (requested && snapshot.liveTurnId) {
        cancelledTurns.add(snapshot.liveTurnId);
        const events = snapshot.liveEvents.map(function cancel(event) { return event.type === "tui_input_consumed" && event.consumed === false ? { ...event, cancelled: true } : event; });
        eventsByTurn.set(snapshot.liveTurnId, events);
        snapshot = { ...snapshot, liveEvents: events, pendingInputs: [] };
      }
      publish({ ...snapshot, cancellationRequested: requested });
    },
    requestExit(code: CliExitCode): void {
      publish({ ...snapshot, requestedExitCode: code });
    },
  };
}
