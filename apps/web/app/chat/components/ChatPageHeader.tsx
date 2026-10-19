/** ChatPageHeader.tsx — Chat/Work 顶部栏与产品隐私提示条；纯展示组件，不持有会话状态，所有动作经 props 注入。 */
"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ContextUsageView } from "@autopilot-agent/core";
import WorkJobs from "./WorkJobs";
import Popconfirm from "./Popconfirm";
import ContextUsageDetails from "./ContextUsageDetails";
import { DiffStatsLabel } from "./ToolCard";
import { WEB_SEARCH_DATA_FLOW_NOTICE } from "@autopilot-agent/presentation";
import { conversationUrl } from "../conversation-target";
import { showDevelopmentDatabaseSync } from "../chat-page-helpers";
import type { AgentStorageQuotaView } from "./StorageQuotaPanel";

/** 生成主 Context 控件标题；只表达整个窗口剩余百分比。 */
function buildContextTitle(usage: ContextUsageView | undefined): string {
  return usage ? `剩余上下文窗口 ${Math.round(Math.max(0, 1 - usage.usageRatio) * 100)}%` : "剩余上下文窗口未知";
}

/** 生成 Context 条旁的整个窗口整数剩余百分比。 */
function buildContextStatusLabel(usage: ContextUsageView | undefined): string {
  return usage ? `${Math.round(Math.max(0, 1 - usage.usageRatio) * 100)}%` : "—";
}

/** Escape 关闭 Context 面板后恢复键盘焦点；由窄 helper 保留可单测的关闭契约。 */
export function closeContextPanelOnEscape(
  event: Pick<KeyboardEvent, "key">,
  closePanel: () => void,
  contextButton: Pick<HTMLButtonElement, "focus"> | null,
): void {
  if (event.key !== "Escape") return;
  closePanel();
  contextButton?.focus();
}

interface ChatPageHeaderProps {
  isChat: boolean;
  displayTitle: string;
  handleSidebarToggle: () => void;
  workspaceId: string;
  sessionId: string;
  active: boolean;
  loading: boolean;
  requestedJobId: string | undefined;
  setRequestedJobId: Dispatch<SetStateAction<string | undefined>>;
  canWrite: boolean;
  compacting: boolean;
  compactContext: () => Promise<void>;
  compactConfirmOpen: boolean;
  setCompactConfirmOpen: Dispatch<SetStateAction<boolean>>;
  /** Core 最新安全 Context Usage 快照；undefined 表示未知，不表现为 0%。 */
  contextUsage: ContextUsageView | undefined;
  showSources: boolean;
  setShowSources: Dispatch<SetStateAction<boolean>>;
  showProcess: boolean;
  setShowProcess: Dispatch<SetStateAction<boolean>>;
  databaseEnabled: boolean;
  setDatabaseEnabled: Dispatch<SetStateAction<boolean>>;
  syncDatabase: () => Promise<void>;
  databaseSyncing: boolean;
  hasWorkspace: boolean;
  setPermissionPanelOpen: Dispatch<SetStateAction<boolean>>;
  storageQuota: AgentStorageQuotaView | undefined;
  setStorageQuotaPanelOpen: Dispatch<SetStateAction<boolean>>;
  activeTurnId: string;
  readOnlyReason: string | undefined;
  cancelCurrentTurn: () => Promise<void>;
  /** Diff 侧边栏开关状态（chat-page-content 持有）；diffEntryStats 为 undefined（无安全 diff 事实）时入口隐藏，只读历史会话仍显示。 */
  diffSidebarOpen?: boolean;
  diffEntryStats?: { added: number; removed: number };
  onDiffSidebarToggle?: () => void;
}

/** 渲染顶部栏与 Work 隐私提示条；条件分支与 DOM 结构保持原页面形态。 */
export default function ChatPageHeader({ isChat, displayTitle, handleSidebarToggle, workspaceId, sessionId, active, loading, requestedJobId, setRequestedJobId, canWrite, compacting, compactContext, compactConfirmOpen, setCompactConfirmOpen, contextUsage, showSources, setShowSources, showProcess, setShowProcess, databaseEnabled, setDatabaseEnabled, syncDatabase, databaseSyncing, hasWorkspace, setPermissionPanelOpen, storageQuota, setStorageQuotaPanelOpen, activeTurnId, readOnlyReason, cancelCurrentTurn, diffSidebarOpen, diffEntryStats, onDiffSidebarToggle }: ChatPageHeaderProps) {
  /** 分类明细面板开关；纯 UI 状态，打开/关闭不请求 Provider、不重算 tokens。 */
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const contextControlRef = useRef<HTMLDivElement>(null);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const contextTitle = buildContextTitle(contextUsage);
  // 有数据时按 Core compactNeeded 决定强调色，不按固定 80% 猜门槛；无数据时全部使用中性格。
  const usedSegments = contextUsage ? Math.ceil(Math.min(Math.max(contextUsage.usageRatio, 0), 1) * 20) : 0;
  const contextEmphasized = contextUsage?.compactNeeded === true;

  /** 统一关闭分类面板；外部点击关闭时保留目标点击的原生焦点流。 */
  function closeContextPanel(): void {
    setContextPanelOpen(false);
  }

  // 面板打开期间监听 Escape 与外部点击；Escape 关闭后明确把焦点还给 Context 按钮。
  useEffect(function closeContextPanelOnOutsideInteraction() {
    if (!contextPanelOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      closeContextPanelOnEscape(event, closeContextPanel, contextButtonRef.current);
    }
    function handlePointerDown(event: MouseEvent) {
      if (!contextControlRef.current?.contains(event.target as Node)) closeContextPanel();
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    return function removeOutsideInteractionListeners() {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [contextPanelOpen]);

  return (
    <>
      <header className="h-12 flex items-center justify-between px-4 border-b-2 border-ink">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={handleSidebarToggle}
            className="border-2 border-ink px-2 py-1 text-[10px] font-semibold hover:bg-ink hover:text-ink-on-dark transition-colors shrink-0"
            title="展开会话列表"
          >
            ☰
          </button>
          <span className="text-sm text-muted truncate">{displayTitle}</span>
        </div>
        {!isChat && <div className="flex items-center gap-2">
          {sessionId && !readOnlyReason && <WorkJobs workspaceId={workspaceId} sessionId={sessionId} active={active} turnRunning={loading} requestedJobId={requestedJobId} onRequestedJobHandled={function clearRequestedJob() { setRequestedJobId(undefined); }} />}
          <div className="relative" ref={contextControlRef}>
            <div className="flex items-center gap-1.5">
              {/* Context 条只负责“查看上下文明细”；压缩入口移入明细面板内的独立按钮。 */}
              <button
                type="button"
                ref={contextButtonRef}
                onClick={() => setContextPanelOpen((current) => !current)}
                aria-expanded={contextPanelOpen}
                aria-controls="context-usage-details"
                aria-label={contextTitle}
                title={contextTitle}
                className="grid h-5 w-20 [grid-template-columns:repeat(20,minmax(0,1fr))] gap-px border-2 border-ink bg-card p-px"
              >
                {Array.from({ length: 20 }, (_, index) => (
                  <span key={index} className={index < usedSegments ? (contextEmphasized ? "bg-accent" : "bg-ink") : "bg-bg"} />
                ))}
              </button>
              <span className="whitespace-nowrap text-[10px] text-muted tabular-nums">{buildContextStatusLabel(contextUsage)}</span>
            </div>
            {contextPanelOpen && (
              <ContextUsageDetails
                usage={contextUsage}
                canWrite={canWrite && Boolean(sessionId)}
                compacting={compacting}
                onOpenCompactConfirm={function openCompactConfirm() {
                  closeContextPanel();
                  setCompactConfirmOpen(true);
                }}
              />
            )}
            <Popconfirm
              open={compactConfirmOpen}
              title="压缩上下文"
              description="压缩会重建模型上下文投影，不会删除原始聊天记录；压缩后的 token 为本地估算。"
              confirmText={compacting ? "压缩中…" : "确认压缩"}
              cancelText="取消"
              onConfirm={() => void compactContext()}
              onCancel={() => setCompactConfirmOpen(false)}
            />
          </div>
          <button
            type="button"
            onClick={() => setShowSources((current) => !current)}
            className={`hidden border-2 border-ink px-2 py-1 text-[10px] font-semibold transition-colors ${showSources ? "bg-ink text-ink-on-dark" : "bg-card text-ink hover:bg-ink/10"}`}
            title="控制后续问答是否返回并显示来源"
          >
            来源 {showSources ? "开" : "关"}
          </button>
          <button
            type="button"
            onClick={() => setShowProcess((current) => !current)}
            className={`hidden border-2 border-ink px-2 py-1 text-[10px] font-semibold transition-colors ${showProcess ? "bg-ink text-ink-on-dark" : "bg-card text-ink hover:bg-ink/10"}`}
            title="控制后续问答是否显示服务端执行过程"
          >
            过程 {showProcess ? "开" : "关"}
          </button>
          <button
            type="button"
            onClick={() => setDatabaseEnabled((current) => !current)}
            className={`hidden border-2 border-ink px-2 py-1 text-[10px] font-semibold transition-colors ${databaseEnabled ? "bg-accent text-ink-on-dark" : "bg-card text-ink hover:bg-ink/10"}`}
            title="开启深度搜索后，后续问题会搜索已配置的数据库"
          >
            深度搜索 {databaseEnabled ? "开" : "关"}
          </button>
          {showDevelopmentDatabaseSync && (
            <button
              type="button"
              onClick={() => { void syncDatabase(); }}
              disabled={!canWrite || databaseSyncing || loading}
              className="border-2 border-dashed border-accent px-2 py-1 text-[10px] font-semibold text-accent hover:bg-accent hover:text-ink-on-dark disabled:border-muted disabled:text-muted"
              title="仅开发环境：生成已配置数据库的本地只读快照"
            >
              {databaseSyncing ? "同步中…" : "开发同步"}
            </button>
          )}
          {diffEntryStats && onDiffSidebarToggle && (
            <button
              type="button"
              id="diff-sidebar-trigger"
              onClick={onDiffSidebarToggle}
              aria-expanded={Boolean(diffSidebarOpen)}
              aria-controls="diff-sidebar"
              className={`border-2 border-ink px-2 py-1 text-[10px] font-semibold hover:bg-ink hover:text-ink-on-dark ${diffSidebarOpen ? "bg-ink text-ink-on-dark" : "bg-card text-ink"}`}
              title="查看本轮与历史的文件修改 Diff"
            >
              Diff <DiffStatsLabel statistics={diffEntryStats} />
            </button>
          )}
          <button
            type="button"
            disabled={!hasWorkspace || !sessionId}
            onClick={() => setPermissionPanelOpen(true)}
            className="border-2 border-ink px-2 py-1 text-[10px] font-semibold hover:bg-ink hover:text-ink-on-dark disabled:bg-muted disabled:text-ink-on-dark"
            title={sessionId ? "查看并撤销持久授权" : "创建会话后可管理授权"}
          >
            授权
          </button>
          <button
            type="button"
            onClick={() => setStorageQuotaPanelOpen(true)}
            className={`border-2 border-ink px-2 py-1 text-[10px] font-semibold hover:bg-ink hover:text-ink-on-dark ${storageQuota?.status === "healthy" || !storageQuota ? "" : "border-accent text-accent"}`}
            title="查看并设置本机服务端全局 Agent 存储上限"
          >
            存储{storageQuota?.status === "warning" ? " !" : storageQuota?.status === "degraded" ? " !!" : ""}
          </button>
          {activeTurnId && !readOnlyReason && (
            <button
              type="button"
              onClick={() => {
                void cancelCurrentTurn();
              }}
              className="border-2 border-ink px-2 py-1 text-[10px] font-semibold hover:bg-accent hover:text-ink-on-dark"
              title="终止当前任务（Esc）"
            >
              终止 Esc
            </button>
          )}
        </div>}
      </header>
      {!isChat && <aside className="border-b-2 border-ink px-4 py-2 text-xs text-muted" aria-label="网络搜索隐私提示">
        {WEB_SEARCH_DATA_FLOW_NOTICE} <Link href={`/settings?returnTo=${encodeURIComponent(conversationUrl(workspaceId, sessionId))}`} className="text-accent underline">模型与搜索配置</Link>
      </aside>}
    </>
  );
}
