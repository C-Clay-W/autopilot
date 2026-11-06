/** r011真实Web Route到Core产物：同源审批投影、摘要滞后和已决定恢复。 */
import { expect, it } from "vitest";
import { createAgentRuntime, createMemoryPorts } from "@autopilot-agent/core";
import { GET } from "@/app/api/sessions/[id]/route";
import { POST as approve } from "@/app/api/sessions/[id]/approvals/route";
import { POST as continueTurn } from "@/app/api/sessions/[id]/continue/route";
import { createWebTurnHost } from "@/lib/workspace-host/web-turn-host";
import { runWithWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";
import type { WebWorkspaceContext } from "@/lib/workspace-host/web-workspace-host";

/** 真实Core产生合法write_file暂停；仅内存状态及fake sampler，无外部请求。 */
async function fixture() {
  const ports = createMemoryPorts(process.cwd());
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), permissionMode: "ask", modelSampler: { async sample() { return { content: "", toolCalls: [{ id: "write-web-r011", name: "write_file", input: { path: "r011-never-created.html", content: "fixture" } }], reasoningSummary: "审批" }; } } } });
  const session = await runtime.sessions.create({ title: "Web子会话" });
  const stream = runtime.turns.start({ sessionId: session.id, content: "隔离审批" });
  while ((await stream.next()).value?.type !== "turn_paused") { /* 故意不进入流finally。 */ }
  const turnHost = createWebTurnHost({ runtime, ports });
  const context = { workspaceId: "r011", workspaceRoot: process.cwd(), projectId: session.projectId, runtime, turnHost } as WebWorkspaceContext;
  const view = (await runtime.turns.getExecutionState({ sessionId: session.id }))!;
  const event = view.interaction!.approval!.event;
  if (event.type !== "approval_required") throw Error("missing request");
  const approvalId = event.result.approval.approvalId;
  /** 经真实受信Workspace上下文调用canonical处理器，保持浏览器DTO边界。 */
  async function call(handler: typeof GET | typeof approve, body?: object) {
    return runWithWorkspaceRequestContext(context, function route() { return handler(new Request("http://localhost/api/workspaces/r011/sessions/fixture", body ? { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify(body) } : {}), { params: Promise.resolve({ id: session.id }) }); });
  }
  return { ports, runtime, session, stream, turnHost, view, approvalId, call };
}

it("Web摘要running仍展示Core当前审批，过期显示状态且不返回可提交身份", async function staleSummaryVisible() {
  const f = await fixture();
  try {
    const turn = (await f.ports.turnStore.getLatest(f.session.id))!;
    await f.ports.turnStore.save({ ...turn, status: "running" });
    await f.ports.sessionStore.save({ ...(await f.ports.sessionStore.get(f.session.id))!, status: "running", activeTurnId: turn.id });
    const response = await f.call(GET);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.runtimeStatus).toBe("waiting_approval");
    expect(body.agent).toMatchObject({ approvalId: f.approvalId, interactionState: "pending", execution: "inactive", warning: "summary_lag" });
    expect(body.execution).toMatchObject({ waiting: "approval", interactionState: "pending" });
    expect(body.execution).not.toHaveProperty("interaction");
    const clock = f.ports.clock.now;
    f.ports.clock.now = function expired() { return clock() + 601000; };
    const expired = await (await f.call(GET)).json();
    expect(expired.agent.interactionState).toBe("expired"); expect(expired.agent.approvalId).toBeUndefined();
  } finally { await f.stream.return(undefined); }
});

it("Web决定已存不再生成待审批卡，正式continue可复用精确决定", async function savedDecisionContinues() {
  const f = await fixture();
  try {
    const invalid = await f.call(approve, { turnId: f.view.turnId, approvalId: "wrong", decision: "deny" });
    expect(invalid.status).toBe(409);
    const submitted = await f.call(approve, { turnId: f.view.turnId, approvalId: f.approvalId, decision: "deny" });
    expect(submitted.status).toBe(200);
    const body = await (await f.call(GET)).json();
    expect(body.agent.interactionState).toBe("decided");
    expect(body.presentation.items.some(function pending(item: { kind: string; state: string }) { return item.kind === "approval" && item.state === "pending"; })).toBe(false);
    const continued = await f.call(continueTurn, { turnId: f.view.turnId });
    expect(continued.status, await continued.clone().text()).toBe(202);
    expect(await f.turnHost.waitSettled(f.view.turnId)).toBe(true);
    await f.stream.return(undefined);
    expect((await f.runtime.turns.getExecutionState({ sessionId: f.session.id }))?.result).toBe("failed");
  } finally { await f.stream.return(undefined); }
});
