/** S1 定向回归，真实 Core 服务验证受信宿主隔离、旧归属证据与人类 CAS。 */
import { expect, it, vi } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createSessionService } from "../../../src/runtime/application/session-service";
import { createThreadService, createThreadFacade } from "../../../src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../../src/runtime/application/thread-delivery-service";
import { assertThreadExecutionHost, resolveThreadExecutionHost } from "../../../src/runtime/application/thread-execution-host";
import { createAgentRuntime } from "../../../src/runtime/public/create-agent-runtime";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { createNodeThreadStore } from "../../../../adapters/src/node/stores/node-thread-store";

/** 建立普通启用组，所有状态只存在于内存。 */
async function setup(executionHost: string | undefined = "cli-work-v1") {
  const ports = createMemoryPorts();
  const sessions = createSessionService(ports);
  const root = await sessions.create({ title: "root" });
  const context = { workspaceId: "workspace", stateRootId: "state", projectId: root.projectId!, allowedTools: [], modelCatalog: [], executionHost, humanPrincipalId: "user", actor: { kind: "human" as const, principalId: "user" } };
  const human = createThreadService(ports, ports.threadStore, context);
  const group = await human.enable({ requestId: "enable", rootThreadId: root.id });
  const groupId = group.group.groupId;
  const child = await human.create({ groupId, parentThreadId: root.id, requestId: "child" });
  /** 同一状态根上分别装配独立宿主实例。 */
  function host(kind: string, owner = `${kind}:workspace:100`) {
    return createThreadDeliveryService(ports, ports.threadStore, { workspaceId: "workspace", stateRootId: "state", executionHost: `${kind}-work-v1`, ownerId: owner });
  }
  return { ports, sessions, root, context, human, groupId, child, host };
}

/** 修改自有组快照，模拟发布前缺少可选字段的持久记录。 */
async function legacy(f: Awaited<ReturnType<typeof setup>>) {
  const current = (await f.ports.threadStore.readControl(f.groupId))!;
  const next = { ...current, revision: current.revision + 1, members: current.members.map(function strip(item) { return { ...item, executionHost: undefined }; }), creates: current.creates.map(function strip(item) { return { ...item, executionHost: undefined }; }), deliveries: current.deliveries.map(function strip(item) { return { ...item, executionHost: undefined }; }) };
  expect(await f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, next)).toBe(true);
}

it.each(["cli", "web"])("S1 %s 普通根/关联/嵌套创建及跨端投递保留目标档位，并发仅领取一次", async function isolates(kind) {
  const f = await setup(`${kind}-work-v1`);
  const opposite = kind === "cli" ? "web" : "cli";
  const otherHuman = createThreadService(f.ports, f.ports.threadStore, { ...f.context, executionHost: `${opposite}-work-v1` });
  const nested = await otherHuman.create({ groupId: f.groupId, parentThreadId: f.child.threadId, requestId: "nested" });
  const associated = await f.sessions.create({ projectId: f.root.projectId, title: "associated" });
  await f.human.associate({ groupId: f.groupId, threadId: associated.id, requestId: "associate" });
  expect((await f.ports.threadStore.readControl(f.groupId))!.members.map(function host(item) { return item.executionHost; })).toEqual(Array(4).fill(`${kind}-work-v1`));
  await otherHuman.send({ groupId: f.groupId, threadId: nested.threadId, requestId: "run", mode: "run", content: "controlled" });
  expect(await f.host(opposite).claimDeliveries({ activeThreads: [] })).toEqual([]);
  const claimed = await Promise.all([f.host(kind).claimDeliveries({ activeThreads: [] }), f.host(kind, `${kind}:workspace:101`).claimDeliveries({ activeThreads: [] })]);
  expect(claimed.flat()).toHaveLength(1);
  expect(claimed.flat()[0].delivery.executionHost).toBe(`${kind}-work-v1`);
});

it.each(["cli", "web"])("S1 %s 模型自动建组的根与孩子同档位", async function bootstraps(kind) {
  const f = await setup(`${kind}-work-v1`);
  const root = await f.sessions.create({ projectId: f.root.projectId, title: "fresh" });
  await f.ports.sessionStore.save({ ...root, status: "running", activeTurnId: "model-turn" });
  await f.ports.turnStore.save({ id: "model-turn", sessionId: root.id, status: "running", frozenRunConfig: {}, startedAt: 1 });
  const model = createThreadService(f.ports, f.ports.threadStore, { ...f.context, actor: { kind: "thread", threadId: root.id, turnId: "model-turn" } });
  const groupId = await model.ensureCurrentGroupForCreate();
  await model.create({ groupId, parentThreadId: root.id, requestId: "model-child" });
  expect((await f.ports.threadStore.readControl(groupId))!.members.map(function member(item) { return item.executionHost; })).toEqual([`${kind}-work-v1`, `${kind}-work-v1`]);
});

it("S1 明确档位优先于历史错宿主，热轮询不读历史Turn", async function preservesDeclaredHost() {
  const f = await setup();
  await f.human.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "controlled" });
  const current = (await f.ports.threadStore.readControl(f.groupId))!;
  await f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, { ...current, revision: current.revision + 1, deliveries: current.deliveries.map(function oldOwner(item) { return { ...item, ownerId: "web:workspace:30324", turnId: "old-turn" }; }) });
  const reads = vi.spyOn(f.ports.turnStore, "get");
  expect(await resolveThreadExecutionHost(f.ports, f.groupId, f.child.threadId)).toBe("cli-work-v1");
  expect(await f.host("web").claimDeliveries({ activeThreads: [] })).toEqual([]);
  expect(reads).not.toHaveBeenCalled();
});

it("S1 旧无标识由精确owner及真实Turn补齐，活跃领取身份保持", async function infersOwner() {
  const f = await setup();
  await f.human.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "controlled" });
  await legacy(f);
  await f.ports.turnStore.save({ id: "old-turn", sessionId: f.child.threadId, status: "running", frozenRunConfig: {}, startedAt: 1 });
  const current = (await f.ports.threadStore.readControl(f.groupId))!;
  await f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, { ...current, revision: current.revision + 1, deliveries: current.deliveries.map(function owned(item) { return { ...item, status: "claimed", ownerId: "web:workspace:30324", turnId: "old-turn", ownerHeartbeatAt: Date.now() }; }) });
  expect(await resolveThreadExecutionHost(f.ports, f.groupId, f.child.threadId)).toBe("web-work-v1");
  const resolved = (await f.ports.threadStore.readControl(f.groupId))!;
  expect(resolved.deliveries[0]).toMatchObject({ executionHost: "web-work-v1", ownerId: "web:workspace:30324", turnId: "old-turn", status: "claimed" });
  await expect(f.human.bindExecutionHost({ groupId: f.groupId, threadId: f.child.threadId, expectedRevision: resolved.revision, executionHost: "cli-work-v1" })).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
});

it("S1 歧义旧投递由人类精确CAS绑定，迟到和模型代选拒绝", async function bindsLegacy() {
  const f = await setup();
  await f.human.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "controlled" });
  await legacy(f);
  expect(await f.host("cli").claimDeliveries({ activeThreads: [] })).toEqual([]);
  expect(await f.host("web").claimDeliveries({ activeThreads: [] })).toEqual([]);
  const facade = createThreadFacade(f.ports, f.context);
  const snapshot = await facade.list({ protocolVersion: 1, groupId: f.groupId });
  const input = { protocolVersion: 1, groupId: f.groupId, threadId: f.child.threadId, expectedRevision: snapshot.revision, executionHost: "web-work-v1" as const };
  expect(await facade.bindExecutionHost(input)).toMatchObject({ executionHost: "web-work-v1" });
  await expect(facade.bindExecutionHost({ ...input, executionHost: "cli-work-v1" })).rejects.toMatchObject({ code: "THREAD_STATE_CONFLICT" });
  const model = createThreadService(f.ports, f.ports.threadStore, { ...f.context, actor: { kind: "thread", threadId: f.root.id, turnId: "model-turn" } });
  await expect(model.bindExecutionHost(input)).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
  expect(await f.host("cli").claimDeliveries({ activeThreads: [] })).toEqual([]);
  expect(await f.host("web").claimDeliveries({ activeThreads: [] })).toHaveLength(1);
});

it("S1 冻结Web能力可识别旧目标，缺证据或伪造owner保持未知", async function infersFrozenTools() {
  const f = await setup(undefined);
  await legacy(f);
  const checkpoint = { turnId: "frozen-turn", status: "awaiting_user_input", stepCount: 1, messages: [], completedCallIds: [], samplingTools: [{ type: "function", function: { name: "ask_user_question", description: "", parameters: {} } }] };
  await f.ports.turnStore.save({ id: checkpoint.turnId, sessionId: f.child.threadId, status: "waiting_user_input", frozenRunConfig: {}, startedAt: 1 });
  await f.ports.checkpointStore.save(f.child.threadId, checkpoint as never);
  expect(await resolveThreadExecutionHost(f.ports, f.groupId, f.child.threadId)).toBe("web-work-v1");
  expect(await resolveThreadExecutionHost(f.ports, f.groupId, f.root.id)).toBeUndefined();
  await expect(assertThreadExecutionHost(f.ports, f.child.threadId, f.root.projectId, "cli-work-v1", true)).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
});

it("S1 run/steer与resume控制只有兼容宿主可以领取", async function isolatesControls() {
  const f = await setup();
  const run = await f.human.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "controlled" });
  const claim = (await f.host("cli").claimDeliveries({ activeThreads: [] }))[0];
  const turnId = claim.delivery.reservedTurnId!;
  const child = (await f.ports.sessionStore.get(f.child.threadId))!;
  await f.ports.sessionStore.save({ ...child, status: "running", activeTurnId: turnId });
  await f.ports.turnStore.save({ id: turnId, sessionId: child.id, status: "running", frozenRunConfig: {}, startedAt: 1 });
  await f.human.send({ groupId: f.groupId, threadId: child.id, requestId: "steer", mode: "steer", expectedTurnId: turnId, content: "controlled" });
  expect(await f.host("web").claimDeliveries({ activeThreads: [child.id] })).toEqual([]);
  expect(await f.ports.inputInbox.list({ sessionId: child.id })).toEqual([]);
  await f.host("cli").claimDeliveries({ activeThreads: [child.id] });
  expect(await f.ports.inputInbox.list({ sessionId: child.id })).toHaveLength(1);
  const current = (await f.ports.threadStore.readControl(f.groupId))!;
  await f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, { ...current, revision: current.revision + 1, controls: [{ controlId: "resume", kind: "resume", status: "pending", threadId: child.id, expectedTurnId: turnId, createdAt: 1, updatedAt: 1 }] as never });
  expect(await f.host("web").pendingResumes()).toEqual([]);
  expect(await f.host("web").claimResume({ groupId: f.groupId, controlId: "resume" })).toBe(false);
  const claims = await Promise.all([f.host("cli").claimResume({ groupId: f.groupId, controlId: "resume" }), f.host("cli", "cli:workspace:101").claimResume({ groupId: f.groupId, controlId: "resume" })]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(run.messageId).toBe(claim.delivery.messageId);
});

it("S1 直接start/continue执行门禁保留人类决定及历史，兼容端可通过归属检查", async function guardsDirectExecution() {
  const f = await setup();
  const runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: { threads: { ...f.context, executionHost: "web-work-v1" } } });
  await expect(runtime.turns.start({ sessionId: f.child.threadId, prompt: "controlled" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
  await expect(runtime.turns.continue({ sessionId: f.child.threadId })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
  await expect(assertThreadExecutionHost(f.ports, f.child.threadId, f.root.projectId, "cli-work-v1")).resolves.toBeUndefined();
  expect((await f.ports.sessionStore.get(f.child.threadId))!.status).toBe("idle");
});

it("S1 Node两个Store并发绑定/领取及重开保持唯一档位和owner", async function durableCas() {
  const f = await setup();
  const evidence = path.resolve("../../.agent-tests/work-test/cli-core-web-refix-01a1a631/runs/r001/node-states");
  await mkdir(evidence, { recursive: true });
  const stateRoot = await mkdtemp(path.join(evidence, "host-"));
  await writeFile(path.join(stateRoot, "schema.json"), JSON.stringify({ schemaVersion: 8 }));
  const first = createNodeThreadStore(stateRoot);
  const second = createNodeThreadStore(stateRoot);
  f.ports.threadStore = first;
  const human = createThreadService(f.ports, first, f.context);
  const group = await human.enable({ rootThreadId: f.root.id, requestId: "durable-enable" });
  const groupId = group.group.groupId;
  await human.send({ groupId, threadId: f.root.id, requestId: "durable-run", mode: "run", content: "controlled" });
  const current = (await first.readControl(groupId))!;
  await first.compareAndSetControl(groupId, current.revision, { ...current, revision: current.revision + 1, members: current.members.map(function old(item) { return { ...item, executionHost: undefined }; }), deliveries: current.deliveries.map(function old(item) { return { ...item, executionHost: undefined }; }) });
  const snapshot = (await first.readControl(groupId))!;
  const otherPorts = { ...f.ports, threadStore: second };
  const otherHuman = createThreadService(otherPorts, second, f.context);
  const input = { groupId, threadId: f.root.id, expectedRevision: snapshot.revision, executionHost: "cli-work-v1" as const };
  const binds = await Promise.allSettled([human.bindExecutionHost(input), otherHuman.bindExecutionHost({ ...input, executionHost: "web-work-v1" })]);
  expect(binds.filter(function success(item) { return item.status === "fulfilled"; })).toHaveLength(1);
  const bound = (await second.readControl(groupId))!.members[0].executionHost!;
  const a = createThreadDeliveryService(f.ports, first, { workspaceId: "workspace", stateRootId: "state", executionHost: bound, ownerId: "owner-a" });
  const b = createThreadDeliveryService(otherPorts, second, { workspaceId: "workspace", stateRootId: "state", executionHost: bound, ownerId: "owner-b" });
  const claims = await Promise.all([a.claimDeliveries({ activeThreads: [] }), b.claimDeliveries({ activeThreads: [] })]);
  expect(claims.flat()).toHaveLength(1);
  const reopened = createNodeThreadStore(stateRoot);
  expect((await reopened.readControl(groupId))!.deliveries[0]).toMatchObject({ status: "claimed", executionHost: bound, ownerId: claims.flat()[0].delivery.ownerId });
});

it("S1 不可信owner与冲突证据不推断宿主，也不能人工覆盖执行事实", async function rejectsAmbiguity() {
  const f = await setup();
  await f.human.send({ groupId: f.groupId, threadId: f.child.threadId, requestId: "run", mode: "run", content: "controlled" });
  await legacy(f);
  await f.ports.turnStore.save({ id: "old-turn", sessionId: f.child.threadId, status: "interrupted", frozenRunConfig: {}, startedAt: 1 });
  const current = (await f.ports.threadStore.readControl(f.groupId))!;
  await f.ports.threadStore.compareAndSetControl(f.groupId, current.revision, { ...current, revision: current.revision + 1, deliveries: current.deliveries.map(function forged(item) { return { ...item, ownerId: "web:other-workspace:123", turnId: "old-turn" }; }) });
  expect(await resolveThreadExecutionHost(f.ports, f.groupId, f.child.threadId)).toBeUndefined();
  const revision = (await f.human.listThreads({ groupId: f.groupId })).revision;
  await expect(f.human.bindExecutionHost({ groupId: f.groupId, threadId: f.child.threadId, expectedRevision: revision, executionHost: "cli-work-v1" })).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
});

it.each(["running", "waiting_user_input"] as const)("S1 CLI关联Web %s 普通Session保持冻结能力及owner，重启用不改档位", async function associatesWebSession(status) {
  const f = await setup();
  const target = await f.sessions.create({ projectId: f.root.projectId, title: "web ordinary" });
  const turnId = `web-${status}`;
  await f.ports.sessionStore.save({ ...target, status, activeTurnId: status === "running" ? turnId : undefined });
  await f.ports.turnStore.save({ id: turnId, sessionId: target.id, status, frozenRunConfig: { workPreviewEnabled: true }, startedAt: 1 });
  await f.ports.checkpointStore.save(target.id, { turnId, status: status === "running" ? "running" : "awaiting_user_input", stepCount: 1, messages: [], completedCallIds: [], lease: { ownerId: "active-web-owner", leaseId: "lease", heartbeatAt: Date.now(), safeBoundarySeq: 1 } } as never);
  await f.human.associate({ groupId: f.groupId, threadId: target.id, requestId: "associate-web" });
  const control = (await f.ports.threadStore.readControl(f.groupId))!;
  expect(control.members.find(function member(item) { return item.threadId === target.id; })?.executionHost).toBe("web-work-v1");
  expect((await f.ports.checkpointStore.getLatest(target.id))?.lease?.ownerId).toBe("active-web-owner");
  if (status === "waiting_user_input") await expect(assertThreadExecutionHost(f.ports, target.id, target.projectId, "web-work-v1", true)).resolves.toBeUndefined();
  await f.human.disable({ groupId: f.groupId, requestId: "disable" });
  await f.human.enable({ groupId: f.groupId, rootThreadId: f.root.id, requestId: "reenable" });
  expect((await f.ports.threadStore.readControl(f.groupId))!.members.find(function member(item) { return item.threadId === target.id; })?.executionHost).toBe("web-work-v1");
});

it("S1 重新启用旧缺省根不以查看端覆盖，随后由冻结证据补齐", async function reenablesLegacyRoot() {
  const f = await setup();
  await legacy(f);
  await f.ports.turnStore.save({ id: "web-root", sessionId: f.root.id, status: "completed", frozenRunConfig: { workPreviewEnabled: true }, startedAt: 1 });
  await f.ports.checkpointStore.save(f.root.id, { turnId: "web-root", status: "completed", stepCount: 1, messages: [], completedCallIds: [] } as never);
  await f.human.disable({ groupId: f.groupId, requestId: "disable" });
  await f.human.enable({ groupId: f.groupId, rootThreadId: f.root.id, requestId: "reenable" });
  expect(await resolveThreadExecutionHost(f.ports, f.groupId, f.root.id)).toBe("web-work-v1");
});

it("S1 人类跨端保存原问题答案，CLI拒绝执行而兼容Web继续原Turn", async function continuesQuestionOnCompatibleHost() {
  const f = await setup("web-work-v1");
  let samples = 0;
  const runtime = createAgentRuntime({ ports: f.ports, enableUserQuestions: true, defaultRunConfig: { threads: f.context, modelSampler: { async sample() {
    samples++;
    if (samples === 1) return { content: "", toolCalls: [{ id: "ask-host", name: "ask_user_question", input: { questions: [{ id: "scope", header: "范围", question: "请选择范围", options: [{ label: "小", description: "最小范围" }, { label: "全", description: "全部范围" }] }] } }], reasoningSummary: "controlled" };
    return { content: "done", toolCalls: [], reasoningSummary: "controlled" };
  } } } });
  let requestId = "";
  let turnId = "";
  for await (const event of runtime.turns.start({ sessionId: f.child.threadId, content: "controlled" })) {
    if (event.type === "question_required") { requestId = event.requestId; turnId = event.turnId; }
  }
  expect(requestId).not.toBe("");
  const cli = createAgentRuntime({ ports: f.ports, defaultRunConfig: { threads: { ...f.context, executionHost: "cli-work-v1" } } });
  await cli.questions.submit({ sessionId: f.child.threadId, turnId, requestId, answers: [{ id: "scope", selected: ["小"] }] });
  await expect(cli.turns.continue({ sessionId: f.child.threadId, turnId, requestId })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
  const events = [];
  for await (const event of runtime.turns.continue({ sessionId: f.child.threadId, turnId, requestId })) events.push(event);
  expect(events.filter(function result(event) { return event.type === "tool_result" && event.callId === "ask-host"; })).toHaveLength(1);
  expect(events.some(function completed(event) { return event.type === "turn_completed"; })).toBe(true);
  expect(events.every(function original(event) { return event.turnId === turnId; })).toBe(true);
});
