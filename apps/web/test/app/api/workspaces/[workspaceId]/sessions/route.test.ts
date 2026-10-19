/** route.test.ts — workspace-scoped Session 列表、创建与旧 projectId 迁移回归。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/workspaces/[workspaceId]/sessions/route";
import { setWebWorkspaceHostForTest } from "@/lib/workspace-host/web-workspace-server";
import type { WebWorkspaceContext, WebWorkspaceHost } from "@/lib/workspace-host/web-workspace-host";

/** 构造只含本 Route 所需 Runtime 接口的受信 Context。 */
function createContext(sessions: Array<{ id: string; projectId?: string; title?: string; createdAt: number; updatedAt: number; status: "idle" }>): WebWorkspaceContext {
  return {
    workspaceId: "v1-1234567890abcdef",
    workspaceRoot: "C:/server-only-root",
    projectId: "project-a",
    compositionRoot: {} as WebWorkspaceContext["compositionRoot"],
    runtime: {
      sessions: {
        list: vi.fn(async function listSessions() { return sessions; }),
        save: vi.fn(async function saveSession() {}),
        create: vi.fn(async function createSession(input: { projectId: string }) {
          return { id: "new_session", projectId: input.projectId, title: undefined, createdAt: 3, updatedAt: 3, status: "idle", persistenceMode: "durable" };
        }),
      },
    } as unknown as WebWorkspaceContext["runtime"],
  };
}

/** 让每个用例独立注入 Workspace Host。 */
afterEach(function resetWorkspaceHost() {
  setWebWorkspaceHostForTest(undefined);
});

describe("workspace-scoped Session API", function workspaceScopedSessionApiSuite() {
  it("创建 Session 的异步失败经过 HTTP 边界且不泄露磁盘错误", async function catchesCreateRejection() {
    const context = createContext([]);
    vi.mocked(context.runtime.sessions.create).mockRejectedValueOnce(new Error("EACCES /private/secret"));
    setWebWorkspaceHostForTest({ getContext: vi.fn(async function getContext() { return context; }) } as unknown as WebWorkspaceHost);
    const response = await POST(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ workspaceId: context.workspaceId }) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "WORKSPACE_INTERNAL_ERROR", error: "工作区服务发生内部错误" });
  });

  it("只列出绑定当前 Project 的任务，不回写无归属历史", async function listsAndMigratesLegacySessions() {
    const sessions = [
      { id: "legacy", createdAt: 1, updatedAt: 1, status: "idle" as const },
      { id: "foreign", projectId: "project-b", createdAt: 2, updatedAt: 2, status: "idle" as const },
    ];
    const context = createContext(sessions);
    setWebWorkspaceHostForTest({ getContext: vi.fn(async function getContext() { return context; }) } as unknown as WebWorkspaceHost);
    const response = await GET(new Request("http://localhost/api/workspaces/v1-1234567890abcdef/sessions"), { params: Promise.resolve({ workspaceId: context.workspaceId }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sessions: [] });
    expect(sessions[0].projectId).toBeUndefined();
    expect(context.runtime.sessions.save).not.toHaveBeenCalled();
  });

  it("新建 Session 显式写入当前 Context 的 projectId", async function createsProjectBoundSession() {
    const context = createContext([]);
    setWebWorkspaceHostForTest({ getContext: vi.fn(async function getContext() { return context; }) } as unknown as WebWorkspaceHost);
    const response = await POST(new Request("http://localhost/api/workspaces/v1-1234567890abcdef/sessions", { method: "POST" }), { params: Promise.resolve({ workspaceId: context.workspaceId }) });
    expect(response.status).toBe(200);
    expect(context.runtime.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-a" }));
  });
});
