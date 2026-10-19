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
  return { replayWebPresentation: function replayWebPresentationMock() { return { items: [] }; } };
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

/** 构造带 getContextUsage 查询的最小 Runtime mock。 */
function createRuntime(getContextUsage: () => Promise<unknown>) {
  return {
    turns: {
      getState: vi.fn().mockResolvedValue({ checkpoint: { turnId: "turn-1", status: "completed", consumedInputIds: [] }, events: [], readOnlyReason: undefined }),
      getRecoverableState: vi.fn().mockResolvedValue(null),
      getContextUsage,
    },
    inbox: { list: vi.fn().mockResolvedValue([]) },
  };
}

describe("GET /api/sessions/:id contextUsage", function sessionDetailContextUsageSuite() {
  beforeEach(function resetSessionDetailMocks() {
    vi.clearAllMocks();
    mocks.getSessionMeta.mockResolvedValue({ id: "session-1", title: "T", createdAt: 1, updatedAt: 1 });
    mocks.getSessionMessages.mockResolvedValue([]);
  });

  it("响应携带 Core 最新安全 Context Usage 快照", async function returnsLatestSafeSnapshot() {
    const getContextUsage = vi.fn().mockResolvedValue(usageFixture);
    const runtime = createRuntime(getContextUsage);
    mocks.getSharedWebRuntime.mockResolvedValue(runtime);

    const response = await GET(new Request("http://localhost/api/sessions/session-1"), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.contextUsage).toEqual(usageFixture);
    expect(getContextUsage).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("无可用快照时返回 null，不伪造 0% 或窗口", async function returnsNullWhenNoSnapshot() {
    const runtime = createRuntime(vi.fn().mockResolvedValue(null));
    mocks.getSharedWebRuntime.mockResolvedValue(runtime);

    const response = await GET(new Request("http://localhost/api/sessions/session-1"), { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.contextUsage).toBeNull();
  });
});
