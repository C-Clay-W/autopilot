/** 会话任务 Store 测试：锁定 workspaceId + sessionId 的复合隔离与终态边沿。 */
import { describe, expect, it, vi } from "vitest";
import type { WebSessionDto } from "@/lib/runtime-host/web-ui-dto";
import { createSessionTaskManager, createWorkspaceSessionKey } from "@/app/chat/session-task-store";

/** 创建安全 Web Session DTO fixture。 */
function createSession(id: string, runtimeStatus: WebSessionDto["runtimeStatus"] = "idle", updatedAt = 1): WebSessionDto {
  return { id, title: `任务 ${id}`, createdAt: updatedAt - 1, updatedAt, status: "active", runtimeStatus };
}

/** 在指定工作区预置 Session，模拟 workspace-scoped 列表响应。 */
function createManager(workspaceId: string, sessions: WebSessionDto[]) {
  const manager = createSessionTaskManager();
  manager.syncWorkspaceSessions(workspaceId, sessions);
  return manager;
}

describe("SessionTaskManager", function sessionTaskManagerSuite() {
  it("为 A/B 保留独立快照和独立订阅通知", function isolatesSessionSnapshots() {
    const manager = createManager("workspace-a", [createSession("a"), createSession("b")]);
    const aKey = createWorkspaceSessionKey("workspace-a", "a");
    const bKey = createWorkspaceSessionKey("workspace-a", "b");
    const aListener = vi.fn();
    const bListener = vi.fn();
    manager.subscribeSession(aKey, aListener);
    manager.subscribeSession(bKey, bListener);
    manager.beginSession(aKey, "turn-a");
    expect(manager.getSessionSnapshot(aKey)).toMatchObject({ phase: "starting", activeTurnId: "turn-a" });
    expect(manager.getSessionSnapshot(bKey)).toMatchObject({ phase: "idle", activeTurnId: undefined });
    expect(aListener).toHaveBeenCalledTimes(1);
    expect(bListener).not.toHaveBeenCalled();
  });

  it("相同 sessionId 在不同工作区不会复用状态", function isolatesSameSessionIdsAcrossWorkspaces() {
    const manager = createManager("workspace-a", [createSession("same")]);
    manager.syncWorkspaceSessions("workspace-b", [createSession("same")]);
    const aKey = createWorkspaceSessionKey("workspace-a", "same");
    const bKey = createWorkspaceSessionKey("workspace-b", "same");
    manager.beginSession(aKey, "turn-a");
    expect(manager.getSessionSnapshot(aKey)).toMatchObject({ phase: "starting", activeTurnId: "turn-a" });
    expect(manager.getSessionSnapshot(bKey)).toMatchObject({ phase: "idle", activeTurnId: undefined });
  });

  it("只由精确终态事件为未查看会话武装一次性提醒", function armsTerminalNoticeFromExactEvent() {
    const manager = createManager("workspace-a", [createSession("a", "completed"), createSession("b", "failed")]);
    const aKey = createWorkspaceSessionKey("workspace-a", "a");
    const bKey = createWorkspaceSessionKey("workspace-a", "b");
    manager.selectSession(aKey);
    manager.applyTerminalEvent(aKey, "turn_completed");
    manager.applyTerminalEvent(bKey, "turn_failed");
    expect(manager.getSessionSnapshot(aKey)?.terminalNotice).toBeNull();
    expect(manager.getSessionSnapshot(bKey)?.terminalNotice).toBe("failure");
  });

  it("刷新单个工作区不会清理其他工作区的会话", function keepsOtherWorkspaceOnScopedRefresh() {
    const manager = createManager("workspace-a", [createSession("a")]);
    manager.syncWorkspaceSessions("workspace-b", [createSession("b")]);
    manager.syncWorkspaceSessions("workspace-a", []);
    expect(manager.getSessionSnapshot(createWorkspaceSessionKey("workspace-a", "a"))).toBeNull();
    expect(manager.getSessionSnapshot(createWorkspaceSessionKey("workspace-b", "b"))).not.toBeNull();
  });

  it("只保留当前页面生命周期内实际访问过的复合会话键", function tracksVisitedSessions() {
    const manager = createManager("workspace-a", [createSession("a")]);
    const key = createWorkspaceSessionKey("workspace-a", "a");
    manager.selectSession(key);
    expect(manager.getVisitedSessionIds()).toEqual([key]);
    manager.removeSession(key);
    expect(manager.getVisitedSessionIds()).toEqual([]);
  });

  it("协作终态事件只清理匹配 Turn 的陈旧执行态", function clearsMatchingStaleTurn() {
    const manager = createManager("workspace-a", [createSession("a")]);
    const key = createWorkspaceSessionKey("workspace-a", "a");
    manager.beginSession(key, "turn-1");
    manager.applyThreadTurnTerminal("workspace-a", "a", "turn-1");
    expect(manager.getSessionSnapshot(key)).toMatchObject({ phase: "completed", activeTurnId: undefined });
  });

  it("旧 Turn 的迟到终态不覆盖新 Turn", function keepsNewerTurnOnLateTerminal() {
    const manager = createManager("workspace-a", [createSession("a")]);
    const key = createWorkspaceSessionKey("workspace-a", "a");
    manager.beginSession(key, "turn-2");
    manager.applyThreadTurnTerminal("workspace-a", "a", "turn-1");
    expect(manager.getSessionSnapshot(key)).toMatchObject({ phase: "starting", activeTurnId: "turn-2" });
  });

  it("等待类阶段不被协作终态事件改写", function keepsWaitingPhase() {
    const manager = createManager("workspace-a", [createSession("a")]);
    const key = createWorkspaceSessionKey("workspace-a", "a");
    manager.updateRuntimeState(key, "waiting_approval", "turn-3");
    manager.applyThreadTurnTerminal("workspace-a", "a", "turn-3");
    expect(manager.getSessionSnapshot(key)).toMatchObject({ phase: "waiting_approval", activeTurnId: "turn-3" });
  });
});
