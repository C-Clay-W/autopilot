/** ChatMessageList.tsx — 消息容器、空态、上传进度与断连/滚动提示的纯展示；单条消息委托 ChatMessageItem 渲染。 */
"use client";

import { memo, useLayoutEffect, useRef, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import PinnedSkillsBar from "./PinnedSkillsBar";
import KnowledgeIngestProgress from "./KnowledgeIngestProgress";
import ActivityIndicator from "./ActivityIndicator";
import ChatMessageItem from "./ChatMessageItem";
import type { ProcessStep } from "./process-step";
import type { UserQuestionAnswerDraft } from "./AskUserQuestionCard";
import type { AgentPresentationState, ApprovalItem, UserQuestionItem } from "@autopilot-agent/presentation";
import type { ChatRetrievalMode } from "@autopilot-agent/core";
import type { Message, SourceItem } from "../chat-page-types";
import type { WorkPreviewViewProps } from "../work-preview-state";
import type { WebSessionPinnedSkill as SessionPinnedSkill } from "@/lib/runtime-host/web-ui-dto";
import type { WebActivityState } from "@/lib/runtime-host/web-activity";
import type { AgentStorageQuotaView } from "./StorageQuotaPanel";
import type { WorkspaceSummary } from "../session-task-context";
import { recordWebPerformanceDiagnostic } from "@/lib/runtime-host/web-performance-diagnostics";

interface ChatMessageListProps {
  isChat: boolean;
  messages: Message[];
  sessionId: string;
  loading: boolean;
  submissionActivity: "answer" | "upload";
  currentRetrieval: ChatRetrievalMode;
  knowledgeProgress: ProcessStep[];
  pinnedSkills: SessionPinnedSkill[];
  getSkillDisplayName: (skillRef: string) => string;
  togglePinnedSkill: (skillRef: string) => void;
  storageQuota: AgentStorageQuotaView | undefined;
  setStorageQuotaPanelOpen: Dispatch<SetStateAction<boolean>>;
  presentation: AgentPresentationState;
  refreshTransport: () => Promise<void>;
  isPinned: boolean;
  unreadCount: number;
  showLatest: () => void;
  pendingApproval: ApprovalItem | undefined;
  pendingUserQuestion: UserQuestionItem | undefined;
  focusPendingApproval: () => void;
  focusPendingUserQuestion: () => void;
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  handleScroll: () => void;
  workspaceId: string;
  workspace: WorkspaceSummary | undefined;
  canWrite: boolean;
  showProcess: boolean;
  renderEvidence: (sources?: SourceItem[]) => ReactNode;
  activity: WebActivityState | undefined;
  setRequestedJobId: Dispatch<SetStateAction<string | undefined>>;
  handleApproval: (messageId: string, approval: ApprovalItem, decision: "allow_once" | "allow_session" | "allow_workspace" | "deny") => Promise<void>;
  handleUserQuestion: (messageId: string, question: UserQuestionItem, answers: UserQuestionAnswerDraft[]) => Promise<void>;
  cancelCurrentTurn: () => Promise<void>;
  handleContinueTurn: (messageId: string) => Promise<void>;
  /** 停止请求在途：继续入口显示忙状态，避免服务端未确认停止时抢跑（H2）。 */
  stopping: boolean;
  editingPrompt: { messageId: string; content: string } | null;
  setEditingPrompt: Dispatch<SetStateAction<{ messageId: string; content: string } | null>>;
  handleResendEditedPrompt: () => void;
  handleCopyMessage: (messageId: string, content: string, label: "Prompt" | "回复") => Promise<void>;
  copiedMessageId: string | null;
  handleEditPrompt: (messageId: string, content: string) => void;
  setSelectedImage: Dispatch<SetStateAction<{ url: string; alt: string } | null>>;
  readOnlyReason: string | undefined;
  /** Work 内置预览接线；未传（Chat）时沿用原链接弹窗行为。 */
  workPreview?: WorkPreviewViewProps;
}

/** 渲染消息滚动容器与浮动提示；所有状态与动作由装配层注入。 */
function ChatMessageList({ isChat, messages, sessionId, loading, submissionActivity, currentRetrieval, knowledgeProgress, pinnedSkills, getSkillDisplayName, togglePinnedSkill, storageQuota, setStorageQuotaPanelOpen, presentation, refreshTransport, isPinned, unreadCount, showLatest, pendingApproval, pendingUserQuestion, focusPendingApproval, focusPendingUserQuestion, containerRef, contentRef, handleScroll, workspaceId, workspace, canWrite, showProcess, renderEvidence, activity, setRequestedJobId, handleApproval, handleUserQuestion, cancelCurrentTurn, handleContinueTurn, stopping, editingPrompt, setEditingPrompt, handleResendEditedPrompt, handleCopyMessage, copiedMessageId, handleEditPrompt, setSelectedImage, readOnlyReason, workPreview }: ChatMessageListProps) {
  const previousPresentationRef = useRef(presentation);
  useLayoutEffect(function recordPresentationCommit() {
    if (previousPresentationRef.current === presentation) return;
    previousPresentationRef.current = presentation;
    recordWebPerformanceDiagnostic("presentation_commit", "presentation");
  }, [presentation]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto px-4 py-6" aria-label="对话消息">
        <div ref={contentRef} className="max-w-3xl mx-auto space-y-6 pb-10">
        {!isChat && <PinnedSkillsBar skills={pinnedSkills.map((skill) => ({ skillRef: skill.skillRef, name: getSkillDisplayName(skill.skillRef) }))} onUnpin={togglePinnedSkill} />}
        {!isChat && storageQuota && storageQuota.status !== "healthy" && (
          <button type="button" onClick={() => setStorageQuotaPanelOpen(true)} className="w-full border-l-4 border-accent bg-accent/10 px-3 py-2 text-left text-xs hover:bg-accent/20">
            Agent 存储已使用 {(storageQuota.usedBytes / 1024 / 1024 / 1024).toFixed(2)} / {(storageQuota.hardLimit / 1024 / 1024 / 1024).toFixed(2)} GB；{storageQuota.status === "warning" ? "接近上限，点击查看回收策略。" : "已达到上限，非必要长期记忆写入会被拒绝。"}
          </button>
        )}
        {messages.length === 0 && !sessionId && (
          <div className="text-center text-muted text-sm mt-20">
            开始新的对话
          </div>
        )}
         {messages.length === 0 && sessionId && (
           <div className="text-center text-muted text-sm mt-20">
             继续对话，或发一条新消息
           </div>
         )}
         {loading && (submissionActivity === "upload" || !sessionId) && (
           submissionActivity === "upload"
             ? isChat && currentRetrieval === "rag"
               ? <KnowledgeIngestProgress steps={knowledgeProgress.length ? knowledgeProgress : [{ stage: "upload", message: "正在准备上传文件" }]} />
               : <p role="status" className="border-2 border-ink bg-card px-4 py-3 text-sm">{isChat ? "正在上传临时附件，上传完成后开始问答" : "正在上传任务图片"}</p>
             : <ActivityIndicator running />
         )}
         {messages.map((msg) => (
          <ChatMessageItem
            key={msg.id}
            msg={msg}
            workspaceId={workspaceId}
            workspace={workspace}
            sessionId={sessionId}
            isChat={isChat}
            currentRetrieval={currentRetrieval}
            presentation={presentation}
            showProcess={showProcess}
            renderEvidence={renderEvidence}
            loading={loading}
            canWrite={canWrite}
            readOnlyReason={readOnlyReason}
            activity={activity}
            setRequestedJobId={setRequestedJobId}
            handleApproval={handleApproval}
            handleUserQuestion={handleUserQuestion}
            cancelCurrentTurn={cancelCurrentTurn}
            handleContinueTurn={handleContinueTurn}
            stopping={stopping}
            editingPrompt={editingPrompt}
            setEditingPrompt={setEditingPrompt}
            handleResendEditedPrompt={handleResendEditedPrompt}
            handleCopyMessage={handleCopyMessage}
            copiedMessageId={copiedMessageId}
            handleEditPrompt={handleEditPrompt}
            setSelectedImage={setSelectedImage}
            workPreview={workPreview}
          />
        ))}
        </div>
      </div>
      {presentation.transport === "disconnected" && (
        <div className="absolute bottom-4 right-4 max-w-sm border-2 border-accent bg-card px-3 py-2 text-xs shadow-none" role="status" aria-live="polite">
          <p className="font-semibold">⚠ 连接已断开</p>
          <p className="mt-1 text-muted">任务真实状态尚未确认，请刷新已保存进展。</p>
          <button type="button" onClick={() => void refreshTransport()} className="mt-2 border-2 border-ink px-2 py-1 font-semibold hover:bg-ink hover:text-ink-on-dark">刷新状态</button>
        </div>
      )}
      {presentation.transport === "reconnecting" && (
        <div className="absolute bottom-4 right-4 border-2 border-ink bg-card px-3 py-2 text-xs" role="status" aria-live="polite">正在恢复连接…</div>
      )}
      {!isPinned && (unreadCount > 0 || pendingApproval || pendingUserQuestion) && (
        <div className="absolute bottom-4 left-1/2 flex w-[min(24rem,calc(100%-2rem))] -translate-x-1/2 flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-center">
          {pendingApproval && (
            <button type="button" onClick={focusPendingApproval} className="border-2 border-accent bg-card px-3 py-2 text-left font-semibold hover:bg-accent hover:text-ink-on-dark">
              ⚠ 任务正在等待你的确认 · 查看
            </button>
          )}
          {pendingUserQuestion && (
            <button type="button" onClick={focusPendingUserQuestion} className="border-2 border-accent bg-card px-3 py-2 text-left font-semibold hover:bg-accent hover:text-ink-on-dark">
              任务正在等待你的回答 · 查看
            </button>
          )}
          {unreadCount > 0 && (
            <button type="button" onClick={showLatest} className="border-2 border-ink bg-card px-3 py-2 font-semibold hover:bg-ink hover:text-ink-on-dark" aria-label={`查看 ${unreadCount} 条新进展`}>
              ↓ {unreadCount} 条新进展
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 输入字符变化时保持消息树不变；内容、Presentation 或交互边界变化仍会触发更新。 */
function areChatMessageListPropsEqual(previous: ChatMessageListProps, next: ChatMessageListProps): boolean {
  return previous.isChat === next.isChat
    && previous.messages === next.messages
    && previous.sessionId === next.sessionId
    && previous.loading === next.loading
    && previous.submissionActivity === next.submissionActivity
    && previous.currentRetrieval === next.currentRetrieval
    && previous.knowledgeProgress === next.knowledgeProgress
    && previous.pinnedSkills === next.pinnedSkills
    && previous.getSkillDisplayName === next.getSkillDisplayName
    && previous.storageQuota === next.storageQuota
    && previous.presentation === next.presentation
    && previous.isPinned === next.isPinned
    && previous.unreadCount === next.unreadCount
    && previous.pendingApproval === next.pendingApproval
    && previous.pendingUserQuestion === next.pendingUserQuestion
    && previous.containerRef === next.containerRef
    && previous.contentRef === next.contentRef
    && previous.workspaceId === next.workspaceId
    && previous.workspace === next.workspace
    && previous.canWrite === next.canWrite
    && previous.stopping === next.stopping
    && previous.showProcess === next.showProcess
    && previous.renderEvidence === next.renderEvidence
    && previous.activity === next.activity
    && previous.editingPrompt === next.editingPrompt
  && previous.copiedMessageId === next.copiedMessageId
  && previous.readOnlyReason === next.readOnlyReason
  && previous.workPreview === next.workPreview;
}

export default memo(ChatMessageList, areChatMessageListPropsEqual);
