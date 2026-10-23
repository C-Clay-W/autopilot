/** useSessionConversation.ts — 单 Session 的 History/Presentation/Activity/SSE 投影与 Turn 生命周期状态；History 瞬时失败按会话归属保留实时内容，其余逻辑自原 page.tsx 原样迁入。 */
"use client";

import { useState, useRef, useEffect, useCallback, type Dispatch, type SetStateAction } from "react";
import { createPresentationState, type AgentPresentationState, type TransportState } from "@autopilot-agent/presentation";
import { reduceWebActivityState, type WebActivityState } from "@/lib/runtime-host/web-activity";
import { reduceWebPresentationEvent, reduceWebTransportEvent } from "@/lib/runtime-host/web-presentation-adapter";
import { isWebTurnFailure, toWebTurnFailure } from "@/lib/runtime-host/web-turn-failure";
import { sessionApiUrl } from "../conversation-target";
import { mapHistoryMessage, shouldRetryHistoryFailure, type HistoryErrorPhase } from "../history-restore";
import type {
  WebSessionDto as SessionMeta,
  WebSessionPinnedSkill as SessionPinnedSkill,
} from "@/lib/runtime-host/web-ui-dto";
import { createSessionTaskController, hasDurableTerminalTurn, type SessionTaskController, type SessionTaskStreamOutcome } from "../session-task-controller";
import { useSessionTaskContext } from "../session-task-context";
import { createWorkspaceSessionKey } from "../session-task-store";
import { mergeHistoryIntoChatMessages } from "../chat-message-state";
import { createWebPresentationFrameBatcher, isWebPresentationDelta, type WebPresentationFrameBatcher } from "../web-presentation-frame-batcher";
import type {
  Message,
  SessionAgentState,
  PendingAgentInput,
  SessionHistoryPayload,
  ChatAttachmentView,
  InputDeliveryNotice,
  ContextUsageView,
  SelectedSkill,
} from "../chat-page-types";

/** History 加载失败信息；phase 按请求阶段区分（fetch 拒绝/HTTP/JSON 解码/映射应用），manualRetry 决定是否显示手动重试按钮。 */
type HistoryErrorState = { phase: HistoryErrorPhase; status?: number; message: string; manualRetry: boolean };

/** 标记 History 请求失败阶段的内部错误；日志按阶段区分，UI 仍显示统一安全文案。 */
class HistoryStageError extends Error {
  readonly stage: "fetch" | "json";

  constructor(stage: "fetch" | "json") {
    super(stage);
    this.stage = stage;
  }
}

/** 首次 History 恢复失败的自动重试上限；返回会话时自动再次获取历史，不让用户手动恢复。 */
const MAX_HISTORY_AUTO_RETRY = 3;

interface UseSessionConversationOptions {
  workspaceId: string;
  sessionId: string;
  isChat: boolean;
  notifyNewProgress: () => void;
  setSelectedSkills: Dispatch<SetStateAction<SelectedSkill[]>>;
  setPinnedSkills: Dispatch<SetStateAction<SessionPinnedSkill[]>>;
}

/** 共用传输地址解析；Chat 作用域永远不发送到 Work API。 */
const getWorkspaceSessionUrl = sessionApiUrl;

/** 承接原 ChatPageContent 的 History/SSE/Turn 生命周期逻辑；语句顺序、请求体与依赖数组保持不变。 */
export function useSessionConversation({ workspaceId, sessionId, isChat, notifyNewProgress, setSelectedSkills, setPinnedSkills }: UseSessionConversationOptions) {
  const { manager } = useSessionTaskContext();
  const [messages, setMessages] = useState<Message[]>([]);
  const [presentation, setPresentation] = useState<AgentPresentationState>(createPresentationState);
  const [activity, setActivity] = useState<WebActivityState | undefined>();
  const [loading, setLoading] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState("");
  const [activeTurnId, setActiveTurnId] = useState("");
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const [readOnlyReason, setReadOnlyReason] = useState<string | undefined>();
  const [historyReady, setHistoryReady] = useState(!sessionId);
  const [historyError, setHistoryError] = useState<HistoryErrorState | null>(null);
  const [chatAttachments, setChatAttachments] = useState<ChatAttachmentView[]>([]);
  const [pendingInputs, setPendingInputs] = useState<PendingAgentInput[]>([]);
  const [inputDeliveryNotice, setInputDeliveryNotice] = useState<InputDeliveryNotice | null>(null);
  const [resumePendingSessionId, setResumePendingSessionId] = useState<string | null>(null);
  /** Core 最新安全 Context Usage 快照；undefined 表示无可用展示事实，绝不表现为 0%。 */
  const [contextUsage, setContextUsage] = useState<ContextUsageView | undefined>();
  /** 当前 URL 选中的 Session；旧 Session 的异步 SSE/History 不能回写新 Session。 */
  const currentSessionIdRef = useRef(sessionId);
  // eslint-disable-next-line react-hooks/refs -- 模式自原 page.tsx 原样迁入：每次渲染同步刷新 Session 身份，供异步回调读取最新值。
  currentSessionIdRef.current = sessionId;
  const streamingMessageIdRef = useRef("");
  useEffect(function syncStreamingMessageIdRef() {
    streamingMessageIdRef.current = streamingMessageId;
  }, [streamingMessageId]);
  /** 当前 URL 工作区；异步 History/SSE 只能回写其创建时绑定的 workspace。 */
  const currentWorkspaceIdRef = useRef(workspaceId);
  // eslint-disable-next-line react-hooks/refs -- 模式自原 page.tsx 原样迁入：每次渲染同步刷新工作区身份。
  currentWorkspaceIdRef.current = workspaceId;
  /** 当前 Session Meta 归属的会话 id；History 失败时用于区分“同会话瞬时刷新”与“切换会话首次加载”。 */
  const sessionMetaIdRef = useRef<string | null>(null);
  // eslint-disable-next-line react-hooks/refs -- 与 currentSessionIdRef 相同模式：每次渲染同步，供异步 History 回调读取最新归属。
  sessionMetaIdRef.current = sessionMeta?.id ?? null;
  const requestAbortRef = useRef<AbortController | null>(null);
  /** 首次创建 Session 期间禁止 URL 变化触发的空 History 覆盖本地实时消息。 */
  const locallyCreatedSessionRef = useRef<string | null>(null);
  const pendingInputsRef = useRef<PendingAgentInput[]>([]);
  /** 历史请求序号；只允许最后一次 loadHistory 覆盖当前聊天，避免审批与引导请求乱序回写。 */
  const sessionControllersRef = useRef<Map<string, SessionTaskController>>(new Map());
  /** 记录已在 SSE 安全边界合并的输入，避免 SSE 先到、202 确认后到时把它重新显示为等待。 */
  const joinedInputIdsRef = useRef<Set<string>>(new Set());
  /** History 已显示普通用户气泡的 queue 身份，避免晚到确认再补正文。 */
  const historyInputIdsRef = useRef<Set<string>>(new Set());
  /** 首次 History 恢复失败的自动重试计数；按会话键控，进入会话时重置预算。 */
  const historyAutoRetryRef = useRef<{ sid: string; count: number } | null>(null);
  const activeTurnRef = useRef<{ sessionId: string; turnId: string } | null>(null);
  const cancelRequestedRef = useRef(false);
  /** 记录已点击取消的 Turn，屏蔽其在服务端收口前迟到的 SSE。 */
  const cancelledTurnIdsRef = useRef<Set<string>>(new Set());
  /** 服务端取消请求在途时阻止用户立即启动下一 Turn，避免取消与新任务竞争同一 Session。 */
  const cancelInFlightRef = useRef<Promise<void> | null>(null);
  const transportDisconnectedRef = useRef(false);
  const awaitingApprovalRef = useRef(false);
  const awaitingUserInputRef = useRef(false);
  /** 执行代次：开始/停止/继续各自认领一段执行，旧请求的 finally 只能清理自己的执行段（H2）。 */
  const executionEpochRef = useRef(0);
  const queueExecutionRequestedRef = useRef(false);
  const presentationFrameBatcherRef = useRef<WebPresentationFrameBatcher | null>(null);
  const presentationFrameBatcherKeyRef = useRef("");

  /** 返回永久绑定目标 Session 的 controller，绝不以当前 URL 选择事件写入目标。 */
  function getSessionController(sid: string): SessionTaskController {
    const controllerKey = createWorkspaceSessionKey(workspaceId || "unselected", sid || "draft");
    const existing = sessionControllersRef.current.get(controllerKey);
    if (existing) return existing;
    const controller = createSessionTaskController(controllerKey, function applyTargetEvent(messageId, data) {
      // eslint-disable-next-line react-hooks/immutability -- function 声明提升与原 page.tsx 保持一致：controller 回调绑定同 Hook 内后置声明的 SSE 投影函数。
      applyAgentStreamEvent(messageId, sid, data);
    });
    sessionControllersRef.current.set(controllerKey, controller);
    return controller;
  }

  /** 将浏览器连接状态作为 Host 状态保存，绝不把断连误写为 Runtime 失败。 */
  function setTransportState(transport: TransportState): void {
    transportDisconnectedRef.current = transport === "disconnected";
    setPresentation((current) => current.transport === transport ? current : reduceWebTransportEvent(current, transport));
  }

  /** Keep a paused turn cancellable even though its original SSE request has already closed. */
  function markAwaitingApproval(sid: string, turnId: string): void {
    awaitingApprovalRef.current = true;
    activeTurnRef.current = { sessionId: sid, turnId };
    setActiveTurnId(turnId);
  }

  /** 保持等待结构化回答的 Turn 可取消，原始 SSE 已正常结束也不释放控制权。 */
  function markAwaitingUserInput(sid: string, turnId: string): void {
    awaitingUserInputRef.current = true;
    activeTurnRef.current = { sessionId: sid, turnId };
    setActiveTurnId(turnId);
  }

  /** Clear local controls only after a terminal event or a non-paused history reload. */
  function clearActiveTurn(): void {
    awaitingApprovalRef.current = false;
    awaitingUserInputRef.current = false;
    activeTurnRef.current = null;
    setActiveTurnId("");
  }

  /** 从等待输入列表移除已被当前 turn 接收的引导，并显示一次开始执行提示。 */
  function removeConsumedPendingInput(inputId: string): void {
    joinedInputIdsRef.current.add(inputId);
    const joinedInput = pendingInputsRef.current.find((input) => input.inputId === inputId);
    pendingInputsRef.current = pendingInputsRef.current.filter((input) => input.inputId !== inputId);
    setPendingInputs((current) => current.filter((input) => input.inputId !== inputId));
    if (joinedInput) {
      const notice = { delivery: joinedInput.delivery, content: joinedInput.content, status: "started" as const };
      setInputDeliveryNotice(notice);
      window.setTimeout(function expireOwnNotice() { setInputDeliveryNotice(function expire(current) { return current === notice ? null : current; }); }, 6000);
    }
  }

  /** 将同一帧内的连续 delta 按到达顺序一次性交给 Activity 与 Presentation reducer。 */
  function applyPresentationDeltaFrame(events: Array<Record<string, unknown>>): void {
    const targetSessionId = currentSessionIdRef.current;
    if (!targetSessionId || events.length === 0) return;
    const turnId = events[events.length - 1]?.turnId;
    if (typeof turnId !== "string") return;
    activeTurnRef.current = { sessionId: targetSessionId, turnId };
    setActiveTurnId(turnId);
    notifyNewProgress();
    setTransportState("connected");
    setMessages((current) => {
      let changed = false;
      const next = current.map((message) => {
        if (message.id !== streamingMessageIdRef.current || (message.turnId === turnId && message.activity === "answer")) return message;
        changed = true;
        return { ...message, turnId, activity: "answer" as const };
      });
      return changed ? next : current;
    });
    setActivity((current) => events.reduce((state, event) => reduceWebActivityState(state, event), current));
    setPresentation((current) => events.reduce((state, event) => reduceWebPresentationEvent(state, event, targetSessionId), current));
  }

  /** 创建浏览器帧调度器；测试和非可视环境使用定时器回退。 */
  function getPresentationFrameBatcher(): WebPresentationFrameBatcher {
    const batcherKey = `${workspaceId}:${sessionId}`;
    if (presentationFrameBatcherRef.current && presentationFrameBatcherKeyRef.current === batcherKey) return presentationFrameBatcherRef.current;
    presentationFrameBatcherRef.current?.cancel();
    presentationFrameBatcherKeyRef.current = batcherKey;
    presentationFrameBatcherRef.current = createWebPresentationFrameBatcher({
      onFlush: applyPresentationDeltaFrame,
      schedule: function scheduleFrame(callback) {
        if (typeof window.requestAnimationFrame === "function") return { kind: "raf", id: window.requestAnimationFrame(callback) };
        return { kind: "timeout", id: window.setTimeout(callback, 16) };
      },
      cancelSchedule: function cancelFrame(handle) {
        if (!handle || typeof handle !== "object") return;
        const scheduled = handle as { kind?: string; id?: number };
        if (typeof scheduled.id !== "number") return;
        if (scheduled.kind === "raf" && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(scheduled.id);
        else window.clearTimeout(scheduled.id);
      },
    });
    return presentationFrameBatcherRef.current;
  }

  /** 首次 History 恢复失败时安排有界自动重试；返回 true 表示已调度本次重试，调用方不得覆盖成终态错误提示。 */
  function scheduleHistoryAutoRetry(sid: string): boolean {
    const previous = historyAutoRetryRef.current;
    const count = previous && previous.sid === sid ? previous.count : 0;
    if (count >= MAX_HISTORY_AUTO_RETRY) return false;
    historyAutoRetryRef.current = { sid, count: count + 1 };
    window.setTimeout(function retryHistoryLoad() {
      if (currentSessionIdRef.current !== sid || currentWorkspaceIdRef.current !== workspaceId) return;
      void loadHistory(sid);
    }, 500 * 2 ** count);
    return true;
  }

  // 加载历史消息
  const loadHistory = useCallback(async (sid: string, prefetchedData?: SessionHistoryPayload) => {
    if (currentSessionIdRef.current !== sid || currentWorkspaceIdRef.current !== workspaceId) return false;
    const controller = getSessionController(sid);
    const requestId = controller.beginHistoryRequest();
    const isCurrentRequest = () => controller.isLatestHistoryRequest(requestId) && currentSessionIdRef.current === sid && currentWorkspaceIdRef.current === workspaceId;
    // Session 变化与所有失败路径先清空旧 Context Usage，再应用当前请求结果，避免旧 Session 值泄漏。
    setContextUsage(undefined);
    if (!sid) {
      transportDisconnectedRef.current = false;
      setMessages([]);
      setPresentation(createPresentationState());
      setActivity(undefined);
      setLoading(false);
      setStreamingMessageId("");
      setSessionMeta(null);
      setReadOnlyReason(undefined);
      setChatAttachments([]);
      setHistoryReady(!sid);
      setPinnedSkills([]);
      setSelectedSkills([]);
      setPendingInputs([]);
      pendingInputsRef.current = [];
      joinedInputIdsRef.current.clear();
      historyInputIdsRef.current.clear();
      setInputDeliveryNotice(null);
      setResumePendingSessionId(null);
      setHistoryError(null);
      historyAutoRetryRef.current = null;
      clearActiveTurn();
      return true;
    }
    try {
      let data = prefetchedData;
      if (!data) {
        let res: Response;
        try {
          res = await fetch(getWorkspaceSessionUrl(workspaceId, sid)!);
        } catch {
          throw new HistoryStageError("fetch");
        }
        console.log(res);
        if (!isCurrentRequest()) return false;
        if (!res.ok) {
          const failure = await res.json().catch(() => ({}));
          const canRetry = shouldRetryHistoryFailure("http", res.status);
          // 同会话瞬时 History 失败：保留实时消息与 Presentation，只记录可重试错误；切换会话/无归属时才清空。
          if (sessionMetaIdRef.current === sid) {
            console.warn("[useSessionConversation] History load failed", { phase: "http", status: res.status, sessionId: sid });
            setHistoryError({ phase: "http", status: res.status, message: failure.error || `历史记录加载失败（HTTP ${res.status}）`, manualRetry: true });
            setLoading(false);
            return false;
          }
          setReadOnlyReason(failure.error || "无法读取此会话，请检查其归属与工作区状态");
          setHistoryReady(false);
          setMessages([]);
          setSessionMeta(null);
          setHistoryError(null);
          clearActiveTurn();
          setLoading(false);
          // 首次恢复失败自动再次获取历史；穷尽后保留提示，不让会话静默空白。
          if (!canRetry || !scheduleHistoryAutoRetry(sid)) {
            const retryCount = historyAutoRetryRef.current?.sid === sid ? historyAutoRetryRef.current.count : 0;
            console.warn("[useSessionConversation] History load failed", { phase: "http", status: res.status, sessionId: sid, retryCount });
            setHistoryError({ phase: "http", status: res.status, message: failure.error || `历史记录加载失败（HTTP ${res.status}）`, manualRetry: false });
          }
          return false;
        }
        try {
          data = await res.json() as SessionHistoryPayload;
        } catch {
          throw new HistoryStageError("json");
        }
      }
      if (!isCurrentRequest()) return false;
      const restoredPresentation = (data.presentation as AgentPresentationState | undefined) ?? createPresentationState();
      if (isChat && data.meta.productMode !== "chat") { setReadOnlyReason("会话身份不匹配"); return false; }
      setSessionMeta(data.meta);
      setReadOnlyReason(data.readOnlyReason);
      setContextUsage(data.contextUsage ?? undefined);
      setChatAttachments(isChat ? data.attachments ?? [] : []);
      setHistoryReady(true);
      setHistoryError(null);
      setPresentation(restoredPresentation);
      const agent = !isChat && !data.readOnlyReason ? data.agent as SessionAgentState | undefined : undefined;
      /**
       * 服务端终态优先于 Presentation 里可能残留的 activeOperation：
       * 旧活动快照不得把已失败/已完成/已中断的 Turn 重新恢复成运行中（H2）。
       */
      const serverSettled = data.meta.runtimeStatus === "idle"
        || data.meta.runtimeStatus === "completed"
        || data.meta.runtimeStatus === "failed"
        || data.meta.runtimeStatus === "interrupted"
        || agent?.status === "failed";
      const restoredActiveOperation = data.readOnlyReason || serverSettled ? undefined : restoredPresentation.activeOperation;
      const restoredStart = restoredPresentation.turnId ? Date.parse(restoredPresentation.turnStartedAt[restoredPresentation.turnId] ?? "") : Number.NaN;
      setActivity(Number.isFinite(restoredStart) && restoredActiveOperation ? { turnId: restoredPresentation.turnId, startedAt: restoredStart, phase: "waiting", lastProgressAt: Date.now(), hasActiveTool: restoredActiveOperation.kind === "tool", stallable: false } : undefined);
      const restoredPins = (data.meta as SessionMeta).pinnedSkills ?? [];
      setPinnedSkills(restoredPins);
      setSelectedSkills(restoredPins.map((skill) => ({ skillRef: skill.skillRef, pinned: true })));
      manager.updateRuntimeState(createWorkspaceSessionKey(workspaceId, sid), data.meta.runtimeStatus, data.meta.activeTurnId ?? agent?.turnId);
      const recoverableTurnId = agent?.recoverable && (agent.status === "interrupted_recoverable" || agent.status === "limit_reached")
        ? agent.turnId
        : undefined;
      const mapped: Message[] = data.messages.map(function mapMessage(m) { return mapHistoryMessage(m, agent, recoverableTurnId); });
      const restoredPendingInputs = (data.pendingInputs as PendingAgentInput[] | undefined) ?? [];
      const restoredTurnId = typeof data.turnId === "string" ? data.turnId : restoredPresentation.turnId;
      const hasRestoredActiveTurn = Boolean(restoredActiveOperation && restoredTurnId);
      setPendingInputs(restoredPendingInputs);
      pendingInputsRef.current = restoredPendingInputs;
      joinedInputIdsRef.current = new Set(restoredPresentation.items.flatMap(function consumed(item) { return item.kind === "input_notice" && item.state !== "queued" ? [item.inputId] : []; }));
      historyInputIdsRef.current = new Set(data.messages.flatMap(function queued(message) { return message.role === "user" && message.turnId && message.clientRecordId?.startsWith("input:") ? [message.clientRecordId.slice(6)] : []; }));
      for (const inputId of historyInputIdsRef.current) joinedInputIdsRef.current.add(inputId);
      setInputDeliveryNotice(null);
      setResumePendingSessionId(!isChat && !data.readOnlyReason && data.canAutoStartNext === true && restoredPendingInputs.length > 0 ? sid : null);
      if (agent?.status === "awaiting_approval" || agent?.status === "awaiting_user_input") {
        if (agent.status === "awaiting_approval") markAwaitingApproval(sid, agent.turnId);
        else markAwaitingUserInput(sid, agent.turnId);
        if (!mapped.some((message) => message.turnId === agent.turnId)) mapped.push({ id: `agent-turn-${agent.turnId}`, role: "assistant", content: "", turnId: agent.turnId });
      } else if (hasRestoredActiveTurn) {
        activeTurnRef.current = { sessionId: sid, turnId: restoredTurnId! };
        setActiveTurnId(restoredTurnId!);
        setLoading(true);
        if (!mapped.some((message) => message.turnId === restoredTurnId)) mapped.push({ id: `agent-turn-${restoredTurnId}`, role: "assistant", content: "", turnId: restoredTurnId, activity: "answer" });
      } else {
        clearActiveTurn();
        setLoading(false);
        if (agent && !mapped.some((message) => message.turnId === agent.turnId)) mapped.push({
          id: `agent-turn-${agent.turnId}`,
          role: "assistant",
          content: "",
          turnId: agent.turnId,
          termination: agent.termination,
          canContinue: Boolean(recoverableTurnId && agent.recoverable),
        });
      }
      setMessages((current) => mergeHistoryIntoChatMessages(current, mapped));
      notifyNewProgress();
      transportDisconnectedRef.current = false;
      historyAutoRetryRef.current = null;
      return true;
    } catch (error) {
      if (!isCurrentRequest()) return false;
      // 同会话瞬时 History 失败：保留实时内容，按阶段记录安全错误；UI 保持统一文案。
      if (sessionMetaIdRef.current === sid) {
        const stage = error instanceof HistoryStageError ? error.stage : "mapping";
        console.warn("[useSessionConversation] History load failed", { phase: stage, sessionId: sid });
        setHistoryError({ phase: stage, message: "历史记录加载失败，请刷新页面重试", manualRetry: true });
        return false;
      }
      setMessages([]);
      setPresentation(createPresentationState());
      setActivity(undefined);
      setSessionMeta(null);
      setReadOnlyReason(undefined);
      setChatAttachments([]);
      setHistoryReady(!sid);
      setPinnedSkills([]);
      setSelectedSkills([]);
      setPendingInputs([]);
      setResumePendingSessionId(null);
      setHistoryError(null);
      clearActiveTurn();
      // 首次恢复失败自动再次获取历史；穷尽后保留提示，不让会话静默空白。
      const stage = error instanceof HistoryStageError ? error.stage : "mapping";
      const canRetry = shouldRetryHistoryFailure(stage);
      if (!canRetry || !scheduleHistoryAutoRetry(sid)) {
        const retryCount = historyAutoRetryRef.current?.sid === sid ? historyAutoRetryRef.current.count : 0;
        console.warn("[useSessionConversation] History load failed", { phase: stage, sessionId: sid, retryCount });
        const message = canRetry ? "历史记录自动重试后仍未加载成功，请刷新页面重试" : "历史记录加载失败，请刷新页面重试";
        setHistoryError({ phase: stage, message, manualRetry: false });
      }
      return false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- controller 以当前已挂载 Session 为键，不能因父级重渲染重新触发 History。
  }, [notifyNewProgress, workspaceId]);

  /** 将 Agent SSE 交给共享 Presentation reducer；页面只处理连接、队列和终态控制。 */
  function applyAgentStreamEvent(messageId: string, sid: string, data: Record<string, unknown>): void {
    if (currentSessionIdRef.current !== sid || currentWorkspaceIdRef.current !== workspaceId) return;
    const turnId = typeof data.turnId === "string" ? data.turnId : undefined;
    const cancelled = Boolean(turnId && cancelledTurnIdsRef.current.has(turnId));
    const terminal = data.type === "turn_completed" || data.type === "turn_failed" || data.type === "turn_interrupted" || data.type === "turn_limit_reached";
    if (cancelled && !terminal) return;
    const sessionKey = createWorkspaceSessionKey(workspaceId, sid);
    const currentTurnId = manager.getSessionSnapshot(sessionKey)?.activeTurnId;
    if (terminal && currentTurnId && turnId && currentTurnId !== turnId) return;
    if (isWebPresentationDelta(data)) {
      streamingMessageIdRef.current = messageId;
      getPresentationFrameBatcher().enqueue(data);
      return;
    }
    getPresentationFrameBatcher().flush();
    notifyNewProgress();
    setTransportState("connected");
    if (turnId && !cancelled) {
      activeTurnRef.current = { sessionId: sid, turnId };
      setActiveTurnId(turnId);
      setMessages((current) => current.map((message) => message.id === messageId ? { ...message, turnId, activity: "answer" } : message));
    }
    if (data.type === "turn_started") {
      manager.updateRuntimeState(sessionKey, "running", turnId);
      // 新 Turn 开始即视为用户活动，清除上一轮残留的 History 错误条。
      setHistoryError(null);
    }
    if (data.type === "approval_required") manager.updateRuntimeState(sessionKey, "waiting_approval", turnId);
    if (data.type === "question_required") manager.updateRuntimeState(sessionKey, "waiting_user_input", turnId);
    if (data.type === "turn_completed") {
      manager.updateRuntimeState(sessionKey, "completed");
      manager.applyTerminalEvent(sessionKey, "turn_completed");
    }
    if (data.type === "turn_failed") {
      // Host 已构建并持久化的 DTO 直接沿用；只有裸错误文本才重新分类（沙箱类别不降级）。
      const failure = isWebTurnFailure(data.failure) ? data.failure : toWebTurnFailure(data.error ?? data.failure);
      setMessages((current) => current.map((message) => message.id === messageId ? { ...message, failure } : message));
      manager.updateRuntimeState(sessionKey, "failed");
      manager.applyTerminalEvent(sessionKey, "turn_failed");
    }
    if (data.type === "turn_interrupted") manager.updateRuntimeState(sessionKey, "interrupted");
    if (data.type === "turn_limit_reached") manager.markLimitReached(sessionKey);
    if (cancelled) return;
    if (data.type === "context_diagnostic") {
      const diagnostics = data.diagnostics;
      if (Array.isArray(diagnostics)) {
        setMessages((current) => current.map((message) => message.id === messageId ? { ...message, diagnostics: diagnostics.filter((item): item is string => typeof item === "string") } : message));
      }
      // Host 诊断不再承担 Session Context usage；顶栏只消费 Core context_usage_updated。
      return;
    }
    if (data.type === "context_usage_updated") {
      // Core 已在安全边界脱敏；usage 为 null 表示明确清空旧状态。
      const usage = data.usage;
      setContextUsage(usage && typeof usage === "object" ? usage as ContextUsageView : undefined);
      return;
    }
    setActivity((current) => reduceWebActivityState(current, data));
    setPresentation((current) => reduceWebPresentationEvent(current, data, sid));
    if ((data.type === "input_joined" || data.type === "input_consumed") && typeof data.inputId === "string") removeConsumedPendingInput(data.inputId);
    if (data.type === "approval_required" && turnId) markAwaitingApproval(sid, turnId);
    if (data.type === "question_required" && turnId) markAwaitingUserInput(sid, turnId);
    if (data.type === "turn_completed") queueExecutionRequestedRef.current = true;
    if (data.type === "turn_completed" || data.type === "turn_interrupted" || data.type === "turn_failed" || data.type === "turn_limit_reached") {
      // SSE 终态已由 Web 服务端 DTO 白名单化；客户端只消费 Core 已确认的可恢复字段。
      const termination = data.termination as SessionAgentState["termination"];
      const canContinue = !isChat
        && termination?.recoverable === true
        && (data.type === "turn_interrupted" || data.type === "turn_limit_reached");
      setMessages((current) => current.map((message) => message.id === messageId ? {
        ...message,
        activity: undefined,
        canContinue,
        recoveryError: undefined,
        // 新终态整体覆盖旧 termination：完成/失败不带 termination 时清掉上一段恢复留下的旧停止提示（P17 问题2）。
        termination,
      } : message));
      clearActiveTurn();
    }
  }

  /** 查询同一 Turn 的完整持久终态；请求本身有短超时，校准失败不影响原 SSE。 */
  async function getDurableTerminalSnapshot(sid: string, turnId: string): Promise<SessionHistoryPayload | null> {
    const url = getWorkspaceSessionUrl(workspaceId, sid);
    if (!url) return null;
    const abortController = new AbortController();
    const timeoutId = window.setTimeout(function abortTerminalCheck() { abortController.abort(); }, 3_000);
    try {
      const response = await fetch(url, { cache: "no-store", signal: abortController.signal });
      console.log(response);
      if (!response.ok) return null;
      const snapshot = await response.json() as SessionHistoryPayload;
      return hasDurableTerminalTurn(snapshot, turnId) ? snapshot : null;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  /** 消费任意 Agent SSE；空闲尾流以同 Turn 的服务端终态做有界校准，并返回收口结果供调用方决定 History fallback。 */
  async function consumeAgentStream(response: Response, messageId: string, sid: string): Promise<SessionTaskStreamOutcome> {
    try {
      return await getSessionController(sid).consume(response, messageId, {
        getTerminalSnapshot: function readDurableTerminal(turnId) { return getDurableTerminalSnapshot(sid, turnId); },
        applyTerminalSnapshot: function restoreDurableTerminal(_turnId, snapshot) { return loadHistory(sid, snapshot as SessionHistoryPayload); },
      });
    } finally {
      presentationFrameBatcherRef.current?.flush();
    }
  }

  /** URL 切换后始终加载目标 Session；旧发送请求由 Session 身份校验阻止回写。进入会话时重置自动重试预算。 */
  useEffect(function loadSelectedSessionHistory() {
    if (sessionId && locallyCreatedSessionRef.current === sessionId) return;
    historyAutoRetryRef.current = null;
    void loadHistory(sessionId);
  }, [workspaceId, sessionId, loadHistory]);

  useEffect(function syncPendingInputsRef() {
    pendingInputsRef.current = pendingInputs;
  }, [pendingInputs]);

  /** Session 切换或页面卸载时取消未提交帧，避免旧流迟到后写入新会话。 */
  useEffect(function cancelPendingPresentationFrame() {
    return function cancelFrameOnSessionChange() {
      presentationFrameBatcherRef.current?.cancel();
    };
  }, [sessionId, workspaceId]);

  return {
    messages, setMessages,
    presentation, setPresentation,
    activity, setActivity,
    loading, setLoading,
    streamingMessageId, setStreamingMessageId,
    activeTurnId, setActiveTurnId,
    sessionMeta, setSessionMeta,
    readOnlyReason, setReadOnlyReason,
    historyReady, setHistoryReady,
    historyError,
    chatAttachments, setChatAttachments,
    pendingInputs, setPendingInputs,
    inputDeliveryNotice, setInputDeliveryNotice,
    resumePendingSessionId, setResumePendingSessionId,
    contextUsage, setContextUsage,
    currentSessionIdRef,
    currentWorkspaceIdRef,
    requestAbortRef,
    locallyCreatedSessionRef,
    pendingInputsRef,
    joinedInputIdsRef,
    historyInputIdsRef,
    activeTurnRef,
    cancelRequestedRef,
    cancelledTurnIdsRef,
    cancelInFlightRef,
    transportDisconnectedRef,
    awaitingApprovalRef,
    awaitingUserInputRef,
    executionEpochRef,
    queueExecutionRequestedRef,
    getSessionController,
    setTransportState,
    markAwaitingUserInput,
    clearActiveTurn,
    loadHistory,
    consumeAgentStream,
  };
}
