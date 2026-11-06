/** 取消Route的owner边界和精确Turn确认，不访问真实服务或用户会话。 */
import { expect, it, vi } from "vitest";
import { createAgentRuntime, createMemoryPorts } from "@autopilot-agent/core";
import { POST as cancel } from "@/app/api/sessions/[id]/cancel/route";
import { GET as turnState } from "@/app/api/workspaces/[workspaceId]/sessions/[sessionId]/turn-state/route";
import { runWithWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";

const injected = vi.hoisted(function injection() { return { workspace: undefined as unknown }; });
vi.mock("@/lib/workspace-host/workspace-session-route", function routeBoundary() { return { runWorkspaceSessionRoute: async function run(_params: unknown, action: (workspace: unknown, sessionId: string) => Promise<Response>) { return action(injected.workspace, "session"); } }; });

it("停止确认要求同Turn非活动checkpoint，迟到摘要和跨会话身份不能确认", async function exactCancellationState() {
  const ports = createMemoryPorts();
  injected.workspace = { compositionRoot: { getRuntimePorts: function get() { return ports; } } };
  await ports.turnStore.save({ id: "T", sessionId: "session", status: "interrupted", startedAt: 1, frozenRunConfig: {} });
  await ports.checkpointStore.save("session", { turnId: "T", status: "running", stepCount: 0, messages: [], completedCallIds: [] });
  /** 通过精确URL调用真实处理器。 */
  async function read(id = "T") { return turnState(new Request(`http://localhost/api/workspaces/ws/sessions/session/turn-state?turnId=${id}`), { params: Promise.resolve({ workspaceId: "ws", sessionId: "session" }) }); }
  expect((await (await read()).json()).cancellation).toBe("pending");
  await ports.checkpointStore.save("session", { turnId: "T", status: "interrupted", stepCount: 0, messages: [], completedCallIds: [] });
  await ports.turnStore.save({ id: "new", sessionId: "session", status: "running", startedAt: 2, frozenRunConfig: {} });
  expect(await (await read()).json()).toMatchObject({ turnId: "T", cancellation: "confirmed" });
  await ports.turnStore.save({ id: "foreign", sessionId: "other", status: "interrupted", startedAt: 1, frozenRunConfig: {} });
  expect((await read("foreign")).status).toBe(404);
});

it("远端running取消只发送既有interrupt，不能本地伪写interrupted", async function remoteCancelUsesOwner() {
  const ports = createMemoryPorts();
  const runtime = createAgentRuntime({ ports });
  const session = await runtime.sessions.create({ title: "远端" });
  await ports.sessionStore.save({ ...session, status: "running", activeTurnId: "remote" });
  await ports.turnStore.save({ id: "remote", sessionId: session.id, status: "running", frozenRunConfig: {}, startedAt: 1 });
  await ports.checkpointStore.save(session.id, { turnId: "remote", status: "running", stepCount: 0, messages: [], completedCallIds: [] });
  const interrupt = vi.fn(async function accept() { return { accepted: true, controlId: "control" }; });
  const localCancel = vi.spyOn(runtime.turns, "cancel");
  const context = { workspaceId: "ws", runtime, threadHost: { facade: function facade() { return { groupOf: async function group() { return { group: { groupId: "g" } }; }, interrupt }; }, ensureStarted: vi.fn(), kick: vi.fn() } };
  const response = await runWithWorkspaceRequestContext(context as never, function request() { return cancel(new Request("http://localhost/api/workspaces/ws/sessions/remote/cancel", { method: "POST", body: JSON.stringify({ turnId: "remote" }) }), { params: Promise.resolve({ id: session.id }) }); });
  expect(response.status).toBe(202);
  expect((await response.json()).cancellation).toBe("pending");
  expect(interrupt).toHaveBeenCalledWith(expect.objectContaining({ expectedTurnId: "remote", threadId: session.id }));
  expect(localCancel).not.toHaveBeenCalled();
  expect((await ports.turnStore.get("remote"))?.status).toBe("running");
});
