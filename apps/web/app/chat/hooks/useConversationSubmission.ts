/** useConversationSubmission.ts — 文件选择、拖拽、附件上传、创建 Session 与 handleSend 的连续逻辑；自原 page.tsx 原样迁入，不重排分支。 */
"use client";

import { useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { uploadChatKnowledge } from "@/lib/knowledge-ingest-client";
import { getKnowledgeIngestProcessStep } from "../components/KnowledgeIngestProgress";
import { sessionApiUrl } from "../conversation-target";
import type { ChatRetrievalMode } from "@autopilot-agent/core";
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
  requestNextQueuedTurn: () => Promise<void>;
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
  queueExecutionRequestedRef: RefObject<boolean>;
  awaitingApprovalRef: RefObject<boolean>;
  awaitingUserInputRef: RefObject<boolean>;
  /** 执行代次：开始/停止/继续共用，旧请求的 finally 只能清理自己的执行段（H2）。 */
  executionEpochRef: RefObject<number>;
  transportDisconnectedRef: RefObject<boolean>;
}

/** 共用传输地址解析；Chat 作用域永远不发送到 Work API。 */
const getWorkspaceSessionUrl = sessionApiUrl;

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
    pendingInputsRef,
    queueExecutionRequestedRef,
    awaitingApprovalRef,
    awaitingUserInputRef,
    executionEpochRef,
    transportDisconnectedRef,
  } = options;
  const { manager, refreshSessions } = useSessionTaskContext();
  const notice = useNotice();
  const inputOrderRef = useRef(0);
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
    const payload = await response.json() as { attachment: SessionImageAttachment & ChatAttachmentView };
    if (isChat) {
      setChatAttachments((current) => [...current, payload.attachment]);
      return { id: payload.attachment.ref, name: payload.attachment.displayName, mimeType: payload.attachment.mimeType };
    }
    return payload.attachment;
  }

  // 发消息：如果有 sessionId 直接发；如果没有先创建会话
  const handleSend = async (overrideContent?: string) => {
    if (!hasWorkspace) {
      onOpenWorkspacePicker();
      return;
    }
    // 发送前置校验：只读/生成中、等待用户回答、空内容、取消收口中、竞态，任一命中都直接拦住
    // cr by clayw on 20260909
    if (!canWrite || (isChat && loading)) return;
    if (awaitingUserInputRef.current) return;
    const content = (overrideContent ?? inputRef.current).trim();
    if (!content && selectedFiles.length === 0) return;
    if (cancelInFlightRef.current) {
      // 停止在途时不得抢跑，也不能静默丢弃用户动作（H2）。
      notice.warning("任务正在停止，请等待服务端确认后再发送");
      return;
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

    const files = selectedFiles;
    const selectedSkillsForRequest = selectedSkills;
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
    setComposerInput("");
    resetComposerHeight(textareaRef.current);
    setSelectedFiles([]);

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
        if (!res.ok) {
          const failure = await res.json().catch(() => ({}));
          notice.error(failure.error || "创建会话失败");
          setLoading(false);
          setComposerInput(content);
          setSelectedFiles(files);
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
      } catch {
        notice.error("创建会话失败，请重试");
        setComposerInput(content);
        setSelectedFiles(files);
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
      try { attachments.push(await uploadSessionImage(sid, file.file, !content)); }
      catch (error) {
        notice.error(error instanceof Error ? error.message : "附件上传失败");
        setComposerInput(content);
        setSelectedFiles(attachmentFiles.slice(index));
        if (!isSubmittingToActiveTurn) setLoading(false);
        return;
      }
    }
    if (!isSubmittingToActiveTurn) setSubmissionActivity("answer");
    const agentContent = content;
    if (!isSubmittingToActiveTurn && (content || (!isChat && attachments.length))) {
      setMessages((prev) => [...prev, { id: mkId("u"), role: "user", content, attachments: isChat ? undefined : attachments, optimistic: true, createdAt: submittedAt }]);
    }

    // 有文本统一提交 /messages：202 表示加入队列，SSE 表示流式回答；Chat/Work 与 RAG 的差异由请求体和服务端 session 元数据决定。
    if (agentContent) {
      if (isSubmittingToActiveTurn) {
        const position = inputPosition!;
        /** 旧请求仅能回写其提交时的 Session 与工作区。 */
        function isCurrentInputTarget(): boolean { return options.currentSessionIdRef.current === sid && options.currentWorkspaceIdRef.current === workspaceId; }
        try {
          if (!isCurrentInputTarget()) return;
          const clientMessageId = mkId("input");
          const response = await fetch(getWorkspaceSessionUrl(workspaceId, sid, "/messages")!, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: agentContent, clientMessageId, delivery: inputDelivery, attachmentIds: attachments.map((attachment) => attachment.id), databaseSearchEnabled: databaseEnabled, selectedSkills: selectedSkillsForRequest }),
          });
          console.log(response);
          // 响应体解析失败按空对象处理，由下方字段校验统一报错。
          const payload = await response.json().catch(() => ({})) as Partial<PendingAgentInput> & { error?: string; code?: string };
          if (!isCurrentInputTarget()) return;
          if (!response.ok && payload.code === "active_turn_finished") {
            if (options.activeTurnRef.current && options.activeTurnRef.current.turnId !== position.turnId) return;
            clearActiveTurn();
            setLoading(false);
            setComposerInput(agentContent);
            setMessages((current) => [...current, { id: mkId("input-retry"), role: "assistant", content: "上一任务已经结束，已将输入放回输入框，请重新发送。" }]);
            await loadHistory(sid);
            return;
          }
          if (!response.ok || !payload.inputId || !payload.delivery || !payload.status) throw new Error(payload.error || "输入未能加入任务队列");
          const cancelled = Boolean(position.turnId && options.cancelledTurnIdsRef.current.has(position.turnId)) || (options.activeTurnRef.current?.turnId === position.turnId && cancelRequestedRef.current);
          const responseTurnId = typeof (payload as { turnId?: unknown }).turnId === "string" ? (payload as { turnId: string }).turnId : position.turnId;
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
          setMessages((current) => [...current, { id: mkId("input-error"), role: "assistant", content: `输入加入失败：${error instanceof Error ? error.message : "未知错误"}` }]);
        }
        return;
      }
      const aiId = mkId("a");
      ownedExecutionEpoch = executionEpochRef.current + 1;
      executionEpochRef.current = ownedExecutionEpoch;
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
              selectedSkills: selectedSkillsForRequest,
            }),
        });
        console.log(res);

        if (res.status === 202) {
          const payload = await res.json().catch(() => ({})) as Partial<PendingAgentInput>;
          if (!payload.inputId || !payload.delivery || !payload.status) throw new Error("服务端未返回等待输入确认");
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
          if (errData.code === "WORK_HISTORY_READ_ONLY") setReadOnlyReason("WORK_HISTORY_READ_ONLY");
          if (errData.code === "WORKSPACE_NOT_TRUSTED") setReadOnlyReason("工作区信任已失效，请重新选择并确认工作区");
          setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, content: `分析失败：${errData.error || `${res.status} ${res.statusText}`}`, activity: undefined, processSteps: undefined } : m)));
          setStreamingMessageId("");
          setLoading(false);
          return;
        }

        if (!res.body) {
          setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, content: "分析失败：响应体为空", activity: undefined, processSteps: undefined } : m)));
          setStreamingMessageId("");
          setLoading(false);
          return;
        }
        manager.beginSession(createWorkspaceSessionKey(workspaceId, sid));
        setSelectedSkills((current) => current.filter((skill) => skill.pinned));
        setPinnedSkills((current) => current.filter((skill) => selectedSkillsForRequest.some((selected) => selected.skillRef === skill.skillRef && selected.pinned)));
        // SSE 已收到终点后先释放当前页面交互；终态明确或已原子校准时本地投影完整，不再额外请求完整 History。
        const streamOutcome = await consumeAgentStream(res, aiId, sid);
        if (streamOutcome === "ended_without_terminal") void loadHistory(sid);
      } catch (err) {
        const cancelled = cancelRequestedRef.current || abortController.signal.aborted;
        const disconnected = !cancelled && isTransportFailure(err);
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
      } finally {
        if (requestAbortRef.current === abortController) requestAbortRef.current = null;
        if (locallyCreatedSessionRef.current === sid) locallyCreatedSessionRef.current = null;
        // 旧发送的收尾只清理自己认领的执行段，不覆盖后来续接的 loading/active（H2）。
        if (executionEpochRef.current === ownedExecutionEpoch) {
          setStreamingMessageId("");
          cancelRequestedRef.current = false;
          if (!awaitingApprovalRef.current && !awaitingUserInputRef.current && !transportDisconnectedRef.current) clearActiveTurn();
        }
      }
    }
    if (!agentContent && locallyCreatedSessionRef.current === sid) {
      locallyCreatedSessionRef.current = null;
      void loadHistory(sid);
    }
    // 旧发送结束后不得清掉后来续接的执行 loading（H2）。
    if (ownedExecutionEpoch === null || executionEpochRef.current === ownedExecutionEpoch) setLoading(false);
    if (queueExecutionRequestedRef.current) {
      queueExecutionRequestedRef.current = false;
      window.setTimeout(() => { void requestNextQueuedTurn(); }, 0);
    }
  };

  return {
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
  };
}
