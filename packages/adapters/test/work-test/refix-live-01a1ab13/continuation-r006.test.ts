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
  const evidence = path.resolve("../../.agent-tests/work-test/refix-live-01a1ab13/fixtures/r006-continuation");
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


it.each(["read_decision", "continue", "after_started"] as const)("r006 %s 失败留安全诊断、原身份、真实暂停且仅明确未启动可重试", async function safeFailure(stage) {
  const f = await fixture("approval");
  await f.save();
  const receipt = await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
  const original = f.runtime.turns.continue;
  const secret = "C:/private/command-token-SECRET";
  if (stage === "read_decision") vi.spyOn(f.ports.approvalStore, "getDecision").mockRejectedValueOnce(Object.assign(new Error(secret), { code: "EPERM" }));
  else vi.spyOn(f.runtime.turns, "continue").mockImplementationOnce(async function* injected(input) {
    if (stage === "after_started") { for await (const event of original(input)) { yield event; if (event.type === "turn_started") break; } }
    throw Object.assign(new Error(secret), { code: stage === "continue" ? secret : "TURN_NOT_RESUMABLE" });
  });
  try {
    await f.runner.start();
    await until(async function failed() { return (await f.ports.threadStore.readControl(f.groupId))!.controls[0].status === "failed"; });
    vi.restoreAllMocks();
    const intent = (await f.reopen().ports.threadStore.readControl(f.groupId))!.controls[0];
    expect(intent).toMatchObject({ controlId: receipt.controlId, threadId: "target", expectedTurnId: f.identity.turnId, approvalId: f.identity.approvalId, failureCode: "CONTINUE_FAILED", failureDiagnostic: { stage, started: stage === "after_started", category: stage === "read_decision" ? "os" : stage === "continue" ? "unknown" : "runtime", code: stage === "read_decision" ? "EPERM" : stage === "continue" ? "CONTINUE_UNKNOWN" : "TURN_NOT_RESUMABLE" } });
    expect(JSON.stringify(intent)).not.toContain(secret);
    const view = await f.runtime.turns.getExecutionState(f.identity);
    if (stage !== "after_started") expect(view?.interaction).toMatchObject({ state: "decided", decision: "approved", continuation: { state: "failed", failureDiagnostic: intent.failureDiagnostic } });
    if (stage !== "after_started") {
    const snapshot = await f.runtime.threads.bind({ workspaceId: "workspace", stateRootId: "state", projectId: "project", allowedTools: [], modelCatalog: [], humanPrincipalId: "user", executionHost: "web-work-v1", actor: { kind: "human", principalId: "user" } }).wait({ protocolVersion: 1, groupId: f.groupId, targets: [{ threadId: "target" }], timeoutMs: 0 });
    expect(snapshot.results[0].summary).toMatchObject({ interactionState: "decided", continuationState: "failed", interactionDecision: "approved" });
    }
    expect(view?.continuation?.failureDiagnostic).toEqual(intent.failureDiagnostic);
    if (stage === "after_started") await expect(f.foreign.runtime.turns.requestInteractionContinuation!(f.identity)).rejects.toBeDefined();
    else {
      expect(view?.status).toBe("waiting_approval");
      const retry = await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
      expect(retry.controlId).toBe(receipt.controlId);
      f.runner.kick();
      await until(async function completed() { return (await f.ports.turnStore.get(f.identity.turnId))?.status === "completed"; });
      expect((await f.ports.transcriptStore.getEvents("target")).filter(function result(item) { return item.event.type === "tool_result" && item.event.callId === "todo-1"; })).toHaveLength(1);
    }
  } finally { await f.runner.stop(); vi.restoreAllMocks(); }
});
it("r006 未知诊断附加字段不进入外部投影，Node拒绝写入并保留原记录", async function safeProjection() {
 const f = await fixture("approval"); await f.save(); await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
 const current = (await f.ports.threadStore.readControl(f.groupId))!;
 const invalid = { ...current, revision: current.revision + 1, controls: current.controls.map(function inject(item) { return { ...item, failureDiagnostic: { stage: "continue", category: "unknown", code: "private-path", started: false, message: "SECRET" } }; }) } as any;
 await expect(f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, invalid)).rejects.toThrow("THREAD_CONTROL_CORRUPTED");
 expect((await f.ports.threadStore.readControl(f.groupId))!.revision).toBe(current.revision);
});

it("r006 拒绝决定的安全投影不误写已批准", async function deniedProjection() {
 const f = await fixture("approval");
 await f.foreign.runtime.approvals.submit({ ...f.identity, approvalId: f.identity.approvalId!, decision: "deny" });
 await f.foreign.runtime.turns.requestInteractionContinuation!(f.identity);
 expect((await f.reopen().runtime.turns.getExecutionState(f.identity))?.interaction).toMatchObject({ state: "decided", decision: "denied", continuation: { state: "pending" } });
});
