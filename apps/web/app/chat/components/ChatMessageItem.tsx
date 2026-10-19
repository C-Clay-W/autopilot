/** ChatMessageItem.tsx — 单条消息气泡：附件、诊断、Turn 展示、编辑/复制操作的纯展示接线；动作经 props 注入。 */
"use client";

import Image from "next/image";
import { memo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import MarkdownRenderer from "../../components/MarkdownRenderer";
import ActivityIndicator from "./ActivityIndicator";
import KnowledgeIngestCard from "./KnowledgeIngestCard";
import KnowledgeIngestProgress from "./KnowledgeIngestProgress";
import TurnPresentation from "./TurnPresentation";
import type { UserQuestionAnswerDraft } from "./AskUserQuestionCard";
import { selectAssistantAnswers, type AgentPresentationState, type ApprovalItem, type UserQuestionItem } from "@autopilot-agent/presentation";
import type { ChatRetrievalMode } from "@autopilot-agent/core";
import { conversationUrl } from "../conversation-target";
import { formatSize, getSessionImageUrl } from "../chat-page-helpers";
import type { Message, SourceItem } from "../chat-page-types";
import type { WebActivityState } from "@/lib/runtime-host/web-activity";
import type { WorkspaceSummary } from "../session-task-context";

interface ChatMessageItemProps {
  msg: Message;
  workspaceId: string;
  workspace: WorkspaceSummary | undefined;
  sessionId: string;
  isChat: boolean;
  currentRetrieval: ChatRetrievalMode;
  presentation: AgentPresentationState;
  showProcess: boolean;
  renderEvidence: (sources?: SourceItem[]) => ReactNode;
  loading: boolean;
  canWrite: boolean;
  readOnlyReason: string | undefined;
  activity: WebActivityState | undefined;
  setRequestedJobId: Dispatch<SetStateAction<string | undefined>>;
  handleApproval: (messageId: string, approval: ApprovalItem, decision: "allow_once" | "allow_session" | "allow_workspace" | "deny") => Promise<void>;
  handleUserQuestion: (messageId: string, question: UserQuestionItem, answers: UserQuestionAnswerDraft[]) => Promise<void>;
  cancelCurrentTurn: () => Promise<void>;
  handleContinueTurn: (messageId: string) => Promise<void>;
  editingPrompt: { messageId: string; content: string } | null;
  setEditingPrompt: Dispatch<SetStateAction<{ messageId: string; content: string } | null>>;
  handleResendEditedPrompt: () => void;
  handleCopyMessage: (messageId: string, content: string, label: "Prompt" | "回复") => Promise<void>;
  copiedMessageId: string | null;
  handleEditPrompt: (messageId: string, content: string) => void;
  setSelectedImage: Dispatch<SetStateAction<{ url: string; alt: string } | null>>;
}

/** 渲染单条消息气泡；展示顺序、条件分支和回调接线与原页面保持一致。 */
function ChatMessageItem({ msg, workspaceId, workspace, sessionId, isChat, currentRetrieval, presentation, showProcess, renderEvidence, loading, canWrite, readOnlyReason, activity, setRequestedJobId, handleApproval, handleUserQuestion, cancelCurrentTurn, handleContinueTurn, editingPrompt, setEditingPrompt, handleResendEditedPrompt, handleCopyMessage, copiedMessageId, handleEditPrompt, setSelectedImage }: ChatMessageItemProps) {
  const assistantAnswers = msg.role === "assistant" && msg.turnId ? selectAssistantAnswers(presentation, msg.turnId) : [];
  const assistantReplyContent = assistantAnswers[assistantAnswers.length - 1]?.content ?? (msg.role === "assistant" && !msg.turnId ? msg.content : undefined);

  return (
    <div
      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[80%] px-4 py-3 text-sm leading-relaxed ${
          msg.role === "user"
            ? "group relative bg-card border-2 border-ink text-ink"
            : "group relative text-ink"
        }`}
      >
        {msg.role === "assistant" && (
          <span className="inline-flex items-center justify-center w-5 h-5 text-ink-on-dark text-xs mr-2"></span>
        )}
        {msg.files?.map((file, index) => (
          <div key={`${file.name}-${file.size}-${index}`} className="flex items-center gap-2 mb-2 px-3 py-2 border border-ink bg-card text-xs">
            📎 {file.name}
            <span className="text-muted">{formatSize(file.size)}</span>
          </div>
        ))}
        {msg.knowledgeFiles?.map((file, index) => (
          <div key={`${file.name}-${file.size}-${index}`} className="flex items-center gap-2 mb-2 px-3 py-2 border border-ink bg-card text-xs">
            📎 {file.name}
            <span className="text-muted">{formatSize(file.size)}</span>
          </div>
        ))}
        {msg.attachments?.map((attachment) => {
          const imageUrl = getSessionImageUrl(workspaceId, sessionId, attachment.id);
          return (
            <button
              key={attachment.id}
              type="button"
              onClick={() => imageUrl && setSelectedImage({ url: imageUrl, alt: attachment.name })}
              className="mb-2 flex w-full items-center gap-3 border border-ink bg-card px-3 py-2 text-left text-xs hover:bg-ink/10"
              title="点击查看已上传图片"
            >
              {imageUrl && <Image src={imageUrl} alt="" width={48} height={48} className="h-12 w-12 shrink-0 border border-ink object-cover" />}
              <span className="min-w-0 flex-1 truncate">图片附件：{attachment.name}</span>
              <span className="shrink-0 text-muted">已上传 · 点击查看</span>
            </button>
          );
        })}
        {msg.diagnostics?.map((diagnostic, index) => <div key={`${diagnostic}-${index}`} className="mt-2 border-l-4 border-accent bg-accent/10 px-3 py-2 text-xs">{diagnostic}</div>)}
        {msg.role === "assistant" && msg.turnId && (
          <TurnPresentation
            state={presentation}
            turnId={msg.turnId}
            showThinking={showProcess}
            evidence={renderEvidence(msg.sources)}
            failure={msg.failure}
            termination={msg.termination}
            settingsHref={`/settings?returnTo=${encodeURIComponent(conversationUrl(workspaceId, sessionId))}`}
            readOnly={Boolean(readOnlyReason)}
            productMode={isChat ? "chat" : "work"}
            ragEvidence={isChat && currentRetrieval === "rag"}
            disabled={loading || !canWrite}
            isResuming={msg.activity === "answer"}
            activity={activity}
            onOpenBackgroundJob={function openBackgroundJob(jobId) { setRequestedJobId(jobId); }}
            onApprovalDecision={(approval, decision) => void handleApproval(msg.id, approval, decision)}
            onUserQuestionSubmit={(question, answers) => handleUserQuestion(msg.id, question, answers)}
            onUserQuestionCancel={function cancelUserQuestionTurn() { void cancelCurrentTurn(); }}
          />
        )}
        {msg.role === "assistant" && msg.activity === "answer" && !msg.turnId && <ActivityIndicator running />}
        {msg.role === "assistant" && msg.activity === "ingest" && !msg.turnId && <KnowledgeIngestProgress steps={msg.processSteps || []} />}
        {msg.role === "assistant" && msg.knowledgeIngestItems?.length && (
          <KnowledgeIngestCard readOnly={!isChat} items={msg.knowledgeIngestItems} workspaceName={workspace?.displayName || "当前"} />
        )}
        {msg.content && msg.role === "assistant" && !msg.turnId && (
          <MarkdownRenderer content={msg.content} ragEvidence={isChat && currentRetrieval === "rag"} />
        )}
        {!isChat && !readOnlyReason && msg.role === "assistant" && msg.canContinue && (
          <button
            type="button"
            onClick={() => void handleContinueTurn(msg.id)}
            disabled={loading || !canWrite}
            className="mt-3 inline-flex items-center gap-2 border-2 border-accent bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent hover:text-ink-on-dark disabled:opacity-50 disabled:cursor-not-allowed"
          >
            继续执行
          </button>
        )}
        {msg.role === "assistant" && assistantReplyContent && (
          <div className="absolute left-4 top-full z-10 hidden pt-1 group-hover:block group-focus-within:block">
            <button
              type="button"
              onClick={() => void handleCopyMessage(msg.id, assistantReplyContent, "回复")}
              className="flex h-6 w-6 items-center justify-center border-2 border-ink bg-card text-ink hover:bg-ink hover:text-ink-on-dark"
              aria-label={copiedMessageId === msg.id ? "已复制回复" : "复制回复"}
              title={copiedMessageId === msg.id ? "已复制回复" : "复制回复"}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><rect x="5.25" y="1.75" width="8.5" height="10.5" /><path d="M10.75 12.25v2H2.25v-10.5h3" /></svg>
            </button>
          </div>
        )}
        {msg.content && msg.role === "user" && (
          editingPrompt?.messageId === msg.id ? (
            <div className="space-y-2">
              <textarea
                rows={3}
                value={editingPrompt.content}
                onChange={function updateEditingPrompt(event) {
                  setEditingPrompt((current) => current?.messageId === msg.id ? { ...current, content: event.target.value } : current);
                }}
                onKeyDown={function submitEditingPrompt(event) {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleResendEditedPrompt();
                  }
                }}
                className="w-full resize-y border-2 border-ink bg-card px-2 py-2 text-sm outline-none focus:border-accent"
                aria-label="编辑历史 Prompt"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleResendEditedPrompt}
                  disabled={!editingPrompt.content.trim() || loading}
                  className="border-2 border-accent bg-accent px-2 py-1 text-[10px] font-semibold text-ink-on-dark hover:bg-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  发送此版本
                </button>
                <button
                  type="button"
                  onClick={function cancelEditingPrompt() { setEditingPrompt(null); }}
                  className="border-2 border-ink px-2 py-1 text-[10px] hover:bg-ink hover:text-ink-on-dark"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <span className="whitespace-pre-wrap">{msg.content}</span>
              <div className="absolute right-0 top-full z-10 hidden pt-1 group-hover:block group-focus-within:block">
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => void handleCopyMessage(msg.id, msg.content, "Prompt")}
                    className="flex h-6 w-6 items-center justify-center border-2 border-ink bg-card text-ink hover:bg-ink hover:text-ink-on-dark"
                    aria-label={copiedMessageId === msg.id ? "已复制 Prompt" : "复制 Prompt"}
                    title={copiedMessageId === msg.id ? "已复制 Prompt" : "复制 Prompt"}
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><rect x="5.25" y="1.75" width="8.5" height="10.5" /><path d="M10.75 12.25v2H2.25v-10.5h3" /></svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEditPrompt(msg.id, msg.content)}
                    className="flex h-6 w-6 items-center justify-center border-2 border-ink bg-card text-ink hover:bg-ink hover:text-ink-on-dark"
                    aria-label="编辑后重发"
                    title="编辑后重发"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d="m3 11.75-.75 2.5 2.5-.75 8.5-8.5-1.75-1.75Z" /><path d="m10.75 3.5 1.75 1.75" /></svg>
                  </button>
                </div>
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}

/** 流式更新只重绘当前 Turn；历史消息的 Markdown 和工具卡保持已提交结果。 */
function areChatMessageItemPropsEqual(previous: ChatMessageItemProps, next: ChatMessageItemProps): boolean {
  const previousIsCurrentTurn = Boolean(previous.msg.turnId && previous.presentation.turnId === previous.msg.turnId);
  const nextIsCurrentTurn = Boolean(next.msg.turnId && next.presentation.turnId === next.msg.turnId);
  const presentationUnchanged = previous.presentation === next.presentation || (!previousIsCurrentTurn && !nextIsCurrentTurn);
  const activityUnchanged = previous.activity === next.activity || (!previous.msg.turnId && !next.msg.turnId);
  return previous.msg === next.msg
    && previous.workspaceId === next.workspaceId
    && previous.workspace === next.workspace
    && previous.sessionId === next.sessionId
    && previous.isChat === next.isChat
    && previous.currentRetrieval === next.currentRetrieval
    && previous.showProcess === next.showProcess
    && previous.renderEvidence === next.renderEvidence
    && previous.loading === next.loading
    && previous.canWrite === next.canWrite
    && previous.readOnlyReason === next.readOnlyReason
    && presentationUnchanged
    && activityUnchanged
    && previous.editingPrompt === next.editingPrompt
    && previous.copiedMessageId === next.copiedMessageId;
}

export default memo(ChatMessageItem, areChatMessageItemPropsEqual);
