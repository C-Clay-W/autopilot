/** UndoService 回归：验证显式 preview/confirm、SHA fail-closed 与 create 回滚不覆盖后续人工修改。 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime } from "../public";
import { createMemoryPorts } from "../adapters/memory";

const temporaryRoots: string[] = [];

/** 创建独立工作区，避免 Undo 测试接触真实仓库。 */
async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "autopilot-undo-"));
  temporaryRoots.push(root);
  return root;
}

/** 为测试持久化一个已完成、已 Trust 的 Turn。 */
async function createUndoFixture(root: string) {
  const ports = createMemoryPorts(root);
  const runtime = createAgentRuntime({ ports });
  const session = await runtime.sessions.create({ persistenceMode: "durable" });
  await ports.turnStore.save({
    id: "turn-1", sessionId: session.id, status: "completed", startedAt: 1, completedAt: 2, schemaVersion: 1,
    frozenRunConfig: { workspaceRoot: root, workspaceTrusted: true, permissionMode: "ask" },
  });
  return { ports, runtime, session };
}

afterEach(async function cleanTemporaryWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map(async function removeWorkspace(root) { await rm(root, { recursive: true, force: true }); }));
});

describe("UndoService", function suite() {
  it("只在显式确认后撤销最近 create，并把原 mutation 标记为已撤销", async function rollsBackCreate() {
    const root = await createWorkspace();
    const { ports, runtime, session } = await createUndoFixture(root);
    const target = path.join(root, "created.txt");
    const after = Buffer.from("created", "utf8");
    await writeFile(target, after);
    const mutation = await ports.fileMutationStore.prepare({ sessionId: session.id, turnId: "turn-1", toolCallId: "call-1", path: "created.txt", operation: "create", before: null, after, createdAt: 10 });
    mutation.status = "applied";
    await ports.fileMutationStore.save(mutation);

    await expect(runtime.undo.preview({ sessionId: session.id })).resolves.toMatchObject({ status: "available", turnId: "turn-1", files: [{ path: "created.txt", operation: "create" }] });
    await expect(runtime.undo.execute({ sessionId: session.id, confirmed: true })).resolves.toMatchObject({ status: "completed", restoredPaths: ["created.txt"] });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ports.fileMutationStore.listBySession(session.id)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: mutation.id, undoneBy: expect.any(String) })]));
  });

  it("检测到后续人工修改时 fail closed，绝不覆盖目标文件", async function rejectsHumanChange() {
    const root = await createWorkspace();
    const { ports, runtime, session } = await createUndoFixture(root);
    const target = path.join(root, "edited.txt");
    const before = Buffer.from("before", "utf8");
    const after = Buffer.from("agent-after", "utf8");
    await writeFile(target, after);
    const mutation = await ports.fileMutationStore.prepare({ sessionId: session.id, turnId: "turn-1", toolCallId: "call-1", path: "edited.txt", operation: "edit", before, after, createdAt: 10 });
    mutation.status = "applied";
    await ports.fileMutationStore.save(mutation);
    await writeFile(target, "human-after", "utf8");

    await expect(runtime.undo.preview({ sessionId: session.id })).resolves.toMatchObject({ status: "unavailable", reason: "UNDO_CONFLICT" });
    await expect(runtime.undo.execute({ sessionId: session.id, confirmed: true })).rejects.toMatchObject({ code: "RUNTIME_ERROR" });
    await expect(readFile(target, "utf8")).resolves.toBe("human-after");
  });

  it("同一 Turn 多次修改同一路径时按逆序 mutation 链回滚", async function rollsBackSamePathMutationChain() {
    const root = await createWorkspace();
    const { ports, runtime, session } = await createUndoFixture(root);
    const target = path.join(root, "chain.txt");
    const first = Buffer.from("first", "utf8");
    const second = Buffer.from("second", "utf8");
    await writeFile(target, second);
    const firstMutation = await ports.fileMutationStore.prepare({ sessionId: session.id, turnId: "turn-1", toolCallId: "call-1", path: "chain.txt", operation: "edit", before: Buffer.from("before", "utf8"), after: first, createdAt: 10 });
    firstMutation.status = "applied";
    await ports.fileMutationStore.save(firstMutation);
    const secondMutation = await ports.fileMutationStore.prepare({ sessionId: session.id, turnId: "turn-1", toolCallId: "call-2", path: "chain.txt", operation: "edit", before: first, after: second, createdAt: 11 });
    secondMutation.status = "applied";
    await ports.fileMutationStore.save(secondMutation);

    await expect(runtime.undo.preview({ sessionId: session.id })).resolves.toMatchObject({ status: "available", turnId: "turn-1" });
    await expect(runtime.undo.execute({ sessionId: session.id, confirmed: true })).resolves.toMatchObject({ status: "completed" });
    await expect(readFile(target, "utf8")).resolves.toBe("before");
  });

  it("收敛隔离区中断事务并允许用户重新执行 Undo", async function reconcilesIsolatedTransaction() {
    const root = await createWorkspace();
    const { ports, runtime, session } = await createUndoFixture(root);
    const target = path.join(root, "interrupted.txt");
    const before = Buffer.from("before", "utf8");
    const after = Buffer.from("after", "utf8");
    const mutation = await ports.fileMutationStore.prepare({ sessionId: session.id, turnId: "turn-1", toolCallId: "call-1", path: "interrupted.txt", operation: "edit", before, after, createdAt: 10 });
    mutation.status = "applied";
    await ports.fileMutationStore.save(mutation);
    const isolationName = ".interrupted.txt.undo-interrupted.0.isolation";
    await writeFile(path.join(root, isolationName), after);
    await ports.fileMutationStore.saveUndoTransaction({
      id: "undo-interrupted", sessionId: session.id, turnId: "turn-1", workspaceRoot: root, status: "applying", createdAt: 20, updatedAt: 20,
      files: [{ mutationId: mutation.id, path: "interrupted.txt", status: "isolated", isolationName }],
    });

    await expect(runtime.undo.preview({ sessionId: session.id })).resolves.toMatchObject({ status: "available", turnId: "turn-1" });
    await expect(readFile(target, "utf8")).resolves.toBe("after");
    await expect(ports.fileMutationStore.listUndoTransactions(session.id)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "undo-interrupted", status: "failed", files: [expect.objectContaining({ status: "compensated" })] })]));
  });

  it("二进制或超限快照均不可撤销，且不会进入 Undo 候选", async function rejectsBinaryAndOversizedSnapshots() {
    const root = await createWorkspace();
    const { ports, runtime, session } = await createUndoFixture(root);
    const binary = await ports.fileMutationStore.prepare({ sessionId: session.id, turnId: "turn-1", toolCallId: "binary", path: "image.bin", operation: "create", before: null, after: Buffer.from([0, 1, 2]), createdAt: 10 });
    binary.status = "applied";
    await ports.fileMutationStore.save(binary);
    expect(binary).toMatchObject({ reversible: false, nonReversibleReason: "BINARY_FILE" });
    await expect(runtime.undo.preview({ sessionId: session.id })).resolves.toMatchObject({ status: "unavailable", reason: "UNDO_NON_REVERSIBLE" });

    const oversized = await ports.fileMutationStore.prepare({ sessionId: session.id, turnId: "turn-2", toolCallId: "oversized", path: "large.txt", operation: "create", before: null, after: Buffer.alloc(512 * 1024 + 1, 1), createdAt: 11 });
    expect(oversized).toMatchObject({ reversible: false, nonReversibleReason: "FILE_SIZE_LIMIT" });
  });
});
