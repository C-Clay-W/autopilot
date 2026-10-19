/**
 * Talk-Plan1013 Stage 4（16.8 #4）：/api/sessions/:id/approvals POST 同源校验测试。
 * 跨站/外部 Host 的四字段审批提交必须被拒绝，且不触达 Runtime。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(function createApprovalsRouteMocks() {
  return {
    getSharedWebRuntime: vi.fn(),
    validateWorkJobRequestSource: vi.fn(),
    rejectUnscopedWorkRequest: vi.fn(),
    getSessionMeta: vi.fn(),
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
      return new Response(JSON.stringify({ code }), { status: 400 });
    },
    toWorkSessionErrorResponse: function toWorkSessionErrorResponseMock() {
      return new Response("{}", { status: 500 });
    },
  };
});

vi.mock("@/lib/session-store", function mockSessionStore() {
  return { getSessionMeta: mocks.getSessionMeta };
});

vi.mock("@/lib/composition-root", function mockCompositionRoot() {
  return { getSharedWebRuntime: mocks.getSharedWebRuntime };
});

import { POST } from "@/app/api/sessions/[id]/approvals/route";

/** 构造合法四字段审批提交请求。 */
function createApprovalRequest(origin?: string): Request {
  return new Request("http://localhost:3000/api/sessions/session-1/approvals", {
    method: "POST",
    headers: origin ? { origin } : undefined,
    body: JSON.stringify({ turnId: "turn-1", approvalId: "approval-1", decision: "deny" }),
  });
}

describe("POST /api/sessions/:id/approvals 同源校验", function approvalsOriginSuite() {
  beforeEach(function resetMocks() {
    vi.clearAllMocks();
    mocks.rejectUnscopedWorkRequest.mockReturnValue(undefined);
  });

  it("跨站 Origin 的审批提交被拒绝且不触达 Runtime", async function rejectsCrossOriginSubmit() {
    mocks.validateWorkJobRequestSource.mockReturnValue(new Response("{}", { status: 403 }));
    const response = await POST(createApprovalRequest("http://evil.example"), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(403);
    expect(mocks.validateWorkJobRequestSource).toHaveBeenCalledWith(expect.anything(), true);
    expect(mocks.getSharedWebRuntime).not.toHaveBeenCalled();
  });

  it("同源合法提交继续走四字段 submit", async function allowsSameOriginSubmit() {
    mocks.validateWorkJobRequestSource.mockReturnValue(undefined);
    mocks.getSessionMeta.mockResolvedValue({ id: "session-1" });
    const runtime = {
      turns: { getRecoverableState: vi.fn().mockResolvedValue({ status: "awaiting_approval", approval: { approvalId: "approval-1" } }) },
      approvals: { submit: vi.fn().mockResolvedValue({ approvalId: "approval-1", decision: "deny" }) },
    };
    mocks.getSharedWebRuntime.mockResolvedValue(runtime);
    const response = await POST(createApprovalRequest("http://localhost:3000"), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(200);
    expect(runtime.approvals.submit).toHaveBeenCalledWith({ sessionId: "session-1", turnId: "turn-1", approvalId: "approval-1", decision: "deny" });
  });
});
