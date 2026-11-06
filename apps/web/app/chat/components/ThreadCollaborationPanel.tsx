"use client";
/**
 * ThreadCollaborationPanel.tsx — 会话协作面板（只读 + 人类启用/停用）
 *
 * 展示成员与状态、消息交付状态、共享板受控内容与 revision，并支持复制独立链接。
 * 建会话、发任务与写共享板仍由 Agent 工具完成；停用不等于停止活动任务。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { conversationUrl } from "../conversation-target";
import type { ThreadGroupSummary } from "../hooks/useThreadGroups";

/** 浏览器会话摘要；只取面板需要的安全字段。 */
interface PanelSession {
  id: string;
  title: string;
  runtimeStatus: string;
  activeTurnId?: string;
}

/** 面板展示的消息投影；正文只做截断预览，不进入其他状态。 */
interface PanelMessage {
  messageId: string;
  mode: string;
  deliveryStatus: string;
  deliverySeq: number;
  content: string;
}

/** 共享板读取结果。 */
interface PanelState {
  value: Record<string, unknown>;
  revision: number;
  updatedAt?: number;
}

const DELIVERY_LABELS: Record<string, string> = {
  accepted: "已接受",
  pending: "待宿主领取",
  claimed: "宿主已领取",
  delivered: "已交付",
  blocked: "已阻塞",
  failed: "失败",
  cancelled: "已取消",
};

/** 协作面板外壳；open=false 时不渲染，避免无谓请求。 */
export default function ThreadCollaborationPanel({ open, workspaceId, sessionId, onClose, onChanged }: {
  open: boolean;
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [groups, setGroups] = useState<ThreadGroupSummary[]>([]);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [sessions, setSessions] = useState<PanelSession[]>([]);
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [messagesError, setMessagesError] = useState<string | undefined>(undefined);
  const [state, setState] = useState<PanelState | undefined>(undefined);
  const [sessionReady, setSessionReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const matchingGroups = groups.filter(function containsSession(item) { return item.members.some(function member(member) { return member.threadId === sessionId; }); });
  const ambiguous = matchingGroups.length > 1;
  const group = useMemo(function findGroup() {
    const matched = groups.filter(function containsSession(item) { return item.members.some(function member(member) { return member.threadId === sessionId; }); });
    return matched.length === 1 ? matched[0] : undefined;
  }, [groups, sessionId]);
  const session = sessions.find(function matchSession(item) { return item.id === sessionId; });
  const sessionIdle = sessionReady;

  /** 重新读取面板数据；组存在时才读共享板与消息。 */
  const load = useCallback(async function load() {
    if (!open || !workspaceId || !sessionId) return;
    setLoading(true);
    setSessionReady(false);
    setError(undefined);
    // 重新读取时先丢弃上一次结果，避免失败后继续展示旧消息或误报为空。
    setMessages([]);
    setMessagesLoaded(false);
    setMessagesError(undefined);
    try {
      const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
      const [groupsResponse, capabilitiesResponse, sessionsResponse, detailResponse] = await Promise.all([
        fetch(`${base}/threads/groups`),
        fetch(`${base}/threads/capabilities`),
        fetch(`${base}/sessions`),
        fetch(`${base}/sessions/${encodeURIComponent(sessionId)}`),
      ]);
      if (!groupsResponse.ok || !capabilitiesResponse.ok) {
        setError("无法读取协作状态");
        return;
      }
      const groupsPayload = await groupsResponse.json() as { items?: ThreadGroupSummary[] };
      const capabilitiesPayload = await capabilitiesResponse.json() as { allowedTools?: string[] };
      const nextGroups = Array.isArray(groupsPayload.items) ? groupsPayload.items : [];
      setGroups(nextGroups);
      setAllowedTools(Array.isArray(capabilitiesPayload.allowedTools) ? capabilitiesPayload.allowedTools : []);
      if (sessionsResponse.ok) {
        const sessionsPayload = await sessionsResponse.json() as { sessions?: PanelSession[] };
        setSessions(Array.isArray(sessionsPayload.sessions) ? sessionsPayload.sessions : []);
      }
      if (detailResponse.ok) {
        const detail = await detailResponse.json() as { meta?: { runtimeStatus?: string; activeTurnId?: string }; agent?: { status?: string }; canAutoStartNext?: boolean; readOnlyReason?: string };
        const status = detail.meta?.runtimeStatus;
        setSessionReady(!detail.readOnlyReason && !detail.meta?.activeTurnId && (status === "idle" || (status === "completed" && detail.canAutoStartNext === true && !detail.agent)));
      }
      const matches = nextGroups.filter(function contains(item) { return item.members.some(function member(member) { return member.threadId === sessionId; }); });
      const target = matches.length === 1 ? matches[0] : undefined;
      if (!target) {
        setMessages([]);
        setMessagesLoaded(true);
        setState(undefined);
        return;
      }
      const [stateResponse, messagesResponse] = await Promise.all([
        fetch(`${base}/threads/groups/${encodeURIComponent(target.groupId)}/state`),
        fetch(`${base}/threads/${encodeURIComponent(sessionId)}/messages?groupId=${encodeURIComponent(target.groupId)}&limit=10`),
      ]);
      if (stateResponse.ok) {
        const payload = await stateResponse.json() as { value?: Record<string, unknown>; revision?: number; updatedAt?: number };
        setState({ value: payload.value && typeof payload.value === "object" ? payload.value : {}, revision: typeof payload.revision === "number" ? payload.revision : 0, updatedAt: payload.updatedAt });
      }
      if (messagesResponse.ok) {
        const payload = await messagesResponse.json() as { items?: PanelMessage[] };
        setMessages(Array.isArray(payload.items) ? payload.items : []);
        setMessagesLoaded(true);
      } else {
        const failure = await messagesResponse.json().catch(function empty() { return {} as { error?: unknown }; });
        setMessagesError(typeof failure.error === "string" ? failure.error : "无法读取协作消息");
      }
    } catch {
      setError("无法读取协作状态");
      setMessagesError("无法读取协作消息");
    } finally {
      setLoading(false);
    }
  }, [open, workspaceId, sessionId]);

  useEffect(function loadOnOpen() {
    if (!open) return;
    void load();
  }, [open, load]);

  /** 统一提交启用/停用；失败只展示服务端安全文案。 */
  async function submit(input: { method: "POST" | "PATCH"; url: string; body: Record<string, unknown> }): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(input.url, { method: input.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.body) });
      if (!response.ok) {
        const failure = await response.json().catch(function empty() { return {} as Record<string, unknown>; });
        setError(typeof failure.error === "string" ? failure.error : "协作操作失败");
        return false;
      }
      await load();
      onChanged?.();
      return true;
    } catch {
      setError("协作操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 人类显式启用协作：确认后由宿主绑定当前空闲会话与授权清单。 */
  async function enableGroup(): Promise<void> {
    const enabled = await submit({
      method: "POST",
      url: `/api/workspaces/${encodeURIComponent(workspaceId)}/threads/groups`,
      body: { requestId: crypto.randomUUID(), rootThreadId: sessionId },
    });
    if (enabled) setNotice("已启用会话协作");
  }

  /** 停用只关闭新增写入，不停止活动任务；运行中任务需先用停止按钮中断。 */
  async function disableGroup(): Promise<void> {
    if (!group) return;
    const enabled = await submit({
      method: "PATCH",
      url: `/api/workspaces/${encodeURIComponent(workspaceId)}/threads/groups/${encodeURIComponent(group.groupId)}`,
      body: { requestId: crypto.randomUUID(), enabled: false },
    });
    if (enabled) setNotice("已停用协作组；历史、回执与未交付项保留");
  }

  /** 重新启用复用同一组，必须由人类再次确认。 */
  async function reenableGroup(): Promise<void> {
    if (!group) return;
    const enabled = await submit({
      method: "PATCH",
      url: `/api/workspaces/${encodeURIComponent(workspaceId)}/threads/groups/${encodeURIComponent(group.groupId)}`,
      body: { requestId: crypto.randomUUID(), enabled: true, rootThreadId: group.rootThreadId },
    });
    if (enabled) setNotice("已重新启用会话协作");
  }

  /** 复制独立链接；链接只含不透明的 workspaceId 与 sessionId。 */
  async function copyLink(threadId: string): Promise<void> {
    try {
      const absolute = new URL(conversationUrl(workspaceId, threadId), window.location.origin).toString();
      await navigator.clipboard.writeText(absolute);
      setNotice("已复制会话链接");
    } catch {
      setError("复制失败，请手动复制地址栏链接");
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal="true" aria-label="会话协作">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto border-[3px] border-ink bg-card p-4 text-sm text-ink">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold">会话协作</h2>
            <p className="mt-1 text-xs text-muted">只读观察成员与交付状态；建会话、发任务与写共享板由 Agent 工具完成。</p>
          </div>
          <button type="button" onClick={onClose} className="border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark" title="关闭">关闭</button>
        </div>

        {loading && <p className="text-xs text-muted">加载中…</p>}
        {error && <p role="alert" className="mb-2 border-2 border-accent px-2 py-1 text-xs text-accent">{error}</p>}
        {notice && <p className="mb-2 border-2 border-rule px-2 py-1 text-xs text-muted">{notice}</p>}

        {ambiguous && <p className="mb-2 text-xs text-muted" role="status">当前会话关联多个协作范围，需按明确范围操作；任务条分别按真实任务展示。</p>}
        {!loading && !group && !ambiguous && (
          <section className="space-y-3">
            <p className="text-xs text-muted">当前会话尚未启用协作。启用后可创建子会话、收发任务消息并共享显式状态。</p>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-accent">授权工具清单</p>
              <p className="mt-1 break-all text-xs text-ink-soft">{allowedTools.join("、") || "（宿主未提供）"}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!sessionIdle || busy}
                onClick={function handleEnable() { void enableGroup(); }}
                className="border-2 border-ink px-3 py-1.5 text-xs font-semibold hover:bg-ink hover:text-ink-on-dark disabled:cursor-not-allowed disabled:opacity-50"
                title={sessionIdle ? "启用会话协作" : "仅空闲会话可启用协作"}
              >
                启用会话协作
              </button>
              {!sessionIdle && <span className="text-xs text-muted">会话正在执行，需等待空闲后启用</span>}
            </div>
          </section>
        )}

        {!loading && group && (
          <div className="space-y-4">
            <section>
              <p className="text-[10px] uppercase tracking-widest text-accent">状态</p>
              <p className="mt-1 text-xs">
                {group.enabled ? "已启用" : "已停用"} · 根会话 {group.rootThreadId.slice(0, 8)} · 成员 {group.members.length}
              </p>
              {!group.enabled && <p className="mt-1 text-xs text-muted">停用只拒绝新增创建、发送、共享板写入与中断请求；历史、回执与未交付项保留。</p>}
              {session?.runtimeStatus === "running" && <p className="mt-1 text-xs text-accent">当前仍有运行中任务；停用不会停止它，如需停止请先使用顶部停止按钮。</p>}
            </section>

            <section>
              <p className="text-[10px] uppercase tracking-widest text-accent">成员</p>
              <ul className="mt-1 divide-y-2 divide-rule border-2 border-ink">
                {group.members.map(function renderMember(member) {
                  const memberSession = sessions.find(function match(item) { return item.id === member.threadId; });
                  return <li key={member.threadId} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate" title={member.title ?? member.threadId}>
                      {member.parentThreadId ? "↳ " : "▰ "}
                      {memberSession?.title ?? member.title ?? member.threadId.slice(0, 8)}
                      {member.roleLabel ? <span className="ml-1 text-muted">[{member.roleLabel}]</span> : null}
                    </span>
                    <span className="shrink-0 text-muted">{memberSession?.runtimeStatus ?? "未知"}</span>
                    <button type="button" onClick={function handleCopy() { void copyLink(member.threadId); }} className="shrink-0 border-2 border-ink px-1.5 text-[10px] hover:bg-ink hover:text-ink-on-dark" title="复制该会话链接">链接</button>
                  </li>;
                })}
              </ul>
            </section>

            <section>
              <p className="text-[10px] uppercase tracking-widest text-accent">消息交付状态</p>
              {messagesError
                ? <p role="alert" className="mt-1 border-2 border-accent px-2 py-1 text-xs text-accent">{messagesError}</p>
                : !messagesLoaded
                  ? <p className="mt-1 text-xs text-muted">正在读取协作消息…</p>
                  : messages.length === 0
                    ? <p className="mt-1 text-xs text-muted">暂无协作消息。</p>
                    : <ul className="mt-1 divide-y-2 divide-rule border-2 border-ink">
                      {messages.map(function renderMessage(message) {
                        return <li key={message.messageId} className="px-2 py-1.5 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 text-muted">#{message.deliverySeq}</span>
                            <span className="shrink-0 border-2 border-ink px-1 text-[10px]">{message.mode}</span>
                            <span className="shrink-0 text-muted">{DELIVERY_LABELS[message.deliveryStatus] ?? message.deliveryStatus}</span>
                          </div>
                          <p className="mt-1 line-clamp-2 break-all text-ink-soft">{message.content.slice(0, 160)}</p>
                        </li>;
                      })}
                    </ul>}
              <p className="mt-1 text-[10px] text-muted">“已接受 / 已交付”只说明投递事实；目标任务是否完成以对应会话的 Turn 结果为准。</p>
            </section>

            <section>
              <p className="text-[10px] uppercase tracking-widest text-accent">共享板 · revision {state?.revision ?? 0}</p>
              {state && Object.keys(state.value).length > 0
                ? <pre className="mt-1 max-h-40 overflow-auto border-2 border-ink px-2 py-1 text-[11px] leading-snug">{JSON.stringify(state.value, null, 2).slice(0, 2_000)}</pre>
                : <p className="mt-1 text-xs text-muted">共享板为空。</p>}
            </section>

            <section className="flex flex-wrap items-center gap-2">
              {group.enabled
                ? <button
                  type="button"
                  disabled={busy}
                  onClick={function handleDisable() { if (window.confirm("停用后拒绝新增创建、发送、共享板写入与中断请求；历史与未交付项保留。继续？")) void disableGroup(); }}
                  className="border-2 border-ink px-3 py-1.5 text-xs font-semibold hover:bg-ink hover:text-ink-on-dark disabled:opacity-50"
                >
                  停用协作组
                </button>
                : <button
                  type="button"
                  disabled={busy || !sessionIdle}
                  onClick={function handleReenable() { void reenableGroup(); }}
                  className="border-2 border-ink px-3 py-1.5 text-xs font-semibold hover:bg-ink hover:text-ink-on-dark disabled:cursor-not-allowed disabled:opacity-50"
                  title="重新启用需要空闲会话，并会重新校验 Trust"
                >
                  重新启用
                </button>}
              <button type="button" onClick={function handleRefresh() { void load(); }} className="border-2 border-ink px-3 py-1.5 text-xs hover:bg-ink hover:text-ink-on-dark">刷新</button>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
