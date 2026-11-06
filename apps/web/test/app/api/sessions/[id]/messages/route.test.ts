/** Messages Route compact 操作的行为测试：活动 Turn 返回 409 拒绝；changed/skipped 显式返回 outcome 与安全快照。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(function createCompactRouteMocks() {
  class TestWebRouteError extends Error {}
  return {
    readRequestObject: vi.fn(),
    getSessionMeta: vi.fn(),
    getSessionMessages: vi.fn(),
    getSharedWebRuntime: vi.fn(),
    persistCompactionRecord: vi.fn(),
    turnHostStart: vi.fn(),
    WebRouteError: TestWebRouteError,
  };
});

vi.mock("@/lib/workspace-host/work-route-boundary", function mockWorkRouteBoundary() {
  return { rejectUnscopedWorkRequest: function rejectUnscopedWorkRequestMock() { return null; } };
});

vi.mock("@/lib/workspace-host/work-session-error", function mockWorkSessionError() {
  return { toWorkSessionErrorResponse: function toWorkSessionErrorResponseMock() { return new Response("{}", { status: 500 }); } };
});

vi.mock("@/lib/runtime-host/web-http-error", function mockWebHttpError() {
  return { readRequestObject: mocks.readRequestObject, WebRouteError: mocks.WebRouteError };
});

vi.mock("@/lib/agent-turn-store", function mockAgentTurnStore() {
  return { tryAcquireQueueStartLock: vi.fn() };
});

vi.mock("@/lib/session-store", function mockSessionStore() {
  return {
    getSessionMeta: mocks.getSessionMeta,
    getSessionMessages: mocks.getSessionMessages,
    updatePinnedSkills: vi.fn(),
    updateSessionPermissionMode: vi.fn(),
  };
});

vi.mock("@/lib/workspace-host/web-workspace-session", function mockWorkspaceSession() {
  return { requireWorkspaceTurnHost: () => ({ start: mocks.turnHostStart }) };
});

vi.mock("@/lib/session-attachment-store", function mockAttachmentStore() {
  return { resolveSessionImages: function resolveSessionImagesMock() { return []; } };
});

vi.mock("@/lib/composition-root", function mockCompositionRoot() {
  return {
    getDefaultWebCompositionRoot: vi.fn(function getDefaultWebCompositionRootMock() {
      return {
        prepareTurnContext: async function prepareTurnContext() { return undefined; },
        resolveSelectedSkills: async function resolveSelectedSkills() { return { skills: [], pinnedSkills: [], diagnostics: [] }; },
        createAttachmentInstruction: function createAttachmentInstruction() { return undefined; },
        createSelectedSkillsInstruction: function createSelectedSkillsInstruction() { return undefined; },
      };
    }),
    getSharedWebRuntime: mocks.getSharedWebRuntime,
  };
});

vi.mock("@/lib/runtime-host/web-message-projection", function mockMessageProjection() {
  return { persistUserMessage: vi.fn() };
});

vi.mock("@/lib/runtime-host/web-agent-stream", function mockAgentStream() {
  return { createRuntimeAgentStream: vi.fn() };
});

vi.mock("@/lib/runtime-host/web-compaction-projection", function mockCompactionProjection() {
  return { persistCompactionRecord: mocks.persistCompactionRecord };
});

import { POST } from "@/app/api/sessions/[id]/messages/route";

/** 与 Core ContextUsageView 字段一致的只读 fixture。 */
const usageFixture = {
  modelRef: "deepseek-chat",
  contextWindowTokens: 128_000,
  estimatedAddedTokens: 1_000,
  currentContextTokens: 17_000,
  outputReserveTokens: 8_192,
  compactTriggerTokens: 102_400,
  projectedTokens: 25_192,
  usageRatio: 0.1968,
  compactNeeded: false,
  measurement: "estimated",
  breakdown: {
    categories: [],
    freeTokens: 77_208,
    freeRatio: 0.6032,
    compactBufferTokens: 25_600,
    compactBufferRatio: 0.2,
    overLimitTokens: 0,
    overLimitRatio: 0,
    measurement: "estimated",
  },
};

/** 构造 compact 操作请求。 */
function createCompactRequest(): Request {
  return new Request("http://localhost/api/sessions/session-1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "compact", clientMessageId: "compact-fixture123" }),
  });
}

describe("POST /api/sessions/:id/messages compact", function compactRouteSuite() {
  beforeEach(function resetCompactMocks() {
    vi.clearAllMocks();
    mocks.getSessionMeta.mockResolvedValue({ id: "session-1", title: "T", createdAt: 1, updatedAt: 1 });
    mocks.getSessionMessages.mockResolvedValue([]);
    mocks.readRequestObject.mockImplementation(async function readRequestObjectMock() {
      return { operation: "compact", clientMessageId: "compact-fixture123" };
    });
  });

  it("活动 Turn 运行时返回 409 TURN_ALREADY_RUNNING，不执行 compact", async function rejectsWhileTurnRunning() {
    const compact = vi.fn();
    mocks.getSharedWebRuntime.mockResolvedValue({
      turns: {
        getState: vi.fn().mockResolvedValue({ turn: { status: "running" }, checkpoint: null }),
        compact,
      },
    });

    const response = await POST(createCompactRequest(), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toMatchObject({ code: "TURN_ALREADY_RUNNING" });
    expect(compact).not.toHaveBeenCalled();
    expect(mocks.persistCompactionRecord).not.toHaveBeenCalled();
  });

  it("changed 时返回显式 outcome 与安全快照并写入压缩记录", async function returnsChangedOutcome() {
    const compact = vi.fn().mockResolvedValue({
      outcome: "changed",
      summary: "压缩摘要",
      messages: [],
      preTokens: 100,
      postTokens: 50,
      preservedFromIndex: 0,
      contextUsage: usageFixture,
    });
    mocks.getSharedWebRuntime.mockResolvedValue({
      turns: {
        getState: vi.fn().mockResolvedValue({ turn: null, checkpoint: { turnId: "turn-1", status: "completed", consumedInputIds: [] } }),
        compact,
      },
    });
    mocks.persistCompactionRecord.mockResolvedValue({ compactId: "compact-1", preTokens: 100, postTokens: 50 });

    const response = await POST(createCompactRequest(), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ outcome: "changed", preTokens: 100, postTokens: 50, contextUsage: usageFixture });
    expect(mocks.persistCompactionRecord).toHaveBeenCalledTimes(1);
  });

  it("skipped 时不写入压缩记录，原样返回 outcome 与原快照", async function returnsSkippedOutcome() {
    const compact = vi.fn().mockResolvedValue({
      outcome: "skipped",
      reason: "no_compactable_history",
      summary: "",
      messages: [],
      preTokens: 100,
      postTokens: 100,
      preservedFromIndex: 0,
      contextUsage: usageFixture,
    });
    mocks.getSharedWebRuntime.mockResolvedValue({
      turns: {
        getState: vi.fn().mockResolvedValue({ turn: null, checkpoint: { turnId: "turn-1", status: "completed", consumedInputIds: [] } }),
        compact,
      },
    });

    const response = await POST(createCompactRequest(), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ outcome: "skipped", reason: "no_compactable_history", contextUsage: usageFixture });
    expect(mocks.persistCompactionRecord).not.toHaveBeenCalled();
  });
});

/** 构造普通发送请求。 */
function createSendRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/sessions/session-1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "任务", clientMessageId: "fixture-input-01", ...body }),
  });
}

describe("POST /api/sessions/:id/messages 权限模式", function permissionModeSuite() {
  beforeEach(function resetPermissionMocks() {
    vi.clearAllMocks();
    mocks.readRequestObject.mockImplementation(async function readBody(request: Request) { return await request.json(); });
    mocks.getSessionMeta.mockResolvedValue({ id: "session-1", title: "T", createdAt: 1, updatedAt: 1 });
    mocks.getSessionMessages.mockResolvedValue([]);
    mocks.getSharedWebRuntime.mockResolvedValue({
      turns: { getState: vi.fn().mockResolvedValue({ turn: null, checkpoint: null }) },
      inbox: { post: vi.fn() },
    });
    mocks.turnHostStart.mockReturnValue(undefined);
  });

  it("合法权限模式随 runConfig 启动并持久化为会话缺省", async function persistsPermissionMode() {
    const { updateSessionPermissionMode } = await import("@/lib/session-store");
    const response = await POST(createSendRequest({ permissionMode: "auto_approve" }), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(202);
    expect(mocks.turnHostStart).toHaveBeenCalledTimes(1);
    expect(mocks.turnHostStart.mock.calls[0]![0]!.runConfig).toMatchObject({ permissionMode: "auto_approve" });
    expect(updateSessionPermissionMode).toHaveBeenCalledWith(expect.anything(), "session-1", "auto_approve");
  });

  it("缺省权限模式为 ask，未知值拒绝且不持久化", async function rejectsUnknownPermissionMode() {
    const { updateSessionPermissionMode } = await import("@/lib/session-store");
    const defaulted = await POST(createSendRequest({}), { params: Promise.resolve({ id: "session-1" }) });
    expect(defaulted.status).toBe(202);
    expect(mocks.turnHostStart.mock.calls[0]![0]!.runConfig).toMatchObject({ permissionMode: "ask" });
    expect(updateSessionPermissionMode).not.toHaveBeenCalled();

    const rejected = await POST(createSendRequest({ permissionMode: "yolo" }), { params: Promise.resolve({ id: "session-1" }) });
    expect(rejected.status).toBe(500);
    expect(updateSessionPermissionMode).not.toHaveBeenCalled();
    expect(mocks.turnHostStart).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/sessions/:id/messages 暂停任务", function pausedTurnSuite() {
  beforeEach(function resetPausedMocks() {
    vi.clearAllMocks();
    mocks.readRequestObject.mockImplementation(async function readBody(request: Request) { return await request.json(); });
    mocks.getSessionMeta.mockResolvedValue({ id: "session-1", title: "T", createdAt: 1, updatedAt: 1 });
    mocks.getSessionMessages.mockResolvedValue([]);
    mocks.getSharedWebRuntime.mockResolvedValue({
      turns: { getState: vi.fn().mockResolvedValue({ turn: { id: "turn-1", status: "interrupted" }, checkpoint: { turnId: "turn-1", status: "interrupted" } }) },
      inbox: { post: vi.fn() },
    });
    mocks.turnHostStart.mockReturnValue(undefined);
  });

  it("暂停会话发新输入返回 409 active_turn_paused 并引导恢复", async function rejectsPausedTurnWithGuidance() {
    const response = await POST(createSendRequest({}), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "active_turn_paused", error: "当前任务已暂停；点击「继续执行」恢复，或新建任务" });
    expect(mocks.turnHostStart).not.toHaveBeenCalled();
  });
});
