/** R4 回归：隔离 OS 用户锁域，验证不同 workspace/stateRoot 对同文件的提交与 Undo 串行。 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile, unlink, stat } from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import { createNodeFileMutationStore } from "../../src/node/stores/node-file-mutation-store";
import { createNodeHostMutationProtection } from "../../src/node/host-mutation-protection";
import { getNodeFileMutationLockRoot } from "../../src/node/file-mutation-locks";
import { createWriteFileTool } from "../../../core/src/internal/tools/builtins/write-file-tool";
import { createEditFileTool } from "../../../core/src/internal/tools/builtins/edit-file-tool";
import { createMemoryPorts } from "../../../core/src/runtime/adapters/memory";
import { createUndoService } from "../../../core/src/runtime/application/undo-service";
import type { ToolExecutionContext } from "../../../core/src/internal/tools/types";

const artifacts = path.resolve("../../.agent-tests/work-test/external-workspace-permissions/runs/p1fix-r005-controller");

/** 构造显式屏障，在第一次提交已经读取 before 后让第二次提交进入竞争。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(function setResolve(callback) { resolve = callback; });
  return { promise, resolve };
}

/** 所有数据和模拟用户目录均留在任务产物目录，不写真实用户 home。 */
async function fixture() {
  await mkdir(artifacts, { recursive: true });
  const base = await mkdtemp(path.join(artifacts, "r4-"));
  const home = path.join(base, "home");
  const workspaces = [path.join(base, "w1"), path.join(base, "w2")];
  await Promise.all([home, ...workspaces].map(function create(directory) { return mkdir(directory, { recursive: true }); }));
  const mock = vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  const stores = workspaces.map(function store(_, index) { return createNodeFileMutationStore({ stateRoot: path.join(base, `state${index}`) }); });
  const target = path.join(await realpath(base), "shared.txt");
  /** 构造执行层已批准绑定；本文件只验证锁，不冒充人类审批来源验收。 */
  function context(index: number, operation: string): ToolExecutionContext {
    return { workspaceRoot: workspaces[index], workspaceTrusted: true, permissionMode: "full_access", toolCallId: `c${index}`, fileMutations: { store: stores[index]!, sessionId: `s${index}`, turnId: `t${index}` }, fileMutationAuthorization: { canonicalTarget: target, canonicalWorkspace: workspaces[index]!, operation, constraint: `ext-file:${target}` } } as ToolExecutionContext;
  }
  return { base, target, workspaces, stores, mock, context };
}

describe("R4 shared target locks", function suite() {
  it("负向对照：只保留旧 workspace 锁会让两个 create 都提交", async function reproducesOldLockDomain() {
    const f = await fixture();
    try {
      for (const store of f.stores) {
        const lock = store.withWorkspaceLock.bind(store);
        store.withWorkspaceLock = function workspaceOnly(workspace, operation) { return lock(workspace, operation); };
      }
      const entered = deferred(); const release = deferred();
      const prepare = f.stores[0]!.prepare.bind(f.stores[0]);
      f.stores[0]!.prepare = async function holdAfterRead(input) { entered.resolve(); await release.promise; return prepare(input); };
      const tool = createWriteFileTool();
      const first = tool.execute({ path: f.target, content: "first" }, f.context(0, "create"));
      await entered.promise;
      try { await tool.execute({ path: f.target, content: "second" }, f.context(1, "create")); }
      finally { release.resolve(); }
      await first;
      expect(await readFile(f.target, "utf8")).toBe("first");
      expect((await f.stores[0]!.listBySession("s0"))[0]?.status).toBe("applied");
      expect((await f.stores[1]!.listBySession("s1"))[0]?.status).toBe("applied");
    } finally { f.mock.mockRestore(); }
  });
  for (const operation of ["create", "overwrite"] as const) {
    it(`${operation}: 两个 stateRoot 最多一个提交，另一 FILE_STALE`, async function competingWrites() {
      const f = await fixture();
      try {
        if (operation === "overwrite") await writeFile(f.target, "before");
        const entered = deferred();
        const release = deferred();
        const prepare = f.stores[0]!.prepare.bind(f.stores[0]);
        f.stores[0]!.prepare = async function holdAfterRead(input) { entered.resolve(); await release.promise; return prepare(input); };
        const tool = createWriteFileTool();
        const expectedSha256 = operation === "overwrite" ? createHash("sha256").update("before").digest("hex") : undefined;
        const first = tool.execute({ path: f.target, content: "first", expectedSha256 }, f.context(0, operation));
        await entered.promise;
        const second = tool.execute({ path: f.target, content: "second", expectedSha256 }, f.context(1, operation));
        // 旧 workspace-only 锁会允许第二次基于相同 before 完成；新锁只能等待。
        await Promise.race([second.catch(function failed() {}), new Promise(function wait(resolve) { setTimeout(resolve, 100); })]);
        release.resolve();
        const outcomes = await Promise.allSettled([first, second]);
        expect(outcomes[0].status).toBe("fulfilled");
        expect(outcomes[1].status).toBe("rejected");
        if (outcomes[1].status === "rejected") expect(outcomes[1].reason.toolError?.code).toBe("FILE_STALE");
        expect(await readFile(f.target, "utf8")).toBe("first");
      } finally { f.mock.mockRestore(); }
    });
  }

  it("edit 与 write 共用目标锁，等待后的旧 SHA 不可覆盖", async function editAgainstWrite() {
    const f = await fixture();
    try {
      await writeFile(f.target, "before\n");
      const hash = createHash("sha256").update("before\n").digest("hex");
      const entered = deferred(); const release = deferred();
      const prepare = f.stores[0]!.prepare.bind(f.stores[0]);
      f.stores[0]!.prepare = async function hold(input) { entered.resolve(); await release.promise; return prepare(input); };
      const first = createWriteFileTool().execute({ path: f.target, content: "first\n", expectedSha256: hash }, f.context(0, "overwrite"));
      await entered.promise;
      const context = f.context(1, "edit");
      context.fileReadStates = new Map([[`ext:${f.target}`, { sha256: hash, mtimeMs: (await stat(f.target)).mtimeMs, observedRanges: [{ startLine: 1, endLine: 2 }] }]]);
      const second = createEditFileTool().execute({ path: f.target, oldString: "before", newString: "second", replaceAll: false }, context);
      await Promise.race([second.catch(function failed() {}), new Promise(function wait(resolve) { setTimeout(resolve, 100); })]);
      release.resolve();
      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes[0].status).toBe("fulfilled");
      expect(outcomes[1].status).toBe("rejected");
      if (outcomes[1].status === "rejected") expect(outcomes[1].reason.toolError?.code).toBe("FILE_STALE");
      expect(await readFile(f.target, "utf8")).toBe("first\n");
    } finally { f.mock.mockRestore(); }
  });

  it("Undo 与其他 workspace 写入共用锁，恢复后旧 SHA 写入停止", async function undoAgainstWrite() {
    const f = await fixture();
    try {
      await writeFile(f.target, "after");
      const ports = createMemoryPorts(f.workspaces[0]!);
      ports.fileMutationStore = f.stores[0]!;
      await ports.sessionStore.save({ id: "s0", status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1 });
      await ports.turnStore.save({ id: "t0", sessionId: "s0", status: "completed", startedAt: 1, completedAt: 2, schemaVersion: 1, frozenRunConfig: { workspaceRoot: f.workspaces[0], workspaceTrusted: true, permissionMode: "ask" } });
      const mutation = await f.stores[0]!.prepare({ sessionId: "s0", turnId: "t0", toolCallId: "original", path: `ext:${f.target}`, operation: "overwrite", before: Buffer.from("before"), after: Buffer.from("after"), createdAt: 10 });
      mutation.status = "applied"; await f.stores[0]!.save(mutation);
      const entered = deferred(); const release = deferred();
      const save = f.stores[0]!.saveUndoTransaction.bind(f.stores[0]);
      f.stores[0]!.saveUndoTransaction = async function hold(transaction) { if (transaction.status === "prepared") { entered.resolve(); await release.promise; } return save(transaction); };
      const undo = createUndoService(ports).execute({ sessionId: "s0", confirmed: true });
      await entered.promise;
      const hash = createHash("sha256").update("after").digest("hex");
      const write = createWriteFileTool().execute({ path: f.target, content: "second", expectedSha256: hash }, f.context(1, "overwrite"));
      await Promise.race([write.catch(function failed() {}), new Promise(function wait(resolve) { setTimeout(resolve, 100); })]);
      release.resolve();
      const outcomes = await Promise.allSettled([undo, write]);
      expect(outcomes[0].status).toBe("fulfilled");
      if (outcomes[0].status === "fulfilled") expect(outcomes[0].value.status).toBe("completed");
      expect(outcomes[1].status).toBe("rejected");
      if (outcomes[1].status === "rejected") expect(outcomes[1].reason.toolError?.code).toBe("FILE_STALE");
      expect(await readFile(f.target, "utf8")).toBe("before");
    } finally { f.mock.mockRestore(); }
  });

  it("共同锁目录属于宿主保护域，目标锁排序/去重并在异常后释放", async function lockContract() {
    const f = await fixture();
    try {
      const protection = createNodeHostMutationProtection({ stateRoot: path.join(f.base, "state0"), workspaceRoot: f.workspaces[0] });
      expect((await protection.getProtectedTargets(f.workspaces[0]!)).some(function commonRoot(target) { return target.path === getNodeFileMutationLockRoot() && target.scope === "directory"; })).toBe(true);
      const other = path.join(f.base, "other.txt");
      await expect(f.stores[0]!.withWorkspaceLock(f.workspaces[0]!, async function fail() { throw new Error("fixture-failure"); }, [f.target, other, f.target])).rejects.toThrow("fixture-failure");
      await expect(f.stores[1]!.withWorkspaceLock(f.workspaces[1]!, async function retry() { return "released"; }, [other, f.target])).resolves.toBe("released");
    } finally { f.mock.mockRestore(); }
  });

  it("年龄超过 60 秒的活 owner 不被目标锁抢占", async function keepsLiveOwner() {
    const f = await fixture();
    try {
      const lockRoot = getNodeFileMutationLockRoot();
      await mkdir(lockRoot, { recursive: true });
      const normalized = path.normalize(f.target);
      const id = createHash("sha256").update(process.platform === "win32" ? normalized.toLowerCase() : normalized).digest("hex");
      const lockPath = path.join(lockRoot, `${id}.target.lock`);
      await writeFile(lockPath, JSON.stringify({ ownerId: "live-fixture", pid: process.pid, createdAt: Date.now() - 120_000 }));
      let entered = false;
      const pending = f.stores[0]!.withWorkspaceLock(f.workspaces[0]!, async function acquired() { entered = true; }, [f.target]);
      await new Promise(function wait(resolve) { setTimeout(resolve, 100); });
      const original = await readFile(lockPath, "utf8");
      const wasEntered = entered;
      // 显式释放本测试创建的锁；不触及真实用户状态或其他 owner。
      await unlink(lockPath);
      await pending;
      expect(wasEntered).toBe(false);
      expect(JSON.parse(original).ownerId).toBe("live-fixture");
    } finally { f.mock.mockRestore(); }
  });
});
