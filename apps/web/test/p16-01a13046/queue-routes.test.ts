/** P16 真实 Route 配线回归：冻结 Runtime/HTTP 边界，验证领取身份和旧 queue History 不重复正文。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(function routeMocks() { return { runtime: vi.fn(), messages: vi.fn(), persistUserMessage: vi.fn(), stream: vi.fn(), lock: vi.fn() }; });
vi.mock("@/lib/workspace-host/work-route-boundary", function boundary() { return { rejectUnscopedWorkRequest: function allowed() { return null; } }; });
vi.mock("@/lib/workspace-host/work-session-error", function error() { return { toWorkSessionErrorResponse: function response(error: unknown) { return Response.json({ error: String(error) }, { status: 500 }); } }; });
vi.mock("@/lib/agent-turn-store", function turns() { return { tryAcquireQueueStartLock: mocks.lock, cancelActiveTurn: vi.fn(), hasActiveTurn: vi.fn() }; });
vi.mock("@/lib/session-store", function store() { return { getSessionMeta: vi.fn(async function meta() { return { id: "session", pinnedSkills: [] }; }), getSessionMessages: mocks.messages, updatePinnedSkills: vi.fn(), deleteSession: vi.fn() }; });
vi.mock("@/lib/session-attachment-store", function attachments() { return { resolveSessionImages: function none() { return []; } }; });
vi.mock("@/lib/composition-root", function composition() { return { getSharedWebRuntime: mocks.runtime, getDefaultWebCompositionRoot: function root() { return { prepareTurnContext: vi.fn(async function prepare() { return undefined; }), resolveSelectedSkills: vi.fn(async function skills() { return { skills: [], pinnedSkills: [], diagnostics: [] }; }), createAttachmentInstruction: vi.fn(), createSelectedSkillsInstruction: vi.fn() }; } }; });
vi.mock("@/lib/runtime-host/web-message-projection", function projection() { return { persistUserMessage: mocks.persistUserMessage, projectEvents: function empty() { return { answer: "", sources: [], editDiffs: [], processSteps: [], turnSegments: [] }; } }; });
vi.mock("@/lib/runtime-host/web-agent-stream", function stream() { return { createRuntimeAgentStream: mocks.stream }; });
vi.mock("@/lib/runtime-host/web-compaction-projection", function compact() { return { persistCompactionRecord: vi.fn() }; });

import { POST } from "@/app/api/sessions/[id]/messages/route";
import { GET } from "@/app/api/sessions/[id]/route";

/** Runtime mock 只提供本次合法 session 的公共 API，不读取真实工作区或调用 Provider。 */
function runtime() {
  const input = { inputId: "queue-input", clientMessageId: "queue-client-id", sessionId: "session", turnId: "B", content: "队列原文", delivery: "queue", status: "consumed", attachments: [], selectedSkills: [], createdAt: new Date(1).toISOString() };
  return { turns: { getState: vi.fn(async function state() { return { checkpoint: { turnId: "A", status: "completed", consumedInputIds: [] }, events: [] }; }), getContextUsage: vi.fn(async function usage() { return null; }), getRecoverableState: vi.fn(async function recoverable() { return null; }) }, inbox: { claimNext: vi.fn(async function claim() { return input; }), consume: vi.fn(async function consume() { return true; }), list: vi.fn(async function list() { return [input]; }), cancel: vi.fn() } };
}

describe("P16 queue Routes", function suite() {
  beforeEach(function reset() { vi.clearAllMocks(); mocks.messages.mockResolvedValue([]); mocks.lock.mockReturnValue(vi.fn()); mocks.stream.mockImplementation(function stream() { return new ReadableStream({ start(controller) { controller.close(); } }); }); });

  it("start_next 回传实际领取inputId和新TurnId，并为唯一用户历史记录保留身份", async function claimedHeaders() {
    const ports = runtime();
    mocks.runtime.mockResolvedValue(ports);
    const response = await POST(new Request("http://localhost/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "start_next" }) }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(200);
    const turnId = response.headers.get("X-Agent-Turn-Id");
    expect(turnId).toBeTruthy();
    expect(response.headers.get("X-Agent-Input-Id")).toBe("queue-input");
    expect(ports.inbox.consume).toHaveBeenCalledWith({ sessionId: "session", inputId: "queue-input", turnId });
    expect(mocks.persistUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.persistUserMessage).toHaveBeenCalledWith(ports, "session", "队列原文", [], "input:queue-input");
    expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ turnId, content: "队列原文", continuity: { source: "claimed_queue" } }));
  });

  it.each([true, false])("History queue关联身份存在=%s，保留原用户气泡且不补重复正文", async function queueHistory(linked) {
    const ports = runtime();
    mocks.runtime.mockResolvedValue(ports);
    mocks.messages.mockResolvedValue([{ type: "message", id: "user", role: "user", content: "队列原文", createdAt: 1, ...(linked ? { clientRecordId: "input:queue-input" } : {}) }]);
    const response = await GET(new Request("http://localhost/session"), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.messages.filter(function body(message: { content: string }) { return message.content === "队列原文"; })).toHaveLength(1);
    expect(payload.presentation.items.some(function body(item: { content?: string }) { return item.content === "队列原文"; })).toBe(false);
    expect(payload.messages[0].turnId).toBe(linked ? "B" : undefined);
    expect(ports.inbox.list).toHaveBeenCalledWith({ sessionId: "session" });
  });
});
