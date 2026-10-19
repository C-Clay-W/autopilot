/** useTurnRecoveryActions.ts — cancel/queue/continue/approval/question 与 transport refresh 的连续逻辑；自原 page.tsx 原样迁入，不含新的业务判断。 */
"use client";

import { useRef, useEffect, useCallback } from "react";
import { reducePresentationInput, resolvePresentationApproval, restorePresentationApproval, type ApprovalItem, type UserQuestionItem } from "@autopilot-agent/presentation";
import { sessionApiUrl } from "../conversation-target";
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
  setInputDeliveryNotice: React.Dispatch<React.SetStateAction<import("../chat-page-types").InputDeliveryNotice | null>>;
  setResumePendingSessionId: (sessionId: string | null) => void;
  loadHistory: (sid: string, prefetchedData?: import("../chat-page-types").SessionHistoryPayload) => Promise<boolean>;
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
  transportDisconnectedRef: React.MutableRefObject<boolean>;
  awaitingApprovalRef: React.MutableRefObject<boolean>;
  awaitingUserInputRef: React.MutableRefObject<boolean>;
  pendingInputsRef: React.MutableRefObject<PendingAgentInput[]>;
  joinedInputIdsRef: React.MutableRefObject<Set<string>>;
  currentSessionIdRef: React.MutableRefObject<string>;
  currentWorkspaceIdRef: React.MutableRefObject<string>;
  queueExecutionRequestedRef: React.MutableRefObject<boolean>;
}

/** 共用传输地址解析；Chat 作用域永远不发送到 Work API。 */
const getWorkspaceSessionUrl = sessionApiUrl;

/** 承接原 ChatPageContent 的 Turn 恢复与排队启动逻辑；语句顺序、请求体与依赖数组保持不变。 */
export function useTurnRecoveryActions(options: UseTurnRecoveryActionsOptions) {
  const {
    isChat,
    workspaceId,
    sessionId,
    canWrite,
    messages,
    loading,
    activeTurnId,
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
    setInputDeliveryNotice,
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
    pendingInputsRef,
    joinedInputIdsRef,
    currentSessionIdRef,
    queueExecutionRequestedRef,
  } = options;
  const { manager, refreshSessions } = useSessionTaskContext();
  const notice = useNotice();
  const queueStartInFlightRef = useRef<Promise<void> | null>(null);
  const startNextQueuedTurnRef = useRef<(() => Promise<void>) | null>(null);

  /** 先请求服务端取消并等待 durable 收口，再断开本地 SSE；本地 UI 在点击时立即停止更新。 */
  const cancelCurrentTurn = useCallback(async function cancelCurrentTurn(): Promise<void> {
    if (cancelInFlightRef.current) return;
    const activeTurn = activeTurnRef.current;
    if (!activeTurn && !requestAbortRef.current) return;
    cancelRequestedRef.current = true;
    const requestAbortController = requestAbortRef.current;
    if (!activeTurn) {
      requestAbortController?.abort();
      setLoading(false);
      cancelRequestedRef.current = false;
      return;
    }
    cancelledTurnIdsRef.current.add(activeTurn.turnId);
    setPresentation(function cancelInputs(current) { return { ...current, items: current.items.map(function cancel(item) { return item.kind === "input_notice" && item.turnId === activeTurn.turnId && item.state === "queued" ? { ...item, cancelled: true } : item; }) }; });
    setMessages((previous) => previous.map((message) => (
      message.id === streamingMessageId || message.turnId === activeTurn?.turnId
        ? { ...message, content: "用户已取消", activity: undefined, processSteps: undefined, sources: undefined, canContinue: true }
        : message
    )));
    setActivity(undefined);
    setStreamingMessageId("");
    clearActiveTurn();
    // loading 只代表当前页面是否可继续交互；服务端收口由独立的 cancel Promise 负责。
    setLoading(false);
    const cancelPromise = (async function requestServerCancellation(): Promise<void> {
      try {
        const response = await fetch(getWorkspaceSessionUrl(workspaceId, activeTurn.sessionId, "/cancel")!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnId: activeTurn.turnId }),
        });
        console.log(response);
        if (response.ok) await loadHistory(activeTurn.sessionId);
        else notice.warning("任务尚未确认停止，已重新同步实际状态");
      } catch {
        // 本地已停止展示；服务端失败时保留取消 Turn 标记，避免迟到 SSE 再写回界面。
      } finally {
        void refreshSessions(workspaceId);
        requestAbortController?.abort();
        if (requestAbortRef.current === requestAbortController) requestAbortRef.current = null;
        cancelRequestedRef.current = false;
        cancelInFlightRef.current = null;
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

  /** 当前 turn 成功结束后领取一条 durable queue 输入，并沿用同一 Messages Route 的 Agent SSE。 */
  async function startNextQueuedTurnOnce(): Promise<void> {
    if (isChat || !canWrite) return;
    const sid = sessionId;
    /** 请求和所有收尾回调都必须仍归属原页面目标。 */
    function isCurrentQueueTarget(): boolean { return currentSessionIdRef.current === sid && options.currentWorkspaceIdRef.current === workspaceId; }
    if (!sid || !isCurrentQueueTarget() || activeTurnRef.current) return;
    let claimedTurnId: string | null = null;
    /** 旧 queue 只能结束自己的活动轮，不能清理同会话后来开始的另一轮。 */
    function ownsQueueLifecycle(): boolean { return isCurrentQueueTarget() && (!activeTurnRef.current || activeTurnRef.current.turnId === claimedTurnId); }
    setLoading(true);
    const assistantId = `queued-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setMessages((current) => [...current,
      { id: assistantId, role: "assistant", content: "", activity: "answer", processSteps: [{ stage: "prepare", message: "正在开始排队任务" }] },
    ]);
    try {
      const response = await fetch(getWorkspaceSessionUrl(workspaceId, sid, "/messages")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "start_next" }),
      });
      console.log(response);
      if (!isCurrentQueueTarget()) return;
      if (response.status === 204) {
        setMessages((current) => current.filter((message) => message.id !== assistantId));
        return;
      }
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({ error: "排队任务启动失败" }))).error || "排队任务启动失败");
      manager.beginSession(createWorkspaceSessionKey(workspaceId, sid));
      const claimedInputId = response.headers.get("X-Agent-Input-Id");
      claimedTurnId = response.headers.get("X-Agent-Turn-Id");
      if (claimedInputId) joinedInputIdsRef.current.add(claimedInputId);
      const nextInput = pendingInputsRef.current.find(function claimed(input) { return input.inputId === claimedInputId; });
      if (claimedInputId && claimedTurnId) setPresentation(function claimed(current) {
        if (!isCurrentQueueTarget()) return current;
        return reducePresentationInput(current, { kind: "host_event", event: { kind: "input", input: { inputId: claimedInputId, turnId: claimedTurnId!, delivery: nextInput?.delivery ?? "queue", content: nextInput?.content, state: "consumed", position: { turnId: claimedTurnId!, items: [], order: -1 } } } });
      });
      if (nextInput) pendingInputsRef.current = pendingInputsRef.current.filter((input) => input.inputId !== nextInput.inputId);
      if (nextInput) {
        const notice = { delivery: nextInput.delivery, content: nextInput.content, status: "started" as const };
        setInputDeliveryNotice(notice);
        window.setTimeout(function expireOwnNotice() { setInputDeliveryNotice(function expire(current) { return current === notice ? null : current; }); }, 6000);
      }
      setPendingInputs((current) => current.filter((input) => input.inputId !== claimedInputId));
      const streamOutcome = await consumeAgentStream(response, assistantId, sid);
      // 排队 Turn 终态明确或已校准时本地投影完整；只有流结束无终态才需要 History fallback。
      if (streamOutcome === "ended_without_terminal" && ownsQueueLifecycle()) void loadHistory(sid);
    } catch (error) {
      if (!isCurrentQueueTarget()) return;
      const disconnected = isTransportFailure(error);
      if (disconnected && ownsQueueLifecycle()) setTransportState("disconnected");
      setMessages((current) => current.map((message) => message.id === assistantId ? disconnected ? { ...message, activity: undefined } : { ...message, content: `排队任务失败：${error instanceof Error ? error.message : "未知错误"}`, activity: undefined } : message));
    } finally {
      if (ownsQueueLifecycle()) {
        setLoading(false);
        if (!awaitingApprovalRef.current && !awaitingUserInputRef.current && !transportDisconnectedRef.current) clearActiveTurn();
      }
    }
  }

  /** 同一页面只允许一个排队 Turn 启动请求，重复触发只复用在途 Promise。 */
  function requestNextQueuedTurn(): Promise<void> {
    const inFlight = queueStartInFlightRef.current;
    if (inFlight) return inFlight;
    const run = startNextQueuedTurnOnce();
    queueStartInFlightRef.current = run;
    void run.then(function clearQueueStartLock(): void {
      if (queueStartInFlightRef.current !== run) return;
      queueStartInFlightRef.current = null;
      if (queueExecutionRequestedRef.current) {
        queueExecutionRequestedRef.current = false;
        window.setTimeout(() => { void requestNextQueuedTurn(); }, 0);
      }
    }, function clearQueueStartLockAfterFailure(): void {
      if (queueStartInFlightRef.current !== run) return;
      queueStartInFlightRef.current = null;
    });
    return run;
  }

  startNextQueuedTurnRef.current = requestNextQueuedTurn;

  /** 页面恢复后继续处理未消费输入，避免完成事件已发生时遗留 steer/queue 永久停留。 */
  useEffect(function resumePendingAgentInputs() {
    if (!resumePendingSessionId) return;
    if (resumePendingSessionId !== sessionId) {
      setResumePendingSessionId(null);
      return;
    }
    if (loading || activeTurnId) return;
    setResumePendingSessionId(null);
    void startNextQueuedTurnRef.current?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖数组与原 page.tsx 一致；setResumePendingSessionId 为稳定 setter。
  }, [resumePendingSessionId, sessionId, loading, activeTurnId]);

  /** 任务达到最大执行步骤后直接调用 Continue Route，绝不以普通文本猜测恢复意图。 */
  async function handleContinueTurn(messageId: string): Promise<void> {
    if (isChat || !canWrite) return;
    const message = messages.find((item) => item.id === messageId);
    if (!sessionId || !message?.turnId) return;
    if (cancelInFlightRef.current) return;
    const turnId = message.turnId;
    cancelledTurnIdsRef.current.delete(turnId);
    const abortController = getSessionController(sessionId).createAbortController();
    requestAbortRef.current = abortController;
    cancelRequestedRef.current = false;
    activeTurnRef.current = { sessionId, turnId };
    setActiveTurnId(turnId);
    setLoading(true);
    setMessages((current) => current.map((item) => item.id === messageId ? { ...item, activity: "answer", canContinue: false } : item));
    try {
      const response = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/continue")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({ turnId }),
      });
      console.log(response);
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({ error: "恢复失败" }))).error || "恢复失败");
      manager.beginSession(createWorkspaceSessionKey(workspaceId, sessionId), turnId);
      const streamOutcome = await consumeAgentStream(response, messageId, sessionId);
      // Continue 的实时输出不依赖 History 请求；终态明确或已校准时直接收口。
      if (streamOutcome === "ended_without_terminal") void loadHistory(sessionId);
    } catch (error) {
      const cancelled = cancelRequestedRef.current || abortController.signal.aborted;
      const disconnected = isTransportFailure(error);
      if (disconnected && !cancelled) setTransportState("disconnected");
      setMessages((current) => current.map((item) => item.id === messageId ? cancelled
        ? { ...item, content: "用户已取消", activity: undefined, canContinue: true }
        : disconnected
          ? { ...item, activity: undefined }
          : { ...item, content: `恢复失败：${error instanceof Error ? error.message : "未知错误"}`, activity: undefined }
        : item));
    } finally {
      if (requestAbortRef.current === abortController) requestAbortRef.current = null;
      cancelRequestedRef.current = false;
      setLoading(false);
      if (!awaitingApprovalRef.current && !awaitingUserInputRef.current && !transportDisconnectedRef.current) clearActiveTurn();
    }
  }

  /** 提交冻结审批决定后用新 SSE 恢复同一 turn，浏览器从不重传工具参数。 */
  async function handleApproval(messageId: string, approval: ApprovalItem, decision: "allow_once" | "allow_session" | "allow_workspace" | "deny") {
    if (isChat || !canWrite) return;
    if (!sessionId) return;
    setPresentation((current) => resolvePresentationApproval(current, approval.approvalId));
    setLoading(true);
    activeTurnRef.current = { sessionId, turnId: approval.turnId };
    setActiveTurnId(approval.turnId);
    let approvalSubmitted = false;
    try {
      const approvalResponse = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/approvals")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId: approval.turnId, approvalId: approval.approvalId, decision }),
      });
      if (!approvalResponse.ok) throw new Error((await approvalResponse.json()).error || "提交审批失败");
      approvalSubmitted = true;
      const continueResponse = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/continue")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId: approval.turnId, approvalId: approval.approvalId }),
      });
      if (!continueResponse.ok || !continueResponse.body) throw new Error((await continueResponse.json().catch(() => ({ error: "恢复失败" }))).error || "恢复失败");
      awaitingApprovalRef.current = false;
      manager.beginSession(createWorkspaceSessionKey(workspaceId, sessionId), approval.turnId);
      const streamOutcome = await consumeAgentStream(continueResponse, messageId, sessionId);
      // 审批恢复先完成实时收尾；终态明确或已校准时不再额外请求完整 History。
      if (streamOutcome === "ended_without_terminal") void loadHistory(sessionId);
    } catch (error) {
      const disconnected = isTransportFailure(error);
      if (disconnected) setTransportState("disconnected");
      if (!approvalSubmitted && currentSessionIdRef.current === sessionId) {
        setPresentation((current) => restorePresentationApproval(current, approval.approvalId));
        awaitingApprovalRef.current = true;
        activeTurnRef.current = { sessionId, turnId: approval.turnId };
        setActiveTurnId(approval.turnId);
      }
      setMessages((prev) => prev.map((message) => message.id === messageId ? disconnected ? { ...message, activity: undefined } : { ...message, content: `审批恢复失败：${error instanceof Error ? error.message : "未知错误"}` } : message));
    } finally {
      setLoading(false);
      if (!awaitingApprovalRef.current && !awaitingUserInputRef.current && !transportDisconnectedRef.current) clearActiveTurn();
      textareaRef.current?.focus();
    }
  }

  /** 先持久化结构化答案，再只携带 requestId 从同一 Turn 的可信 Store 恢复 SSE。 */
  async function handleUserQuestion(messageId: string, question: UserQuestionItem, answers: UserQuestionAnswerDraft[]): Promise<void> {
    if (isChat || !canWrite) return;
    if (!sessionId || cancelInFlightRef.current) throw new Error("当前任务不可提交答案");
    const abortController = getSessionController(sessionId).createAbortController();
    requestAbortRef.current = abortController;
    cancelRequestedRef.current = false;
    activeTurnRef.current = { sessionId, turnId: question.turnId };
    setActiveTurnId(question.turnId);
    setLoading(true);
    try {
      const questionResponse = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/questions")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({ turnId: question.turnId, requestId: question.requestId, answers }),
      });
      console.log(questionResponse);
      if (!questionResponse.ok) throw new Error((await questionResponse.json().catch(() => ({ error: "提交回答失败" }))).error || "提交回答失败");
      const continueResponse = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/continue")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({ turnId: question.turnId, requestId: question.requestId }),
      });
      console.log(continueResponse);
      if (!continueResponse.ok || !continueResponse.body) throw new Error((await continueResponse.json().catch(() => ({ error: "恢复失败" }))).error || "恢复失败");
      awaitingUserInputRef.current = false;
      manager.beginSession(createWorkspaceSessionKey(workspaceId, sessionId), question.turnId);
      const streamOutcome = await consumeAgentStream(continueResponse, messageId, sessionId);
      // 结构化回答恢复先释放运行态；终态明确或已校准时不再额外请求完整 History。
      if (streamOutcome === "ended_without_terminal") void loadHistory(sessionId);
    } catch (error) {
      const cancelled = cancelRequestedRef.current || abortController.signal.aborted;
      const disconnected = isTransportFailure(error);
      if (disconnected && !cancelled) setTransportState("disconnected");
      if (!cancelled && currentSessionIdRef.current === sessionId) markAwaitingUserInput(sessionId, question.turnId);
      throw new Error(error instanceof Error ? error.message : "提交回答失败，请重试");
    } finally {
      if (requestAbortRef.current === abortController) requestAbortRef.current = null;
      cancelRequestedRef.current = false;
      setLoading(false);
      if (!awaitingApprovalRef.current && !awaitingUserInputRef.current && !transportDisconnectedRef.current) clearActiveTurn();
    }
  }

  /** 取消未消费输入；编辑和切换投递模式均先取消旧记录，再以新幂等键重新提交。 */
  async function cancelPendingInput(inputId: string): Promise<void> {
    if (!sessionId) return;
    try {
      const response = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/messages")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "cancel_input", inputId }),
      });
      console.log(response);
      if (!response.ok) return;
      setPendingInputs((current) => current.filter((input) => input.inputId !== inputId));
      pendingInputsRef.current = pendingInputsRef.current.filter(function other(input) { return input.inputId !== inputId; });
      setPresentation(function cancel(current) { return { ...current, items: current.items.map(function input(item) { return item.kind === "input_notice" && item.inputId === inputId ? { ...item, cancelled: true } : item; }) }; });
    } catch { /* 网络失败保留卡片，避免 UI 假报已删除。 */ }
  }

  /** 断连后只重放服务端已持久化状态，避免浏览器臆测 Runtime 是否失败。 */
  async function refreshTransport(): Promise<void> {
    if (!sessionId) return;
    setTransportState("reconnecting");
    const recovered = await loadHistory(sessionId);
    setTransportState(recovered ? "connected" : "disconnected");
  }

  return {
    cancelCurrentTurn,
    handleContinueTurn,
    handleApproval,
    handleUserQuestion,
    cancelPendingInput,
    refreshTransport,
    startNextQueuedTurnRef,
    requestNextQueuedTurn,
  };
}
