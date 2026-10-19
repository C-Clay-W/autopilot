/** Sessions Route 测试：锁定列表排序和安全运行摘要响应。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(function createSessionRouteMocks() {
  class TestWorkspaceTrustError extends Error {}
  return {
    createSession: vi.fn(),
    getSharedWebRuntime: vi.fn(),
    WorkspaceTrustError: TestWorkspaceTrustError,
  };
});

vi.mock("@/lib/session-store", function mockSessionStore() {
  return { createSession: mocks.createSession };
});

vi.mock("@/lib/composition-root", function mockCompositionRoot() {
  return { getSharedWebRuntime: mocks.getSharedWebRuntime };
});

vi.mock("@/lib/core-loader", function mockCoreLoader() {
  return { loadCore: function loadCoreMock() { return { WorkspaceTrustError: mocks.WorkspaceTrustError }; } };
});

vi.mock("@/lib/runtime-host/web-ui-dto", function mockWebUiDto() {
  return {
    toWebSessionDto: function toWebSessionDtoMock(session: Record<string, unknown>) {
      return {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: "active",
        runtimeStatus: session.status,
        activeTurnId: session.activeTurnId,
      };
    },
  };
});

import { GET } from "@/app/api/sessions/route";

describe("GET /api/sessions", function sessionsRouteSuite() {
  beforeEach(function resetSessionRouteMocks() {
    vi.clearAllMocks();
    mocks.getSharedWebRuntime.mockResolvedValue({
      sessions: {
        list: vi.fn().mockResolvedValue([
          { id: "session-a", persistenceMode: "durable", status: "running", activeTurnId: "turn-a", title: "A", createdAt: 1, updatedAt: 10, runConfig: { secret: "no" } },
          { id: "session-b", persistenceMode: "durable", status: "completed", title: "B", createdAt: 2, updatedAt: 20 },
        ]),
      },
    });
  });

  it("旧无作用域入口不初始化默认 Runtime", async function rejectsUnscopedSession() {
    const response = await GET();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "WORKSPACE_REQUIRED" });
    expect(mocks.getSharedWebRuntime).not.toHaveBeenCalled();
  });
});
