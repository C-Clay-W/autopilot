/** P16 真实 Route 配线回归：冻结 Runtime/HTTP 边界，验证领取身份和旧 queue History 不重复正文。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(function routeMocks() { return { runtime: vi.fn(), messages: vi.fn(), persistUserMessage: vi.fn(), stream: vi.fn(), lock: vi.fn(), turnHost: { start: vi.fn() } }; });
vi.mock("@/lib/workspace-host/work-route-boundary", function boundary() { return { rejectUnscopedWorkRequest: function allowed() { return null; } }; });
vi.mock("@/lib/workspace-host/work-session-error", function error() { return { toWorkSessionErrorResponse: function response(error: unknown) { return Response.json({ error: String(error) }, { status: 500 }); } }; });
vi.mock("@/lib/workspace-host/web-workspace-session", function session() { return { requireWorkspaceTurnHost: function host() { return mocks.turnHost; } }; });
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
  beforeEach(function reset() {
    vi.clearAllMocks();
    mocks.messages.mockResolvedValue([]);
    mocks.lock.mockReturnValue(vi.fn());
    mocks.stream.mockImplementation(function stream() { return new ReadableStream({ start(controller) { controller.close(); } }); });
    mocks.turnHost.start.mockImplementation(function accept(input: { turnId: string }) { return { turnId: input.turnId }; });
  });

  it("普通新输入只提交意图：202 回执 turnId，执行交给 TurnHost", async function acceptedByHost() {
    const ports = runtime();
    mocks.runtime.mockResolvedValue(ports);
    const response = await POST(new Request("http://localhost/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "新任务", clientMessageId: "client-message-1", delivery: "auto" }) }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(202);
    const payload = await response.json() as { accepted: boolean; turnId: string };
    expect(payload).toMatchObject({ accepted: true });
    expect(payload.turnId).toBeTruthy();
    expect(mocks.persistUserMessage).toHaveBeenCalledWith(ports, "session", "新任务", []);
    // 页面不再接收执行 SSE；启动参数原样交给宿主 Runner。
    expect(mocks.turnHost.start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session", turnId: payload.turnId, content: "新任务" }));
    // 普通输入不再在 Route 内领取队列输入。
    expect(ports.inbox.claimNext).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("start_next 不再是页面调度入口，也不领取输入", async function rejectsLegacyStartNext() {
    const ports = runtime();
    mocks.runtime.mockResolvedValue(ports);
    const response = await POST(new Request("http://localhost/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "start_next" }) }), { params: Promise.resolve({ id: "session" }) });
    // 本文件的错误映射替身把领域码统一收敛为失败响应；这里只断言不再被接受且没有领取/启动副作用。
    expect(response.ok).toBe(false);
    expect(ports.inbox.claimNext).not.toHaveBeenCalled();
    expect(mocks.turnHost.start).not.toHaveBeenCalled();
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
