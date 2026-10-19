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
  };
});

vi.mock("@/lib/session-attachment-store", function mockAttachmentStore() {
  return { resolveSessionImages: function resolveSessionImagesMock() { return []; } };
});

vi.mock("@/lib/composition-root", function mockCompositionRoot() {
  return {
    getDefaultWebCompositionRoot: vi.fn(),
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
