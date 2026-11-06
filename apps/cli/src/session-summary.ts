/** CLI当前交互身份摘要：待审批/输入不把已释放的执行activeTurnId当作当前Turn身份。 */
import { readTurnExecutionView, type RuntimePorts, type SessionDirectoryEntry, type TurnExecutionView } from "@autopilot-agent/core";

/** 只读目录与最新Turn，校验归属/状态并在await后复核元数据；安全投影按游标追尾，取消后停止后续读取，不恢复执行。 */
export async function readCliSessionSummary(ports: RuntimePorts, sessionId: string, signal?: AbortSignal): Promise<(SessionDirectoryEntry & { currentTurnId?: string; executionView?: TurnExecutionView | null }) | null> {
  if (!ports.sessionStore.getDirectoryEntry) throw new Error("CLI_SESSION_DIRECTORY_UNAVAILABLE");
  signal?.throwIfAborted();
  const summary = await ports.sessionStore.getDirectoryEntry(sessionId);
  signal?.throwIfAborted();
  if (!summary) return null;
  const executionView = await readTurnExecutionView(ports, { sessionId, signal });
  signal?.throwIfAborted();
  if (executionView) return { ...summary, status: executionView.status, currentTurnId: executionView.turnId, executionView };
  if (summary.status !== "waiting_approval" && summary.status !== "waiting_user_input") return { ...summary, currentTurnId: summary.activeTurnId };
  const latest = await ports.turnStore.getLatest(sessionId);
  signal?.throwIfAborted();
  const current = await ports.sessionStore.getDirectoryEntry(sessionId);
  if (!current || current.status !== summary.status || current.activeTurnId !== summary.activeTurnId) return null;
  const valid = latest?.sessionId === sessionId && latest.status === current.status;
  return { ...current, currentTurnId: valid ? latest.id : undefined };
}
