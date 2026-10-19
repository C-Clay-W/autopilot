/** web-workspace-session.test.ts — workspace-scoped Session 归属与旧记录迁移回归。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebWorkspaceContext, WebWorkspaceHost } from "@/lib/workspace-host/web-workspace-host";
import { setWebWorkspaceHostForTest } from "@/lib/workspace-host/web-workspace-server";
import { requireWorkspaceSession, runWithWorkspaceRequestContext, getWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";

/** 构造不触碰真实磁盘的受信 workspace Context。 */
function createContext(projectId: string, session: { id: string; projectId?: string }): WebWorkspaceContext {
  return {
    workspaceId: "v1-1234567890abcdef",
    workspaceRoot: "C:/workspace-safe-root",
    projectId,
    compositionRoot: {} as WebWorkspaceContext["compositionRoot"],
    runtime: {
      sessions: {
        get: vi.fn(async function getSession() { return session; }),
        save: vi.fn(async function saveSession() {}),
      },
    } as unknown as WebWorkspaceContext["runtime"],
  };
}

/** 每个测试恢复服务器单例，避免 Context 注入跨用例泄漏。 */
afterEach(function resetWorkspaceHost() {
  setWebWorkspaceHostForTest(undefined);
});

describe("workspace-scoped Session", function workspaceScopedSessionSuite() {
  it("拒绝无归属旧 Session，HTTP 读取不补写历史", async function migratesLegacySession() {
    const session: { id: string; projectId?: string } = { id: "session_legacy" };
    const context = createContext("project-a", session);
    setWebWorkspaceHostForTest({ getContext: vi.fn(async function getContext() { return context; }) } as unknown as WebWorkspaceHost);

    await expect(requireWorkspaceSession(context.workspaceId, session.id)).rejects.toMatchObject({ code: "WORKSPACE_SESSION_NOT_FOUND" });
    expect(session.projectId).toBeUndefined();
    expect(context.runtime.sessions.save).not.toHaveBeenCalled();
  });

  it("拒绝 projectId 不匹配的伪造 Session，并将请求上下文限定在回调内", async function rejectsCrossWorkspaceSession() {
    const context = createContext("project-a", { id: "session_b", projectId: "project-b" });
    setWebWorkspaceHostForTest({ getContext: vi.fn(async function getContext() { return context; }) } as unknown as WebWorkspaceHost);

    await expect(requireWorkspaceSession(context.workspaceId, "session_b")).rejects.toMatchObject({ code: "WORKSPACE_SESSION_NOT_FOUND" });
    await runWithWorkspaceRequestContext(context, async function observeContext() {
      expect(getWorkspaceRequestContext()).toBe(context);
    });
    expect(getWorkspaceRequestContext()).toBeUndefined();
  });
});
