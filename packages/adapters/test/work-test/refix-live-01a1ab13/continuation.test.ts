/** S2 真实Node持久交互交接回归，采样受控，模拟宿主重建与首事件前失败。 */
import { expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentRuntime } from "../../../../core/src/runtime/public/create-agent-runtime";
import { createThreadDeliveryService } from "../../../../core/src/runtime/application/thread-delivery-service";
import { createNodeRuntimePorts } from "../../../src/node/create-node-runtime-ports";
import { createNodeThreadRunner } from "../../../src/node/thread-runner";
import { createMemoryPorts } from "../../../../core/src/runtime/adapters/memory";

/** 有界等待自有Runner的持久事实，失败不重复提交输入。 */
async function until(probe: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await probe()) return;
    await new Promise(function wait(resolve) { setTimeout(resolve, 20); });
  }
  throw new Error("controlled continuation timeout");
}

/** 建立独占Node状态根，源Runtime产生合法暂停，外端只能保存决定及持久交接。 */
async function fixture(kind: "approval" | "question", followup = false) {
  const evidence = path.resolve("../../.agent-tests/work-test/refix-live-01a1ab13/fixtures/r002-continuation");
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(path.join(evidence, `${kind}-`));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const options = { stateRoot: path.join(root, "state"), workspaceRoot, env: {}, userSettingsPath: path.join(root, "settings.json"), trustRoot: path.join(root, "trust") };
  const ports = createNodeRuntimePorts(options);
  await ports.projectStore.save({ id: "project", name: "controlled", workspaceRoot, createdAt: Date.now(), updatedAt: Date.now() });
  await ports.sessionStore.save({ id: "target", productMode: "work", projectId: "project", persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
  const capability = { workspaceId: "workspace", stateRootId: "state", projectId: "project", allowedTools: [], modelCatalog: [], humanPrincipalId: "user" };
  let samples = 0;
  let instance = 100;
  const sampler = { async sample() {
    samples++;
    if (samples === 1 || (followup && samples === 2)) return kind === "approval"
      ? { content: "", toolCalls: [{ id: `todo-${samples}`, name: "todo_write", input: { todos: [], fileTargets: [{ path: `controlled-${samples}.txt`, operation: "create" }] } }], reasoningSummary: "controlled" }
      : { content: "", toolCalls: [{ id: `question-${samples}`, name: "ask_user_question", input: { questions: [{ id: "scope", header: "范围", question: "选择范围", options: [{ label: "小", description: "最小范围" }, { label: "全", description: "全部范围" }] }] } }], reasoningSummary: "controlled" };
    return { content: "done", toolCalls: [], reasoningSummary: "controlled" };
  } };
  /** 使用同一持久根重建宿主，冻结执行配置保持原样。 */
  function reopen(host = "web") {
    const nextPorts = createNodeRuntimePorts(options);
    const runtime = createAgentRuntime({ ports: nextPorts, enableUserQuestions: host === "web", defaultRunConfig: { modelSampler: sampler, permissionMode: "ask", workspaceRoot, workspaceTrusted: true, sandboxMode: "workspace-write", threads: { ...capability, executionHost: `${host}-work-v1` } } });
    const delivery = createThreadDeliveryService(nextPorts, nextPorts.threadStore, { workspaceId: "workspace", stateRootId: "state", executionHost: `${host}-work-v1`, ownerId: `${host}:workspace:${++instance}` });
    const errors: unknown[] = [];
    const runner = createNodeThreadRunner({ runtime, ports: nextPorts, delivery, pollIntervalMs: 25, onError: function error(error) { errors.push(error); } });
    return { runtime, ports: nextPorts, delivery, runner, errors };
  }
  const initial = reopen();
  const human = initial.runtime.threads.bind({ ...capability, executionHost: "web-work-v1", actor: { kind: "human", principalId: "user" } });
  const group = await human.enable({ protocolVersion: 1, rootThreadId: "target", requestId: "enable" });
  const events = [];
  for await (const event of initial.runtime.turns.start({ sessionId: "target", content: "controlled" })) events.push(event);
  const view = (await initial.runtime.turns.getExecutionState({ sessionId: "target" }))!;
  const request = events.find(function request(event) { return event.type === "approval_required" || event.type === "question_required"; })!;
  const identity = { sessionId: "target", turnId: view.turnId, ...(request.type === "approval_required" ? { approvalId: request.result.approval.approvalId } : request.type === "question_required" ? { requestId: request.requestId } : {}) };
  const foreign = reopen("cli");
  /** 两种人类决定均通过原服务持久校验。 */
  async function save() {
    if (identity.approvalId) await foreign.runtime.approvals.submit({ ...identity, approvalId: identity.approvalId, decision: "allow_once" });
    else await foreign.runtime.questions.submit({ ...identity, requestId: identity.requestId!, answers: [{ id: "scope", selected: ["小"] }] });
  }
  return { ...initial, foreign, identity, save, reopen, stateRoot: options.stateRoot, groupId: group.group.groupId };
}

it.each(["approval", "question"] as const)("S2 %s 保存后尚未交接即重开，两个入口同意图且原Turn只执行一次", async function savedBeforeHandoff(kind) {
  const f = await fixture(kind);
  await f.save();
  // 原直接跨宿主链确实拒绝，不能把S1门禁当成已自动恢复。
  await expect(f.foreign.runtime.turns.continue({ sessionId: "target", turnId: f.identity.turnId, requestId: f.identity.requestId })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
  const reopened = f.reopen("cli");
  const receipts = await Promise.all([reopened.runtime.turns.requestInteractionContinuation!(f.identity), f.runtime.turns.requestInteractionContinuation!(f.identity)]);
  expect(receipts[0]).toMatchObject({ queued: true, controlId: receipts[1].controlId });
  expect((await reopened.runtime.turns.getExecutionState(f.identity))?.interaction?.continuation?.state).toBe("pending");
  const owner = f.reopen();
  try {
    await reopened.runner.start();
    expect((await reopened.ports.turnStore.get(f.identity.turnId))?.status).not.toBe("completed");
    await owner.runner.start();
    await until(async function completed() { return (await owner.ports.turnStore.get(f.identity.turnId))?.status === "completed"; });
    const events = await owner.ports.transcriptStore.getEvents("target");
    expect(events.filter(function result(item) { return item.event.type === "tool_result" && item.event.callId === (kind === "approval" ? "todo-1" : "question-1"); })).toHaveLength(1);
    expect((await owner.ports.threadStore.readControl(f.groupId))!.controls.filter(function exact(item) { return item.kind === "continue_interaction"; })).toHaveLength(1);
    expect(owner.errors).toEqual([]);
  } finally { await reopened.runner.stop(); await owner.runner.stop(); }
});

