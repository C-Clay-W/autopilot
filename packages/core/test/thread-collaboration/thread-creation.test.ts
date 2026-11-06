/** 验证协作组的受信授权和可恢复创建，不启动模型。 */
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { MemoryThreadStore } from "../../src/runtime/adapters/memory/memory-thread-store";
import { resolveTurnCapabilities } from "../../src/runtime/application/turn/turn-capability-ceiling";
import { createAgentRuntime } from "../../src/runtime/public/create-agent-runtime";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createThreadService } from "../../src/runtime/application/thread-service";
import type { ThreadStore } from "../../src/runtime/ports/thread-store";

/** 初始化真实 Session 和 Project，返回独立测试环境。 */
async function setup() {
  const ports = createMemoryPorts();
  const sessions = createSessionService(ports);
  const root = await sessions.create({ title: "root" });
  const store = new MemoryThreadStore();
  ports.threadStore = store;
  const context = { workspaceId: "workspace", stateRootId: "state-one", allowedTools: ["read_file"], modelCatalog: [], projectId: root.projectId!, actor: { kind: "human" as const, principalId: "user" } };
  const service = createThreadService(ports, store, context);
  const group = await service.enable({ requestId: "enable", rootThreadId: root.id });
  return { ports, root, store, context, service, groupId: group.group.groupId };
}

describe("协作创建", function creationContract() {
  it("同请求恢复原 Session，不同正文冲突，不能跨用户访问", async function idempotenceAndAuthorization() {
    const f = await setup();
    const input = { groupId: f.groupId, requestId: "create", parentThreadId: f.root.id, title: "child" };
    const first = await f.service.create(input);
    expect(await f.service.create(input)).toEqual(first);
    expect((await f.ports.sessionStore.get(first.threadId))?.projectId).toBe(f.root.projectId);
    await expect(f.service.create({ ...input, title: "other" })).rejects.toMatchObject({ code: "THREAD_REQUEST_CONFLICT" });
    const other = createThreadService(f.ports, f.store, { ...f.context, actor: { kind: "human", principalId: "other" } });
    await expect(other.create(input)).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
  });

  it("Session 写入后绑定中断时，同请求重试复用身份", async function recoverAfterSessionWrite() {
    const f = await setup();
    let failCommit = true;
    const interrupted: ThreadStore = {
      verifyRequest: f.store.verifyRequest.bind(f.store), reserveRequest: f.store.reserveRequest.bind(f.store),
      withSessionLock: f.store.withSessionLock.bind(f.store),
      hasMembership: f.store.hasMembership.bind(f.store),
      listGroups: f.store.listGroups.bind(f.store),
      readControl: f.store.readControl.bind(f.store),
      readEvent: f.store.readEvent.bind(f.store),
      writeEvent: f.store.writeEvent.bind(f.store),
      readMessage: f.store.readMessage.bind(f.store),
      writeMessage: f.store.writeMessage.bind(f.store),
      async compareAndSetControl(groupId, revision, value) {
        if (failCommit && value.creates.some(function completed(item) { return item.status === "created"; })) {
          failCommit = false;
          throw new Error("simulated interruption");
        }
        return f.store.compareAndSetControl(groupId, revision, value);
      },
    };
    const service = createThreadService(f.ports, interrupted, f.context);
    const input = { groupId: f.groupId, requestId: "recover", parentThreadId: f.root.id };
    await expect(service.create(input)).rejects.toThrow("simulated interruption");
    const intent = (await f.store.readControl(f.groupId))!.creates[0];
    expect(await f.ports.sessionStore.get(intent.threadId)).not.toBeNull();
    expect((await service.create(input)).threadId).toBe(intent.threadId);
    expect((await f.store.readControl(f.groupId))!.members).toHaveLength(2);
  });
  it("共享板只接受当前版本，重试不重复更新", async function stateCas() {
    const f = await setup();
    const update = { groupId: f.groupId, requestId: "state", expectedRevision: 0, operations: [{ op: "set" as const, key: "goal", value: "one" }] };
    expect(await f.service.updateState(update)).toEqual({ revision: 1 });
    expect(await f.service.updateState(update)).toEqual({ revision: 1 });
    await expect(f.service.updateState({ ...update, requestId: "stale" })).rejects.toMatchObject({ code: "THREAD_STATE_CONFLICT" });
    expect((await f.service.readState(f.groupId)).value).toEqual({ goal: "one" });
  });
  it("通知仅持久化，重试幂等，分页不启动或写 Inbox", async function notificationAndPagination() {
    const f = await setup();
    const input = { groupId: f.groupId, threadId: f.root.id, requestId: "n1", mode: "notify" as const, content: "first" };
    const first = await f.service.send(input);
    expect(await f.service.send(input)).toEqual(first);
    await expect(f.service.send({ ...input, content: "different" })).rejects.toMatchObject({ code: "THREAD_REQUEST_CONFLICT" });
    await f.service.send({ ...input, requestId: "n2", content: "second" });
    const page = await f.service.listMessages({ groupId: f.groupId, threadId: f.root.id, limit: 1 });
    expect(page.items.map(function content(item) { return item.content; })).toEqual(["first"]);
    expect((await f.service.listMessages({ groupId: f.groupId, threadId: f.root.id, limit: 1, cursor: page.nextCursor })).items[0].content).toBe("second");
    expect(await f.ports.inputInbox.list({ sessionId: f.root.id })).toEqual([]);
    expect(await f.ports.turnStore.list(f.root.id)).toEqual([]);
  });
  it("受管父子 Session 不能绕过协作组删除", async function rejectsMemberDelete() {
    const f = await setup();
    const child = await f.service.create({ groupId: f.groupId, requestId: "child", parentThreadId: f.root.id });
    const sessions = createSessionService(f.ports);
    await expect(sessions.delete(f.root.id)).rejects.toMatchObject({ code: "THREAD_HAS_PENDING_WORK" });
    await expect(sessions.delete(child.threadId)).rejects.toMatchObject({ code: "THREAD_HAS_PENDING_WORK" });
    expect(await f.ports.sessionStore.get(child.threadId)).not.toBeNull();
  });
  it("Transcript 对外游标绑定状态根和视图", async function transcriptCursorDomain() {
    const f = await setup();
    for (let i = 1; i <= 2; i++) await f.ports.transcriptStore.append(f.root.id, { sessionId: f.root.id, turnId: "t", seq: i, timestamp: "2026-01-01", event: { type: "turn_started", turnId: "t" } } as never);
    const first = await f.service.readThread({ groupId: f.groupId, threadId: f.root.id, limit: 1 });
    expect(first.history).toHaveLength(1);
    const second = await f.service.readThread({ groupId: f.groupId, threadId: f.root.id, limit: 1, cursor: first.nextCursor });
    expect(second.history[0].seq).toBe(2);
    const other = createThreadService(f.ports, f.store, { ...f.context, stateRootId: "state-two" });
    await expect(other.readThread({ groupId: f.groupId, threadId: f.root.id, cursor: first.nextCursor })).rejects.toMatchObject({ code: "THREAD_CURSOR_INVALID" });
    await expect(f.service.listMessages({ groupId: f.groupId, threadId: f.root.id, cursor: first.nextCursor })).rejects.toMatchObject({ code: "THREAD_CURSOR_INVALID" });
  });
  it("事件按组序号分页且游标不能跨视图使用", async function eventPaging() {
    const f = await setup();
    await f.service.create({ groupId: f.groupId, requestId: "child-event", parentThreadId: f.root.id });
    const page = await f.service.listEvents({ groupId: f.groupId, limit: 1 });
    expect(page.items.map(function kind(event) { return event.kind; })).toEqual(["member_created"]);
    const end = await f.service.listEvents({ groupId: f.groupId, cursor: page.nextCursor });
    expect(end.items[0].groupSeq).toBe(2);
    await f.service.send({ groupId: f.groupId, threadId: f.root.id, requestId: "after-cursor", mode: "notify", content: "next" });
    expect((await f.service.listEvents({ groupId: f.groupId, cursor: end.cursor })).items.map(function sequence(event) { return event.groupSeq; })).toEqual([3]);
    await expect(f.service.listMessages({ groupId: f.groupId, threadId: f.root.id, cursor: page.nextCursor })).rejects.toMatchObject({ code: "THREAD_CURSOR_INVALID" });
  });
  it("事件写入中断后相同创建请求补写并保持序号", async function eventRecovery() {
    const f = await setup();
    let fail = true;
    const interrupted: ThreadStore = {
      verifyRequest: f.store.verifyRequest.bind(f.store), reserveRequest: f.store.reserveRequest.bind(f.store), withSessionLock: f.store.withSessionLock.bind(f.store), hasMembership: f.store.hasMembership.bind(f.store), listGroups: f.store.listGroups.bind(f.store),
      readControl: f.store.readControl.bind(f.store), compareAndSetControl: f.store.compareAndSetControl.bind(f.store),
      readMessage: f.store.readMessage.bind(f.store), writeMessage: f.store.writeMessage.bind(f.store), readEvent: f.store.readEvent.bind(f.store),
      async writeEvent(event) { if (fail) { fail = false; throw new Error("event interrupted"); } return f.store.writeEvent(event); },
    };
    const service = createThreadService(f.ports, interrupted, f.context);
    const input = { groupId: f.groupId, parentThreadId: f.root.id, requestId: "recover-event" };
    await expect(service.create(input)).rejects.toThrow("event interrupted");
    await expect(service.listEvents({ groupId: f.groupId })).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
    const child = await service.create(input);
    const events = await service.listEvents({ groupId: f.groupId });
    expect(events.items.map(function number(item) { return item.groupSeq; })).toEqual([1, 2]);
    expect(events.items[1].threadId).toBe(child.threadId);
  });

  it("模型必须来自宿主目录，来源不裁剪普通能力且来源不可改写", async function modelAndCeiling() {
    const f = await setup();
    const service = createThreadService(f.ports, f.store, { ...f.context, modelCatalog: [{ provider: "p", modelId: "m" }] });
    const input = { groupId: f.groupId, parentThreadId: f.root.id, requestId: "model", modelRef: { provider: "p", modelId: "m" }, reasoningEffort: "medium" as const };
    const created = await service.create(input);
    const session = (await f.ports.sessionStore.get(created.threadId))!;
    expect(session.collaborationAllowedTools).toBeUndefined();
    expect(session.creationSource).toEqual({ actor: f.context.actor, requestId: "model" });
    const resolved = await resolveTurnCapabilities({ session, turnId: "t", runtimeDefault: { toolAllowlist: ["read_file", "write_file"], permissionMode: "full_access" }, override: { toolAllowlist: ["write_file", "read_file"], permissionMode: "full_access" }, frozen: {}, now: 0 });
    expect(resolved.frozen.capabilityCeiling?.allowedTools).toEqual(["read_file", "write_file"]);
    expect(resolved.capabilities.permissionMode).toBe("full_access");
    expect(session.defaultRunConfig?.modelRef).toEqual(input.modelRef);
    await expect(service.create({ ...input, requestId: "denied", modelRef: { provider: "p", modelId: "other" } })).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    await expect(createSessionService(f.ports).save({ ...session, creationSource: { actor: f.context.actor, requestId: "forged" } })).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
  });
  it("容量准入保留终态余量并拒绝新消息", async function reservesCapacity() {
    const f = await setup();
    const control = (await f.store.readControl(f.groupId))!;
    const oversized = { ...control, revision: control.revision + 1, receipts: [...control.receipts, { actorKey: "test", operation: "test", requestId: "test", payloadDigest: "x", result: "x".repeat(3 * 1024 * 1024) }] };
    expect(await f.store.compareAndSetControl(f.groupId, control.revision, oversized)).toBe(true);
    await expect(f.service.send({ groupId: f.groupId, threadId: f.root.id, requestId: "full", mode: "run", content: "new" })).rejects.toMatchObject({ code: "THREAD_STORAGE_FULL" });
    expect((await f.store.readControl(f.groupId))?.messageIntents).toHaveLength(0);
  });
  it("steer 只接受目标当前活动 Turn", async function steerExpectedTurn() {
    const f = await setup();
    const input = { groupId: f.groupId, threadId: f.root.id, requestId: "steer", mode: "steer" as const, content: "step", expectedTurnId: "old" };
    await expect(f.service.send(input)).rejects.toMatchObject({ code: "THREAD_NOT_RUNNING" });
    await f.ports.sessionStore.save({ ...f.root, status: "running", activeTurnId: "current" });
    await f.ports.turnStore.save({ id: "current", sessionId: f.root.id, status: "running", frozenRunConfig: {}, startedAt: 1 });
    await expect(f.service.send(input)).rejects.toMatchObject({ code: "THREAD_TURN_MISMATCH" });
    expect((await f.service.send({ ...input, expectedTurnId: "current" })).deliveryStatus).toBe("pending");
    expect(await f.ports.inputInbox.list({ sessionId: f.root.id })).toEqual([]);
  });
  it("Facade 校验协议且不暴露内部控制意图", async function facadeVersionAndProjection() {
    const f = await setup();
    const facade = createAgentRuntime({ ports: f.ports }).threads.bind(f.context);
    const result = await facade.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: f.root.id });
    expect(result.group.groupId).toBe(f.groupId);
    expect(result).not.toHaveProperty("receipts");
    await expect(facade.list({ protocolVersion: 2, groupId: f.groupId })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await facade.list({ protocolVersion: 1, groupId: f.groupId })).items).toHaveLength(1);
  });
  it("同一 actor 和操作请求 ID 不能跨组重复生效", async function workspaceIdempotency() {
    const f = await setup();
    const otherRoot = await createSessionService(f.ports).create({ title: "second root" });
    const other = await f.service.enable({ rootThreadId: otherRoot.id, requestId: "other-enable" });
    await f.service.create({ groupId: f.groupId, parentThreadId: f.root.id, requestId: "same" });
    await expect(f.service.create({ groupId: other.group.groupId, parentThreadId: otherRoot.id, requestId: "same" })).rejects.toMatchObject({ code: "THREAD_REQUEST_CONFLICT" });
    await f.service.updateState({ groupId: f.groupId, requestId: "same", expectedRevision: 0, operations: [{ op: "set", key: "goal", value: "first" }] });
    await f.service.updateState({ groupId: other.group.groupId, requestId: "other-state", expectedRevision: 0, operations: [{ op: "set", key: "goal", value: "other" }] });
    await expect(f.service.updateState({ groupId: other.group.groupId, requestId: "same", expectedRevision: 0, operations: [{ op: "set", key: "goal", value: "first" }] })).rejects.toMatchObject({ code: "THREAD_REQUEST_CONFLICT" });
    await f.service.send({ groupId: f.groupId, threadId: f.root.id, requestId: "same", mode: "notify", content: "hello" });
    await expect(f.service.send({ groupId: other.group.groupId, threadId: otherRoot.id, requestId: "same", mode: "notify", content: "hello" })).rejects.toMatchObject({ code: "THREAD_REQUEST_CONFLICT" });
  });
  it("读取助手结果且不泄漏工具和审批原始内容", async function safeAnswerProjection() {
    const f = await setup();
    await f.ports.transcriptStore.append(f.root.id, { sessionId: f.root.id, turnId: "t", seq: 1, timestamp: "now", event: { type: "answer_delta", delta: "已完成检查" } } as never);
    await f.ports.transcriptStore.append(f.root.id, { sessionId: f.root.id, turnId: "t", seq: 2, timestamp: "now", event: { type: "tool_result", result: { secret: "private-tool-value" }, approval: "private-approval" } } as never);
    await f.ports.sessionStore.save({ ...f.root, presentation: { messages: [{ id: "assistant", role: "assistant", content: "最终结果", createdAt: 1, sources: [{ id: "secret", text: "raw", score: 1, metadata: { apiKey: "private-key" } }] }] } });
    const result = await f.service.readThread({ groupId: f.groupId, threadId: f.root.id });
    expect(result.latestMessages[0].content).toBe("最终结果");
    expect(JSON.stringify(result)).not.toContain("private-key");
    expect(result.history[0]).toMatchObject({ type: "answer_delta", content: "已完成检查" });
    expect(JSON.stringify(result)).not.toContain("private-tool-value");
    expect(JSON.stringify(result)).not.toContain("private-approval");
  });
  it("已接受消息在准入线以上仍可恢复并写入回执", async function reservedCompletionCapacity() {
    const f = await setup();
    let fail = true;
    const interrupted: ThreadStore = {
      verifyRequest: f.store.verifyRequest.bind(f.store), reserveRequest: f.store.reserveRequest.bind(f.store), withSessionLock: f.store.withSessionLock.bind(f.store), hasMembership: f.store.hasMembership.bind(f.store), listGroups: f.store.listGroups.bind(f.store),
      readControl: f.store.readControl.bind(f.store), compareAndSetControl: f.store.compareAndSetControl.bind(f.store),
      readMessage: f.store.readMessage.bind(f.store), readEvent: f.store.readEvent.bind(f.store), writeEvent: f.store.writeEvent.bind(f.store),
      async writeMessage(message) { if (fail) { fail = false; throw new Error("interrupted"); } return f.store.writeMessage(message); },
    };
    const service = createThreadService(f.ports, interrupted, f.context);
    const input = { groupId: f.groupId, threadId: f.root.id, requestId: "reserved", mode: "notify" as const, content: "message" };
    await expect(service.send(input)).rejects.toThrow("interrupted");
    const current = (await f.store.readControl(f.groupId))!;
    const padded = { ...current, revision: current.revision + 1, receipts: [...current.receipts, { actorKey: "pad", operation: "pad", requestId: "pad", payloadDigest: "pad", result: "x".repeat(3 * 1024 * 1024) }] };
    expect(await f.store.compareAndSetControl(f.groupId, current.revision, padded)).toBe(true);
    const receipt = await service.send(input);
    expect((await service.messageStatus({ groupId: f.groupId, threadId: f.root.id, messageId: receipt.messageId })).deliveryStatus).toBe("pending");
    expect((await f.store.readControl(f.groupId))?.messageIntents[0].committed).toBe(true);
  });
  it("创建登记与删除父 Session 竞争时删除不能越过成员门禁", async function creationDeletionRace() {
    const f = await setup();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(function wait(resolve) { release = resolve; });
    const started = new Promise<void>(function wait(resolve) { entered = resolve; });
    const original = f.ports.sessionStore.createIfAbsent.bind(f.ports.sessionStore);
    f.ports.sessionStore.createIfAbsent = async function delayedCreate(session) { entered(); await held; return original(session); };
    const creation = f.service.create({ groupId: f.groupId, parentThreadId: f.root.id, requestId: "race" });
    await started;
    const deletion = createSessionService(f.ports).delete(f.root.id);
    release();
    const created = await creation;
    await expect(deletion).rejects.toMatchObject({ code: "THREAD_HAS_PENDING_WORK" });
    expect(await f.ports.sessionStore.get(created.threadId)).not.toBeNull();
  });
  it("多个未完成创建均预留记账空间，拒绝后仍可逐一恢复", async function multiplePendingCapacity() {
    const f = await setup();
    const initial = (await f.store.readControl(f.groupId))!;
    const padded = { ...initial, revision: initial.revision + 1, receipts: [...initial.receipts, { actorKey: "pad", operation: "pad", requestId: "pad", payloadDigest: "pad", result: "x".repeat(3 * 1024 * 1024 - 75000) }] };
    expect(await f.store.compareAndSetControl(f.groupId, initial.revision, padded)).toBe(true);
    const original = f.ports.sessionStore.createIfAbsent.bind(f.ports.sessionStore);
    let interrupted = true;
    f.ports.sessionStore.createIfAbsent = async function failBeforeCreate(session) { if (interrupted) throw new Error("interrupted"); return original(session); };
    const accepted: string[] = [];
    let refused = false;
    for (let i = 0; i < 10; i++) {
      const requestId = `pending-${i}`;
      try { await f.service.create({ groupId: f.groupId, parentThreadId: f.root.id, requestId }); }
      catch (error) {
        if (error instanceof Error && error.message === "interrupted") accepted.push(requestId);
        else if (error instanceof Error && error.message === "THREAD_STORAGE_FULL") { refused = true; break; }
        else throw error;
      }
    }
    expect(accepted.length).toBeGreaterThan(1);
    expect(refused).toBe(true);
    interrupted = false;
    for (const requestId of accepted) await f.service.create({ groupId: f.groupId, parentThreadId: f.root.id, requestId });
    const final = (await f.store.readControl(f.groupId))!;
    expect(final.creates.filter(function completed(item) { return item.status === "created"; })).toHaveLength(accepted.length);
    expect(final.receipts.filter(function creation(item) { return item.operation === "create"; })).toHaveLength(accepted.length);
    expect(Buffer.byteLength(JSON.stringify(final), "utf8")).toBeLessThan(4 * 1024 * 1024);
  });
  it("预留 Session ID 遇到无关身份时持久标记需恢复", async function creationIdentityConflict() {
    const f = await setup();
    f.ports.sessionStore.createIfAbsent = async function collision(session) {
      await f.ports.sessionStore.save({ ...session, collaborationCreationId: "unrelated" });
      return false;
    };
    await expect(f.service.create({ groupId: f.groupId, parentThreadId: f.root.id, requestId: "collision" })).rejects.toMatchObject({ code: "THREAD_RECOVERY_REQUIRED" });
    const control = (await f.store.readControl(f.groupId))!;
    expect(control.creates[0].status).toBe("recovery_required");
    expect((await f.ports.sessionStore.get(control.creates[0].threadId))?.collaborationCreationId).toBe("unrelated");
  });
});
