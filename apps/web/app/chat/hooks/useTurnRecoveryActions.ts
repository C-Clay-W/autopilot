/** Web Turn 的停止与重新观察，以及 Work 的排队和交互恢复。 */
"use client";

import { useRef, useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { resolvePresentationApproval, type ApprovalItem, type UserQuestionItem } from "@autopilot-agent/presentation";import { sessionApiUrl } from "../conversation-target";
import { useSessionTaskContext } from "../session-task-context";
import { createWorkspaceSessionKey } from "../session-task-store";
import { isTransportFailure } from "../chat-page-helpers";
import type { UserQuestionAnswerDraft } from "../components/AskUserQuestionCard";
import type { PendingAgentInput } from "../chat-page-types";
import { useNotice } from "../components/Notice";

interface UseTurnRecoveryActionsOptions {
  isChat: boolean;
  workspaceId: string;
  sessionId: string;
  canWrite: boolean;
  messages: import("../chat-page-types").Message[];
  loading: boolean;
  activeTurnId: string;
  chatObservation?: { turnId: string; cursor: number } | null;
  streamingMessageId: string;
  resumePendingSessionId: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setMessages: React.Dispatch<React.SetStateAction<import("../chat-page-types").Message[]>>;
  setLoading: (loading: boolean) => void;
  setActivity: React.Dispatch<React.SetStateAction<import("@/lib/runtime-host/web-activity").WebActivityState | undefined>>;
  setPresentation: React.Dispatch<React.SetStateAction<import("@autopilot-agent/presentation").AgentPresentationState>>;
  setStreamingMessageId: (streamingMessageId: string) => void;
  setActiveTurnId: (activeTurnId: string) => void;
  setPendingInputs: React.Dispatch<React.SetStateAction<PendingAgentInput[]>>;
  setResumePendingSessionId: (sessionId: string | null) => void;
  loadHistory: (sid: string, prefetchedData?: import("../chat-page-types").SessionHistoryPayload, observation?: boolean, signal?: AbortSignal) => Promise<boolean>;
  consumeAgentStream: (response: Response, messageId: string, sid: string) => Promise<import("../session-task-controller").SessionTaskStreamOutcome>;
  getSessionController: (sid: string) => import("../session-task-controller").SessionTaskController;
  setTransportState: (transport: import("@autopilot-agent/presentation").TransportState) => void;
  clearActiveTurn: () => void;
  markAwaitingUserInput: (sid: string, turnId: string) => void;
  activeTurnRef: React.MutableRefObject<{ sessionId: string; turnId: string } | null>;
  cancelRequestedRef: React.MutableRefObject<boolean>;
  cancelledTurnIdsRef: React.MutableRefObject<Set<string>>;
  cancelInFlightRef: React.MutableRefObject<Promise<void> | null>;
  requestAbortRef: React.MutableRefObject<AbortController | null>;
  chatStartPendingRef?: React.RefObject<boolean>;
  transportDisconnectedRef: React.MutableRefObject<boolean>;
  awaitingApprovalRef: React.MutableRefObject<boolean>;
  awaitingUserInputRef: React.MutableRefObject<boolean>;
  executionEpochRef: React.MutableRefObject<number>;
  executionFactRef?: React.MutableRefObject<{ epoch: number; turnId: string } | null>;
  pendingInputsRef: React.MutableRefObject<PendingAgentInput[]>;
  currentSessionIdRef: React.MutableRefObject<string>;
  currentWorkspaceIdRef: React.MutableRefObject<string>;
}

/** 共用传输地址解析；Chat 作用域永远不发送到 Work API。 */
const getWorkspaceSessionUrl = sessionApiUrl;

/** 取消确认的提示阈值；只报告未确认，不能中止尚未送达的取消命令。 */
const CANCEL_REQUEST_TIMEOUT_MS = 10_000;
/** 停止后的History补齐独立限时，超时取消本次读取并保留精确Turn复查结果。 */
const CANCEL_HISTORY_TIMEOUT_MS = 3_000;

/** 排队 Turn 的只读发现预算：宿主在上一轮收尾后立即领取，这里只覆盖领取与启动的短窗口。 */
const QUEUE_DISCOVERY_ATTEMPTS = 10;
const QUEUE_DISCOVERY_INTERVAL_MS = 400;

/** 仍需接观察流的持久 Turn 状态；其余状态视为已收尾，页面只补历史。 */
const QUEUE_LIVE_TURN_STATUSES = new Set(["running", "waiting_approval", "waiting_user_input"]);

/** 打开当前产品的只读 Turn 流；Chat 可从当前持久快照的游标接续。 */
async function openTurnStream(workspaceId: string, sid: string, turnId: string, signal?: AbortSignal, cursor?: number): Promise<Response> {
  const query = new URLSearchParams({ turnId });
  if (cursor !== undefined) query.set("cursor", String(cursor));
  const url = getWorkspaceSessionUrl(workspaceId, sid, `/stream?${query}`);
  return fetch(url!, { cache: "no-store", signal });
}

/** 协调所属会话的恢复与控制；Work 追加和 Chat 观察分别使用各自的请求边界。 */
export function useTurnRecoveryActions(options: UseTurnRecoveryActionsOptions) {
  const {
    isChat,
    workspaceId,
    sessionId,
    canWrite,
    messages,
    loading,
    activeTurnId,
    chatObservation,
    streamingMessageId,
    resumePendingSessionId,
    textareaRef,
    setMessages,
    setLoading,
    setActivity,
    setPresentation,
    setStreamingMessageId,
    setActiveTurnId,
    setPendingInputs,
    setResumePendingSessionId,
    loadHistory,
    consumeAgentStream,
    getSessionController,
    setTransportState,
    clearActiveTurn,
    markAwaitingUserInput,
    activeTurnRef,
    cancelRequestedRef,
    cancelledTurnIdsRef,
    cancelInFlightRef,
    requestAbortRef,
    transportDisconnectedRef,
    awaitingApprovalRef,
    awaitingUserInputRef,
    executionEpochRef,
    pendingInputsRef,
    currentSessionIdRef,
  } = options;
  const { manager, refreshSessions } = useSessionTaskContext();
  const notice = useNotice();
  /** 停止请求在途：UI 显示忙状态并禁用继续，避免服务端尚未确认停止时抢跑（H2）。 */
  const [stopping, setStopping] = useState(false);
  /** 继续请求单次锁：继续在途时忽略重复触发，避免双击或并发 /continue（P17 问题2）。 */
  const continueInFlightRef = useRef(false);
  /** 排队发现单次锁：同一页面只允许一个发现流程在途。 */
  const queueFollowInFlightRef = useRef<Promise<void> | null>(null);
  /** 当前工作区的侧栏快照；用于发现协作投递在页面之外启动的新 Turn。 */
  const sessionItems = useSyncExternalStore(manager.subscribeList, manager.getListSnapshot, manager.getListSnapshot);
  /** 已交给只读观察流程的外部 Turn；同一会话同一 Turn 只接管一次。 */
  const externallyObservedTurnRef = useRef<{ sessionId: string; turnId: string } | null>(null);
  const externalStreamAbortRef = useRef<AbortController | null>(null);
  const pendingInputCancellationRef = useRef(new Set<string>());
  /** 目录持久版本按精确目标去重；本地执行忙时不消费新版本，待执行段结束后补校准。 */
  const observedDirectoryRevisionRef = useRef<{ key: string; revision: string } | null>(null);

  /** 先请求服务端取消并等待 durable 收口，再断开本地 SSE；本地 UI 在点击时立即停止更新。 */
  const cancelCurrentTurn = useCallback(async function cancelCurrentTurn(): Promise<void> {
    if (cancelInFlightRef.current) return;
    const activeTurn = activeTurnRef.current;
    if (!activeTurn && !requestAbortRef.current) return;
    if (!activeTurn && options.chatStartPendingRef?.current) {
      cancelRequestedRef.current = true;
      return;
    }
    // 停止开启新的执行代次：被中止请求的 finally 不得再清理停止后建立的状态（H2）。
    executionEpochRef.current += 1;
    cancelRequestedRef.current = true;
    const requestAbortController = requestAbortRef.current;
    if (!activeTurn) {
      requestAbortController?.abort();
      setLoading(false);
      cancelRequestedRef.current = false;
      return;
    }
    cancelledTurnIdsRef.current.add(activeTurn.turnId);
    /** 用户已请求停止时收起本轮旧审批；最终恢复资格仍由权威History决定。 */
    function withdrawCancelledApprovals(): void {
      setPresentation(function cancelInputs(current) { return { ...current, items: current.items.map(function cancel(item) {
        if (item.kind === "input_notice" && item.turnId === activeTurn!.turnId && item.state === "queued") return { ...item, cancelled: true };
        if (item.kind === "approval" && item.turnId === activeTurn!.turnId && item.state === "required") return { ...item, state: "resolved" as const };
        return item;
      }) }; });
    }
    withdrawCancelledApprovals();
    setMessages((previous) => previous.map((message) => (
      message.id === streamingMessageId || message.turnId === activeTurn?.turnId
        ? { ...message, activity: undefined, canContinue: false, recoveryError: undefined, stopState: "requesting" as const }
        : message
    )));
    setActivity(undefined);
    setStreamingMessageId("");
    clearActiveTurn();
    // loading 只代表当前页面是否可继续交互；服务端收口由独立的 cancel Promise 负责。
    setLoading(false);
    setStopping(true);
    /** 当前停止结果只更新发起Session，切换页面后的迟到响应不污染新目标。 */
    function currentTarget(): boolean {
      return currentSessionIdRef.current === activeTurn!.sessionId && options.currentWorkspaceIdRef.current === workspaceId;
    }
    /** 请求超时只进入待确认；保留原请求继续送达，不撤销已经发出的停止意图。 */
    const request = fetch(getWorkspaceSessionUrl(workspaceId, activeTurn.sessionId, "/cancel")!, {
      method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
      body: JSON.stringify({ turnId: activeTurn.turnId }),
    }).then(function responseArrived(response) { console.log(response); return response; }).catch(function unavailable() { return undefined; });
    const cancelPromise = (async function requestServerCancellation(): Promise<void> {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([request, new Promise<void>(function hint(resolve) {
          timeoutId = setTimeout(resolve, CANCEL_REQUEST_TIMEOUT_MS);
        })]);
        if (timeoutId) clearTimeout(timeoutId);
        let confirmed = false;
        // 失败响应与提示阈值都不覆盖权威终态；每次复查有独立超时，总次数有界。
        for (const delay of [0, 300, 900, 1800]) {
          if (!currentTarget()) return;
          if (delay) await new Promise<void>(function wait(resolve) { setTimeout(resolve, delay); });
          try {
            const response = await fetch(getWorkspaceSessionUrl(workspaceId, activeTurn.sessionId, `/turn-state?turnId=${encodeURIComponent(activeTurn.turnId)}`)!, { cache: "no-store", signal: AbortSignal.timeout(3000) });
            console.log(response);
            const state = response.ok ? await response.json() as { turnId?: string; cancellation?: string } : undefined;
            if (state?.turnId === activeTurn.turnId && state.cancellation === "confirmed") { confirmed = true; break; }
          } catch { /* 本次复查不可得，仍保留待确认并在预算内重试。 */ }
        }
        if (!currentTarget()) return;
        // 原观察连接已可关闭，避免它的在途标志阻止这次权威History补齐。
        requestAbortController?.abort();
        if (requestAbortRef.current === requestAbortController) requestAbortRef.current = null;
        const historyController = new AbortController();
        let historyTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            loadHistory(activeTurn.sessionId, undefined, true, historyController.signal).catch(function unavailable() { return false; }),
            new Promise<void>(function historyBudget(resolve) {
              historyTimeout = setTimeout(function expired() { historyController.abort(); resolve(); }, CANCEL_HISTORY_TIMEOUT_MS);
            }),
          ]);
        } finally { if (historyTimeout) clearTimeout(historyTimeout); }
        if (!currentTarget()) return;
        setMessages(function cancellationStatus(previous) { return previous.map(function update(message) {
          return message.turnId === activeTurn.turnId || message.id === streamingMessageId
            ? { ...message, activity: undefined, recoveryError: undefined, stopState: confirmed ? "stopped" as const : "pending" as const, ...(!confirmed ? { canContinue: false } : {}) }
            : message;
        }); });
        if (confirmed) clearActiveTurn();
        else {
          withdrawCancelledApprovals();
          activeTurnRef.current = activeTurn;
          setActiveTurnId(activeTurn.turnId);
        }
        setLoading(false);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        void refreshSessions(workspaceId);
        requestAbortController?.abort();
        if (requestAbortRef.current === requestAbortController) requestAbortRef.current = null;
        cancelRequestedRef.current = false;
        cancelInFlightRef.current = null;
        setStopping(false);
      }
    })();
    cancelInFlightRef.current = cancelPromise;
    await cancelPromise;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖数组与原 page.tsx 一致；refs/setter 为稳定引用，不参与重建。
  }, [streamingMessageId, loadHistory, refreshSessions, workspaceId, notice]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (textareaRef.current?.closest("[hidden]")) return;
      if (event.key !== "Escape" || (!activeTurnRef.current && !requestAbortRef.current)) return;
      void cancelCurrentTurn();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖数组与原 page.tsx 一致；refs 为稳定引用不参与重建。
  }, [cancelCurrentTurn]);

  /** 目标仍归属当前页面会话与工作区；切换后到达的旧响应一律丢弃。 */
  function isCurrentQueueTarget(sid: string): boolean {
    return Boolean(sid) && currentSessionIdRef.current === sid && options.currentWorkspaceIdRef.current === workspaceId;
  }

  /** Chat 恢复只读取快照之后的事件；无终态断开时保留原 Turn，允许再次刷新。 */
  useEffect(function attachChatObservation() {
    if (!isChat || !canWrite || !sessionId || !chatObservation || requestAbortRef.current || cancelInFlightRef.current) return;
    const { turnId, cursor } = chatObservation;
    if (activeTurnRef.current?.turnId !== turnId || cancelledTurnIdsRef.current.has(turnId)) return;
    const observer = new AbortController();
    const epoch = executionEpochRef.current;
    requestAbortRef.current = observer;
    const assistantId = messages.find(function existing(message) { return message.role === "assistant" && message.turnId === turnId; })?.id ?? `agent-turn-${turnId}`;
    setStreamingMessageId(assistantId);
    setTransportState("reconnecting");
    void observe();

    /** 停止、导航和新执行都会使这个观察者不再拥有页面状态。 */
    function current(): boolean { return !observer.signal.aborted && executionEpochRef.current === epoch && isCurrentQueueTarget(sessionId); }

    /** 观察失败只更新连接状态，终态仍使用原 SSE 消费和 History 校准。 */
    async function observe(): Promise<void> {
      try {
        const response = await openTurnStream(workspaceId, sessionId, turnId, observer.signal, cursor);
        console.log(response);
        if (!current()) return;
        if (!response.ok) throw new Error("Chat 状态暂时不可读");
        setTransportState("connected");
        const outcome = await consumeAgentStream(response, assistantId, sessionId);
        if (!current()) return;
        if (outcome === "ended_without_terminal") setTransportState("disconnected");
        else setLoading(false);
      } catch {
        if (current()) setTransportState("disconnected");
      } finally {
        if (requestAbortRef.current === observer) requestAbortRef.current = null;
        if (current()) setStreamingMessageId("");
      }
    }

    /** 真实卸载或换目标时关闭 GET，不发停止命令。 */
    return function closeChatObserver(): void {
      observer.abort();
      if (requestAbortRef.current === observer) requestAbortRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在所属目标或完整恢复快照变化时重接，后续 delta 和保活切换不重开流。
  }, [isChat, canWrite, chatObservation, sessionId, workspaceId]);

  /** 读取当前 Session 的最新 Turn 身份与状态；只读入口，不领取输入也不启动 Turn。 */
  async function readLatestTurnState(sid: string, signal: AbortSignal): Promise<{ turnId: string | null; status: string | null } | null> {
    const url = getWorkspaceSessionUrl(workspaceId, sid, "/turn-state");
    if (!url) return null;
    try {
      const response = await fetch(url, { cache: "no-store", signal });
      console.log(response);
      if (!response.ok) return null;
      return await response.json() as { turnId: string | null; status: string | null };
    } catch {
      // 网络失败与目标切换都只结束本次发现；队列执行本身不受页面影响。
      return null;
    }
  }

  /** 接管宿主已启动的 Turn：复用既有观察流，只读事件，不启动也不取消。 */
  async function observeHostStartedTurn(sid: string, turnId: string): Promise<void> {
    const observer = new AbortController();
    externalStreamAbortRef.current?.abort();
    externalStreamAbortRef.current = observer;
    await loadHistory(sid, undefined, true);
    if (!isCurrentQueueTarget(sid) || observer.signal.aborted) return;
    const assistantId = `agent-turn-${turnId}`;
    setMessages((current) => current.some(function same(message) { return message.role === "assistant" && message.turnId === turnId; })
      ? current
      : [...current, { id: assistantId, role: "assistant", content: "", createdAt: current.find(function prompt(message) { return message.role === "user" && message.turnId === turnId; })?.createdAt, turnId, activity: "answer" }]);
    if (awaitingApprovalRef.current || awaitingUserInputRef.current) { setLoading(false); return; }
    manager.beginSession(createWorkspaceSessionKey(workspaceId, sid), turnId);
    activeTurnRef.current = { sessionId: sid, turnId };
    setActiveTurnId(turnId);
    setLoading(true);
    try {
      const response = await openTurnStream(workspaceId, sid, turnId, observer.signal);
      console.log(response);
      if (!isCurrentQueueTarget(sid) || observer.signal.aborted) return;
      const streamOutcome = await consumeAgentStream(response, assistantId, sid);
      // 流结束仍无终态时用持久历史校准；只补齐展示，不改执行。
      if (streamOutcome === "ended_without_terminal" && isCurrentQueueTarget(sid) && !observer.signal.aborted) void loadHistory(sid, undefined, true);
    } catch (error) {
      if (!observer.signal.aborted && isTransportFailure(error)) setTransportState("disconnected");
    } finally {
      if (isCurrentQueueTarget(sid) && !observer.signal.aborted && activeTurnRef.current?.turnId === turnId) {
        setLoading(false);
        if (!awaitingApprovalRef.current && !awaitingUserInputRef.current && !transportDisconnectedRef.current) clearActiveTurn();
      }
      // 仍有排队输入时继续只读跟随下一轮；单次锁在当前 promise 收尾后释放，故延后一拍。
      if (!observer.signal.aborted && pendingInputsRef.current.length && isCurrentQueueTarget(sid)) {
        window.setTimeout(function followNextQueuedTurn() { void requestFollowQueuedTurn(turnId); }, 0);
      }
    }
  }

  /**
   * 协作投递会在页面之外启动新 Turn：从 manager 快照拿到新 Turn 身份后交给既有只读观察流程，
   * 不调用 start/continue；同一活动Turn只接管一次，已结束的短Turn按目录版本只读补历史。
   */
  useEffect(function attachExternallyStartedTurn() {
    if (isChat || !canWrite || !sessionId) return;
    const item = sessionItems.find(function matchCurrentSession(entry) {
      return entry.workspaceId === workspaceId && entry.session.id === sessionId;
    });
    if (!item) return;
    // Session元数据优先；仅从同workspace/session快照读取合法的活动Turn回退。
    const turnId = item.session.activeTurnId ?? manager.getSessionSnapshot(createWorkspaceSessionKey(workspaceId, sessionId))?.activeTurnId;
    const key = createWorkspaceSessionKey(workspaceId, sessionId);
    const revision = JSON.stringify([item.session.updatedAt, item.session.runtimeStatus, turnId ?? null]);
    const previous = observedDirectoryRevisionRef.current;
    if (!previous || previous.key !== key) observedDirectoryRevisionRef.current = { key, revision };
    if (requestAbortRef.current) return;
    if (!turnId) {
      // ThreadStore的短run可能从未出现在running快照，也不在Inbox pending中；终态版本变化不能漏读。
      if (previous?.key === key && previous.revision !== revision && item.phase !== "running" && item.phase !== "starting") {
        observedDirectoryRevisionRef.current = { key, revision };
        externalStreamAbortRef.current?.abort();
        void loadHistory(sessionId, undefined, true);
      }
      return;
    }
    observedDirectoryRevisionRef.current = { key, revision };
    if (externallyObservedTurnRef.current?.sessionId === sessionId && externallyObservedTurnRef.current.turnId === turnId) return;
    if (activeTurnRef.current && activeTurnRef.current.turnId !== turnId && requestAbortRef.current) return;
    const isLive = item.phase === "running" || item.phase === "starting";
    const isWaiting = item.phase === "waiting_approval" || item.phase === "waiting_user_input";
    if (!isLive && !isWaiting) return;
    externallyObservedTurnRef.current = { sessionId, turnId };
    // 等待审批/回答只补权威历史；运行中的 Turn 才续接既有只读观察流。
    if (isWaiting) {
      externalStreamAbortRef.current?.abort();
      void loadHistory(sessionId, undefined, true);
      return;
    }
    void observeHostStartedTurn(sessionId, turnId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖只取触发身份；观察函数每次渲染重建，不参与依赖数组。
  }, [sessionItems, isChat, canWrite, sessionId, workspaceId, activeTurnId, loading]);

  /** 隐藏保活不卸载观察；真正更换固定Session身份或卸载时只关闭本页只读连接。 */
  useEffect(function disposeExternalObservation() {
    return function closeExternalStream() { externalStreamAbortRef.current?.abort(); };
  }, [sessionId, workspaceId]);

  /** 上一轮结束后有界只读发现宿主自动启动的排队 Turn；已收尾的短任务只补历史。 */
  async function followQueuedTurn(previousTurnId: string | null): Promise<void> {
    if (isChat || !canWrite) return;
    const sid = sessionId;
    if (!isCurrentQueueTarget(sid) || activeTurnRef.current) return;
    const controller = getSessionController(sid).createAbortController();
    let seenTurnId = previousTurnId;
    try {
      for (let attempt = 0; attempt < QUEUE_DISCOVERY_ATTEMPTS; attempt += 1) {
        if (!isCurrentQueueTarget(sid) || controller.signal.aborted) return;
        const state = await readLatestTurnState(sid, controller.signal);
        if (!isCurrentQueueTarget(sid)) return;
        if (state?.turnId && state.turnId !== seenTurnId) {
          seenTurnId = state.turnId;
          if (QUEUE_LIVE_TURN_STATUSES.has(state.status ?? "")) {
            await observeHostStartedTurn(sid, state.turnId);
            return;
          }
          // 两次轮询之间已启动并收尾：补齐 Prompt、结果与终态，再继续看是否还有下一条排队输入。
          await loadHistory(sid);
        }
        await new Promise<void>(function waitNextPoll(resolve) { window.setTimeout(resolve, QUEUE_DISCOVERY_INTERVAL_MS); });
      }
    } finally {
      controller.abort();
    }
  }

  /** 同一页面只允许一个排队发现流程，重复触发只复用在途 Promise。 */
  function requestFollowQueuedTurn(previousTurnId: string | null): Promise<void> {
    const inFlight = queueFollowInFlightRef.current;
    if (inFlight) return inFlight;
    const run = followQueuedTurn(previousTurnId);
    queueFollowInFlightRef.current = run;
    void run.then(clearQueueFollowLock, clearQueueFollowLock);
    return run;

    /** 发现流程结束后释放单次锁；旧流程不得清理后来接替的流程。 */
    function clearQueueFollowLock(): void {
      if (queueFollowInFlightRef.current === run) queueFollowInFlightRef.current = null;
    }
  }

  /** 页面恢复后重新校准：只读发现宿主已启动的排队 Turn，不再由页面领取或启动。 */
  useEffect(function resumeQueuedTurnObservation() {
    if (!resumePendingSessionId) return;
    if (resumePendingSessionId !== sessionId) {
      setResumePendingSessionId(null);
      return;
    }
    if (loading || activeTurnId) return;
    setResumePendingSessionId(null);
    void requestFollowQueuedTurn(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖数组与原 page.tsx 一致；setResumePendingSessionId 为稳定 setter。
  }, [resumePendingSessionId, sessionId, loading, activeTurnId]);

  /** 任务达到最大执行步骤后直接调用 Continue Route，绝不以普通文本猜测恢复意图。 */
  async function handleContinueTurn(messageId: string): Promise<void> {
    if (isChat || !canWrite) return;
    const message = messages.find((item) => item.id === messageId);
    if (!sessionId || !message?.turnId) return;
    if (message.stopState === "pending" || message.stopState === "requesting") { notice.warning("停止尚未确认，请先刷新状态或重试停止"); return; }
    if (cancelInFlightRef.current) {
      // 取消在途时不得抢跑，也不能静默丢弃用户动作（H2）。
      notice.warning("任务正在停止，请等待服务端确认后再继续");
      return;
    }
    if (continueInFlightRef.current) return;
    const turnId = message.turnId;
    const executionEpoch = executionEpochRef.current + 1;
    executionEpochRef.current = executionEpoch;
    continueInFlightRef.current = true;
    cancelledTurnIdsRef.current.delete(turnId);
    requestAbortRef.current?.abort();
    const abortController = getSessionController(sessionId).createAbortController();
    requestAbortRef.current = abortController;
    cancelRequestedRef.current = false;
    activeTurnRef.current = { sessionId, turnId };
    setActiveTurnId(turnId);
    setLoading(true);
    // 点击即进入恢复中投影：隐藏旧继续入口与旧停止提示；重新显示只能来自权威 History 或新可恢复终态（P17 问题2）。
    setMessages((current) => current.map((item) => item.id === messageId ? { ...item, activity: "answer", canContinue: false, termination: undefined, recoveryError: undefined, stopState: undefined } : item));
    let observing = false;
    try {
      const response = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/continue")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({ turnId, ...(message.questionRequestId ? { requestId: message.questionRequestId } : {}) }),
      });
      console.log(response);
      if (!response.ok) throw new Error((await response.json().catch(() => ({ error: "恢复失败" }))).error || "恢复失败");
      if (!currentInteraction(executionEpoch, turnId, abortController)) return;
      const accepted = await response.json().catch(function unavailable() { return {}; }) as { controlId?: string };
      if (!currentInteraction(executionEpoch, turnId, abortController)) return;
      awaitingApprovalRef.current = false;
      awaitingUserInputRef.current = false;
      if (accepted.controlId && !(options.executionFactRef?.current?.epoch === executionEpoch && options.executionFactRef.current.turnId === turnId)) {
        setLoading(false);
        setMessages(function waiting(current) { return current.map(function target(item) { return item.id === messageId ? { ...item, activity: undefined, canContinue: true, recoveryError: "决定或答案已保存，等待兼容宿主接手" } : item; }); });
      }
      observing = true;
      observeInteraction(messageId, turnId, executionEpoch, abortController);
    } catch (error) {
      if (executionEpochRef.current !== executionEpoch || currentSessionIdRef.current !== sessionId || options.currentWorkspaceIdRef.current !== workspaceId) return;
      const cancelled = cancelRequestedRef.current || abortController.signal.aborted;
      const disconnected = isTransportFailure(error);
      if (disconnected && !cancelled) setTransportState("disconnected");
      setMessages((current) => current.map((item) => item.id === messageId ? cancelled
        ? { ...item, content: "用户已取消", activity: undefined, canContinue: true, recoveryError: undefined }
        : disconnected
          ? { ...item, activity: undefined }
          : { ...item, activity: undefined, recoveryError: `恢复失败：${error instanceof Error ? error.message : "未知错误"}` }
        : item));
      // 恢复失败不乐观恢复可继续资格：由权威 History 确认仍可恢复才重新显示；读不到时只保留解释（P17 问题2）。
      if (!cancelled) {
        const synced = await loadHistory(sessionId);
        if (!currentInteraction(executionEpoch, turnId, abortController)) return;
        // History会替换消息容器；校准后再保留固定失败提示，不能让400/409解释随快照消失。
        setMessages(function showContinueFailure(current) {
          const target = current.find(function sameId(item) { return item.id === messageId; }) ?? current.find(function sameTurn(item) { return item.role === "assistant" && item.turnId === turnId; });
          return current.map(function explain(item) { return item.id === target?.id ? { ...item, ...(!synced ? { canContinue: false } : {}), recoveryError: synced ? "恢复请求未成功，已同步当前状态；请处理有效审批或稍后重试。" : "无法确认任务当前状态，请刷新后重试" } : item; });
        });
      }
    } finally {
      if (!observing && requestAbortRef.current === abortController) requestAbortRef.current = null;
      continueInFlightRef.current = false;
      // 旧继续请求的收尾只能清理自己认领的执行段，不覆盖后来续接的 loading/active（H2）。
      if (!observing && currentInteraction(executionEpoch, turnId, abortController)) {
        cancelRequestedRef.current = false;
        setLoading(false);
        if (!awaitingApprovalRef.current && !awaitingUserInputRef.current && !transportDisconnectedRef.current) clearActiveTurn();
      }
    }
  }

  const interactionInFlightRef = useRef<string | null>(null);
  const savedQuestionRef = useRef<string | null>(null);

  /** 精确代次与目标仍有效时才提交界面更新，旧观察不会清理后续问题。 */
  function currentInteraction(epoch: number, turnId: string, controller?: AbortController): boolean {
    return currentSessionIdRef.current === sessionId && options.currentWorkspaceIdRef.current === workspaceId && executionEpochRef.current === epoch && !cancelledTurnIdsRef.current.has(turnId) && !controller?.signal.aborted;
  }

  /** 继续已接受后交给既有Session流消费者，提交Promise不等待运行段结束。 */
  function observeInteraction(messageId: string, turnId: string, epoch: number, controller: AbortController): void {
    async function observe(): Promise<void> {
      try {
        const response = await openTurnStream(workspaceId, sessionId, turnId, controller.signal);
        console.log(response);
        if (!currentInteraction(epoch, turnId, controller)) return;
        if (!response.ok) throw new Error("INTERACTION_OBSERVATION_FAILED");
        const outcome = await consumeAgentStream(response, messageId, sessionId);
        if (outcome === "ended_without_terminal" && currentInteraction(epoch, turnId, controller)) await loadHistory(sessionId, undefined, true);
      } catch (error) {
        if (!currentInteraction(epoch, turnId, controller)) return;
        if (isTransportFailure(error)) setTransportState("disconnected");
        setMessages(function failed(current) { return current.map(function target(item) { return item.id === messageId ? { ...item, activity: undefined, canContinue: true, recoveryError: "决定或答案已保存，观察连接中断，请刷新原任务后重试" } : item; }); });
      } finally {
        if (requestAbortRef.current === controller) requestAbortRef.current = null;
        if (currentInteraction(epoch, turnId, controller)) {
          setLoading(false);
          if (!awaitingApprovalRef.current && !awaitingUserInputRef.current && !transportDisconnectedRef.current) clearActiveTurn();
        }
      }
    }
    observe().catch(function reportUnexpectedObservationFailure() {
      if (currentInteraction(epoch, turnId, controller)) {
        setTransportState("disconnected");
        setLoading(false);
        setMessages(function failed(current) { return current.map(function target(item) { return item.id === messageId ? { ...item, activity: undefined, canContinue: true, recoveryError: "无法确认观察结果，请刷新原任务" } : item; }); });
      }
    });
  }

  /** 提交冻结审批决定后用新 SSE 恢复同一 turn，浏览器从不重传工具参数。 */
  async function handleApproval(messageId: string, approval: ApprovalItem, decision: "allow_once" | "allow_session" | "allow_workspace" | "deny") {
    if (isChat || !canWrite || interactionInFlightRef.current || cancelledTurnIdsRef.current.has(approval.turnId) || currentSessionIdRef.current !== sessionId || options.currentWorkspaceIdRef.current !== workspaceId) return;
    if (cancelInFlightRef.current) { notice.warning("任务正在停止，请等待服务端确认后再审批"); return; }
    if (!sessionId || !awaitingApprovalRef.current || activeTurnRef.current?.sessionId !== sessionId || activeTurnRef.current?.turnId !== approval.turnId) return;
    const interactionKey = JSON.stringify([sessionId, approval.turnId, approval.approvalId]);
    interactionInFlightRef.current = interactionKey;
    externalStreamAbortRef.current?.abort();
    const executionEpoch = executionEpochRef.current + 1;
    executionEpochRef.current = executionEpoch;
    setPresentation((current) => resolvePresentationApproval(current, approval.approvalId));
    setLoading(true);
    activeTurnRef.current = { sessionId, turnId: approval.turnId };
    setActiveTurnId(approval.turnId);
    let approvalSubmitted = false;
    let observing = false;
    const abortController = getSessionController(sessionId).createAbortController();
    requestAbortRef.current = abortController;
    try {
      const approvalResponse = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/approvals")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({ turnId: approval.turnId, approvalId: approval.approvalId, decision }),
      });
      console.log(approvalResponse);
      if (!approvalResponse.ok) throw new Error((await approvalResponse.json()).error || "提交审批失败");
      approvalSubmitted = true;
      const continueResponse = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/continue")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({ turnId: approval.turnId, approvalId: approval.approvalId }),
      });
      console.log(continueResponse);
      if (!continueResponse.ok) throw new Error((await continueResponse.json().catch(() => ({ error: "恢复失败" }))).error || "恢复失败");
      if (!currentInteraction(executionEpoch, approval.turnId, abortController)) return;
      const accepted = await continueResponse.json().catch(function unavailable() { return {}; }) as { controlId?: string };
      if (!currentInteraction(executionEpoch, approval.turnId, abortController)) return;
      awaitingApprovalRef.current = false;
      if (accepted.controlId && !(options.executionFactRef?.current?.epoch === executionEpoch && options.executionFactRef.current.turnId === approval.turnId)) {
        setLoading(false);
        setMessages(function waiting(current) { return current.map(function target(item) { return item.id === messageId ? { ...item, activity: undefined, canContinue: true, recoveryError: "审批决定已保存，等待兼容宿主接手" } : item; }); });
      }
      observing = true;
      observeInteraction(messageId, approval.turnId, executionEpoch, abortController);
    } catch (error) {
      if (!currentInteraction(executionEpoch, approval.turnId, abortController)) return;
      const disconnected = isTransportFailure(error);
      if (disconnected) setTransportState("disconnected");
      if (!approvalSubmitted && currentSessionIdRef.current === sessionId) {
        // 失败/过期审批只从权威 History 校准；读失败时也不复活旧卡。
        awaitingApprovalRef.current = false;
        await loadHistory(sessionId);
        if (!currentInteraction(executionEpoch, approval.turnId, abortController)) return;
      }
      setMessages((prev) => prev.map((message) => message.id === messageId ? { ...message, activity: undefined, canContinue: approvalSubmitted, recoveryError: approvalSubmitted ? "审批决定已保存，继续失败，请重试原决定" : `审批提交失败：${error instanceof Error ? error.message : "未知错误"}` } : message));
    } finally {
      if (interactionInFlightRef.current === interactionKey) interactionInFlightRef.current = null;
      if (!observing && requestAbortRef.current === abortController) requestAbortRef.current = null;
      if (!observing && currentInteraction(executionEpoch, approval.turnId, abortController)) {
        setLoading(false);
        if (!awaitingApprovalRef.current && !awaitingUserInputRef.current && !transportDisconnectedRef.current) clearActiveTurn();
      }
      textareaRef.current?.focus();
    }
  }

  /** 答案保存后结束编辑，继续接受后独立观察；原请求重试只继续已存答案。 */
  async function handleUserQuestion(messageId: string, question: UserQuestionItem, answers: UserQuestionAnswerDraft[]): Promise<void> {
    if (isChat || !canWrite) return;
    if (!sessionId || cancelInFlightRef.current || interactionInFlightRef.current || cancelledTurnIdsRef.current.has(question.turnId) || currentSessionIdRef.current !== sessionId || options.currentWorkspaceIdRef.current !== workspaceId) throw new Error("当前任务不可提交答案");
    const interactionKey = JSON.stringify([workspaceId, sessionId, question.turnId, question.requestId]);
    interactionInFlightRef.current = interactionKey;
    const executionEpoch = executionEpochRef.current + 1;
    executionEpochRef.current = executionEpoch;
    const abortController = getSessionController(sessionId).createAbortController();
    requestAbortRef.current = abortController;
    cancelRequestedRef.current = false;
    activeTurnRef.current = { sessionId, turnId: question.turnId };
    setActiveTurnId(question.turnId);
    setLoading(true);
    let saved = savedQuestionRef.current === interactionKey || question.state === "answered";
    let observing = false;
    try {
      if (!saved) {
        const questionResponse = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/questions")!, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: abortController.signal,
          body: JSON.stringify({ turnId: question.turnId, requestId: question.requestId, answers }),
        });
        console.log(questionResponse);
        if (!questionResponse.ok) throw new Error((await questionResponse.json().catch(() => ({ error: "提交回答失败" }))).error || "提交回答失败");
        saved = true;
        savedQuestionRef.current = interactionKey;
      }
      if (currentInteraction(executionEpoch, question.turnId, abortController)) {
        setPresentation(function savedQuestion(current) { return { ...current, items: current.items.map(function exact(item) { return item.kind === "user_question" && item.turnId === question.turnId && item.requestId === question.requestId ? { ...item, state: "answered" as const } : item; }) }; });
        setMessages(function savedQuestion(current) { return current.map(function exact(item) { return item.id === messageId ? { ...item, questionRequestId: question.requestId, recoveryError: undefined } : item; }); });
      }
      if (executionEpochRef.current !== executionEpoch || cancelledTurnIdsRef.current.has(question.turnId) || abortController.signal.aborted) return;
      const continueResponse = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/continue")!, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: abortController.signal,
        body: JSON.stringify({ turnId: question.turnId, requestId: question.requestId }),
      });
      console.log(continueResponse);
      if (!continueResponse.ok) throw new Error((await continueResponse.json().catch(() => ({ error: "恢复失败" }))).error || "恢复失败");
      if (!currentInteraction(executionEpoch, question.turnId, abortController)) return;
      const accepted = await continueResponse.json().catch(function unavailable() { return {}; }) as { controlId?: string };
      if (!currentInteraction(executionEpoch, question.turnId, abortController)) return;
      awaitingUserInputRef.current = false;
      if (accepted.controlId && !(options.executionFactRef?.current?.epoch === executionEpoch && options.executionFactRef.current.turnId === question.turnId)) {
        setLoading(false);
        setMessages(function waiting(current) { return current.map(function target(item) { return item.id === messageId ? { ...item, activity: undefined, canContinue: true, recoveryError: "答案已保存，等待兼容宿主接手" } : item; }); });
      }
      observing = true;
      observeInteraction(messageId, question.turnId, executionEpoch, abortController);
    } catch (error) {
      if (currentInteraction(executionEpoch, question.turnId, abortController)) {
        if (isTransportFailure(error)) setTransportState("disconnected");
        markAwaitingUserInput(sessionId, question.turnId);
        if (saved) setMessages(function savedFailure(current) { return current.map(function exact(item) { return item.id === messageId ? { ...item, activity: undefined, questionRequestId: question.requestId, canContinue: true, recoveryError: "答案已保存，继续请求失败，请重试原请求" } : item; }); });
        else await loadHistory(sessionId, undefined, true);
      }
      if (currentInteraction(executionEpoch, question.turnId, abortController)) throw new Error(saved ? "答案已保存，继续失败，请重试原请求" : error instanceof Error ? error.message : "提交回答失败，请重试");
    } finally {
      if (interactionInFlightRef.current === interactionKey) interactionInFlightRef.current = null;
      if (!observing && requestAbortRef.current === abortController) requestAbortRef.current = null;
      if (!observing && currentInteraction(executionEpoch, question.turnId, abortController)) {
        cancelRequestedRef.current = false;
        setLoading(false);
      }
    }
  }

  /** Work 仅在服务端确认后允许编辑/切换；失败只对账目标输入，避免覆盖并发排队结果。 */
  async function cancelPendingInput(inputId: string): Promise<boolean> {
    const url = getWorkspaceSessionUrl(workspaceId, sessionId);
    const inFlight = pendingInputCancellationRef.current;
    if (isChat || !canWrite || !url || !isCurrentQueueTarget(sessionId) || inFlight.has(inputId)) return false;
    inFlight.add(inputId);
    let confirmed = false;
    let conflict = false;
    try {
      const response = await fetch(`${url}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "cancel_input", inputId }),
        signal: AbortSignal.timeout(5000),
      });
      conflict = response.status === 409;
      confirmed = response.ok && (await response.json()).cancelled === true;
    } catch { /* 状态未确认，进入同一持久列表对账。 */ }
    try {
      if (!isCurrentQueueTarget(sessionId)) return false;
      if (confirmed) {
        removePendingInput();
        setPresentation(function cancel(current) { return { ...current, items: current.items.map(function input(item) { return item.kind === "input_notice" && item.inputId === inputId ? { ...item, cancelled: true } : item; }) }; });
        return true;
      }
      notice.warning(conflict ? "该输入已不再可取消，请核对会话记录" : "未确认取消，请核对等待输入后再试");
      try {
        const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
        console.log(res);
        const snapshot = res.ok ? await res.json() : undefined;
        const pending = snapshot?.pendingInputs;
        if (isCurrentQueueTarget(sessionId) && Array.isArray(pending) && !pending.some(function same(input) { return input.inputId === inputId; })) removePendingInput();
      } catch { /* 对账不可用时保留原卡，供用户重试。 */ }
      return false;
    } finally { inFlight.delete(inputId); }

    /** 只移除当前操作的输入，保留流或并发 202 新登记的其余输入。 */
    function removePendingInput(): void {
      setPendingInputs(function remove(current) { return current.filter(function other(input) { return input.inputId !== inputId; }); });
      pendingInputsRef.current = pendingInputsRef.current.filter(function other(input) { return input.inputId !== inputId; });
    }
  }

  /** 断连后只重放服务端已持久化状态，避免浏览器臆测 Runtime 是否失败。 */
  async function refreshTransport(): Promise<void> {
    if (!sessionId || (isChat && requestAbortRef.current)) return;
    setTransportState("reconnecting");
    const recovered = await loadHistory(sessionId);
    setTransportState(recovered ? "connected" : "disconnected");
  }

  /** 浏览器恢复联网后，Chat 使用同一个只读快照入口重新观察原 Turn。 */
  useEffect(function recoverChatOnOnline() {
    if (!isChat || !sessionId) return;
    function refreshAfterOffline(): void { if (transportDisconnectedRef.current) void refreshTransport(); }
    window.addEventListener("online", refreshAfterOffline);
    return function removeOnlineListener() { window.removeEventListener("online", refreshAfterOffline); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 请求函数绑定本会话；最新断连事实从 ref 获取。
  }, [isChat, sessionId, workspaceId]);

  return {
    stopping,
    cancelCurrentTurn,
    handleContinueTurn,
    handleApproval,
    handleUserQuestion,
    cancelPendingInput,
    refreshTransport,
    requestFollowQueuedTurn,
  };
}
