/** Node 持久会话创建、消息回执及重启后的幂等验证。 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { initializeNodeStateRoot } from "../../src/node/state-root";
import { createNodeRuntimePorts } from "../../src/node/create-node-runtime-ports";
import { createSessionService } from "../../../core/src/runtime/application/session-service";
import type { ThreadStore } from "../../../core/src/runtime/ports/thread-store";
import { createThreadService } from "../../../core/src/runtime/application/thread-service";

/** 创建任务私有目录，禁止读写用户的真实状态根。 */
function fixture(): { workspace: string; state: string } {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/plan1101-01a196cc/fixtures/node-roots");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "durable-"));
  const workspace = path.join(root, "workspace"); const state = path.join(root, "state");
  fs.mkdirSync(workspace); initializeNodeStateRoot(state);
  return { workspace, state };
}

/** 以路径与内容计算隔离根的快照，用于验证读取没有写入。 */
function snapshot(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort(function order(a, b) { return a.name.localeCompare(b.name); });
  return entries.map(function entry(item) {
    const file = path.join(dir, item.name);
    return item.name + ":" + (item.isDirectory() ? snapshot(file) : createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  }).join("|");
}

describe("Node 协作恢复", function durableThread() {
  it("重建宿主后创建与消息请求保持相同身份和回执", async function restartAndRetry() {
    const f = fixture();
    const firstPorts = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const root = await createSessionService(firstPorts).create({ title: "root" });
    const context = { workspaceId: "w", stateRootId: "root-1", projectId: root.projectId!, actor: { kind: "human" as const, principalId: "user" }, allowedTools: ["read_file"], modelCatalog: [] };
    const first = createThreadService(firstPorts, firstPorts.threadStore, context);
    const group = await first.enable({ rootThreadId: root.id, requestId: "enable" });
    const create = { groupId: group.group.groupId, parentThreadId: root.id, requestId: "create" };
    const child = await first.create(create);
    const send = { groupId: group.group.groupId, threadId: child.threadId, requestId: "message", mode: "notify" as const, content: "hello" };
    const receipt = await first.send(send);
    const secondPorts = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const second = createThreadService(secondPorts, secondPorts.threadStore, context);
    expect(await second.create(create)).toEqual(child);
    expect(await second.send(send)).toEqual(receipt);
    expect((await second.messageStatus({ groupId: group.group.groupId, threadId: child.threadId, messageId: receipt.messageId })).deliveryStatus).toBe("pending");
    expect((await second.listMessages({ groupId: group.group.groupId, threadId: child.threadId })).items[0].content).toBe("hello");
    expect((await second.listEvents({ groupId: group.group.groupId })).items.map(function sequence(event) { return event.groupSeq; })).toEqual([1, 2, 3]);
    expect(await secondPorts.inputInbox.list({ sessionId: child.threadId })).toEqual([]);
    const before = snapshot(f.state);
    await second.readThread({ groupId: group.group.groupId, threadId: child.threadId });
    await second.readState(group.group.groupId);
    await second.listEvents({ groupId: group.group.groupId });
    expect(snapshot(f.state)).toBe(before);
    const otherRoot = await createSessionService(secondPorts).create({ title: "other" });
    const other = await second.enable({ rootThreadId: otherRoot.id, requestId: "enable-other" });
    const thirdPorts = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const third = createThreadService(thirdPorts, thirdPorts.threadStore, context);
    await expect(third.create({ groupId: other.group.groupId, parentThreadId: otherRoot.id, requestId: "create" })).rejects.toMatchObject({ code: "THREAD_REQUEST_CONFLICT" });
    await expect(third.send({ groupId: other.group.groupId, threadId: otherRoot.id, requestId: "message", mode: "notify", content: "hello" })).rejects.toMatchObject({ code: "THREAD_REQUEST_CONFLICT" });
  });
  it("两个 Node 宿主中成员创建与父会话删除按同一短锁竞争", async function nodeCreationDeletionRace() {
    const f = fixture();
    const first = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const second = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const root = await createSessionService(first).create({ title: "root" });
    const context = { workspaceId: "w", stateRootId: "root-2", projectId: root.projectId!, actor: { kind: "human" as const, principalId: "user" }, allowedTools: [], modelCatalog: [] };
    const threads = createThreadService(first, first.threadStore, context);
    const group = await threads.enable({ rootThreadId: root.id, requestId: "enable" });
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(function wait(resolve) { release = resolve; });
    const started = new Promise<void>(function wait(resolve) { entered = resolve; });
    const original = first.sessionStore.createIfAbsent.bind(first.sessionStore);
    first.sessionStore.createIfAbsent = async function delayed(session) { entered(); await held; return original(session); };
    const create = threads.create({ groupId: group.group.groupId, parentThreadId: root.id, requestId: "race" });
    await started;
    const deleteRoot = createSessionService(second).delete(root.id);
    release();
    const child = await create;
    await expect(deleteRoot).rejects.toMatchObject({ code: "THREAD_HAS_PENDING_WORK" });
    expect(await second.sessionStore.get(child.threadId)).not.toBeNull();
  });
  it("Session 和消息落盘后中断，重启按原请求补全回执", async function nodeInterruptedRecovery() {
    const f = fixture();
    const first = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const root = await createSessionService(first).create({ title: "root" });
    const context = { workspaceId: "w", stateRootId: "root-3", projectId: root.projectId!, actor: { kind: "human" as const, principalId: "user" }, allowedTools: [], modelCatalog: [] };
    const initial = createThreadService(first, first.threadStore, context);
    const group = await initial.enable({ rootThreadId: root.id, requestId: "enable" });
    let failCreate = true; let failMessage = true;
    const interrupted: ThreadStore = {
      ...first.threadStore,
      async compareAndSetControl(groupId, revision, value) {
        if (failCreate && value.creates.some(function completed(item) { return item.status === "created"; })) { failCreate = false; throw new Error("creation interruption"); }
        if (failMessage && value.messageIntents.some(function completed(item) { return item.committed; })) { failMessage = false; throw new Error("message interruption"); }
        return first.threadStore.compareAndSetControl(groupId, revision, value);
      },
    };
    const service = createThreadService(first, interrupted, context);
    const create = { groupId: group.group.groupId, parentThreadId: root.id, requestId: "create" };
    await expect(service.create(create)).rejects.toThrow("creation interruption");
    const before = (await first.threadStore.readControl(group.group.groupId))!.creates[0];
    const resumedPorts = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const resumed = createThreadService(resumedPorts, resumedPorts.threadStore, context);
    const child = await resumed.create(create);
    expect(child.threadId).toBe(before.threadId);
    const send = { groupId: group.group.groupId, threadId: child.threadId, requestId: "send", mode: "notify" as const, content: "hello" };
    await expect(service.send(send)).rejects.toThrow("message interruption");
    const pending = (await first.threadStore.readControl(group.group.groupId))!.messageIntents[0].message;
    const receipt = await resumed.send(send);
    expect(receipt.messageId).toBe(pending.messageId);
    expect((await resumed.listMessages({ groupId: group.group.groupId, threadId: child.threadId })).items).toHaveLength(1);
  });
  it("Node 多个已接收创建在预留容量下重启后可完成记账", async function nodePendingCapacity() {
    const f = fixture();
    const first = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const root = await createSessionService(first).create({ title: "root" });
    const context = { workspaceId: "w", stateRootId: "root-4", projectId: root.projectId!, actor: { kind: "human" as const, principalId: "user" }, allowedTools: [], modelCatalog: [] };
    const threads = createThreadService(first, first.threadStore, context);
    const group = await threads.enable({ rootThreadId: root.id, requestId: "enable" });
    const initial = (await first.threadStore.readControl(group.group.groupId))!;
    const padded = { ...initial, revision: initial.revision + 1, receipts: [...initial.receipts, { actorKey: "pad", operation: "pad", requestId: "pad", payloadDigest: "pad", result: "x".repeat(3 * 1024 * 1024 - 75000) }] };
    expect(await first.threadStore.compareAndSetControl(group.group.groupId, initial.revision, padded)).toBe(true);
    first.sessionStore.createIfAbsent = async function interrupted() { throw new Error("interrupted"); };
    const accepted: string[] = []; let refused = false;
    for (let i = 0; i < 10; i++) {
      const requestId = `pending-${i}`;
      try { await threads.create({ groupId: group.group.groupId, parentThreadId: root.id, requestId }); }
      catch (error) {
        if (error instanceof Error && error.message === "interrupted") accepted.push(requestId);
        else if (error instanceof Error && error.message === "THREAD_STORAGE_FULL") { refused = true; break; }
        else throw error;
      }
    }
    expect(accepted.length).toBeGreaterThan(1); expect(refused).toBe(true);
    const next = createNodeRuntimePorts({ stateRoot: f.state, workspaceRoot: f.workspace });
    const resumed = createThreadService(next, next.threadStore, context);
    for (const requestId of accepted) await resumed.create({ groupId: group.group.groupId, parentThreadId: root.id, requestId });
    const final = (await next.threadStore.readControl(group.group.groupId))!;
    expect(final.creates.filter(function completed(item) { return item.status === "created"; })).toHaveLength(accepted.length);
    expect(final.receipts.filter(function creation(item) { return item.operation === "create"; })).toHaveLength(accepted.length);
  }, 30000);
});
