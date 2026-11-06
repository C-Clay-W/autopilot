/** useConversationSubmission.ts — 文件选择、拖拽、附件上传、创建 Session 与 handleSend 的连续逻辑；自原 page.tsx 原样迁入，不重排分支。 */
"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { canContinueUi, type UiContinuation, type UiContinueRequest, type UiContinueTarget } from "../components/interactive-ui/continue-chat";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { uploadChatKnowledge } from "@/lib/knowledge-ingest-client";
import { getKnowledgeIngestProcessStep } from "../components/KnowledgeIngestProgress";
import { readConversationTarget, sessionApiUrl } from "../conversation-target";
import type { ChatRetrievalMode, ToolPermissionMode } from "@autopilot-agent/core";
import { useSessionTaskContext } from "../session-task-context";
import { createWorkspaceSessionKey } from "../session-task-store";
import { isContinueCommand, isTransportFailure, resetComposerHeight } from "../chat-page-helpers";
import { useNotice } from "../components/Notice";
import type {
  Message,
  SelectedFile,
  SessionImageAttachment,
  PendingAgentInput,
  ChatAttachmentView,
  ComposerInputActions,
  SessionHistoryPayload,
} from "../chat-page-types";
import type {
  WebSessionDto as SessionMeta,
  WebSessionPinnedSkill as SessionPinnedSkill,
} from "@/lib/runtime-host/web-ui-dto";
import type { WebActivityState } from "@/lib/runtime-host/web-activity";
import { capturePresentationInputPosition, reducePresentationInput, type AgentPresentationState, type TransportState } from "@autopilot-agent/presentation";
import type { SessionTaskController, SessionTaskStreamOutcome } from "../session-task-controller";
import type { ProcessStep } from "../components/process-step";

interface UseConversationSubmissionOptions {
  isChat: boolean;
  active?: boolean;
  workspaceId: string;
  sessionId: string;
  hasWorkspace: boolean;
  canWrite: boolean;
  currentRetrieval: ChatRetrievalMode;
  loading: boolean;
  activeTurnId: string;
  messages: Message[];
  presentation: AgentPresentationState;
  setPresentation: Dispatch<SetStateAction<AgentPresentationState>>;
  currentSessionIdRef: RefObject<string>;
  currentWorkspaceIdRef: RefObject<string>;
  cancelledTurnIdsRef: RefObject<Set<string>>;
  historyInputIdsRef: RefObject<Set<string>>;
  activeTurnRef: RefObject<{ sessionId: string; turnId: string } | null>;
  databaseEnabled: boolean;
  /** Work 会话的工具权限模式；随 POST 持久化为会话缺省。 */
  permissionMode: ToolPermissionMode;
  selectedSkills: { skillRef: string; arguments?: string; pinned?: boolean }[];
  setSelectedSkills: Dispatch<SetStateAction<{ skillRef: string; arguments?: string; pinned?: boolean }[]>>;
  setPinnedSkills: Dispatch<SetStateAction<SessionPinnedSkill[]>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  inputRef: RefObject<string>;
  inputActionsRef: RefObject<ComposerInputActions | null>;
  onOpenWorkspacePicker: () => void;
  onSessionStarting: () => void;
  onSessionCreated: (sessionId: string) => void;
  handleContinueTurn: (messageId: string) => Promise<void>;
  /** 只读发现宿主在上一轮之后启动的排队 Turn；页面不领取、不启动。 */
  requestFollowQueuedTurn: (previousTurnId: string | null) => Promise<void>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setLoading: (loading: boolean) => void;
  setSessionMeta: (sessionMeta: SessionMeta | null) => void;
  setHistoryReady: (historyReady: boolean) => void;
  setReadOnlyReason: Dispatch<SetStateAction<string | undefined>>;
  setChatAttachments: Dispatch<SetStateAction<ChatAttachmentView[]>>;
  setPendingInputs: Dispatch<SetStateAction<PendingAgentInput[]>>;
  setInputDeliveryNotice: Dispatch<SetStateAction<import("../chat-page-types").InputDeliveryNotice | null>>;
  setStreamingMessageId: (streamingMessageId: string) => void;
  setActivity: Dispatch<SetStateAction<WebActivityState | undefined>>;
  setTransportState: (transport: TransportState) => void;
  clearActiveTurn: () => void;
  loadHistory: (sid: string, prefetchedData?: SessionHistoryPayload) => Promise<boolean>;
  consumeAgentStream: (response: Response, messageId: string, sid: string) => Promise<SessionTaskStreamOutcome>;
  getSessionController: (sid: string) => SessionTaskController;
  requestAbortRef: RefObject<AbortController | null>;
  cancelRequestedRef: RefObject<boolean>;
  cancelInFlightRef: RefObject<Promise<void> | null>;
  locallyCreatedSessionRef: RefObject<string | null>;
  joinedInputIdsRef: RefObject<Set<string>>;
  pendingInputsRef: RefObject<PendingAgentInput[]>;
  /** 上一轮成功完成时的 turnId；队列发现以它为基准，避免把已完成轮当新 Turn。 */
  queuedFollowUpTurnIdRef: RefObject<string | null>;
  awaitingApprovalRef: RefObject<boolean>;
  awaitingUserInputRef: RefObject<boolean>;
  /** 执行代次：开始/停止/继续共用，旧请求的 finally 只能清理自己的执行段（H2）。 */
  executionEpochRef: RefObject<number>;
  transportDisconnectedRef: RefObject<boolean>;
}

/** 共用传输地址解析；Chat 作用域永远不发送到 Work API。 */
const getWorkspaceSessionUrl = sessionApiUrl;

/** 只把完整且合法的队列确认视为服务端已确认接收。 */
function hasInputConfirmation(value: Partial<PendingAgentInput> | null): value is Partial<PendingAgentInput> & Pick<PendingAgentInput, "inputId" | "delivery" | "status"> {
  return Boolean(value && typeof value.inputId === "string" && value.inputId.trim() && (value.delivery === "steer" || value.delivery === "queue") && (value.status === "pending" || value.status === "claimed"));
}

/** 承接原 ChatPageContent 的发送链路；语句顺序、请求体与分支结构保持不变。 */
export function useConversationSubmission(options: UseConversationSubmissionOptions) {
  const {
    isChat,
    workspaceId,
    sessionId,
    hasWorkspace,
    canWrite,
    currentRetrieval,
    loading,
    activeTurnId,
    messages,
    databaseEnabled,
    permissionMode,
    selectedSkills,
    setSelectedSkills,
    setPinnedSkills,
    textareaRef,
    inputRef,
    inputActionsRef,
    onOpenWorkspacePicker,
    onSessionStarting,
    onSessionCreated,
    handleContinueTurn,
    requestFollowQueuedTurn,
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
    pendingInputsRef,
    queuedFollowUpTurnIdRef,
    awaitingApprovalRef,
    awaitingUserInputRef,
    executionEpochRef,
    transportDisconnectedRef,
  } = options;
  const { manager, refreshSessions } = useSessionTaskContext();
  const notice = useNotice();
  const inputOrderRef = useRef(0);
  const chatSendLockedRef = useRef(false);
  const latestUiOptionsRef = useRef(options);
  // 与现有身份 ref 一致，同步读取最新前台/归属/可写状态，避免旧 memo 回调误投。
  latestUiOptionsRef.current = options;
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [knowledgeProgress, setKnowledgeProgress] = useState<ProcessStep[]>([]);
  const [submissionActivity, setSubmissionActivity] = useState<"answer" | "upload">("answer");
  const [inputDelivery, setInputDelivery] = useState<"steer" | "queue">("steer");

  /** 更新 Composer 的本地输入；失败恢复和发送清空都不触发页面装配层重渲染。 */
  function setComposerInput(value: string): void {
    inputRef.current = value;
    inputActionsRef.current?.setInput(value);
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (!canWrite) return;
    if (!isChat && Array.from(files).some((file) => !isImage(file.name))) { notice.error("Work 仅上传任务图片；其他任务文件请放在工作区内供 Agent 读取"); return; }
    const picked = Array.from(files).map((f) => ({ name: f.name, size: f.size, file: f }));
    setSelectedFiles((prev) => [...prev, ...picked]);
    e.target.value = "";
  };

  const handleDragEnter = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    if (!canWrite) return;
    if (!isChat && Array.from(files).some((file) => !isImage(file.name))) { notice.error("Work 仅上传任务图片；其他任务文件请放在工作区内供 Agent 读取"); return; }
    if (files.length > 0) {
      const picked = Array.from(files).map((f) => ({ name: f.name, size: f.size, file: f }));
      setSelectedFiles((prev) => [...prev, ...picked]);
    }
  };

  const isImage = (name: string) => /\.(png|jpe?g|webp|gif)$/i.test(name);

  /** Upload one image as a session attachment without sending it to the RAG ingestion routes. */
  async function uploadSessionImage(sid: string, file: File, persist: boolean): Promise<SessionImageAttachment> {
    const formData = new FormData();
    formData.append("file", file);
    if (persist && !isChat) formData.append("persist", "true");
    const response = await fetch(getWorkspaceSessionUrl(workspaceId, sid, isChat ? "/attachments" : "/uploads")!, { method: "POST", body: formData });
    console.log(response);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "图片上传失败" }));
      throw new Error(payload.error || "图片上传失败");
    }
    const payload = await response.json() as { attachment: SessionImageAttachment & ChatAttachmentView & { gifFirstFrame?: boolean } };
    if (isChat) {
      setChatAttachments((current) => [...current, payload.attachment]);
      return { id: payload.attachment.ref, name: payload.attachment.displayName, mimeType: payload.attachment.mimeType };
    }
    if (payload.attachment.gifFirstFrame) notice.warning("GIF 图片仅发送静态首帧");
    return payload.attachment;
  }

  // 发消息：如果有 sessionId 直接发；如果没有先创建会话
  async function sendConversation(overrideContent?: string, uiTarget?: UiContinueTarget) {
    if (!hasWorkspace) {
      onOpenWorkspacePicker();
      return;
    }
    // 发送前置校验：只读/生成中、等待用户回答、空内容、取消收口中、竞态，任一命中都直接拦住
    // cr by clayw on 20260909
    if (!canWrite || (isChat && loading)) return;
    if (awaitingUserInputRef.current) return;
    const content = (overrideContent ?? inputRef.current).trim();
    const initialDraftId = new URLSearchParams(window.location.search).get("draft") || "";
    if (!content && selectedFiles.length === 0) return;
    if (!isChat && selectedFiles.length > 10) { notice.error("一次最多发送 10 张图片"); return; }
    if (cancelInFlightRef.current) {
      // 停止在途时不得抢跑，也不能静默丢弃用户动作（H2）。
      notice.warning("任务正在停止，请等待服务端确认后再发送");
      return;
    }

    /** 检查异步请求仍属于当前工作区与会话，兼容首次创建尚未完成导航。 */
    function isCurrentWorkDraft(): boolean {
      return options.currentWorkspaceIdRef.current === workspaceId && (options.currentSessionIdRef.current === sid || (!options.currentSessionIdRef.current && locallyCreatedSessionRef.current === sid));
    }

    /** 只在发起请求的会话仍处于前台时继续尚未提交的 Work 输入。 */
    function isActiveWorkDraft(): boolean {
      const params = new URLSearchParams(window.location.search);
      const target = readConversationTarget(params);
      return isCurrentWorkDraft() && target.productMode === "work" && target.scope === workspaceId
        && (target.sessionId === sid || (!sessionId && !target.sessionId && (params.get("draft") || "") === initialDraftId));
    }

    /** 迟到请求只能恢复到所属工作区和会话，并保留用户随后输入的新草稿。 */
    function restoreWorkDraft(): void {
      if (isChat || !isCurrentWorkDraft()) return;
      if (content) setComposerInput(inputRef.current ? `${content}\n${inputRef.current}` : content);
      setSelectedFiles(function restore(previous) { return [...files, ...previous]; });
    }
    /** 在原草稿槽中恢复创建失败的输入，同时保留用户后来编辑的内容。 */
    function restoreUncreatedWorkDraft(): void {
      if (isChat || options.currentWorkspaceIdRef.current !== workspaceId || options.currentSessionIdRef.current !== sessionId) return;
      if (content) setComposerInput(inputRef.current ? `${content}\n${inputRef.current}` : content);
      setSelectedFiles(function restore(previous) { return [...files, ...previous]; });
    }
    // 查找那条可续跑的消息
    const resumableMessage = [...messages].reverse().find((message) => message.role === "assistant" && message.canContinue && Boolean(message.turnId));
    if (!isChat && !loading && !overrideContent && sessionId && selectedFiles.length === 0 && selectedSkills.length === 0 && isContinueCommand(content) && resumableMessage) {
      setComposerInput("");
      resetComposerHeight(textareaRef.current);
      void handleContinueTurn(resumableMessage.id);
      return;
    }

    // 唯一允许在 loading 中继续发送的情形：Work 模式 + 有活动 turn + 会话已建立 + 非内部改写内容 → 这就是 steer/queue 追加提问
    const isSubmittingToActiveTurn = Boolean(!isChat && loading && activeTurnId && sessionId && !overrideContent);
    if (loading && !isSubmittingToActiveTurn) return;

    const files = uiTarget ? [] : selectedFiles;
    const selectedSkillsForRequest = uiTarget ? [] : selectedSkills;
    const mkId = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    /** 本函数认领的执行代次；只有发起新 Turn 的发送才拥有执行段（steer/queue 追加不认领）。 */
    let ownedExecutionEpoch: number | null = null;
    const submittedAt = Date.now();
    const inputPosition = isSubmittingToActiveTurn ? capturePresentationInputPosition(options.presentation, activeTurnId, inputOrderRef.current++) : undefined;
    const hasUploadFiles = files.length > 0;

    if (!isSubmittingToActiveTurn) {
      setLoading(true);
      setSubmissionActivity(hasUploadFiles ? "upload" : "answer");
    }
    if (!uiTarget) {
      setComposerInput("");
      resetComposerHeight(textareaRef.current);
      setSelectedFiles([]);
    }

    // 确保有 sessionId
    let sid = sessionId;
    if (!sid) {
      onSessionStarting();
      try {
        if (!workspaceId) {
          setLoading(false);
          onOpenWorkspacePicker();
          return;
        }
        const res = await fetch(getWorkspaceSessionUrl(workspaceId)!, { method: "POST", ...(isChat ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatRetrievalMode: currentRetrieval }) } : {}) });
        console.log(res);
        if (!isChat && (options.currentWorkspaceIdRef.current !== workspaceId || options.currentSessionIdRef.current !== sessionId)) { restoreUncreatedWorkDraft(); return; }
        if (!res.ok) {
          const failure = await res.json().catch(() => ({}));
          notice.error(failure.error || "创建会话失败");
          setLoading(false);
          if (isChat) { setComposerInput(content); setSelectedFiles(files); }
          else restoreUncreatedWorkDraft();
          return;
        }
        const meta = await res.json();
        setSessionMeta(meta);
        setHistoryReady(true);
        sid = meta.id;
        manager.syncWorkspaceSessions(workspaceId, [...manager.getListSnapshot().filter((item) => item.workspaceId === workspaceId).map((item) => item.session), meta]);
        locallyCreatedSessionRef.current = sid;
        onSessionCreated(sid);
        void refreshSessions(workspaceId);
        if (!isChat && !isActiveWorkDraft()) { restoreWorkDraft(); setLoading(false); return; }
      } catch {
        if (!isChat && (options.currentWorkspaceIdRef.current !== workspaceId || options.currentSessionIdRef.current !== sessionId)) { restoreUncreatedWorkDraft(); return; }
        notice.error("创建会话失败，请重试");
        if (isChat) { setComposerInput(content); setSelectedFiles(files); }
        else restoreUncreatedWorkDraft();
        setLoading(false);
        return;
      }
    }

    // rag 上传由用户触发正式入库；其他模式继续使用原临时/任务附件机制。
    if (isChat && currentRetrieval === "rag" && files.length) {
      // 入库上传可被 Esc 或取消按钮中断，使用独立 AbortController。
      const uploadController = new AbortController();
      requestAbortRef.current = uploadController;
      let uploadedFileCount = 0;
      try {
        for (const file of files) {
          setKnowledgeProgress([{ stage: "upload", message: `正在上传 ${file.name}` }]);
          const terminal = await uploadChatKnowledge(file.file, function progress(event) { setKnowledgeProgress([getKnowledgeIngestProcessStep(event)]); }, sid, uploadController.signal);
          if (terminal.status === "failed" || terminal.status === "cancelled") throw new Error(terminal.message);
          uploadedFileCount += 1;
          notice.success(terminal.status === "partial" ? "资料已部分入库，请在知识管理中查看失败页" : "资料已加入私有知识库");
        }
      } catch (error) {
        notice.error(uploadController.signal.aborted ? "入库已取消" : error instanceof Error ? error.message : "入库失败");
        setSelectedFiles(files.slice(uploadedFileCount));
        setComposerInput(content); setLoading(false); return;
      } finally { if (requestAbortRef.current === uploadController) requestAbortRef.current = null; setKnowledgeProgress([]); }
    }
    // none/web 文档和图片进入临时附件；Work 仅使用任务图片链。

    const attachments: SessionImageAttachment[] = [];
    const attachmentFiles = isChat && currentRetrieval === "rag" ? [] : files;
    for (const [index, file] of attachmentFiles.entries()) {
      try { attachments.push(await uploadSessionImage(sid, file.file, false)); }
      catch (error) {
        if (!isChat && !isCurrentWorkDraft()) return;
        notice.error(error instanceof Error ? error.message : "附件上传失败");
        if (isChat) { setComposerInput(content); setSelectedFiles(attachmentFiles.slice(index)); }
        else restoreWorkDraft();
        if (!isSubmittingToActiveTurn) setLoading(false);
        return;
      }
      if (!isChat && !isActiveWorkDraft()) { restoreWorkDraft(); if (!isSubmittingToActiveTurn) setLoading(false); return; }
    }
    if (!isChat && !isActiveWorkDraft()) { restoreWorkDraft(); if (!isSubmittingToActiveTurn) setLoading(false); return; }
    if (!isSubmittingToActiveTurn) setSubmissionActivity("answer");
    const agentContent = content || (!isChat && attachments.length ? "请分析这些图片。" : "");
    const optimisticUserId = mkId("u");
    if (!isSubmittingToActiveTurn && (content || (!isChat && attachments.length))) {
      setMessages((prev) => [...prev, { id: optimisticUserId, role: "user", content: agentContent, attachments: isChat ? undefined : attachments, optimistic: true, createdAt: submittedAt }]);
    }

    // 有文本统一提交 /messages：202 表示加入队列，SSE 表示流式回答；Chat/Work 与 RAG 的差异由请求体和服务端 session 元数据决定。
    if (agentContent) {
      if (isSubmittingToActiveTurn) {
        const position = inputPosition!;
        /** 旧请求仅能回写其提交时的 Session 与工作区。 */
        function isCurrentInputTarget(): boolean { return options.currentSessionIdRef.current === sid && options.currentWorkspaceIdRef.current === workspaceId; }
        let submissionUncertain = true;
        try {
          if (!isCurrentInputTarget()) return;
          const clientMessageId = mkId("input");
          const response = await fetch(getWorkspaceSessionUrl(workspaceId, sid, "/messages")!, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: agentContent, clientMessageId, delivery: inputDelivery, attachmentIds: attachments.map((attachment) => attachment.id), databaseSearchEnabled: databaseEnabled, permissionMode, selectedSkills: selectedSkillsForRequest }),
          });
          console.log(response);
          const payload = (await response.json().catch(function invalidResponse() { return null; })) as (Partial<PendingAgentInput> & { error?: string; code?: string; turnId?: string }) | null;
          if (!isCurrentInputTarget()) return;
          if (!response.ok) submissionUncertain = false;
          if (!response.ok && payload?.code === "active_turn_finished") {
            if (options.activeTurnRef.current && options.activeTurnRef.current.turnId !== position.turnId) return;
            clearActiveTurn();
            setLoading(false);
            restoreWorkDraft();
            setMessages((current) => [...current, { id: mkId("input-retry"), role: "assistant", content: "上一任务已经结束，已将输入放回输入框，请重新发送。" }]);
            await loadHistory(sid);
            return;
          }
          if (!response.ok) throw new Error(payload?.error || "输入未能加入任务队列");
          const responseTurnId = typeof payload?.turnId === "string" ? payload.turnId : position.turnId;
          if (!hasInputConfirmation(payload)) throw new Error("输入确认缺失");
          submissionUncertain = false;
          const cancelled = Boolean(position.turnId && options.cancelledTurnIdsRef.current.has(position.turnId)) || (options.activeTurnRef.current?.turnId === position.turnId && cancelRequestedRef.current);
          options.setPresentation(function confirmInput(current) {
            if (!isCurrentInputTarget()) return current;
            if (options.historyInputIdsRef.current.has(payload.inputId!)) return current;
            const prior = current.items.find(function input(item) { return item.kind === "input_notice" && item.inputId === payload.inputId; });
            if (payload.delivery === "queue" && !(prior?.kind === "input_notice" && (prior.state === "consumed" || prior.state === "joined"))) return current;
            if (!responseTurnId && !(prior && "turnId" in prior)) return current;
            return reducePresentationInput(current, { kind: "host_event", event: { kind: "input", input: { inputId: payload.inputId!, turnId: responseTurnId ?? (prior as { turnId: string }).turnId, delivery: payload.delivery, content: agentContent, position: payload.delivery === "queue" ? { items: [], order: -1 } : position, state: "queued", cancelled: cancelled && !(prior?.kind === "input_notice" && prior.state !== "queued") } } });
          });
          const pendingInput: PendingAgentInput = {
            inputId: payload.inputId,
            clientMessageId,
            delivery: payload.delivery,
            status: payload.status as "pending" | "claimed",
            content: agentContent,
            attachmentCount: attachments.length,
            skillCount: selectedSkillsForRequest.length,
            createdAt: Date.now(),
          };
          const alreadyJoined = joinedInputIdsRef.current.has(pendingInput.inputId);
          if (!alreadyJoined && !cancelled) {
            const nextPendingInputs = pendingInputsRef.current.some((item) => item.inputId === pendingInput.inputId)
              ? pendingInputsRef.current
              : [...pendingInputsRef.current, pendingInput];
            pendingInputsRef.current = nextPendingInputs;
            setPendingInputs(nextPendingInputs);
            setInputDeliveryNotice({ delivery: payload.delivery, content: agentContent, status: "accepted" });
          }
          setSelectedSkills((current) => current.filter((skill) => skill.pinned));
        } catch (error) {
          if (!isCurrentInputTarget()) return;
          restoreWorkDraft();
          setMessages((current) => [...current, { id: mkId("input-error"), role: "assistant", content: submissionUncertain ? "提交状态未确认，草稿已恢复；请先检查会话记录再决定是否重发。" : `输入加入失败：${error instanceof Error ? error.message : "未知错误"}` }]);
        }
        return;
      }
      // 点击目标必须在实际提交前仍然存在且属于当前可写前台实例。
      if (uiTarget && !isCurrentUiTarget(uiTarget)) { setLoading(false); return; }
      const aiId = mkId("a");
      ownedExecutionEpoch = executionEpochRef.current + 1;
      executionEpochRef.current = ownedExecutionEpoch;
      /** Work 回写必须仍属于发起会话及当前执行段；Chat 沿用原有行为。 */
      function ownsExecution(): boolean {
        return isChat || (isCurrentWorkDraft() && executionEpochRef.current === ownedExecutionEpoch);
      }
      const abortController = getSessionController(sid).createAbortController();
      requestAbortRef.current = abortController;
      cancelRequestedRef.current = false;
      setStreamingMessageId(aiId);
      setMessages((prev) => [...prev, {
        id: aiId,
        role: "assistant",
        content: "",
        activity: "answer",
        processSteps: [{ stage: "prepare", message: "正在启动任务" }],
        optimistic: true,
        createdAt: Date.now(),
      }]);
      setActivity(undefined);
      let responseReceived = false;
      try {
        const clientMessageId = mkId("message");
        const res = await fetch(getWorkspaceSessionUrl(workspaceId, sid, "/messages")!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify(isChat
            ? { content: agentContent, clientMessageId }
            : {
              content: agentContent,
              clientMessageId,
              delivery: "auto",
              attachmentIds: attachments.map((attachment) => attachment.id),
              databaseSearchEnabled: databaseEnabled,
              permissionMode,
              selectedSkills: selectedSkillsForRequest,
            }),
        });
        console.log(res);
        responseReceived = true;
        if (!ownsExecution()) return;

        if (res.status === 202) {
          // 202 语义由字段区分：带 turnId 是宿主已接受的执行，带 delivery 是排队/引导输入。
          const payload = (await res.json().catch(function invalidResponse() { return null; })) as (Partial<PendingAgentInput> & { turnId?: string }) | null;
          if (!ownsExecution()) return;
          // Work 统一 Runner：202 只携带 turnId 表示执行已被宿主接受，页面改用只读观察流。
          if (!isChat && payload && typeof payload.turnId === "string" && payload.delivery === undefined) {
            manager.beginSession(createWorkspaceSessionKey(workspaceId, sid));
            if (!uiTarget) {
              setSelectedSkills((current) => current.filter((skill) => skill.pinned));
              setPinnedSkills((current) => current.filter((skill) => selectedSkillsForRequest.some((selected) => selected.skillRef === skill.skillRef && selected.pinned)));
            }
            const streamUrl = getWorkspaceSessionUrl(workspaceId, sid, `/stream?turnId=${encodeURIComponent(payload.turnId)}`);
            const streamResponse = await fetch(streamUrl!, { cache: "no-store", signal: abortController.signal });
            if (!ownsExecution()) return;
            const streamOutcome = await consumeAgentStream(streamResponse, aiId, sid);
            if (!ownsExecution()) return;
            if (streamOutcome === "ended_without_terminal") void loadHistory(sid);
            // 202 观察流同样需要释放本执行段并继续观察宿主排队 Turn。
            setLoading(false);
            if (queuedFollowUpTurnIdRef.current) {
              const completedTurnId = queuedFollowUpTurnIdRef.current;
              queuedFollowUpTurnIdRef.current = null;
              window.setTimeout(function followHostQueuedTurn() { void requestFollowQueuedTurn(completedTurnId); }, 0);
            }
            return;
          }
          if (!hasInputConfirmation(payload)) {
            if (!isChat && !uiTarget && isCurrentWorkDraft()) {
              restoreWorkDraft();
              notice.warning("提交状态未确认，草稿已恢复；请先检查会话记录再决定是否重发");
            }
            setMessages(function markUnconfirmed(current) { return current.map(function mark(message) { return message.id === aiId ? { ...message, content: "提交状态未确认，请先检查会话记录。", activity: undefined, processSteps: undefined } : message; }); });
            setLoading(false);
            return;
          }
          setMessages((current) => current.filter((message) => message.id !== aiId));
          const pendingInput: PendingAgentInput = {
            inputId: payload.inputId,
            clientMessageId,
            delivery: payload.delivery,
            status: payload.status as "pending" | "claimed",
            content: agentContent,
            attachmentCount: attachments.length,
            skillCount: selectedSkillsForRequest.length,
            createdAt: Date.now(),
          };
          const alreadyJoined = joinedInputIdsRef.current.has(pendingInput.inputId);
          if (!alreadyJoined && !cancelRequestedRef.current) {
            const nextPendingInputs = pendingInputsRef.current.some((item) => item.inputId === pendingInput.inputId)
              ? pendingInputsRef.current
              : [...pendingInputsRef.current, pendingInput];
            pendingInputsRef.current = nextPendingInputs;
            setPendingInputs(nextPendingInputs);
            setInputDeliveryNotice({ delivery: payload.delivery, content: agentContent, status: "accepted" });
          }
          void loadHistory(sid);
          setLoading(false);
          return;
        }

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
          if (!ownsExecution()) return;
          if (errData.code === "WORK_HISTORY_READ_ONLY") setReadOnlyReason("WORK_HISTORY_READ_ONLY");
          if (errData.code === "WORKSPACE_NOT_TRUSTED") setReadOnlyReason("工作区信任已失效，请重新选择并确认工作区");
          if (!uiTarget && isCurrentWorkDraft()) {
            restoreWorkDraft();
            setMessages(function removeRejectedInput(current) { return current.filter(function keep(message) { return message.id !== optimisticUserId; }); });
          }
          setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, content: `分析失败：${errData.error || `${res.status} ${res.statusText}`}`, activity: undefined, processSteps: undefined } : m)));
          setStreamingMessageId("");
          setLoading(false);
          if (uiTarget && (errData.code === "CHAT_MESSAGE_ALREADY_SUBMITTED" || res.status >= 500)) {
            setTransportState("disconnected");
            await loadHistory(sid);
          }
          return;
        }

        if (!res.body) {
          setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, content: "分析失败：响应体为空", activity: undefined, processSteps: undefined } : m)));
          setStreamingMessageId("");
          setLoading(false);
          if (uiTarget) { setTransportState("disconnected"); await loadHistory(sid); }
          return;
        }
        manager.beginSession(createWorkspaceSessionKey(workspaceId, sid));
        if (!uiTarget) {
          setSelectedSkills((current) => current.filter((skill) => skill.pinned));
          setPinnedSkills((current) => current.filter((skill) => selectedSkillsForRequest.some((selected) => selected.skillRef === skill.skillRef && selected.pinned)));
        }
        // SSE 已收到终点后先释放当前页面交互；终态明确或已原子校准时本地投影完整，不再额外请求完整 History。
        const streamOutcome = await consumeAgentStream(res, aiId, sid);
        if (!ownsExecution()) return;
        if (streamOutcome === "ended_without_terminal") void loadHistory(sid);
      } catch (err) {
        if (!ownsExecution()) return;
        const cancelled = cancelRequestedRef.current || abortController.signal.aborted;
        const disconnected = !cancelled && isTransportFailure(err);
        if (!isChat && !uiTarget && !cancelled && !responseReceived && isCurrentWorkDraft()) {
          restoreWorkDraft();
          notice.warning("提交状态未确认，草稿已恢复；请先检查会话记录再决定是否重发");
        }
        if (disconnected) setTransportState("disconnected");
        setMessages((prev) => prev.map((m) => (
          m.id === aiId
            ? cancelled
              ? { ...m, content: "用户已取消", activity: undefined, processSteps: undefined, sources: undefined }
              : disconnected
                ? { ...m, activity: undefined, processSteps: undefined }
                : { ...m, content: `分析失败：${err instanceof Error ? err.message : "未知错误"}`, activity: undefined, processSteps: undefined, sources: undefined }
            : m
        )));
        if (uiTarget && !cancelled) { setTransportState("disconnected"); await loadHistory(sid); }
      } finally {
        if (requestAbortRef.current === abortController) requestAbortRef.current = null;
        if (ownsExecution() && locallyCreatedSessionRef.current === sid) locallyCreatedSessionRef.current = null;
        // 旧发送的收尾只清理自己认领的执行段，不覆盖后来续接的 loading/active（H2）。
        if (ownsExecution() && executionEpochRef.current === ownedExecutionEpoch) {
          setStreamingMessageId("");
          cancelRequestedRef.current = false;
          if (!awaitingApprovalRef.current && !awaitingUserInputRef.current && !transportDisconnectedRef.current) clearActiveTurn();
        }
      }
      if (!ownsExecution()) return;
    }
    if (!agentContent && locallyCreatedSessionRef.current === sid) {
      locallyCreatedSessionRef.current = null;
      void loadHistory(sid);
    }
    // 旧发送结束后不得清掉后来续接的执行 loading（H2）。
    if (ownedExecutionEpoch === null || executionEpochRef.current === ownedExecutionEpoch) setLoading(false);
    if (queuedFollowUpTurnIdRef.current) {
      // 宿主已接管排队调度：页面只发现并观察它启动的 Turn，不再领取或启动。
      const completedTurnId = queuedFollowUpTurnIdRef.current;
      queuedFollowUpTurnIdRef.current = null;
      window.setTimeout(function followHostQueuedTurn() { void requestFollowQueuedTurn(completedTurnId); }, 0);
    }
  }

  /** 归属在点击和提交时都从当前实例复核，不以URL或旧回调选择目标。 */
  function isCurrentUiTarget(target: UiContinueTarget): boolean {
    const current = latestUiOptionsRef.current;
    return Boolean(current.active && current.isChat && (current.currentRetrieval === "none" || current.currentRetrieval === "web") && current.canWrite
      && current.sessionId === target.sessionId && current.currentSessionIdRef.current === target.sessionId
      && current.currentWorkspaceIdRef.current === current.workspaceId
      && current.presentation.items.some(function same(item) { return item.kind === "ui_document" && item.document && item.sessionId === target.sessionId && item.turnId === target.turnId && item.uiId === target.uiId; }));
  }

  /** 唯一发送链的同步Chat锁，覆盖UI双击及其与输入框同时发送的竞态。 */
  async function handleSend(overrideContent?: string, uiTarget?: UiContinueTarget) {
    if (isChat && chatSendLockedRef.current) return;
    if (uiTarget) {
      const current = latestUiOptionsRef.current;
      if (!isCurrentUiTarget(uiTarget) || !canContinueUi(uiTarget, {
        sessionId: current.sessionId, isChat: current.isChat, retrieval: current.currentRetrieval,
        active: Boolean(current.active), canWrite: current.canWrite, loading: current.loading,
        activeTurnId: current.activeTurnRef.current?.turnId ?? current.activeTurnId,
        stopping: Boolean(current.cancelInFlightRef.current || current.cancelRequestedRef.current),
        disconnected: current.transportDisconnectedRef.current,
      })) return;
    }
    if (isChat) chatSendLockedRef.current = true;
    try { await sendConversation(overrideContent, uiTarget); }
    finally { if (isChat) chatSendLockedRef.current = false; }
  }

  const latestUiSendRef = useRef(handleSend);
  latestUiSendRef.current = handleSend;
  /** 稳定回调通过最新发送函数进入同一handleSend，不捕获旧Session URL。 */
  const onUiContinue = useCallback(async function onUiContinue(request: UiContinueRequest) {
    await latestUiSendRef.current(request.content, request);
  }, []);
  const uiDisabled = !options.active || !isChat || (currentRetrieval !== "none" && currentRetrieval !== "web") || !canWrite || loading || Boolean(activeTurnId)
    || Boolean(cancelInFlightRef.current || options.activeTurnRef.current || transportDisconnectedRef.current);
  const uiContinuation = useMemo<UiContinuation>(function continuation() { return { disabled: uiDisabled, onContinue: onUiContinue }; }, [uiDisabled, onUiContinue]);

  return {
    selectedFiles, setSelectedFiles,
    knowledgeProgress,
    submissionActivity,
    inputDelivery, setInputDelivery,
    handleSend,
    uiContinuation,
    handleFileSelect,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
