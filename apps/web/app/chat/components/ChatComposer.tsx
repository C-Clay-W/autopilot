/** ChatComposer.tsx — 输入区：等待输入卡片、拖拽/文件选择接线、textarea、发送/停止按钮与 Work 数据库同步提示；Composer 小图标为私有实现。 */
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import SelectedSkillChip from "./SelectedSkillChip";
import { ChatRetrievalControls } from "./ChatModeControls";
import type { UserQuestionItem } from "@autopilot-agent/presentation";
import type { ChatRetrievalMode } from "@autopilot-agent/core";
import { CHAT_SCOPE, sessionApiUrl } from "../conversation-target";
import { formatSize, formatSyncElapsed } from "../chat-page-helpers";
import type { ChatAttachmentView, ComposerInputActions, InputDeliveryNotice, PendingAgentInput, SelectedFile, SelectedSkill } from "../chat-page-types";
import type { WorkspaceSummary } from "../session-task-context";
import { recordWebPerformanceDiagnostic } from "@/lib/runtime-host/web-performance-diagnostics";

/** 绘制运行中发送排队或引导任务的专用 Logo，避免与停止按钮产生相同点击语义。 */
function QueueDeliveryIcon({ delivery }: { delivery: "steer" | "queue" }) {
  return <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d="M4 7h10M4 12h7M4 17h5" /><path d={delivery === "steer" ? "m13 9 4 3-4 3M17 12H9" : "m12 7 4 4-4 4M16 11H8"} /></svg>;
}

/** 绘制只有空输入且主任务运行时才可用的停止 Logo。 */
function StopTaskIcon() {
  return <span className="h-3 w-3 bg-ink-on-dark" aria-hidden="true" />;
}

interface ChatComposerProps {
  pendingInputs: PendingAgentInput[];
  cancelPendingInput: (inputId: string) => Promise<void>;
  setInputDelivery: Dispatch<SetStateAction<"steer" | "queue">>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  inputRef: RefObject<string>;
  inputActionsRef: RefObject<ComposerInputActions | null>;
  inputDeliveryNotice: InputDeliveryNotice | null;
  readOnlyReason: string | undefined;
  isChat: boolean;
  loading: boolean;
  submissionActivity: "answer" | "upload";
  currentRetrieval: ChatRetrievalMode;
  requestAbortRef: RefObject<AbortController | null>;
  chatAttachments: ChatAttachmentView[];
  sessionId: string;
  selectedFiles: SelectedFile[];
  setSelectedFiles: Dispatch<SetStateAction<SelectedFile[]>>;
  onOpenWorkspacePicker: () => void;
  workspace: WorkspaceSummary | undefined;
  setSkillPickerOpen: Dispatch<SetStateAction<boolean>>;
  selectedSkills: SelectedSkill[];
  getSkillDisplayName: (skillRef: string) => string;
  toggleSelectedSkill: (skillRef: string) => void;
  togglePinnedSkill: (skillRef: string) => void;
  showSources: boolean;
  setShowSources: Dispatch<SetStateAction<boolean>>;
  showProcess: boolean;
  setShowProcess: Dispatch<SetStateAction<boolean>>;
  databaseEnabled: boolean;
  setDatabaseEnabled: Dispatch<SetStateAction<boolean>>;
  onRetrievalChange: (mode: ChatRetrievalMode) => void;
  hasWorkspace: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleDragEnter: (e: React.DragEvent) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
  pendingUserQuestion: UserQuestionItem | undefined;
  canWrite: boolean;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  activeTurnId: string;
  handleSend: (overrideContent?: string) => Promise<void>;
  cancelCurrentTurn: () => Promise<void>;
  databaseSyncMessage: string;
  databaseSyncing: boolean;
  databaseSyncElapsedSeconds: number;
  inputDelivery: "steer" | "queue";
}

/** 渲染输入区完整 UI；条件分支、事件回调与原页面保持一致。 */
export default function ChatComposer({ pendingInputs, cancelPendingInput, setInputDelivery, textareaRef, inputRef, inputActionsRef, inputDeliveryNotice, readOnlyReason, isChat, loading, submissionActivity, currentRetrieval, requestAbortRef, chatAttachments, sessionId, selectedFiles, setSelectedFiles, onOpenWorkspacePicker, workspace, setSkillPickerOpen, selectedSkills, getSkillDisplayName, toggleSelectedSkill, togglePinnedSkill, showSources, setShowSources, showProcess, setShowProcess, databaseEnabled, setDatabaseEnabled, onRetrievalChange, hasWorkspace, fileInputRef, handleFileSelect, handleDragEnter, handleDragOver, handleDragLeave, handleDrop, pendingUserQuestion, canWrite, handleKeyDown, activeTurnId, handleSend, cancelCurrentTurn, databaseSyncMessage, databaseSyncing, databaseSyncElapsedSeconds, inputDelivery }: ChatComposerProps) {
  const [input, setInputState] = useState("");
  const previousInputRef = useRef(input);

  /** 只在 Composer 子树内更新文本，并同步提交时读取的 ref。 */
  const updateInput = useCallback(function updateInput(value: string): void {
    inputRef.current = value;
    setInputState(value);
  }, [inputRef]);

  /** 在浏览器提交 Composer 子树后记录输入回显完成时刻。 */
  useLayoutEffect(function recordComposerCommit() {
    if (previousInputRef.current === input) return;
    previousInputRef.current = input;
    recordWebPerformanceDiagnostic("composer_commit", "input");
  }, [input]);

  useEffect(function exposeComposerInputActions() {
    inputActionsRef.current = { setInput: updateInput };
    return function clearComposerInputActions() {
      if (inputActionsRef.current?.setInput === updateInput) inputActionsRef.current = null;
    };
  }, [inputActionsRef, updateInput]);

  return (
    <div
      className="border-[3px] border-ink bg-card"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="max-w-3xl mx-auto p-3">
        {pendingInputs.length > 0 && (
          <div className="mb-3 border-2 border-ink bg-bg">
            <div className="border-b-2 border-ink px-3 py-2 text-xs font-semibold">等待输入</div>
            {pendingInputs.map((pending, index) => (
              <div key={pending.inputId} className="flex items-center gap-2 border-b border-ink px-3 py-2 text-xs last:border-b-0">
                <span className="font-semibold">{index + 1}</span>
                <span className="border border-ink px-1.5 py-0.5">{pending.delivery === "steer" ? "引导" : "排队"}</span>
                <span className="min-w-0 flex-1 truncate">{pending.delivery === "queue" ? pending.content : "已投递到当前任务"}</span>
                <span className="text-muted">附件 {pending.attachmentCount} · Skill {pending.skillCount}</span>
                <button type="button" onClick={() => { updateInput(pending.content); setInputDelivery(pending.delivery); void cancelPendingInput(pending.inputId); textareaRef.current?.focus(); }} className="border border-ink px-1.5 py-0.5 hover:bg-ink hover:text-ink-on-dark">编辑</button>
                <button type="button" onClick={() => { updateInput(pending.content); setInputDelivery(pending.delivery === "steer" ? "queue" : "steer"); void cancelPendingInput(pending.inputId); textareaRef.current?.focus(); }} className="border border-ink px-1.5 py-0.5 hover:bg-ink hover:text-ink-on-dark">切换</button>
                <button type="button" onClick={() => void cancelPendingInput(pending.inputId)} className="border border-ink px-1.5 py-0.5 hover:bg-accent hover:text-ink-on-dark">删除</button>
              </div>
            ))}
          </div>
        )}
        {inputDeliveryNotice && (
          <div className="mb-3 border-2 border-ink bg-ink/10 px-3 py-2 text-xs" role="status" aria-live="polite">
            <div className="flex items-center gap-2 font-semibold">
              <span className="text-accent">{inputDeliveryNotice.status === "started" ? "已开始执行" : "已接收"}</span>
              <span>{inputDeliveryNotice.delivery === "steer" ? "引导当前任务" : "排到下一任务"}</span>
            </div>
            <div className="mt-1 truncate text-muted">{inputDeliveryNotice.status === "started"
              ? inputDeliveryNotice.delivery === "steer" ? "已在当前任务的安全边界合并，正在执行" : "前一任务已完成，正在执行"
              : inputDeliveryNotice.delivery === "steer" ? "已保存，等待合并到当前任务的下一安全边界" : "已保存，等待前一任务结束"}</div>
          </div>
        )}
        {readOnlyReason && <p role="status" className="mb-2 border-2 border-ink p-2 text-xs">{readOnlyReason === "WORK_HISTORY_READ_ONLY" ? "此旧任务的上下文来源无法验证，仅可查看。请新建 Work 任务。" : readOnlyReason}</p>}
        {isChat && loading && submissionActivity === "upload" && currentRetrieval === "rag" && <button type="button" onClick={function cancelKnowledgeUpload() { requestAbortRef.current?.abort(); }} className="ml-3 border border-ink px-2 py-1 text-xs">取消入库</button>}
        {isChat && <p className="mb-2 text-xs text-muted">{currentRetrieval === "rag" ? "加入私有知识库，不随会话删除；可从左侧资源目录预览或删除" : "临时分析，30 天后删除"}</p>}
        {isChat && chatAttachments.length > 0 && <ul aria-label="当前对话临时附件" className="mb-2 flex flex-wrap gap-2 text-xs">{chatAttachments.map(function attachment(file) {
          return <li key={file.ref} className="border border-ink px-2 py-1"><a className="text-accent underline" href={sessionApiUrl(CHAT_SCOPE, sessionId, `/attachments/${encodeURIComponent(file.ref)}`)!} download>{file.displayName}</a> · {new Date(file.expiresAt).toLocaleDateString()} 到期</li>;
        })}</ul>}
        {selectedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {selectedFiles.map((sf, idx) => (
              <div key={idx} className="flex items-center gap-2 px-3 py-2 border border-ink bg-card text-xs">
                {sf.name}
                <span className="text-muted">{formatSize(sf.size)}</span>
                <button
                  onClick={() => setSelectedFiles((prev) => prev.filter((_, i) => i !== idx))}
                  className="ml-1 text-muted hover:text-ink"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {!isChat && <><button data-workspace-chip type="button" onClick={onOpenWorkspacePicker} className="border-2 border-ink px-2 py-1 text-xs font-semibold hover:bg-ink hover:text-ink-on-dark" aria-haspopup="dialog" aria-label={workspace ? `选择工作区，当前为 ${workspace.displayName}` : "选择工作区"}>
            ▰ {workspace?.displayName ?? "选择工作区"} ▾
          </button>
          <button type="button" onClick={() => setSkillPickerOpen(true)} className="border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark">+ Skill</button>
          {selectedSkills.map((skill) => <SelectedSkillChip key={skill.skillRef} name={getSkillDisplayName(skill.skillRef)} pinned={skill.pinned} onRemove={function removeSkill() { toggleSelectedSkill(skill.skillRef); }} onTogglePin={function toggleSkillPin() { togglePinnedSkill(skill.skillRef); }} />)}
         <button
            type="button"
            onClick={() => setShowSources((current) => !current)}
            className={`border-2 border-ink px-2 py-1 text-xs font-semibold transition-colors ${showSources ? "bg-ink text-ink-on-dark" : "bg-card text-ink hover:bg-ink/10"}`}
            title="控制后续问答是否显示来源"
          >
            来源 {showSources ? "开" : "关"}
          </button>
          <button
            type="button"
            onClick={() => setShowProcess((current) => !current)}
            className={`border-2 border-ink px-2 py-1 text-xs font-semibold transition-colors ${showProcess ? "bg-ink text-ink-on-dark" : "bg-card text-ink hover:bg-ink/10"}`}
            title="控制后续问答是否显示执行过程"
          >
            过程 {showProcess ? "开" : "关"}
          </button>
          <button
            type="button"
            onClick={() => setDatabaseEnabled((current) => !current)}
            className={`border-2 border-ink px-2 py-1 text-xs font-semibold transition-colors ${databaseEnabled ? "bg-accent text-ink-on-dark" : "bg-card text-ink hover:bg-ink/10"}`}
            title="开启后续问题的深度数据库搜索"
          >
            深度搜索 {databaseEnabled ? "开" : "关"}
          </button>
          </>}
          {isChat && <ChatRetrievalControls mode={currentRetrieval} persisted={Boolean(sessionId || loading || chatAttachments.length)} onChange={onRetrievalChange} />}
        </div>

        {!isChat && loading && activeTurnId && input.trim() && (
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span>发送方式：</span>
            <button type="button" onClick={() => setInputDelivery("steer")} className={`border-2 border-ink px-2 py-1 ${inputDelivery === "steer" ? "bg-ink text-ink-on-dark" : "bg-card hover:bg-ink/10"}`} title="在当前任务的下一安全边界合并，用于调整正在执行任务的方向">引导当前任务</button>
            <button type="button" onClick={() => setInputDelivery("queue")} className={`border-2 border-ink px-2 py-1 ${inputDelivery === "queue" ? "bg-ink text-ink-on-dark" : "bg-card hover:bg-ink/10"}`} title="当前任务结束后按先后顺序执行">排到下一任务</button>
          </div>
        )}

        <div className={`relative border-2 border-ink bg-card ${hasWorkspace ? "" : "cursor-pointer"}`} onClick={hasWorkspace ? undefined : onOpenWorkspacePicker}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileSelect}
            multiple
            accept={isChat ? (currentRetrieval === "rag" ? ".txt,.md,.docx,.pdf,.xls,.xlsx,.png,.jpg,.jpeg,.webp" : ".txt,.md,.docx,.pdf,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.gif") : "image/png,image/jpeg,image/webp,image/gif"}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={Boolean(pendingUserQuestion) || !canWrite}
            className="absolute left-3 bottom-2.5 w-8 h-8 flex items-center justify-center text-muted hover:bg-ink hover:text-ink-on-dark transition"
            title="选择文件"
          >
            📎
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            disabled={Boolean(pendingUserQuestion) || !canWrite}
            onChange={(e) => {
              recordWebPerformanceDiagnostic("input_event", "input");
              updateInput(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={!hasWorkspace ? "请先选择并信任工作区" : !canWrite ? "当前会话暂不可发送" : isChat ? "聊天、讨论或头脑风暴…" : "描述需要完成的任务…"}
            aria-label={isChat ? "Chat 消息" : "Work 任务"}
            className="w-full resize-none px-12 py-3 pr-12 outline-none text-sm bg-transparent"
            style={{ minHeight: "45px", maxHeight: "200px" }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = target.scrollHeight + "px";
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (pendingUserQuestion) return;
              if (!isChat && loading && activeTurnId && input.trim()) {
                void handleSend();
                return;
              }
              if (loading) {
                void cancelCurrentTurn();
                return;
              }
              void handleSend();
            }}
            disabled={!canWrite || Boolean(pendingUserQuestion) || (loading ? !activeTurnId : (!input.trim() && selectedFiles.length === 0))}
            className={`absolute right-2 top-1/2 h-9 w-9 -translate-y-1/2 flex items-center justify-center transition ${
              !isChat && loading && activeTurnId && input.trim()
                ? "bg-accent text-ink-on-dark hover:bg-ink"
                : loading && activeTurnId
                ? "bg-accent text-ink-on-dark hover:bg-ink"
                : (input.trim() || selectedFiles.length > 0) && !loading
                ? "bg-accent text-ink-on-dark hover:bg-ink"
                : "bg-muted text-ink-on-dark cursor-not-allowed"
            }`}
            aria-label={!isChat && loading && activeTurnId && input.trim() ? (inputDelivery === "steer" ? "发送引导任务" : "发送排队任务") : loading && activeTurnId ? "停止当前任务" : loading ? (submissionActivity === "upload" ? "正在上传附件" : "任务正在启动") : "发送消息"}
            title={!isChat && loading && activeTurnId && input.trim() ? (inputDelivery === "steer" ? "发送引导任务" : "发送排队任务") : loading ? (activeTurnId ? "停止当前任务" : submissionActivity === "upload" ? "正在上传附件" : "任务正在启动") : "发送消息"}
          >
            {!isChat && loading && activeTurnId && input.trim() ? <QueueDeliveryIcon delivery={inputDelivery} /> : loading ? <StopTaskIcon /> : "➤"}
          </button>
        </div>
        {!isChat && (databaseEnabled || databaseSyncMessage) && (
          <div className="mt-2 border-l-4 border-accent bg-accent/10 px-3 py-2 text-xs">
            {databaseEnabled && <span>深度搜索已开启：后续问题会搜索已配置的数据库。</span>}
            {databaseSyncing ? (
              <div className={databaseEnabled ? "mt-2" : ""}>
                <div className="flex items-center justify-between gap-3 font-semibold">
                  <span>正在同步已配置数据库的本地快照</span>
                  <span className="text-accent">已等待 {formatSyncElapsed(databaseSyncElapsedSeconds)}</span>
                </div>
                <div className="mt-2 h-1 overflow-hidden bg-ink/10">
                  <div className="h-full w-1/3 bg-accent animate-pulse" />
                </div>
                <p className="mt-2 text-muted">服务器正在读取已批准的两张表、生成 SQLite 快照与必要语义索引。当前接口未提供真实表级百分比，因此不会显示虚假进度。</p>
              </div>
            ) : databaseSyncMessage && <span className={databaseEnabled ? "ml-2 text-muted" : "text-muted"}>{databaseSyncMessage}</span>}
          </div>
        )}
        <p className="text-center text-xs text-muted mt-2">
          AI 可能会出错，请核实重要信息。
        </p>
      </div>
    </div>
  );
}
