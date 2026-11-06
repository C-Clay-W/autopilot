/** repair-03：真实Web Route→正式Core产物的过期审批重签及有效审批/终态/目标门禁。 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentRuntime, createMemoryPorts } from "@autopilot-agent/core";
import { POST } from "@/app/api/sessions/[id]/continue/route";
import { createWebTurnHost } from "@/lib/workspace-host/web-turn-host";
import { runWithWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";
import type { WebWorkspaceContext } from "@/lib/workspace-host/web-workspace-host";

/** 先由真实Runtime产生审批，再在隔离transcript记录已过期事实，不改真实状态或批准。 */
async function fixture(expired = true) {
  const ports = createMemoryPorts(process.cwd()); let samples = 0;
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), workspaceTrusted: true, permissionMode: "ask", modelSampler: { async sample() { samples++; return { content: "", reasoningSummary: "fixture", toolCalls: [{ id: "write", name: "write_file", input: { path: "repair-03-must-not-exist.txt", content: "fixture" } }], finishReason: "tool_calls" }; } } } });
  const session = await runtime.sessions.create({ title: "expired-continue" }); const input = { sessionId: session.id, turnId: "expired-turn" };
  const turnHost = createWebTurnHost({ runtime, ports }); turnHost.start({ ...input, content: "fixture" }); expect(await turnHost.waitSettled(input.turnId)).toBe(true);
  const events = await ports.transcriptStore.getEvents(session.id); const old = events.find(function approval(item) { return item.event.type === "approval_required"; })!;
  if (old.event.type !== "approval_required") throw new Error("missing approval");
  const oldApprovalId = old.event.result.approval.approvalId;
  if (expired) await ports.transcriptStore.append(session.id, { ...old, seq: events.at(-1)!.seq + 1, event: { ...old.event, result: { ...old.event.result, approval: { ...old.event.result.approval, expiresAt: new Date(Date.now() - 1000).toISOString() } } } });
  const context = { workspaceId: "fixture", workspaceRoot: process.cwd(), projectId: session.projectId, runtime, turnHost } as WebWorkspaceContext;
  /** 只提交浏览器正式DTO，经真实Route与受信Workspace上下文。 */
  async function post(body: object, id = session.id) { return runWithWorkspaceRequestContext(context, function invoke() { return POST(new Request("http://localhost/api/sessions/fixture/continue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }); }); }
  return { ports, runtime, session, input, turnHost, post, oldApprovalId, samples: function count() { return samples; } };
}

describe("repair-03 expired approval continue", function suite() {
  it("过期无有效ID可重签同Turn新审批，不批准/写文件/再采样", async function resignExpired() {
    const f = await fixture(); expect((await f.runtime.turns.getRecoverableState(f.input))?.approval).toBeUndefined();
    const response = await f.post({ turnId: f.input.turnId });
    expect(response.status, await response.clone().text()).toBe(202);
    expect(await f.turnHost.waitSettled(f.input.turnId)).toBe(true);
    const state = await f.runtime.turns.getRecoverableState(f.input);
    expect(state?.status).toBe("awaiting_approval"); expect(state?.approval?.approvalId).toBeTruthy(); expect(state?.approval?.approvalId).not.toBe(f.oldApprovalId);
    expect((await f.post({ turnId: f.input.turnId })).status).toBe(400);
    expect(await f.ports.turnStore.list(f.session.id)).toHaveLength(1);
    expect(f.samples()).toBe(1); expect(fs.existsSync(path.join(process.cwd(), "repair-03-must-not-exist.txt"))).toBe(false);
    expect(await f.runtime.approvals.getDecision({ ...f.input, approvalId: state!.approval!.approvalId })).toBeNull();
    await expect(f.runtime.approvals.submit({ ...f.input, approvalId: f.oldApprovalId, decision: "allow_once" })).rejects.toBeDefined();
  });

  it("有效审批缺ID/错误ID/未提交决定仍拒绝，过期旧ID不成为恢复批准", async function approvalBoundary() {
    const f = await fixture(false);
    expect((await f.post({ turnId: f.input.turnId })).status).toBe(400);
    expect((await f.post({ turnId: f.input.turnId, approvalId: "wrong" })).status).toBe(409);
    expect((await f.post({ turnId: f.input.turnId, approvalId: f.oldApprovalId })).status).toBe(409);
    const expired = await fixture(); expect((await expired.post({ turnId: expired.input.turnId, approvalId: expired.oldApprovalId })).status).toBe(409);
    expect(f.samples()).toBe(1); expect(expired.samples()).toBe(1);
  });

  it("错目标与终态保持原Runtime不可恢复门禁", async function targetAndTerminal() {
    const f = await fixture(); const other = await f.runtime.sessions.create({ title: "other" });
    expect((await f.post({ turnId: f.input.turnId }, other.id)).status).toBe(404);
    const checkpoint = (await f.ports.checkpointStore.getLatest(f.session.id))!;
    await f.ports.checkpointStore.save(f.session.id, { ...checkpoint, status: "completed", messages: [], pendingCalls: undefined });
    expect((await f.post({ turnId: f.input.turnId })).status).toBe(409); expect(f.samples()).toBe(1);
  });
});
