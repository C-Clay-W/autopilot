/** session-chat-host.ts — 临时会话在 Chat 壳中的可见性与渲染身份计算。 */

/** 首次发送创建的临时 Session 身份；未选择具体会话时仍显示空白草稿。 */
export interface ProvisionalSessionIdentity {
  workspaceId: string;
  sessionId: string;
}

/** 判断临时 Session 是否就是当前 URL 选中的会话。 */
export function isProvisionalSessionSelected(
  provisionalSession: ProvisionalSessionIdentity,
  selectedWorkspaceId: string,
  selectedSessionId: string,
): boolean {
  return Boolean(
    selectedSessionId
    && provisionalSession.workspaceId === selectedWorkspaceId
    && provisionalSession.sessionId === selectedSessionId,
  );
}

/** 仅在 URL 已确认选中创建出的 Session 后释放过渡槽，避免中间渲染卸载首发 SSE。 */
export function shouldReleaseProvisionalTransition(
  provisionalSession: ProvisionalSessionIdentity | null,
  selectedWorkspaceId: string,
  selectedSessionId: string,
): boolean {
  return Boolean(
    provisionalSession
    && isProvisionalSessionSelected(provisionalSession, selectedWorkspaceId, selectedSessionId),
  );
}

/** 计算临时 Chat 是否应显示以及当前应绑定的 Session。 */
export function resolveProvisionalSessionView(
  provisionalSession: ProvisionalSessionIdentity | null,
  selectedWorkspaceId: string,
  selectedSessionId: string,
): { visible: boolean; sessionId: string } {
  const matchesSelection = provisionalSession
    ? isProvisionalSessionSelected(provisionalSession, selectedWorkspaceId, selectedSessionId)
    : false;
  return {
    visible: !selectedSessionId || matchesSelection,
    sessionId: matchesSelection ? provisionalSession!.sessionId : "",
  };
}
