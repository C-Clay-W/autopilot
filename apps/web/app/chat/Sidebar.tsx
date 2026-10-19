/** 侧栏复用会话状态与操作：Chat 列表无工作区分组，Work 按已信任工作区展示。 */
"use client";

import { type MouseEvent, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSessionTaskContext, useSessionTaskList, type WorkspaceSummary } from "./session-task-context";
import SessionStatusIndicator from "./components/SessionStatusIndicator";
import { CHAT_SCOPE, conversationUrl, sessionApiUrl, readConversationTarget } from "./conversation-target";
import { useNotice } from "./components/Notice";
import { navigateChat } from "./chat-navigation";

/** 渲染一个会话行，并让删除按钮始终位于固定状态槽左侧。 */
function SessionRow({ item, currentWorkspaceId, currentSessionId, onNavigate, onDelete }: {
  item: ReturnType<typeof useSessionTaskList>[number];
  currentWorkspaceId: string;
  currentSessionId: string;
  onNavigate?: () => void;
  onDelete(workspaceId: string, sessionId: string): void;
}) {
  const session = item.session;

  /** 将会话时间转为侧栏的紧凑本地时间。 */
  function formatTime(ts: number): string {
    const date = new Date(ts);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  /** 选择目标会话，只改变 URL 可见实例，不影响其余 Session 的 SSE。 */
  function handleSelectSession(): void {
    navigateChat(conversationUrl(item.workspaceId, session.id));
    onNavigate?.();
  }

  /** 阻止删除点击触发行导航。 */
  function handleDeleteSession(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    onDelete(item.workspaceId, session.id);
  }

  return (
    <div
      className={`group flex items-center px-3 py-2 text-sm cursor-pointer transition-colors ${
        currentWorkspaceId === item.workspaceId && currentSessionId === session.id
          ? "bg-ink text-ink-on-dark"
          : "text-ink hover:bg-ink hover:text-ink-on-dark"
      }`}
    >
      <button type="button" onClick={handleSelectSession} className="min-w-0 flex-1 truncate text-left focus-visible:outline-2 focus-visible:outline-accent" title={session.title}>{session.title}</button>
      <span className="text-xs opacity-60 ml-2 shrink-0">{formatTime(session.updatedAt)}</span>
      <button
        onClick={handleDeleteSession}
        className="ml-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-xs hover:text-accent shrink-0"
        title="删除"
        aria-label={`删除${session.title}`}
      >
        ✕
      </button>
      <SessionStatusIndicator phase={item.phase} terminalNotice={item.terminalNotice} isCurrent={currentWorkspaceId === item.workspaceId && currentSessionId === session.id} />
    </div>
  );
}

/** 使用当前产品的列表与新建入口，删除失败按服务端安全文案提示。 */
export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const searchParams = useSearchParams();
  const target = readConversationTarget(searchParams);
  const currentSessionId = target.sessionId;
  const currentWorkspaceId = target.scope;
  const isChat = target.productMode === "chat";
  const notice = useNotice();
  const { loading, workspaces, refreshSessions, removeSession } = useSessionTaskContext();
  const sessionItems = useSessionTaskList();
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<ReadonlySet<string>>(new Set());

  /** 切换指定工作区分组的折叠/展开状态。 */
  function toggleWorkspaceCollapsed(workspaceId: string): void {
    setCollapsedWorkspaceIds(function flipCollapsed(previous) {
      const next = new Set(previous);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }

  /** 立即打开空白 Chat；Session 延迟到首次发送时创建，避免运行中长流阻塞新建。 */
  function handleNewSession(): void {
    if (!currentWorkspaceId) return;
    navigateChat(conversationUrl(currentWorkspaceId, "", "none", crypto.randomUUID()));
    onNavigate?.();
  }

  async function handleDelete(workspaceId: string, id: string): Promise<void> {
    try {
      const response = await fetch(sessionApiUrl(workspaceId, id)!, { method: "DELETE" });
      console.log(response);
      if (!response.ok) { const failure = await response.json().catch(() => ({})); notice.error(failure.error || "删除失败"); return; }
      removeSession(workspaceId, id);
      if (currentWorkspaceId === workspaceId && currentSessionId === id) {
        navigateChat(conversationUrl(workspaceId), true);
      }
      await refreshSessions(workspaceId);
    } catch {
      /* 静默失败 */
    }
  }

  /** 从已同步列表中读取目标工作区的会话，避免 Sidebar 保存第二份选择状态。 */
  function getWorkspaceSessions(workspace: WorkspaceSummary) {
    return sessionItems.filter(function belongsToWorkspace(item) { return item.workspaceId === workspace.workspaceId; });
  }

  /** 侧栏只展示当前可操作且确有历史会话的工作区，失效 Registry 留给工作区管理入口处理。 */
  const visibleWorkspaceGroups = workspaces
    .filter(function isOperationalWorkspace(workspace) { return workspace.available && workspace.trustStatus === "trusted"; })
    .map(function attachWorkspaceSessions(workspace) { return { workspace, items: getWorkspaceSessions(workspace) }; })
    .filter(function hasSessions(group) { return group.items.length > 0; });

  return (
    <>
      {/* 新建对话按钮 */}
      <div className="px-3 py-3">
        <button
          onClick={handleNewSession}
          disabled={!isChat && !workspaces.some((workspace) => workspace.workspaceId === currentWorkspaceId && workspace.available && workspace.trustStatus === "trusted")}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5
            bg-ink text-ink-on-dark font-bold border-2 border-ink disabled:cursor-not-allowed disabled:opacity-60
            hover:bg-ink-soft transition-colors text-sm"
        >
          {isChat ? "+ 新建 Chat" : currentWorkspaceId ? "+ 新建 Work 任务" : "请先选择工作区"}
        </button>
      </div>

      {/* 对话列表区 */}
      <nav className="flex-1 overflow-y-auto px-2">
        {loading && (
          <p className="px-3 py-2 text-xs text-muted">加载中…</p>
        )}

        {!loading && isChat && sessionItems.filter((item) => item.workspaceId === CHAT_SCOPE).map((item) => <SessionRow key={item.key} item={item} currentWorkspaceId={currentWorkspaceId} currentSessionId={currentSessionId} onNavigate={onNavigate} onDelete={handleDelete} />)}
        {!loading && !isChat && visibleWorkspaceGroups.map(function renderWorkspaceGroup(group) {
          const { workspace, items } = group;
          const collapsed = collapsedWorkspaceIds.has(workspace.workspaceId);
          return <section key={workspace.workspaceId} className="mb-3">
            <button
              type="button"
              onClick={function handleToggleGroup() { toggleWorkspaceCollapsed(workspace.workspaceId); }}
              aria-expanded={!collapsed}
              className="w-full flex items-center px-3 py-2 text-xs text-muted hover:bg-ink hover:text-ink-on-dark transition-colors focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span className="shrink-0 w-4 text-left text-[1.3em]" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
              <span className="min-w-0 flex-1 truncate text-left">▰ {workspace.displayName}</span>
              <span className="sr-only">{collapsed ? "展开会话列表" : "折叠会话列表"}</span>
            </button>
            {!collapsed && items.map(function renderWorkspaceSession(item) {
              return <SessionRow key={item.key} item={item} currentWorkspaceId={currentWorkspaceId} currentSessionId={currentSessionId} onNavigate={onNavigate} onDelete={handleDelete} />;
            })}
          </section>;
        })}

        {!loading && (isChat ? !sessionItems.some((item) => item.workspaceId === CHAT_SCOPE) : visibleWorkspaceGroups.length === 0) && <p className="px-3 py-2 text-xs text-muted">暂无历史会话</p>}
      </nav>

      {/* 底部导航 */}
      <div className="divider-dotted !my-0 mx-4" />
      <div className="px-3 py-3 space-y-1">
        {isChat && <Link
          href="/chat/knowledge"
          onClick={onNavigate}
          className="flex items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-ink hover:text-ink-on-dark transition-colors"
        >
          资源目录
        </Link>}
        <Link
          href={`/settings?returnTo=${encodeURIComponent(conversationUrl(currentWorkspaceId, currentSessionId, target.retrievalMode))}`}
          onClick={onNavigate}
          className="flex items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-ink hover:text-ink-on-dark transition-colors"
        >
          设置
        </Link>
        <Link
          href="/"
          className="flex items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-ink hover:text-ink-on-dark transition-colors"
        >
          ← 返回首页
        </Link>

      </div>
    </>
  );
}
