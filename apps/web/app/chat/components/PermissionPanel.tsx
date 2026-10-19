/**
 * 会话授权管理面板：读取当前会话可见的持久授权，并允许用户逐项撤销。
 */
"use client";

import { useEffect, useState } from "react";

interface PersistentGrant {
  scope: "allow_session" | "allow_workspace";
  toolName: string;
  constraint: string;
  projection?: "synced" | "pending";
  createdAt: string;
}

interface PermissionPanelProps {
  workspaceId: string;
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

/** Turn a persisted scope into a label users can act on. */
function getScopeLabel(scope: PersistentGrant["scope"]): string {
  return scope === "allow_workspace" ? "本工作区" : "本会话";
}

/** Read the grants currently visible to the selected session. */
async function fetchGrants(workspaceId: string, sessionId: string): Promise<PersistentGrant[]> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/permissions`);
  console.log(response);
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: "授权读取失败" }))).error || "授权读取失败");
  const payload = await response.json() as { grants?: PersistentGrant[] };
  return payload.grants || [];
}

/** Render and operate the session-scoped persistent authorization manager. */
export default function PermissionPanel({ workspaceId, sessionId, open, onClose }: PermissionPanelProps) {
  const [grants, setGrants] = useState<PersistentGrant[]>([]);
  const [error, setError] = useState("");
  const [revokingId, setRevokingId] = useState("");

  useEffect(() => {
    if (!open || !workspaceId || !sessionId) return;
    void fetchGrants(workspaceId, sessionId)
      .then((items) => {
        setGrants(items);
        setError("");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "授权读取失败"))
  }, [open, workspaceId, sessionId]);

  /** Revoke a single persisted grant by toolName+constraint and remove it from the visible list on success. */
  async function handleRevoke(grant: PersistentGrant): Promise<void> {
    if (!workspaceId || !sessionId || revokingId) return;
    const grantKey = `${grant.scope}|${grant.toolName}|${grant.constraint}`;
    setRevokingId(grantKey);
    setError("");
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/permissions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: grant.toolName, constraint: grant.constraint }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({ error: "撤销授权失败" }))).error || "撤销授权失败");
      setGrants((current) => current.filter((item) => `${item.scope}|${item.toolName}|${item.constraint}` !== grantKey));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "撤销授权失败");
    } finally {
      setRevokingId("");
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6" role="dialog" aria-modal="true" aria-label="授权管理" onMouseDown={onClose}>
      <section className="max-h-[80vh] w-full max-w-2xl overflow-y-auto border-[3px] border-ink bg-card p-5" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b-2 border-ink pb-3">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-accent">Agent 权限</p>
            <h2 className="mt-1 text-lg font-bold">授权管理</h2>
            <p className="mt-1 text-xs text-muted">撤销后，后续同范围操作会再次请求确认。</p>
          </div>
          <button type="button" onClick={onClose} className="border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark">关闭</button>
        </div>

        <div className="mt-4 space-y-2">
          {error && <p className="border-2 border-accent px-3 py-2 text-xs text-ink">{error}</p>}
          {!error && grants.length === 0 && <p className="border-2 border-ink px-3 py-3 text-xs text-muted">当前会话没有可撤销的持久授权。</p>}
          {grants.map((grant) => {
            const grantKey = `${grant.scope}|${grant.toolName}|${grant.constraint}`;
            return (
            <div key={grantKey} className="border-2 border-ink px-3 py-3 text-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{grant.toolName} · {getScopeLabel(grant.scope)}{grant.projection === "pending" ? " · 记住未同步（待重新批准）" : ""}</p>
                  <p className="mt-1 break-all text-muted">{grant.constraint}</p>
                </div>
                <button type="button" disabled={revokingId === grantKey} onClick={() => void handleRevoke(grant)} className="shrink-0 border-2 border-ink px-2 py-1 text-[10px] hover:bg-accent hover:text-ink-on-dark disabled:bg-muted disabled:text-ink-on-dark">
                  {revokingId === grantKey ? "撤销中" : "撤销"}
                </button>
              </div>
            </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
