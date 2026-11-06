/** GET /api/sessions/:id 的 contextUsage 契约测试：响应必须携带 Core 最新安全快照，无数据时为 null。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(function createSessionDetailMocks() {
  return {
    getSessionMeta: vi.fn(),
    getSessionMessages: vi.fn(),
    getSharedWebRuntime: vi.fn(),
  };
});

vi.mock("@/lib/workspace-host/work-route-boundary", function mockWorkRouteBoundary() {
  return { rejectUnscopedWorkRequest: function rejectUnscopedWorkRequestMock() { return null; } };
});

vi.mock("@/lib/workspace-host/work-session-error", function mockWorkSessionError() {
  return { toWorkSessionErrorResponse: function toWorkSessionErrorResponseMock() { return new Response("{}", { status: 500 }); } };
});

vi.mock("@/lib/session-store", function mockSessionStore() {
  return {
    getSessionMeta: mocks.getSessionMeta,
    getSessionMessages: mocks.getSessionMessages,
    deleteSession: vi.fn(),
  };
});

vi.mock("@/lib/agent-turn-store", function mockAgentTurnStore() {
  return { cancelActiveTurn: vi.fn(), hasActiveTurn: vi.fn() };
});

vi.mock("@/lib/composition-root", function mockCompositionRoot() {
  return { getSharedWebRuntime: mocks.getSharedWebRuntime };
});

vi.mock("@/lib/runtime-host/web-ui-dto", function mockWebUiDto() {
  return { toWebTurnDto: function toWebTurnDtoMock() { return null; } };
});

vi.mock("@/lib/runtime-host/web-message-projection", function mockMessageProjection() {
  return { projectEvents: function projectEventsMock() { return { answer: "", sources: [], editDiffs: [], processSteps: [], turnSegments: [] }; } };
});

vi.mock("@/lib/runtime-host/web-presentation-adapter", function mockPresentationAdapter() {
  return { replayWebPresentation: function replayWebPresentationMock() { return { items: [], turnStartedAt: { "turn-1": "2026-11-02T00:00:00.000Z" } }; } };
});

import { GET } from "@/app/api/sessions/[id]/route";

/** 与 Core ContextUsageView 字段一致的只读 fixture；只包含安全数值与枚举。 */
const usageFixture = {
  modelRef: "deepseek-chat",
  contextWindowTokens: 128_000,
  estimatedAddedTokens: 0,
  currentContextTokens: 16_000,
  outputReserveTokens: 8_192,
  compactTriggerTokens: 102_400,
  projectedTokens: 24_192,
  usageRatio: 0.189,
  compactNeeded: false,
  measurement: "measured",
  breakdown: {
    categories: [],
    freeTokens: 78_208,
    freeRatio: 0.611,
    compactBufferTokens: 25_600,
    compactBufferRatio: 0.2,
    overLimitTokens: 0,
    overLimitRatio: 0,
    measurement: "estimated",
  },
};

/** 与 Core TurnUsageSummaryView 字段一致的只读 fixture；只包含安全数值。 */
const turnUsageFixture = {
  turnId: "turn-1",
  inputTokens: 12_345,
  outputTokens: 6_789,
  totalTokens: 19_134,
  elapsedMs: 125_000,
};

/** 构造带 getContextUsage / getTurnUsageSummary 查询的最小 Runtime mock。 */
function createRuntime(getContextUsage: () => Promise<unknown>, getTurnUsageSummary: () => Promise<unknown> = vi.fn().mockResolvedValue(null) as () => Promise<unknown>) {
  return {
    turns: {
      getState: vi.fn().mockResolvedValue({ checkpoint: { turnId: "turn-1", status: "completed", consumedInputIds: [] }, events: [], readOnlyReason: undefined }),
      getRecoverableState: vi.fn().mockResolvedValue(null),
      getContextUsage,
      getTurnUsageSummary,
    },
    inbox: { list: vi.fn().mockResolvedValue([]) },
  };
}

describe("GET /api/sessions/:id contextUsage", function sessionDetailContextUsageSuite() {
  /** 真实assistant已持久时不重复合成；没有缓存容器时才沿transcript投影补唯一容器。 */
  it.each([false, true])("W3 等待审批合成容器只在缺失时补，已有cache=%s", async function keepsOneAssistant(cached) {
    const runtime = createRuntime(vi.fn().mockResolvedValue(null));
    runtime.turns.getState.mockResolvedValue({ checkpoint: { turnId: "turn-1", status: "awaiting_approval", consumedInputIds: [] }, events: [], readOnlyReason: undefined });
    runtime.turns.getRecoverableState.mockResolvedValue({ turnId: "turn-1", status: "awaiting_approval", recoverable: true });
    mocks.getSharedWebRuntime.mockResolvedValue(runtime);
    const segments = [{ type: "message", id: "real-one", role: "assistant", turnId: "turn-1", content: "前段", createdAt: 1 }, { type: "message", id: "real-two", role: "assistant", turnId: "turn-1", content: "后段", createdAt: 2 }];
    mocks.getSessionMessages.mockResolvedValue(cached ? segments : []);
    const payload = await (await GET(new Request("http://localhost/api/sessions/session-1"), { params: Promise.resolve({ id: "session-1" }) })).json();
    expect(payload.messages).toHaveLength(cached ? 2 : 1);
    if (cached) expect(payload.messages).toEqual(segments);
    else {
      expect(payload.messages[0]).toMatchObject({ id: "agent-turn-turn-1", role: "assistant", turnId: "turn-1", createdAt: Date.parse("2026-11-02T00:00:00.000Z") });
      const refreshed = await (await GET(new Request("http://localhost/api/sessions/session-1"), { params: Promise.resolve({ id: "session-1" }) })).json();
      expect(refreshed.messages[0].createdAt).toBe(payload.messages[0].createdAt);
    }
  });

  beforeEach(function resetSessionDetailMocks() {
    vi.clearAllMocks();
    mocks.getSessionMeta.mockResolvedValue({ id: "session-1", title: "T", createdAt: 1, updatedAt: 1 });
    mocks.getSessionMessages.mockResolvedValue([]);
  });

  it("响应携带 Core 最新安全 Context Usage 快照", async function returnsLatestSafeSnapshot() {
    const getContextUsage = vi.fn().mockResolvedValue(usageFixture);
    const getTurnUsageSummary = vi.fn().mockResolvedValue(turnUsageFixture);
    const runtime = createRuntime(getContextUsage, getTurnUsageSummary);
    mocks.getSharedWebRuntime.mockResolvedValue(runtime);

    const response = await GET(new Request("http://localhost/api/sessions/session-1"), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.contextUsage).toEqual(usageFixture);
    expect(getContextUsage).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(payload.turnUsage).toEqual(turnUsageFixture);
    expect(getTurnUsageSummary).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("无可用快照时返回 null，不伪造 0% 或窗口", async function returnsNullWhenNoSnapshot() {
    const runtime = createRuntime(vi.fn().mockResolvedValue(null));
    mocks.getSharedWebRuntime.mockResolvedValue(runtime);

    const response = await GET(new Request("http://localhost/api/sessions/session-1"), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.contextUsage).toBeNull();
    expect(payload.turnUsage).toBeNull();
  });
});
