/** chat-session-host.tsx — Session/URL/草稿槽/Workspace 宿主编排；整段自原 page.tsx 的 SessionChatHost 原样迁入，继续复用 session-chat-host.ts 纯判断。 */
"use client";

import { useState, useRef, useEffect } from "react";
import { flushSync } from "react-dom";
import { useSearchParams } from "next/navigation";
import WorkspacePicker from "./components/WorkspacePicker";
import WorkspaceTrustDialog from "./components/WorkspaceTrustDialog";
import { ProductModeTabs } from "./components/ChatModeControls";
import { CHAT_SCOPE, conversationUrl, readConversationTarget } from "./conversation-target";
import type { ChatRetrievalMode } from "@autopilot-agent/core";
import { useSessionTaskContext, useSessionTaskList, type WorkspaceSummary } from "./session-task-context";
import { createWorkspaceSessionKey } from "./session-task-store";
import { navigateChat } from "./chat-navigation";
import { isProvisionalSessionSelected, shouldReleaseProvisionalTransition } from "./session-chat-host";
import type { DraftSessionSlot } from "./chat-page-types";
import ChatPageContent from "./chat-page-content";

/** URL 直达 Session 的稳定渲染条目；列表就绪后由真实条目以相同 key 复用实例，只补 Meta 不换组件。 */
interface RetainedSessionEntry {
  key: string;
  workspaceId: string;
  id: string;
  retrievalMode: ChatRetrievalMode;
  workspace: WorkspaceSummary | undefined;
}

/** 保留已访问 Session 的聊天实例，使 URL 切换不会卸载后台 SSE 与草稿。 */
export default function SessionChatHost() {
  const searchParams = useSearchParams();
  const target = readConversationTarget(searchParams);
  const selectedWorkspaceId = target.scope;
  const selectedSessionId = target.sessionId;
  const selectedDraftId = searchParams.get("draft") || "";
  const { manager, workspaces, directoryPickerAvailable, refreshWorkspaces, refreshSessions } = useSessionTaskContext();
  const sessionItems = useSessionTaskList();
  const [draftSlots, setDraftSlots] = useState<DraftSessionSlot[]>([]);
  const draftSlotsRef = useRef<DraftSessionSlot[]>([]);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspacePickerCancellable, setWorkspacePickerCancellable] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [trustChallenge, setTrustChallenge] = useState<{ challengeId: string; displayName: string } | null>(null);
  const pickerAbortControllerRef = useRef<AbortController | null>(null);
  /** 收敛 Session 创建回调与 URL 更新可能分离提交的短暂渲染。 */
  const [draftTransition, setDraftTransition] = useState<DraftSessionSlot | null>(null);
  const draftTransitionRef = useRef<DraftSessionSlot | null>(null);
  const selectedSessionKey = selectedWorkspaceId && selectedSessionId ? createWorkspaceSessionKey(selectedWorkspaceId, selectedSessionId) : "";

  useEffect(function loadWorkRegistryOnEntry() {
    if (target.productMode === "work") void refreshWorkspaces();
  }, [target.productMode, refreshWorkspaces]);

  useEffect(function syncSelectedSession() {
    manager.selectSession(selectedSessionKey || null);
  }, [manager, selectedSessionKey]);

  /** 等 URL 订阅者确认新 Session 后再释放过渡态，期间必须保留原首发 Chat 实例。 */
  useEffect(function releaseCommittedDraftTransition() {
    const transition = draftTransitionRef.current;
    if (!shouldReleaseProvisionalTransition(transition, selectedWorkspaceId, selectedSessionId)) return;
    draftTransitionRef.current = null;
    setDraftTransition((current) => current?.slotId === transition?.slotId ? null : current);
  }, [selectedWorkspaceId, selectedSessionId]);

  /** 首次持久动作开始前保留原草稿实例，切换页面不卸载在途创建/上传。 */
  function handleSessionStarting(slot: DraftSessionSlot): void {
    if (draftSlotsRef.current.some((item) => item.slotId === slot.slotId)) return;
    const next = [...draftSlotsRef.current, { ...slot, pending: true }];
    draftSlotsRef.current = next;
    flushSync(function retainPendingDraft() { setDraftSlots(next); });
  }

  /** 创建回调只绑定发起动作的槽位；迟到创建不会把用户从另一页面拉回来。 */
  function handleSessionCreated(slot: DraftSessionSlot, sessionId: string): void {
    const nextSlot: DraftSessionSlot = { ...slot, sessionId, pending: false };
    const nextDraftSlots = draftSlotsRef.current.map((item) => item.slotId === slot.slotId ? nextSlot : item);
    draftSlotsRef.current = nextDraftSlots;
    draftTransitionRef.current = nextSlot;
    flushSync(function commitCreatedDraftSlot() {
      setDraftTransition(nextSlot);
      setDraftSlots(nextDraftSlots);
    });
    window.setTimeout(function selectCreatedSession() {
      const params = new URLSearchParams(window.location.search);
      const current = readConversationTarget(params);
      if (current.scope === slot.workspaceId && !current.sessionId && (params.get("draft") || "") === (slot.draftId || "")) {
        navigateChat(conversationUrl(slot.workspaceId, sessionId));
      }
    }, 0);
  }

  /** 产品切换打开全新草稿，不传递当前输入、附件或知识引用。 */
  function changeProduct(mode: "chat" | "work"): void {
    if (mode === target.productMode) return;
    setWorkspacePickerOpen(false);
    setTrustChallenge(null);
    pickerAbortControllerRef.current?.abort();
    navigateChat(conversationUrl(mode === "chat" ? CHAT_SCOPE : "", "", "none", crypto.randomUUID()));
  }

  /** 来源切换始终进入新的空白 Chat，旧持久会话与后台任务保留。 */
  function changeRetrieval(mode: ChatRetrievalMode): void {
    navigateChat(conversationUrl(CHAT_SCOPE, "", mode, crypto.randomUUID()));
  }

  /** 打开输入区和无工作区空态共用的选择器入口。 */
  function openWorkspacePicker(): void {
    setWorkspaceError("");
    setWorkspacePickerOpen(true);
  }

  /** 关闭 picker 后将焦点还给触发 Chip，保持键盘导航连续。 */
  function closeWorkspacePicker(): void {
    setWorkspacePickerOpen(false);
    window.requestAnimationFrame(function restoreWorkspaceChipFocus() {
      document.querySelector<HTMLButtonElement>("[data-workspace-chip]")?.focus();
    });
  }

  /** 切换工作区只更新 URL，绝不改写已有 Session 的 projectId。 */
  function selectWorkspace(workspaceId: string): void {
    setWorkspacePickerOpen(false);
    navigateChat(conversationUrl(workspaceId, "", "none", crypto.randomUUID()));
  }

  /** 通过 Host 原生 chooser 添加工作区，并把 token 立即交给安全 open Route。 */
  async function addWorkspace(): Promise<void> {
    if (workspaceBusy) return;
    const selectionAtStart = window.location.search;
    const pickerController = new AbortController();
    pickerAbortControllerRef.current = pickerController;
    setWorkspacePickerCancellable(true);
    setWorkspaceBusy(true);
    setWorkspaceError("");
    try {
      const pickerResponse = await fetch("/api/workspaces/picker", { method: "POST", signal: pickerController.signal });
      console.log(pickerResponse);
      const pickerPayload = await pickerResponse.json().catch(() => ({})) as { selection?: { selectionToken?: string }; error?: string };
      if (!pickerResponse.ok) throw new Error(pickerPayload.error || "无法打开本机目录选择器");
      const selectionToken = pickerPayload.selection?.selectionToken;
      if (!selectionToken) return;
      setWorkspacePickerCancellable(false);
      if (pickerController.signal.aborted) return;
      const openResponse = await fetch("/api/workspaces/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectionToken }), signal: pickerController.signal });
      console.log(openResponse);
      const openPayload = await openResponse.json().catch(() => ({})) as { workspace?: WorkspaceSummary; challenge?: { challengeId: string; displayName: string }; error?: string };
      if (!openResponse.ok) throw new Error(openPayload.error || "无法打开工作区");
      if (window.location.search !== selectionAtStart) return;
      if (openPayload.challenge) {
        setTrustChallenge(openPayload.challenge);
        return;
      }
      if (!openPayload.workspace) throw new Error("工作区响应无效");
      await refreshWorkspaces();
      await refreshSessions(openPayload.workspace.workspaceId);
      if (window.location.search === selectionAtStart) selectWorkspace(openPayload.workspace.workspaceId);
    } catch (error) {
      if (pickerController.signal.aborted) return;
      setWorkspaceError(error instanceof Error ? error.message : "工作区操作失败");
    } finally {
      if (pickerAbortControllerRef.current === pickerController) pickerAbortControllerRef.current = null;
      setWorkspacePickerCancellable(false);
      setWorkspaceBusy(false);
    }
  }

  /** 取消正在等待的本机 chooser，并通过 AbortSignal 释放服务端 busy 锁。 */
  function cancelWorkspacePicker(): void {
    const pickerController = pickerAbortControllerRef.current;
    if (!pickerController) return;
    pickerController.abort();
    setWorkspacePickerOpen(false);
    setWorkspaceError("");
  }

  /** 将 Trust 决定提交给 Host；拒绝仅关闭确认，不创建 Runtime 或隐式选中目录。 */
  async function decideWorkspaceTrust(decision: "allow" | "deny"): Promise<void> {
    if (!trustChallenge || workspaceBusy) return;
    const selectionAtStart = window.location.search;
    setWorkspaceBusy(true);
    try {
      const response = await fetch("/api/workspaces/trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeId: trustChallenge.challengeId, decision }) });
      console.log(response);
      const payload = await response.json().catch(() => ({})) as { workspace?: WorkspaceSummary; error?: string };
      if (window.location.search !== selectionAtStart) return;
      if (!response.ok) throw new Error(payload.error || "工作区信任确认失败");
      setTrustChallenge(null);
      if (decision === "deny" || !payload.workspace) {
        setWorkspaceError("未授予工作区访问权限。");
        return;
      }
      await refreshWorkspaces();
      await refreshSessions(payload.workspace.workspaceId);
      if (window.location.search === selectionAtStart) selectWorkspace(payload.workspace.workspaceId);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "工作区信任确认失败");
    } finally {
      setWorkspaceBusy(false);
    }
  }

  /** 取消只关闭前端确认卡，保留 challenge 直到过期，绝不发送 Trust 请求。 */
  function cancelWorkspaceTrust(): void {
    if (workspaceBusy) return;
    setTrustChallenge(null);
  }

  const renderDraftSlots = draftSlots;
  const renderDraftTransition = draftTransition;
  const listedSessionKeys = new Set(sessionItems.map(function getSessionKey(item) { return item.key; }));
  const visitedSessionKeys = new Set(manager.getVisitedSessionIds());
  const provisionalSessionKeys = new Set(renderDraftSlots.filter(function isBoundDraftSlot(item) { return Boolean(item.sessionId); }).map(function getProvisionalSessionKey(item) {
    return createWorkspaceSessionKey(item.workspaceId, item.sessionId);
  }));
  const renderedDraftSlots = renderDraftSlots.filter(function keepLiveDraftSlot(item) {
    if (!item.sessionId) return item.pending === true;
    const key = createWorkspaceSessionKey(item.workspaceId, item.sessionId);
    return listedSessionKeys.has(key) || visitedSessionKeys.has(key) || key === selectedSessionKey;
  });
  const transitionDraftSlot = renderDraftTransition && !renderDraftSlots.some(function hasCommittedTransitionSlot(item) {
    return item.slotId === renderDraftTransition.slotId && item.sessionId === renderDraftTransition.sessionId;
  }) ? renderDraftTransition : null;
  const selectedDraftSlot = renderedDraftSlots.find(function findSelectedDraftSlot(item) {
    return isProvisionalSessionSelected(item, selectedWorkspaceId, selectedSessionId);
  }) ?? (transitionDraftSlot && isProvisionalSessionSelected(transitionDraftSlot, selectedWorkspaceId, selectedSessionId) ? transitionDraftSlot : undefined);
  const blankDraftSlot = !selectedSessionId
    ? (renderDraftTransition && renderDraftTransition.workspaceId === selectedWorkspaceId && (renderDraftTransition.draftId || "") === selectedDraftId ? renderDraftTransition : undefined)
      ?? renderDraftSlots.findLast(function findBlankDraftSlot(item) { return item.workspaceId === selectedWorkspaceId && !item.sessionId && (item.draftId || "") === selectedDraftId; })
      ?? {
        slotId: renderDraftSlots.some(function hasWorkspaceDraft(item) { return item.workspaceId === selectedWorkspaceId; }) ? `unbound:${selectedWorkspaceId}:${selectedDraftId}:${renderDraftSlots.length}` : `initial:${selectedWorkspaceId}:${selectedDraftId}:${renderDraftSlots.length}`,
        workspaceId: selectedWorkspaceId,
        retrievalMode: target.retrievalMode,
        draftId: selectedDraftId,
        sessionId: "",
      }
    : null;
  const selectedSessionNeedsDraft = Boolean(selectedSessionId && selectedWorkspaceId && !listedSessionKeys.has(selectedSessionKey));
  const activeDraftSlot = selectedDraftSlot ?? blankDraftSlot;
  const retainedSessionKeys = new Set([...manager.getVisitedSessionIds(), selectedSessionKey].filter(Boolean));
  const renderedSessionItems = sessionItems.filter(function isRetainedSession(item) {
    return retainedSessionKeys.has(item.key) && listedSessionKeys.has(item.key) && !provisionalSessionKeys.has(item.key);
  });
  /** URL 直达 Session 而侧栏列表未就绪时，用稳定 key 先挂唯一实例；草稿槽已绑定该会话时不重复挂载。 */
  const retainedRenderEntries: RetainedSessionEntry[] = [
    ...renderedSessionItems.map(function toRenderEntry(item) {
      return { key: item.key, workspaceId: item.workspaceId, id: item.id, retrievalMode: item.session.chatRetrievalMode, workspace: workspaces.find(function findWorkspace(workspace) { return workspace.workspaceId === item.workspaceId; }) };
    }),
    ...(selectedSessionNeedsDraft && selectedWorkspaceId && !provisionalSessionKeys.has(selectedSessionKey)
      ? [{ key: selectedSessionKey, workspaceId: selectedWorkspaceId, id: selectedSessionId, retrievalMode: target.retrievalMode, workspace: workspaces.find(function findWorkspace(workspace) { return workspace.workspaceId === selectedWorkspaceId; }) }]
      : []),
  ];

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex justify-center border-b-2 border-ink px-4 py-2"><ProductModeTabs mode={target.productMode} onChange={changeProduct} /></div>
      <div id="conversation-panel" role="tabpanel" aria-labelledby={`mode-tab-${target.productMode}`} className="flex flex-1 min-h-0 flex-col">
      {[...(activeDraftSlot ? [activeDraftSlot] : []), ...renderedDraftSlots.filter((item) => item.slotId !== activeDraftSlot?.slotId)].map(function renderDraftSlot(item) {
        return <div key={`draft:${item.slotId}`} hidden={item.slotId !== activeDraftSlot?.slotId} className="flex flex-1 min-h-0 flex-col">
          <ChatPageContent workspaceId={item.workspaceId} workspace={workspaces.find((workspace) => workspace.workspaceId === item.workspaceId)} sessionId={item.sessionId} active={target.productMode === "work" && item.slotId === activeDraftSlot?.slotId} retrievalMode={item.retrievalMode} onSessionStarting={function starting() { handleSessionStarting(item); }} onSessionCreated={function created(sid) { handleSessionCreated(item, sid); }} onRetrievalChange={changeRetrieval} onOpenWorkspacePicker={openWorkspacePicker} />
        </div>;
      })}
      {retainedRenderEntries.map(function renderRetainedSession(item) {
        return (
          <div key={item.key} hidden={item.key !== selectedSessionKey} className="flex flex-1 min-h-0 flex-col">
            <ChatPageContent workspaceId={item.workspaceId} workspace={item.workspace} sessionId={item.id} active={target.productMode === "work" && item.key === selectedSessionKey} retrievalMode={item.retrievalMode} onSessionStarting={function alreadyCreated() {}} onSessionCreated={function alreadyBound() {}} onRetrievalChange={changeRetrieval} onOpenWorkspacePicker={openWorkspacePicker} />
          </div>
        );
      })}
      </div>
      <WorkspacePicker open={workspacePickerOpen} workspaces={workspaces} selectedWorkspaceId={selectedWorkspaceId} directoryPickerAvailable={directoryPickerAvailable} busy={workspaceBusy} cancellable={workspacePickerCancellable} error={workspaceError} onSelect={selectWorkspace} onAdd={function addWorkspaceFromPicker() { void addWorkspace(); }} onCancelPicker={cancelWorkspacePicker} onClose={closeWorkspacePicker} />
      <WorkspaceTrustDialog open={Boolean(trustChallenge)} displayName={trustChallenge?.displayName ?? ""} busy={workspaceBusy} onCancel={cancelWorkspaceTrust} onTrust={function submitWorkspaceTrust() { void decideWorkspaceTrust("allow"); }} />
    </div>
  );
}
