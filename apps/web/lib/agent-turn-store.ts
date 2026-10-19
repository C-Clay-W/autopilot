/**
 * 进程内活动 turn 取消索引：仅用于即时 abort；恢复正确性始终依赖 JSONL checkpoint。
 */
const activeTurnControllers = new Map<string, AbortController>();
const queueStartLocks = new Set<string>();

/** 注册正在运行的 turn，以供 cancel route 立即广播 AbortSignal。 */
export function registerActiveTurn(sessionId: string, turnId: string, controller: AbortController): void {
  activeTurnControllers.set(`${sessionId}:${turnId}`, controller);
}

/** 移除已经结束的 turn，避免误取消后续同 ID 不同生命周期。 */
export function unregisterActiveTurn(sessionId: string, turnId: string, controller?: AbortController): void {
  const key = `${sessionId}:${turnId}`;
  if (!controller || activeTurnControllers.get(key) === controller) {
    activeTurnControllers.delete(key);
  }
}

/** 立即取消当前进程中的活动 turn；进程重启后由 checkpoint 恢复逻辑接管。 */
export function cancelActiveTurn(sessionId: string, turnId: string): boolean {
  const controller = activeTurnControllers.get(`${sessionId}:${turnId}`);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** 判断 coordinator 是否仍在本进程运行，供删除会话的受控取消流程使用。 */
export function hasActiveTurn(sessionId: string, turnId: string): boolean {
  return activeTurnControllers.has(`${sessionId}:${turnId}`);
}

/** 尝试取得同一 Session 的排队 Turn 启动锁；已有启动者时立即返回 undefined。 */
export function tryAcquireQueueStartLock(sessionId: string): (() => void) | undefined {
  if (queueStartLocks.has(sessionId)) return undefined;
  queueStartLocks.add(sessionId);
  let released = false;
  return function releaseQueueStartLock(): void {
    if (released) return;
    released = true;
    queueStartLocks.delete(sessionId);
  };
}
