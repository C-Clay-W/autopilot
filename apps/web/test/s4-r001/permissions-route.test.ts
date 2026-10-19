/**
 * Talk-Plan1013 Stage 4（s4-r001）：/api/sessions/:id/permissions 契约测试。
 * 验证 GET/DELETE 走共享 Runtime approvals facade（Core grants 权威），DELETE 要求同源，
 * 不再消费 Web 自有 permission-store。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(function createPermissionRouteMocks() {
  return {
    getSharedWebRuntime: vi.fn(),
    getAgentWorkspaceRoot: vi.fn(),
    validateWorkJobRequestSource: vi.fn(),
    rejectUnscopedWorkRequest: vi.fn(),
  };
});

vi.mock("@/lib/workspace-host/work-route-boundary", function mockWorkRouteBoundary() {
  return { rejectUnscopedWorkRequest: mocks.rejectUnscopedWorkRequest };
});

vi.mock("@/lib/workspace-host/web-workspace-jobs", function mockWorkspaceJobs() {
  return { validateWorkJobRequestSource: mocks.validateWorkJobRequestSource };
});

vi.mock("@/lib/workspace-host/work-session-error", function mockWorkSessionError() {
  return {
    workSessionErrorResponse: function workSessionErrorResponseMock(code: string) {
      return new Response(JSON.stringify({ code }), { status: code === "PERMISSION_GRANT_NOT_FOUND" ? 404 : 500 });
    },
    toWorkSessionErrorResponse: function toWorkSessionErrorResponseMock() {
      return new Response("{}", { status: 500 });
    },
  };
});

vi.mock("@/lib/agent-workspace", function mockAgentWorkspace() {
  return { getAgentWorkspaceRoot: mocks.getAgentWorkspaceRoot };
});

vi.mock("@/lib/composition-root", function mockCompositionRoot() {
  return { getSharedWebRuntime: mocks.getSharedWebRuntime };
});

import { DELETE, GET } from "@/app/api/sessions/[id]/permissions/route";

/** 构造带 approvals facade 的最小 Runtime mock。 */
function createRuntime(grants: unknown[]) {
  return {
    approvals: {
      listPersistentGrants: vi.fn().mockResolvedValue(grants),
      revokePersistentGrant: vi.fn().mockResolvedValue({ deleted: true, ruleRemoved: true }),
    },
  };
}

/** 构造带 params 的 Route 参数。 */
function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/sessions/:id/permissions", function permissionsGetSuite() {
  beforeEach(function resetMocks() {
    vi.clearAllMocks();
    mocks.rejectUnscopedWorkRequest.mockReturnValue(undefined);
    mocks.validateWorkJobRequestSource.mockReturnValue(undefined);
    mocks.getAgentWorkspaceRoot.mockReturnValue("C:/w");
  });

  it("合并 Session 与 Workspace 授权并去重，数据来自共享 facade", async function mergesAndDedupesGrants() {
    const sessionGrant = { scope: "allow_session", sessionId: "session-1", toolName: "write_file", constraint: "ext-file:D:/out/a.txt", projection: "synced", createdAt: "2026-10-14T00:00:00.000Z" };
    const workspaceGrant = { scope: "allow_workspace", workspaceRoot: "C:/w", toolName: "edit_file", constraint: "ext-file:D:/out/b.txt", projection: "synced", createdAt: "2026-10-14T00:00:00.000Z" };
    const runtime = createRuntime([sessionGrant]);
    runtime.approvals.listPersistentGrants.mockImplementation(async function list(input: { workspaceRoot?: string; sessionId?: string }) {
      return input.sessionId !== undefined ? [sessionGrant] : [workspaceGrant];
    });
    mocks.getSharedWebRuntime.mockResolvedValue(runtime);

    const response = await GET(new Request("http://localhost/api/sessions/session-1/permissions"), routeParams("session-1"));
    expect(response.status).toBe(200);
    const payload = await response.json() as { grants: Array<{ constraint: string }> };
    expect(payload.grants).toHaveLength(2);
    expect(payload.grants.map(function constraintOf(grant) { return grant.constraint; })).toEqual(["ext-file:D:/out/a.txt", "ext-file:D:/out/b.txt"]);
    expect(runtime.approvals.listPersistentGrants).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(runtime.approvals.listPersistentGrants).toHaveBeenCalledWith({ workspaceRoot: "C:/w" });
  });

  it("跨站来源的只读请求被拒绝，不查询授权存储", async function rejectsCrossOriginRead() {
    mocks.validateWorkJobRequestSource.mockReturnValue(new Response("{}", { status: 403 }));
    const response = await GET(new Request("http://evil.example/api/sessions/session-1/permissions"), routeParams("session-1"));
    expect(response.status).toBe(403);
    expect(mocks.getSharedWebRuntime).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/sessions/:id/permissions", function permissionsDeleteSuite() {
  beforeEach(function resetMocks() {
    vi.clearAllMocks();
    mocks.rejectUnscopedWorkRequest.mockReturnValue(undefined);
    mocks.validateWorkJobRequestSource.mockReturnValue(undefined);
    mocks.getAgentWorkspaceRoot.mockReturnValue("C:/w");
  });

  it("按 toolName+constraint 精确撤销并返回规则删除状态", async function revokesByToolAndConstraint() {
    const runtime = createRuntime([]);
    mocks.getSharedWebRuntime.mockResolvedValue(runtime);
    const request = new Request("http://localhost/api/sessions/session-1/permissions", { method: "DELETE", body: JSON.stringify({ toolName: "write_file", constraint: "ext-file:D:/out/a.txt" }) });
    const response = await DELETE(request, routeParams("session-1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ruleRemoved: true });
    expect(runtime.approvals.revokePersistentGrant).toHaveBeenCalledWith({ workspaceRoot: "C:/w", sessionId: "session-1", toolName: "write_file", constraint: "ext-file:D:/out/a.txt" });
  });

  it("同源校验失败时拒绝撤销", async function rejectsCrossOriginDelete() {
    mocks.validateWorkJobRequestSource.mockReturnValue(new Response("{}", { status: 403 }));
    const request = new Request("http://evil.example/api/sessions/session-1/permissions", { method: "DELETE", body: JSON.stringify({ toolName: "write_file", constraint: "ext-file:D:/out/a.txt" }) });
    const response = await DELETE(request, routeParams("session-1"));
    expect(response.status).toBe(403);
    expect(mocks.getSharedWebRuntime).not.toHaveBeenCalled();
  });

  it("授权不存在时返回 404 稳定错误码", async function returnsNotFoundForMissingGrant() {
    const runtime = createRuntime([]);
    runtime.approvals.revokePersistentGrant.mockResolvedValue({ deleted: false, ruleRemoved: false });
    mocks.getSharedWebRuntime.mockResolvedValue(runtime);
    const request = new Request("http://localhost/api/sessions/session-1/permissions", { method: "DELETE", body: JSON.stringify({ toolName: "write_file", constraint: "ext-file:D:/missing.txt" }) });
    const response = await DELETE(request, routeParams("session-1"));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("PERMISSION_GRANT_NOT_FOUND");
  });
});
