/** Questions Route 测试：锁定受限 DTO、幂等提交响应与 Runtime 错误到 HTTP 状态的映射。 */
import { runWithWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";
import type { WebWorkspaceContext } from "@/lib/workspace-host/web-workspace-host";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(function createRouteMocks() {
  class TestAgentRuntimeError extends Error {
    code: string;

    /** 创建带 Runtime 错误码的测试错误。 */
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  class TestWorkspaceTrustError extends Error {}

  return {
    bootstrap: vi.fn(),
    getSessionMeta: vi.fn(),
    submit: vi.fn(),
    AgentRuntimeError: TestAgentRuntimeError,
    WorkspaceTrustError: TestWorkspaceTrustError,
  };
});

vi.mock("@/lib/composition-root", function mockCompositionRoot() {
  return { getSharedWebRuntime: mocks.bootstrap };
});

vi.mock("@/lib/session-store", function mockSessionStore() {
  return { getSessionMeta: mocks.getSessionMeta };
});

vi.mock("@/lib/core-loader", function mockCoreLoader() {
  return { loadCore: function loadCoreMock() { return { AgentRuntimeError: mocks.AgentRuntimeError, WorkspaceTrustError: mocks.WorkspaceTrustError }; } };
});

import { POST } from "@/app/api/sessions/[id]/questions/route";

/** 发送测试用的答案请求，并固定动态路由参数。 */
function postQuestion(body: unknown): Promise<Response> {
  return runWithWorkspaceRequestContext({} as WebWorkspaceContext, function scoped() { return POST(new Request("http://localhost/api/sessions/session-1/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "session-1" }) }); });
}

describe("POST /api/sessions/:id/questions", function questionsRouteSuite() {
  beforeEach(function resetQuestionRouteMocks() {
    vi.clearAllMocks();
    mocks.bootstrap.mockResolvedValue({ questions: { submit: mocks.submit } });
    mocks.getSessionMeta.mockResolvedValue({ id: "session-1" });
    mocks.submit.mockResolvedValue({ answers: [] });
  });

  it("仅转交允许的结构化答案，且幂等重试不回显 Other 正文", async function submitsSafeDto() {
    const body = { turnId: "turn-1", requestId: "request-1", answers: [{ id: "scope", selected: [], custom: "只执行最小修复" }] };
    const first = await postQuestion(body);
    const second = await postQuestion(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(mocks.submit).toHaveBeenLastCalledWith({ sessionId: "session-1", ...body });
    expect(JSON.stringify(await first.json())).not.toContain("只执行最小修复");
  });

  it("拒绝 checkpoint、Tool Call 和不完整答案字段", async function rejectsRuntimePrivateFields() {
    const response = await postQuestion({ turnId: "turn-1", requestId: "request-1", answers: [{ id: "scope", selected: ["最小修复"] }], checkpoint: { status: "awaiting_user_input" } });

    expect(response.status).toBe(400);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("将损坏 JSON 作为请求校验错误返回，不进入 Runtime", async function rejectsMalformedJson() {
    const response = await runWithWorkspaceRequestContext({} as WebWorkspaceContext, function scoped() { return POST(new Request("http://localhost/api/sessions/session-1/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }), { params: Promise.resolve({ id: "session-1" }) }); });

    expect(response.status).toBe(400);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it("将不存在、状态冲突与答案校验失败映射为 404、409、400", async function mapsRuntimeErrors() {
    mocks.submit.mockRejectedValueOnce(new mocks.AgentRuntimeError("QUESTION_NOT_FOUND", "问题不存在"));
    expect((await postQuestion({ turnId: "turn-1", requestId: "missing", answers: [] })).status).toBe(404);

    mocks.submit.mockRejectedValueOnce(new mocks.AgentRuntimeError("QUESTION_ALREADY_ANSWERED", "答案冲突"));
    expect((await postQuestion({ turnId: "turn-1", requestId: "conflict", answers: [] })).status).toBe(409);

    mocks.submit.mockRejectedValueOnce(new mocks.AgentRuntimeError("QUESTION_ANSWER_INVALID", "答案无效"));
    expect((await postQuestion({ turnId: "turn-1", requestId: "invalid", answers: [] })).status).toBe(400);
  });
});
