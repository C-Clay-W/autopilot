/** chat-page-content.tsx — 单 Session 装配层：组合四组现有 Hook 与叶子 UI 组件，只保留必要装配与跨区域派生值，不新增业务判断。 */
"use client";

import { useCallback, useState, useRef, useEffect, type ReactNode } from "react";
import PermissionPanel from "./components/PermissionPanel";
import StorageQuotaPanel from "./components/StorageQuotaPanel";
import SkillPicker from "./components/SkillPicker";
import ChatPageHeader from "./components/ChatPageHeader";
import ChatMessageList from "./components/ChatMessageList";
import ChatComposer from "./components/ChatComposer";
import ChatImagePreview from "./components/ChatImagePreview";
import DiffSidebar from "./components/DiffSidebar";
import DiffSidebarDivider from "./components/DiffSidebarDivider";
import { selectDiffSections } from "./components/diff-sidebar-model";
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
    transportDisconnectedRef,
  });

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
    setDiffSidebarOpenSessionId(diffSidebarOpen ? null : sessionId);
  }

  /** 关闭 Diff 侧边栏（Esc 与关闭按钮共用），并把焦点还给头部入口按钮（对齐 Context 面板焦点规范）。 */
  function closeDiffSidebar(): void {
    setDiffSidebarOpenSessionId(null);
    document.getElementById("diff-sidebar-trigger")?.focus();
  }

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

      {/* 消息列表与输入区：md+ 与 Diff 侧边栏并排；窄屏 Diff 为全屏 overlay，不占布局位 */}
      <div ref={diffRowRef} className="flex min-h-0 flex-1 flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
        cancelCurrentTurn={cancelCurrentTurn}
        databaseSyncMessage={databaseSyncMessage}
        databaseSyncing={databaseSyncing}
        databaseSyncElapsedSeconds={databaseSyncElapsedSeconds}
        inputDelivery={inputDelivery}
      />
        </div>
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
