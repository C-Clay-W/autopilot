/** chat-page-content.tsx — 单 Session 装配层：组合四组现有 Hook 与叶子 UI 组件，只保留必要装配与跨区域派生值，不新增业务判断。 */
"use client";

import { useCallback, useMemo, useState, useRef, useEffect, type ReactNode } from "react";
import PermissionPanel from "./components/PermissionPanel";
import StorageQuotaPanel from "./components/StorageQuotaPanel";
import SkillPicker from "./components/SkillPicker";
import ChatPageHeader from "./components/ChatPageHeader";
import ChatMessageList from "./components/ChatMessageList";
import ChatComposer from "./components/ChatComposer";
import ChatImagePreview from "./components/ChatImagePreview";
import DiffSidebar from "./components/DiffSidebar";
import DiffSidebarDivider from "./components/DiffSidebarDivider";
import WorkPreviewPanel from "./components/WorkPreviewPanel";
import WorkPreviewLayout from "./components/WorkPreviewLayout";
import { selectDiffSections } from "./components/diff-sidebar-model";
import {
  admitAutoOpenPreview,
  closedPreview,
  createPreviewAutoOpenSuppression,
  createPreviewRatioMemory,
  createRequestGeneration,
  evaluateAfterTurnCandidate,
  canAutoOpenPreview,
  findPreviewCandidateTurnId,
  invalidatePendingAutoCandidates,
  isDualPaneCapable,
  listPreviewCandidates,
  listStartedPreviewCalls,
  previewEmbeddingUnknown,
  previewFailed,
  previewLoaded,
  previewTargetReady,
  startPreviewResolve,
  suppressAutoOpenTurn,
  type PreviewCandidate,
  type PreviewStartedCall,
  type WorkPreviewPanelState,
  type WorkPreviewViewProps,
} from "./work-preview-state";

import { useNotice } from "./components/Notice";
import { useSmartScroll } from "./hooks/useSmartScroll";
import { useSidebar } from "./sidebar-context";
import type { ApprovalItem, UserQuestionItem } from "@autopilot-agent/presentation";
import { CHAT_SCOPE, sessionApiUrl } from "./conversation-target";
import type { ChatRetrievalMode, ContextUsageView } from "@autopilot-agent/core";
import type { WorkspaceSummary } from "./session-task-context";
import { createWorkspaceSessionKey } from "./session-task-store";
import { isDisplayableSource } from "./chat-page-helpers";
import type { ComposerInputActions, SourceItem } from "./chat-page-types";
import { useSessionConversation } from "./hooks/useSessionConversation";
import { useWorkControls } from "./hooks/useWorkControls";
import { useTurnRecoveryActions } from "./hooks/useTurnRecoveryActions";
import { useConversationSubmission } from "./hooks/useConversationSubmission";

/** 共用传输地址解析；Chat 作用域永远不发送到 Work API。 */
const getWorkspaceSessionUrl = sessionApiUrl;

/** Diff 侧边栏宽度常量：参考 DS columns.ts 的右栏/中栏下限，按现有页面取值。 */
const DIFF_SIDEBAR_MIN = 300;
const DIFF_SIDEBAR_DEFAULT = 400;
/** 聊天主栏在 Diff 打开时受保护的最小宽度。 */
const CHAT_MIN_WIDTH = 400;

/** 同一个会话视图按产品切换能力，已经挂载的后台实例保持原有身份。 */
export default function ChatPageContent({ workspaceId, workspace, sessionId, active = false, retrievalMode = "none", onSessionCreated, onSessionStarting, onOpenWorkspacePicker, onRetrievalChange }: { workspaceId: string; workspace?: WorkspaceSummary; sessionId: string; active?: boolean; retrievalMode?: ChatRetrievalMode; onSessionCreated(sessionId: string): void; onSessionStarting(): void; onOpenWorkspacePicker(): void; onRetrievalChange(mode: ChatRetrievalMode): void }) {
  const { toggleSidebar, toggleDesktopSidebar, sidebarOpen, closeSidebar } = useSidebar();
  const isChat = workspaceId === CHAT_SCOPE;
  const hasWorkspace = isChat || Boolean(workspaceId && workspace?.available && workspace.trustStatus === "trusted");
  const [permissionPanelOpen, setPermissionPanelOpen] = useState(false);
  const [storageQuotaPanelOpen, setStorageQuotaPanelOpen] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  /** Diff 侧边栏开关：记录"打开时所在的 sessionId"，派生开关值随会话切换自动关闭（第七节契约，且避免 effect 内 setState）。 */
  const [diffSidebarOpenSessionId, setDiffSidebarOpenSessionId] = useState<string | null>(null);
  const diffSidebarOpen = diffSidebarOpenSessionId !== null && diffSidebarOpenSessionId === sessionId;
  /** Diff 侧边栏桌面端宽度：由本布局持有，分隔条拖动/键盘调整；窄屏 overlay 不消费。 */
  const [diffSidebarWidth, setDiffSidebarWidth] = useState(DIFF_SIDEBAR_DEFAULT);
  /** Diff 行容器宽度：用 ResizeObserver 测量实际 flex 行，限值按容器而非 window 计算。 */
  const diffRowRef = useRef<HTMLDivElement>(null);
  const [diffRowWidth, setDiffRowWidth] = useState(0);
  useEffect(function trackDiffRowWidth() {
    const el = diffRowRef.current;
    if (!el) return;
    const observer = new ResizeObserver(function measureRow(entries) {
      setDiffRowWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return function unobserveRow() {
      observer.disconnect();
    };
  }, []);
  /** Diff 宽度上限：为聊天主栏保留 CHAT_MIN_WIDTH；容器未知时退回默认宽度。 */
  const diffSidebarMax = diffRowWidth > DIFF_SIDEBAR_MIN + CHAT_MIN_WIDTH ? diffRowWidth - CHAT_MIN_WIDTH : DIFF_SIDEBAR_DEFAULT;
  /** 拖动/键盘回调：统一钳制到 [DIFF_SIDEBAR_MIN, 上限]。 */
  const handleDiffSidebarWidthChange = useCallback(function handleDiffSidebarWidthChange(nextWidth: number) {
    setDiffSidebarWidth(Math.min(diffSidebarMax, Math.max(DIFF_SIDEBAR_MIN, Math.round(nextWidth))));
  }, [diffSidebarMax]);
  /** 容器变窄越限或从未知变为已知时，把当前宽度收进限值。 */
  useEffect(function clampDiffSidebarWidth() {
    setDiffSidebarWidth(function clamp(current) {
      return Math.min(diffSidebarMax, Math.max(DIFF_SIDEBAR_MIN, current));
    });
  }, [diffSidebarMax]);
  /** Work 内置预览面板状态：绑定打开时所在 sessionId；会话切换关闭，返回不补打开。 */
  const [preview, setPreview] = useState<{ sessionId: string; state: WorkPreviewPanelState }>(function initialPreviewState() { return { sessionId: "", state: closedPreview() }; });
  const previewRef = useRef(preview);
  useEffect(function syncPreviewRef() { previewRef.current = preview; });
  /** 左栏会话内存比例（0–100）：宽度按当前容器派生，容器变化比例不变。 */
  const [previewLeftRatio, setPreviewLeftRatio] = useState(50);
  const previewRatioMemoryRef = useRef(createPreviewRatioMemory());
  const previewGenerationRef = useRef(createRequestGeneration());
  const previewToolbarRef = useRef<HTMLDivElement | null>(null);
  /** now/after_turn 自动打开的一次性消费记录（判定 4）。 */
  const autoOpenedPreviewRef = useRef<Set<string>>(new Set());
  /** 用户动作抑制：手动选择淘汰的更早候选、关闭后的整轮抑制（判定 6/AC-7）。 */
  const previewSuppressionRef = useRef(createPreviewAutoOpenSuppression());
  /** 最近一次渲染的工具交付候选快照：用户动作以此刻已存在的候选为边界。 */
  const previewCandidatesRef = useRef<PreviewCandidate[]>([]);
  /** 此刻已开始的 open_preview 调用快照：动作前已开始、动作后才完成的调用不得覆盖用户选择。 */
  const previewStartedCallsRef = useRef<PreviewStartedCall[]>([]);
  /** 当前工具交付导航的 previewId；resolving 阶段面板尚无目标，关闭时用它反查 Turn。 */
  const panelPreviewIdRef = useRef<string | null>(null);
  /** 待执行的自动展开定时器；实例失活或卸载时必须清除（AC-5）。 */
  const previewTimersRef = useRef<Set<number>>(new Set());
  const [resolvingPreviewId, setResolvingPreviewId] = useState<string | null>(null);
  /** 当前实例是否可见活动：异步响应落地前重核，隐藏实例不得改写面板或挂载 iframe（AC-5）。 */
  const previewActiveRef = useRef(active);
  useEffect(function syncPreviewActiveRef() { previewActiveRef.current = active; }, [active]);
  /** 清除全部待执行的自动展开定时器（幂等）。 */
  const clearPreviewTimers = useCallback(function clearPreviewTimers() {
    for (const timerId of previewTimersRef.current) window.clearTimeout(timerId);
    previewTimersRef.current.clear();
  }, []);
  /**
   * 用户显式预览动作（手动打开、结果内切换、关闭面板）：清除待执行自动展开，
   * 淘汰此刻已存在的自动候选；关闭时另把抑制提升到 Turn 身份（AC-7/判定 6）。
   */
  const markUserPreviewAction = useCallback(function markUserPreviewAction(options: { suppressTurn: boolean }) {
    clearPreviewTimers();
    const candidates = previewCandidatesRef.current;
    invalidatePendingAutoCandidates(previewSuppressionRef.current, candidates, previewStartedCallsRef.current);
    if (!options.suppressTurn) return;
    const target = previewRef.current.state.target;
    const previewId = target?.source === "tool_delivery" ? target.previewId : panelPreviewIdRef.current ?? undefined;
    const turnId = target?.turnId ?? findPreviewCandidateTurnId(candidates, previewId);
    if (turnId) suppressAutoOpenTurn(previewSuppressionRef.current, turnId);
  }, [clearPreviewTimers]);
  const previewOpen = !isChat && hasWorkspace && active && preview.sessionId === sessionId && preview.state.phase !== "closed";
  const previewDual = previewOpen && isDualPaneCapable(diffRowWidth);
  /** 本挂载实例内经历 Live 流的轮次集合；历史回放轮不在其中（判定 2/G6）。 */
  const liveTurnIdsRef = useRef<Set<string>>(new Set());
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<{ messageId: string; content: string } | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<{ url: string; alt: string } | null>(null);
  const [requestedJobId, setRequestedJobId] = useState<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerInputRef = useRef("");
  const composerInputActionsRef = useRef<ComposerInputActions | null>(null);
  const canWriteRef = useRef(false);
  const workspaceSessionKey = createWorkspaceSessionKey(workspaceId || "unselected", sessionId || "draft");
  const { containerRef, contentRef, isPinned, unreadCount, handleScroll, showLatest, notifyNewProgress } = useSmartScroll({ sessionId: workspaceSessionKey });
  const notice = useNotice();

  const {
    showSources, setShowSources,
    showProcess, setShowProcess,
    databaseEnabled, setDatabaseEnabled,
    databaseSyncing,
    databaseSyncMessage,
    databaseSyncElapsedSeconds,
    storageQuota,
    updateStorageQuota,
    skillCatalog,
    selectedSkills, setSelectedSkills,
    pinnedSkills, setPinnedSkills,
    getSkillDisplayName,
    toggleSelectedSkill,
    togglePinnedSkill,
    syncDatabase,
  } = useWorkControls({ isChat, workspaceId, canWriteRef, hasWorkspace });

  const {
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
  } = useSessionConversation({ workspaceId, sessionId, isChat, notifyNewProgress, setSelectedSkills, setPinnedSkills });

  const canWrite = hasWorkspace && historyReady && !readOnlyReason;
  canWriteRef.current = canWrite;
  const currentRetrieval = sessionMeta?.chatRetrievalMode ?? retrievalMode;

  const {
    stopping,
    cancelCurrentTurn,
    handleContinueTurn,
    handleApproval,
    handleUserQuestion,
    cancelPendingInput,
    refreshTransport,
    requestNextQueuedTurn,
  } = useTurnRecoveryActions({
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
    executionEpochRef,
    pendingInputsRef,
    joinedInputIdsRef,
    currentSessionIdRef,
    currentWorkspaceIdRef,
    queueExecutionRequestedRef,
  });

  const {
    selectedFiles, setSelectedFiles,
    knowledgeProgress,
    submissionActivity,
    inputDelivery, setInputDelivery,
    handleSend,
    handleFileSelect,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useConversationSubmission({
    isChat,
    workspaceId,
    sessionId,
    hasWorkspace,
    canWrite,
    currentRetrieval,
    loading,
    activeTurnId,
    messages,
    presentation,
    setPresentation,
    currentSessionIdRef,
    currentWorkspaceIdRef,
    cancelledTurnIdsRef,
    databaseEnabled,
    selectedSkills,
    setSelectedSkills,
    setPinnedSkills,
    textareaRef,
    inputRef: composerInputRef,
    inputActionsRef: composerInputActionsRef,
    onOpenWorkspacePicker,
    onSessionStarting,
    onSessionCreated,
    handleContinueTurn,
    requestNextQueuedTurn,
    setMessages,
    setLoading,
    setSessionMeta,
    setHistoryReady,
    setReadOnlyReason,
    setChatAttachments,
    setPendingInputs,
    setInputDeliveryNotice,
    setStreamingMessageId,
    setActivity,
    setTransportState,
    clearActiveTurn,
    loadHistory,
    consumeAgentStream,
    getSessionController,
    requestAbortRef,
    cancelRequestedRef,
    cancelInFlightRef,
    locallyCreatedSessionRef,
    joinedInputIdsRef,
    historyInputIdsRef,
    activeTurnRef,
    pendingInputsRef,
    queueExecutionRequestedRef,
    awaitingApprovalRef,
    awaitingUserInputRef,
    executionEpochRef,
    transportDisconnectedRef,
  });

  /** 空输入时的 Continue 入口复用既有恢复动作；只按结构化可恢复事实选择最近一条 Turn（H2）。 */
  const resumableMessage = [...messages].reverse().find((message) => message.role === "assistant" && message.canContinue && Boolean(message.turnId));
  const resumableMessageId = resumableMessage?.id;

  /** 按当前视口切换移动端抽屉或桌面端侧边栏。 */
  function handleSidebarToggle(): void {
    if (window.matchMedia("(min-width: 768px)").matches) {
      toggleDesktopSidebar();
      return;
    }
    toggleSidebar();
  }

  /** 切换 Diff 侧边栏；窄屏打开前先收起会话抽屉，避免双 overlay 叠加（Plan 风险缓解）。 */
  function handleDiffSidebarToggle(): void {
    if (!diffSidebarOpen && !window.matchMedia("(min-width: 768px)").matches && sidebarOpen) closeSidebar();
    // Diff 与预览互斥占用右侧：打开 Diff 前先关闭预览（用户显式切换，计入关闭抑制）。
    if (!diffSidebarOpen) closePreviewPanel();
    setDiffSidebarOpenSessionId(diffSidebarOpen ? null : sessionId);
  }

  /** 关闭 Diff 侧边栏（Esc 与关闭按钮共用），并把焦点还给头部入口按钮（对齐 Context 面板焦点规范）。 */
  function closeDiffSidebar(): void {
    setDiffSidebarOpenSessionId(null);
    document.getElementById("diff-sidebar-trigger")?.focus();
  }

  /** 关闭预览面板：取消在途请求，淘汰更早候选并把关闭抑制提升到 Turn（判定 6），保留会话比例。 */
  const closePreviewPanel = useCallback(function closePreviewPanel() {
    previewGenerationRef.current.next();
    // 已关闭时只是幂等收尾，不把无关的用户动作记成对预览的关闭抑制。
    if (previewRef.current.state.phase !== "closed") markUserPreviewAction({ suppressTurn: true });
    setPreview(function close(current) { return { sessionId: current.sessionId, state: closedPreview() }; });
    setResolvingPreviewId(null);
    panelPreviewIdRef.current = null;
  }, [markUserPreviewAction]);

  /** 解析工具交付引用并打开面板；结果内按钮与 now 交付共用，不抢焦点。 */
  const openPreviewDelivery = useCallback(async function openPreviewDelivery(targetPreviewId: string) {
    if (isChat || !hasWorkspace) return;
    const generation = previewGenerationRef.current.next();
    panelPreviewIdRef.current = targetPreviewId;
    setDiffSidebarOpenSessionId(null);
    setResolvingPreviewId(targetPreviewId);
    setPreview({ sessionId, state: startPreviewResolve(null) });
    setPreviewLeftRatio(previewRatioMemoryRef.current.get(sessionId) ?? 50);
    try {
      const response = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/previews/" + encodeURIComponent(targetPreviewId)));
      const payload = await response.json().catch(function emptyBody() { return {}; }) as { code?: string; error?: string; previewId?: string; turnId?: string; hostLabel?: string; navigationUrl?: string; sandboxProfile?: string; serviceState?: string; canStop?: boolean };
      if (!previewGenerationRef.current.isCurrent(generation) || !previewActiveRef.current) return;
      if (!response.ok || !payload.navigationUrl || !payload.hostLabel) {
        setPreview(function fail(current) { return { sessionId: current.sessionId, state: previewFailed(current.state, payload.error || "预览引用不存在或不属于当前会话") }; });
        return;
      }
      setPreview({ sessionId, state: previewTargetReady({
        source: "tool_delivery",
        previewId: payload.previewId ?? targetPreviewId,
        turnId: payload.turnId,
        hostLabel: payload.hostLabel,
        navigationUrl: payload.navigationUrl,
        sandboxProfile: payload.sandboxProfile === "strict_public" ? "strict_public" : "trusted_local",
        serviceState: payload.serviceState === "ready" || payload.serviceState === "redirect_pending" || payload.serviceState === "unavailable" ? payload.serviceState : "unchecked",
        canStop: payload.canStop === true,
      }) });
    } catch {
      if (previewGenerationRef.current.isCurrent(generation) && previewActiveRef.current) {
        setPreview(function fail(current) { return { sessionId: current.sessionId, state: previewFailed(current.state, "预览面板连接失败，请稍后重试") }; });
      }
    } finally {
      if (previewGenerationRef.current.isCurrent(generation) && previewActiveRef.current) setResolvingPreviewId(null);
    }
  }, [isChat, hasWorkspace, workspaceId, sessionId]);

  /** 延后一拍执行自动展开：避免 effect 内同步 setState；定时器登记以便失活/卸载时清除并重核可见身份。 */
  const schedulePreviewOpen = useCallback(function schedulePreviewOpen(previewId: string) {
    const timerId = window.setTimeout(function openScheduledPreview() {
      previewTimersRef.current.delete(timerId);
      if (!previewActiveRef.current) return;
      void openPreviewDelivery(previewId);
    }, 0);
    previewTimersRef.current.add(timerId);
  }, [openPreviewDelivery]);

  /** Work 弹窗内置打开：POST open-link 校验并打开面板；取消/退出时中止请求并回滚本次导航。 */
  const openPreviewLink = useCallback(async function openPreviewLink(url: string, signal?: AbortSignal): Promise<string | undefined> {
    if (isChat || !hasWorkspace) return "预览仅在 Work 任务中可用";
    const generation = previewGenerationRef.current.next();
    // 手动打开是用户显式选择：淘汰此刻已存在的自动候选，迟到的自动结果不得覆盖（AC-7）。
    panelPreviewIdRef.current = null;
    markUserPreviewAction({ suppressTurn: false });
    // 取消只回滚本次请求打开的解析态，不覆盖用户已经切到的其他目标（AC-7）。
    const previousState = previewRef.current.sessionId === sessionId ? previewRef.current.state : closedPreview();
    const resolveState = startPreviewResolve(null);
    let settled = false;
    signal?.addEventListener("abort", function cancelPreviewNavigation() {
      if (settled) return;
      previewGenerationRef.current.next();
      setPreview(function restore(current) {
        return current.state === resolveState ? { sessionId: current.sessionId, state: previousState } : current;
      });
    }, { once: true });
    setDiffSidebarOpenSessionId(null);
    setResolvingPreviewId(null);
    setPreview({ sessionId, state: resolveState });
    setPreviewLeftRatio(previewRatioMemoryRef.current.get(sessionId) ?? 50);
    try {
      const response = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/previews/open-link"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }), signal });
      const payload = await response.json().catch(function emptyBody() { return {}; }) as { code?: string; error?: string; hostLabel?: string; navigationUrl?: string; sandboxProfile?: string };
      if (!previewGenerationRef.current.isCurrent(generation) || !previewActiveRef.current || signal?.aborted) return "预览请求已被新操作取代";
      if (!response.ok || !payload.navigationUrl || !payload.hostLabel) {
        const message = payload.error || "预览目标当前无法在宿主内打开";
        setPreview(function fail(current) { return { sessionId: current.sessionId, state: previewFailed(current.state, message) }; });
        return message;
      }
      setPreview({ sessionId, state: previewTargetReady({ source: "user_link", hostLabel: payload.hostLabel, navigationUrl: payload.navigationUrl, sandboxProfile: payload.sandboxProfile === "strict_public" ? "strict_public" : "trusted_local", serviceState: "unchecked", canStop: false }) });
      // 弹窗关闭并恢复原焦点之后再聚焦侧栏工具栏（M13 人工验收焦点顺序）。
      window.setTimeout(function focusPreviewToolbar() { previewToolbarRef.current?.focus(); }, 0);
      return undefined;
    } catch {
      return signal?.aborted ? "预览请求已取消" : "预览面板连接失败，请稍后重试";
    } finally {
      // 本次导航已有结论：此后弹窗卸载触发的 abort 不再回滚已打开的面板。
      settled = true;
    }
  }, [isChat, hasWorkspace, workspaceId, sessionId, markUserPreviewAction]);

  /** 结果内切换按钮：本结果已显示时关闭，否则解析并切换到该结果（用户显式选择优先于旧自动候选）。 */
  const togglePreviewDelivery = useCallback(function togglePreviewDelivery(targetPreviewId: string) {
    const current = previewRef.current;
    if (current.sessionId === sessionId && current.state.target?.source === "tool_delivery" && current.state.target.previewId === targetPreviewId) {
      closePreviewPanel();
      return;
    }
    markUserPreviewAction({ suppressTurn: false });
    void openPreviewDelivery(targetPreviewId);
  }, [sessionId, closePreviewPanel, openPreviewDelivery, markUserPreviewAction]);

  /** 刷新按来源重走受限接口：工具交付重新 GET，手动链接重新 POST。 */
  const refreshPreview = useCallback(function refreshPreview() {
    const target = previewRef.current.state.target;
    if (!target) return;
    if (target.source === "tool_delivery" && target.previewId) void openPreviewDelivery(target.previewId);
    else if (target.source === "user_link") void openPreviewLink(target.navigationUrl);
  }, [openPreviewDelivery, openPreviewLink]);

  /** 停止该引用拥有的受管 Job；取得确认终态后才提示"服务已停止"并关闭面板。 */
  const stopPreviewJob = useCallback(async function stopPreviewJob() {
    const target = previewRef.current.state.target;
    if (!target?.previewId) return;
    try {
      const response = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/previews/" + encodeURIComponent(target.previewId) + "/stop"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) { notice.error("预览服务停止失败"); return; }
      closePreviewPanel();
      notice.success("服务已停止");
    } catch {
      notice.error("预览服务停止失败");
    }
  }, [workspaceId, sessionId, closePreviewPanel, notice]);

  /** 拖动/键盘调整左栏比例并写入会话内存（不进入 Runtime、SSE、History 或 settings）。 */
  const handlePreviewLeftRatioChange = useCallback(function handlePreviewLeftRatioChange(nextRatio: number) {
    setPreviewLeftRatio(nextRatio);
    if (sessionId) previewRatioMemoryRef.current.set(sessionId, nextRatio);
  }, [sessionId]);

  /** iframe load：只结束等待动画。 */
  const handlePreviewLoad = useCallback(function handlePreviewLoad() {
    setPreview(function markLoaded(current) { return { sessionId: current.sessionId, state: previewLoaded(current.state) }; });
  }, []);

  /** 界面等待超时：保留 iframe 与手动入口，不断言被 CSP 阻止。 */
  const handlePreviewEmbeddingTimeout = useCallback(function handlePreviewEmbeddingTimeout() {
    setPreview(function markUnknown(current) { return { sessionId: current.sessionId, state: previewEmbeddingUnknown(current.state) }; });
  }, []);

  /** 将 RAG 的已持久化证据独立为 Turn 的 Evidence 分区，不混入 Runtime 工具输出。 */
  const renderEvidence = useCallback(function renderEvidence(sources?: SourceItem[]): ReactNode {
    if (!showSources || !sources?.some(isDisplayableSource)) return null;
    return (
      <section className="mt-3 space-y-1 border-t-2 border-ink pt-2 text-xs">
        <p className="text-[10px] font-semibold tracking-widest text-accent">EVIDENCE</p>
        {sources.filter(isDisplayableSource).slice(0, 3).map((source, index) => {

          const fileName = source.metadata?.fileName || "";
          const pageNumber = source.metadata?.pageNumber;
          return (
            <div key={index} className="border-2 border-ink bg-card px-3 py-2">
              <div>
                来源：<span className="text-accent">{fileName}</span>
                {pageNumber ? ` · 第${pageNumber} 页` : ""}
                {source.metadata?.title ? ` · ${source.metadata.title}` : ""}
              </div>

            </div>
          );
        })}
      </section>
    );
  }, [showSources]);

  /** 确认后请求同一 Messages Route 重建上下文投影；原始聊天记录不会被删除，压缩结果只经 Notice 反馈。 */
  async function compactContext(): Promise<void> {
    if (isChat || !canWrite) return;
    if (!sessionId || compacting) return;
    setCompacting(true);
    try {
      const response = await fetch(getWorkspaceSessionUrl(workspaceId, sessionId, "/messages")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "compact", clientMessageId: `compact-${Date.now()}` }),
      });
      console.log(response);
      const payload = await response.json().catch(() => ({})) as {
        outcome?: "changed" | "skipped";
        contextUsage?: ContextUsageView | null;
        error?: string;
      };
      // 活动 Turn/新鲜 lease：Route 返回 409 TURN_ALREADY_RUNNING；不排队、不提前改变 Context 条。
      if (response.status === 409) {
        notice.warning(payload.error || "当前任务仍在运行，请等待其结束后再压缩上下文");
        return;
      }
      if (!response.ok) throw new Error(payload.error || "上下文压缩失败");
      if (payload.outcome === "skipped") {
        notice.warning("未压缩：无可压缩历史，投影未变化。");
        return;
      }
      setContextUsage(payload.contextUsage ?? undefined);
      notice.success("上下文已压缩；当前显示为估算，下一次模型响应后会校准。");
    } catch (error) {
      notice.error(`上下文压缩失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setCompactConfirmOpen(false);
      setCompacting(false);
    }
  }

  /** 切换工作区只保留纯文本草稿，附件、固定/显式 Skill 等引用必须重新选择。 */
  useEffect(function clearWorkspaceScopedDraftReferences() {
    setSelectedFiles([]);
    setSelectedSkills([]);
    setPinnedSkills([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖数组与原 page.tsx 一致：仅在工作区切换时清空引用，setter 为稳定引用无需列入。
  }, [workspaceId]);

  /** 会话/任务切换或实例失活：取消在途导航、清除待执行定时器并关闭面板；结果与比例保留，回来不补打开（判定 7/AC-5）。 */
  useEffect(function closePreviewOnSessionChange() {
    if (!active) clearPreviewTimers();
    setPreview(function closeIfHidden(current) {
      if ((current.sessionId === sessionId && active) || current.state.phase === "closed") return current;
      previewGenerationRef.current.next();
      setResolvingPreviewId(null);
      return { sessionId: current.sessionId, state: closedPreview() };
    });
  }, [sessionId, active, clearPreviewTimers]);

  /** 卸载清理：作废在途导航并清除待执行定时器，隐藏实例的迟到响应不会再落地面板（AC-5）。 */
  useEffect(function cleanupPreviewOnUnmount() {
    const generation = previewGenerationRef.current;
    return function cleanup() {
      generation.next();
      clearPreviewTimers();
    };
  }, [clearPreviewTimers]);

  /** 同步工具交付候选快照：用户动作以此刻已存在的候选为边界，动作之后的新请求仍按实时规则判定（AC-7）。 */
  useEffect(function syncPreviewCandidates() {
    previewCandidatesRef.current = listPreviewCandidates(presentation);
    previewStartedCallsRef.current = listStartedPreviewCalls(presentation);
  }, [presentation]);

  /** now 交付自动展开：仅活动轮与可见实例展开；后台到达、被用户动作淘汰或本轮已关闭的候选只留结果入口（判定 2/4/5/6）。 */
  useEffect(function autoOpenNowDeliveries() {
    if (isChat || !activeTurnId) return;
    const visible = canAutoOpenPreview({
      active,
      readOnly: Boolean(readOnlyReason),
      documentVisible: typeof document === "undefined" || document.visibilityState === "visible",
    });
    for (const item of presentation.items) {
      if (item.kind !== "tool_call" || item.state !== "completed" || item.turnId !== activeTurnId) continue;
      const detail = item.detail;
      if (detail?.kind !== "open_preview" || detail.openWhen !== "now") continue;
      // 宿主无法证明服务归属时只保留结果入口，不自动展开（R1）。
      if (detail.autoOpen === false) continue;
      const admitted = admitAutoOpenPreview({
        suppression: previewSuppressionRef.current,
        consumed: autoOpenedPreviewRef.current,
        turnId: item.turnId,
        previewId: detail.previewId,
        callId: item.callId,
        visible,
      });
      if (admitted) schedulePreviewOpen(detail.previewId);
    }
  }, [presentation, activeTurnId, active, isChat, readOnlyReason, sessionId, schedulePreviewOpen]);

  /** Live 轮次追踪：start/continue/恢复置位期间记录轮次，供 after_turn 终态评估区分实时与历史回放。 */
  useEffect(function trackLiveTurns() {
    if (!activeTurnId) return;
    liveTurnIdsRef.current.add(activeTurnId);
  }, [activeTurnId]);

  /** after_turn 自动展开：仅本挂载 Live 轮的精确正常终态评估一次；后台/文档隐藏完成、被用户动作淘汰或本轮已关闭的候选只留结果尾部入口（判定 2/3/5/6/7）。 */
  useEffect(function autoOpenAfterTurnDeliveries() {
    if (isChat) return;
    const visible = canAutoOpenPreview({
      active,
      readOnly: Boolean(readOnlyReason),
      documentVisible: typeof document === "undefined" || document.visibilityState === "visible",
    });
    for (const item of presentation.items) {
      if (item.kind !== "turn_summary" || item.state !== "completed") continue;
      if (!liveTurnIdsRef.current.has(item.turnId)) continue;
      const delivery = evaluateAfterTurnCandidate(presentation, item.turnId);
      if (!delivery || delivery.autoOpen === false) continue;
      const admitted = admitAutoOpenPreview({
        suppression: previewSuppressionRef.current,
        consumed: autoOpenedPreviewRef.current,
        turnId: item.turnId,
        previewId: delivery.previewId,
        callId: delivery.callId,
        visible,
      });
      if (!admitted) continue;
      // 延后一拍触发，避免 effect 内同步 setState 造成级联渲染；终态评估仍在本效果内一次性完成。
      schedulePreviewOpen(delivery.previewId);
    }
  }, [presentation, isChat, active, readOnlyReason, schedulePreviewOpen]);

  /** 复制用户 Prompt 或模型回复，并为浏览器权限失败提供明确的短暂反馈。 */
  async function handleCopyMessage(messageId: string, content: string, label: "Prompt" | "回复"): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error("CLIPBOARD_UNAVAILABLE");
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      window.setTimeout(() => setCopiedMessageId((current) => current === messageId ? null : current), 1600);
      notice.success(`${label} 已复制`);
    } catch {
      notice.error("复制失败，请检查浏览器剪贴板权限");
    }
  }

  /** 在历史消息气泡内创建独立草稿；后续发送始终创建新消息，不改写历史。 */
  function handleEditPrompt(messageId: string, content: string) {
    setEditingPrompt({ messageId, content });
  }

  /** 发送气泡内编辑后的 Prompt，并立即退出历史编辑状态。 */
  function handleResendEditedPrompt(): void {
    const content = editingPrompt?.content.trim();
    if (!content || loading) return;
    setEditingPrompt(null);
    void handleSend(content);
  }

  /** 消息链路的预览接线；对象引用随面板状态变化，驱动新旧回答 memo 刷新。 */
  const workPreviewView = useMemo(function buildWorkPreviewView(): WorkPreviewViewProps | undefined {
    if (isChat) return undefined;
    const target = preview.sessionId === sessionId ? preview.state.target : null;
    return {
      panelPreviewId: preview.state.phase !== "closed" && target?.source === "tool_delivery" ? target.previewId ?? null : null,
      resolvingPreviewId: preview.sessionId === sessionId ? resolvingPreviewId : null,
      onTogglePreview: togglePreviewDelivery,
      onOpenInPreview: openPreviewLink,
    };
  // preview 进入依赖：面板打开/关闭/换目标都刷新消息链路的按钮状态。
  }, [isChat, sessionId, preview, resolvingPreviewId, togglePreviewDelivery, openPreviewLink]);

  const pendingApprovals = (isChat || readOnlyReason ? [] : presentation.items).filter((item): item is ApprovalItem => item.kind === "approval" && item.state === "required");
  const pendingApproval = pendingApprovals[pendingApprovals.length - 1];
  const pendingUserQuestions = (isChat || readOnlyReason ? [] : presentation.items).filter((item): item is UserQuestionItem => item.kind === "user_question" && item.state === "required");
  const pendingUserQuestion = pendingUserQuestions[pendingUserQuestions.length - 1];

  /** Diff 入口统计：消费全部 Turn 的安全 diff 事实求和（G1）；无编辑时为 undefined，入口隐藏。只读历史会话仍可查看（第七节契约）。 */
  const diffSections = isChat ? [] : selectDiffSections(presentation.items, "all", undefined);
  const diffEntryStats = diffSections.length > 0 ? diffSections.reduce(function sumDiffStats(acc, section) { return { added: acc.added + section.added, removed: acc.removed + section.removed }; }, { added: 0, removed: 0 }) : undefined;

  /** 将焦点交给用户主动选择查看的审批卡，不在 FreeScroll 时强制抢占阅读位置。 */
  function focusPendingApproval(): void {
    if (!pendingApproval) return;
    const approvalElement = document.getElementById(`approval-${pendingApproval.approvalId}`);
    approvalElement?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    const action = approvalElement?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    action?.focus();
  }

  /** 将焦点交给待回答的问题卡，不在 FreeScroll 状态下自动抢占用户阅读位置。 */
  function focusPendingUserQuestion(): void {
    if (!pendingUserQuestion) return;
    const questionElement = document.getElementById(`user-question-${pendingUserQuestion.requestId}`);
    questionElement?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    questionElement?.querySelector<HTMLButtonElement>("[role='radio']")?.focus();
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handleSend();
    }
  };

  const displayTitle = sessionMeta?.title || (sessionId ? "当前对话" : "新对话");

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg">
      {/* 顶部 */}
      <ChatPageHeader
        isChat={isChat}
        displayTitle={displayTitle}
        handleSidebarToggle={handleSidebarToggle}
        workspaceId={workspaceId}
        sessionId={sessionId}
        active={active}
        loading={loading}
        requestedJobId={requestedJobId}
        setRequestedJobId={setRequestedJobId}
        canWrite={canWrite}
        compacting={compacting}
        compactContext={compactContext}
        compactConfirmOpen={compactConfirmOpen}
        setCompactConfirmOpen={setCompactConfirmOpen}
        contextUsage={contextUsage}
        showSources={showSources}
        setShowSources={setShowSources}
        showProcess={showProcess}
        setShowProcess={setShowProcess}
        databaseEnabled={databaseEnabled}
        setDatabaseEnabled={setDatabaseEnabled}
        syncDatabase={syncDatabase}
        databaseSyncing={databaseSyncing}
        hasWorkspace={hasWorkspace}
        setPermissionPanelOpen={setPermissionPanelOpen}
        storageQuota={storageQuota}
        setStorageQuotaPanelOpen={setStorageQuotaPanelOpen}
        activeTurnId={activeTurnId}
        readOnlyReason={readOnlyReason}
        cancelCurrentTurn={cancelCurrentTurn}
        diffSidebarOpen={diffSidebarOpen}
        diffEntryStats={diffEntryStats}
        onDiffSidebarToggle={handleDiffSidebarToggle}
      />

      {/* History 瞬时加载失败提示条：实时内容已保留；仅同会话刷新失败提供手动重试，首次恢复失败由自动重试接管。 */}
      {historyError && sessionId && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b-2 border-ink bg-error/10 px-4 py-1.5 text-xs text-error">
          <span>{historyError.message}</span>
          {historyError.manualRetry && <button type="button" onClick={function retryHistory() { void loadHistory(sessionId); }} className="border-2 border-ink px-2 py-0.5 text-ink hover:bg-ink hover:text-ink-on-dark">重新加载</button>}
        </div>
      )}

      {/* 消息列表与输入区：md+ 与 Diff/预览右侧面板并排；预览打开时按会话比例分配双栏 */}
      <div ref={diffRowRef} className="flex min-h-0 flex-1 flex-row">
        <WorkPreviewLayout
          containerWidth={diffRowWidth}
          leftRatio={previewLeftRatio}
          onLeftRatioChange={handlePreviewLeftRatioChange}
          active={previewOpen}
          narrow={previewOpen && !previewDual}
          panel={previewOpen ? (
            <WorkPreviewPanel
              state={preview.state}
              narrow={!previewDual}
              toolbarRef={previewToolbarRef}
              onLoad={handlePreviewLoad}
              onEmbeddingTimeout={handlePreviewEmbeddingTimeout}
              onRefresh={refreshPreview}
              onClose={closePreviewPanel}
              onStop={function stopPreview() { void stopPreviewJob(); }}
            />
          ) : null}
        >
      <ChatMessageList
        isChat={isChat}
        messages={messages}
        sessionId={sessionId}
        loading={loading}
        submissionActivity={submissionActivity}
        currentRetrieval={currentRetrieval}
        knowledgeProgress={knowledgeProgress}
        pinnedSkills={pinnedSkills}
        getSkillDisplayName={getSkillDisplayName}
        togglePinnedSkill={togglePinnedSkill}
        storageQuota={storageQuota}
        setStorageQuotaPanelOpen={setStorageQuotaPanelOpen}
        presentation={presentation}
        refreshTransport={refreshTransport}
        isPinned={isPinned}
        unreadCount={unreadCount}
        showLatest={showLatest}
        pendingApproval={pendingApproval}
        pendingUserQuestion={pendingUserQuestion}
        focusPendingApproval={focusPendingApproval}
        focusPendingUserQuestion={focusPendingUserQuestion}
        containerRef={containerRef}
        contentRef={contentRef}
        handleScroll={handleScroll}
        workspaceId={workspaceId}
        workspace={workspace}
        canWrite={canWrite}
        showProcess={showProcess}
        renderEvidence={renderEvidence}
        activity={activity}
        setRequestedJobId={setRequestedJobId}
        handleApproval={handleApproval}
        handleUserQuestion={handleUserQuestion}
        stopping={stopping}
        cancelCurrentTurn={cancelCurrentTurn}
        handleContinueTurn={handleContinueTurn}
        editingPrompt={editingPrompt}
        setEditingPrompt={setEditingPrompt}
        handleResendEditedPrompt={handleResendEditedPrompt}
        handleCopyMessage={handleCopyMessage}
        copiedMessageId={copiedMessageId}
        handleEditPrompt={handleEditPrompt}
        setSelectedImage={setSelectedImage}
        readOnlyReason={readOnlyReason}
        workPreview={workPreviewView}
      />

      {/* 输入区：粗黑边框 + 直角 */}
      <ChatComposer
        pendingInputs={pendingInputs}
        cancelPendingInput={cancelPendingInput}
         setInputDelivery={setInputDelivery}
         textareaRef={textareaRef}
         inputRef={composerInputRef}
         inputActionsRef={composerInputActionsRef}
        inputDeliveryNotice={inputDeliveryNotice}
        readOnlyReason={readOnlyReason}
        isChat={isChat}
        loading={loading}
        submissionActivity={submissionActivity}
        currentRetrieval={currentRetrieval}
        requestAbortRef={requestAbortRef}
        chatAttachments={chatAttachments}
        sessionId={sessionId}
        selectedFiles={selectedFiles}
        setSelectedFiles={setSelectedFiles}
        onOpenWorkspacePicker={onOpenWorkspacePicker}
        workspace={workspace}
        setSkillPickerOpen={setSkillPickerOpen}
        selectedSkills={selectedSkills}
        getSkillDisplayName={getSkillDisplayName}
        toggleSelectedSkill={toggleSelectedSkill}
        togglePinnedSkill={togglePinnedSkill}
        showSources={showSources}
        setShowSources={setShowSources}
        showProcess={showProcess}
        setShowProcess={setShowProcess}
        databaseEnabled={databaseEnabled}
        setDatabaseEnabled={setDatabaseEnabled}
        onRetrievalChange={onRetrievalChange}
        hasWorkspace={hasWorkspace}
        fileInputRef={fileInputRef}
        handleFileSelect={handleFileSelect}
        handleDragEnter={handleDragEnter}
        handleDragOver={handleDragOver}
        handleDragLeave={handleDragLeave}
        handleDrop={handleDrop}
        pendingUserQuestion={pendingUserQuestion}
        canWrite={canWrite}
         handleKeyDown={handleKeyDown}
        activeTurnId={activeTurnId}
        handleSend={handleSend}
        handleContinueTurn={handleContinueTurn}
        resumableMessageId={resumableMessageId}
        stopping={stopping}
        cancelCurrentTurn={cancelCurrentTurn}
        databaseSyncMessage={databaseSyncMessage}
        databaseSyncing={databaseSyncing}
        databaseSyncElapsedSeconds={databaseSyncElapsedSeconds}
        inputDelivery={inputDelivery}
      />
        </WorkPreviewLayout>
        {diffSidebarOpen && <DiffSidebarDivider width={diffSidebarWidth} onChange={handleDiffSidebarWidthChange} />}
        {!isChat && <DiffSidebar open={diffSidebarOpen} onClose={closeDiffSidebar} width={diffSidebarWidth} items={presentation.items} activeTurnId={activeTurnId} />}
      </div>
      {!isChat && <PermissionPanel workspaceId={workspaceId} sessionId={sessionId} open={permissionPanelOpen} onClose={() => setPermissionPanelOpen(false)} />}
      {!isChat && <SkillPicker open={skillPickerOpen} skills={skillCatalog} selectedSkillRefs={selectedSkills.map((skill) => skill.skillRef)} pinnedSkillRefs={pinnedSkills.map((skill) => skill.skillRef)} onSelect={toggleSelectedSkill} onTogglePin={togglePinnedSkill} onClose={function closeSkillPicker() { setSkillPickerOpen(false); }} />}
      {storageQuotaPanelOpen && storageQuota && <StorageQuotaPanel open quota={storageQuota} onClose={() => setStorageQuotaPanelOpen(false)} onUpdated={updateStorageQuota} />}
      <ChatImagePreview selectedImage={selectedImage} setSelectedImage={setSelectedImage} />
    </div>
  );
}
