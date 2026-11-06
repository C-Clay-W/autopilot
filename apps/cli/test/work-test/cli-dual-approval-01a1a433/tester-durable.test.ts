/** 独立Tester验证生产Core产物及真实Node决定与租约并发边界，采样受控。 */
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createNodeRuntimePorts } from "@autopilot-agent/adapters";
import { createAgentRuntime, type AgentEvent } from "@autopilot-agent/core";
/** 走完整公开异步事件入口。 */
async function collect(stream: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of stream) events.push(event); return events; }
/** 让Ink和真实文件端口各完成一次异步轮次。 */
async function frame() { await new Promise(function tick(resolve) { setTimeout(resolve, 40); }); }
/** 有界等待正常入口结果，不重复输入。 */
async function until(check: () => boolean) { for (let i = 0; i < 80 && !check(); i++) await frame(); expect(check()).toBe(true); }
/** 每例创建独占持久根并保留测试证据，不访问真实用户配置。 */
async function fixture(twoApprovals = false) {
  const evidence = fileURLToPath(new URL("../../../../../.agent-tests/work-test/cli-dual-approval-01a1a433/runs/r001/tester-states/", import.meta.url));
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(path.join(evidence, "durable-"));
  const workspaceRoot = path.join(root, "workspace"); await mkdir(workspaceRoot);
  const options = { stateRoot: path.join(root, "state"), workspaceRoot, env: {}, userSettingsPath: path.join(root, "user-settings.json"), trustRoot: path.join(root, "trust") };
  let samples = 0;
  /** 首次提出真实任务文件集合声明，后续只结束原Turn。 */
  const sampler = { sample: async function sample() {
    samples++;
    if (samples === 1) return { content: "", toolCalls: [{ id: "todo-once", name: "todo_write", input: { todos: [], fileTargets: [{ path: "controlled.txt", operation: "create" }] } }], reasoningSummary: "fixture" };
    if (samples === 2 && twoApprovals) return { content: "", toolCalls: [{ id: "todo-next", name: "todo_write", input: { todos: [], externalFileTargets: [{ path: path.join(root, "outside.txt"), operation: "create" }] } }], reasoningSummary: "fixture" };
    return { content: "完成", toolCalls: [], reasoningSummary: "fixture" };
  } };
  const config = { modelSampler: sampler, permissionMode: "ask" as const, workspaceRoot, workspaceTrusted: true, maxSteps: 5, sandboxMode: "workspace-write" as const };
  const ports = createNodeRuntimePorts(options);
  await ports.projectStore.save({ id: "fixture-project", name: "fixture", workspaceRoot, createdAt: Date.now(), updatedAt: Date.now() });
  await ports.sessionStore.save({ id: "child", projectId: "fixture-project", productMode: "work", persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
  const runtime = createAgentRuntime({ ports, defaultRunConfig: config });
  const events = await collect(runtime.turns.start({ sessionId: "child", content: "写受控文件" }));
  const request = events.find(function approval(event) { return event.type === "approval_required"; });
  expect(request?.type).toBe("approval_required");
  if (request?.type !== "approval_required") throw new Error("missing approval");
  const identity = { sessionId: "child", turnId: request.turnId, approvalId: request.result.approval.approvalId };
  /** 模拟重开宿主，所有持久端口重新创建。 */
  function reopen() { const nextPorts = createNodeRuntimePorts(options); return { ports: nextPorts, runtime: createAgentRuntime({ ports: nextPorts, defaultRunConfig: config }) }; }
  return { runtime, ports, identity, workspaceRoot, reopen };
}


it("三个生产Runtime竞争同一请求仅保存一次决定，重开后并发继续仅执行一次", async function concurrentHosts() {
  const f = await fixture();
  const b = f.reopen(); const c = f.reopen();
  const submitted = await Promise.allSettled([f.runtime.approvals.submit({ ...f.identity, decision: "allow_once" }), b.runtime.approvals.submit({ ...f.identity, decision: "allow_once" }), c.runtime.approvals.submit({ ...f.identity, decision: "deny" })]);
  expect(submitted.filter(function success(r) { return r.status === "fulfilled"; })).toHaveLength(1);
  const saved = await c.runtime.approvals.getDecision(f.identity); expect(saved).toBeTruthy();
  const input = { sessionId: f.identity.sessionId, turnId: f.identity.turnId, approval: { approvalId: f.identity.approvalId, decision: saved!.decision === "deny" ? "deny" as const : "allow" as const } };
  const d = f.reopen(); const e = f.reopen();
  const resumed = await Promise.allSettled([collect(d.runtime.turns.continue(input)), collect(e.runtime.turns.continue(input))]);
  expect(resumed.filter(function success(r) { return r.status === "fulfilled"; })).toHaveLength(1);
  const transcript = await e.ports.transcriptStore.getEvents("child");
  expect(transcript.filter(function result(e) { return e.event.type === "tool_result" && e.event.callId === "todo-once"; })).toHaveLength(1);
  expect((await e.ports.turnStore.getLatest("child"))?.id).toBe(f.identity.turnId);
  expect(await e.runtime.approvals.getDecision(f.identity)).toEqual(saved);
  await expect(collect(e.runtime.turns.continue(input))).rejects.toMatchObject({ code: "TURN_NOT_RESUMABLE" });
}, 20000);

it("重建宿主后原已保存拒绝只能恢复原Turn，重复批准不能反转或执行工具", async function savedDeny() {
  const f = await fixture(); await f.runtime.approvals.submit({ ...f.identity, decision: "deny" });
  const reopened = f.reopen();
  await expect(reopened.runtime.approvals.submit({ ...f.identity, decision: "allow_once" })).rejects.toMatchObject({ code: "APPROVAL_ALREADY_SUBMITTED" });
  const events = await collect(reopened.runtime.turns.continue({ sessionId: "child", turnId: f.identity.turnId, approval: { approvalId: f.identity.approvalId, decision: "deny" } }));
  expect(events.some(function failed(e) { return e.type === "turn_failed"; })).toBe(true);
  const results = (await reopened.ports.transcriptStore.getEvents("child")).filter(function tool(e) { return e.event.type === "tool_result" && e.event.callId === "todo-once"; });
  expect(results).toHaveLength(1); expect(results[0]!.event).toMatchObject({ result: { status: "denied" } });
}, 20000);
