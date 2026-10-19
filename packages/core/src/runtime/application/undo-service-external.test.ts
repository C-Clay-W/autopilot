/**
 * Undo 外部目标解析测试（Talk-Plan1013 Stage 2）：
 * WAL 中 `ext:<canonicalTarget>` 记录还原真实路径；伪造内部 ext: 记录 fail-safe 拒绝。
 * Talk-Plan1013 Stage5 R6：链接替换后 canonical 身份失配按 UNDO_CONFLICT；恢复写入前
 * deny/ask 收紧即停止；缺投影器与普通外部 Undo 不回归。
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFileMutationTarget, createUndoService } from "./undo-service";
import { createMemoryPorts } from "../adapters/memory";
import type { ExternalPermissionProjector } from "../ports";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 最小投影器替身：只返回固定 allow/deny/ask 规则集合，project 为 no-op。 */
function createUndoProjector(rules: { allow?: string[]; deny?: string[]; ask?: string[] }): ExternalPermissionProjector {
  const allow = rules.allow ?? [];
  const deny = rules.deny ?? [];
  const ask = rules.ask ?? [];
  return {
    async project() { /* 恢复路径不写投影 */ },
    async read() { return { allow: [...allow], deny: [...deny], ask: [...ask] }; },
  };
}

describe("resolveFileMutationTarget（外部 WAL 目标）", () => {
  it("工作区相对路径沿用内部围栏解析", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "undo-ext-"));
    temporaryRoots.push(base);
    const workspaceRoot = path.join(base, "ws");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "note.txt"), "x", "utf8");
    const target = await resolveFileMutationTarget(workspaceRoot, "note.txt");
    expect(target.exists).toBe(true);
    expect(target.absolutePath.toLowerCase()).toBe(path.join(workspaceRoot, "note.txt").toLowerCase());
  });

  it("ext: 外部目标还原 canonical 绝对路径并报告存在性", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "undo-ext-"));
    temporaryRoots.push(base);
    const workspaceRoot = path.join(base, "ws");
    const outsideRoot = path.join(base, "outside");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    const outsideFile = path.join(outsideRoot, "memo.txt");
    await writeFile(outsideFile, "x", "utf8");
    const target = await resolveFileMutationTarget(workspaceRoot, `ext:${outsideFile}`);
    expect(target.exists).toBe(true);
    expect(target.absolutePath.toLowerCase()).toBe(outsideFile.toLowerCase());
    const missing = await resolveFileMutationTarget(workspaceRoot, `ext:${path.join(outsideRoot, "gone.txt")}`);
    expect(missing.exists).toBe(false);
  });

  it("ext: 伪造内部路径 fail-safe 拒绝（UNDO_CONFLICT）", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "undo-ext-"));
    temporaryRoots.push(base);
    const workspaceRoot = path.join(base, "ws");
    await mkdir(workspaceRoot, { recursive: true });
    await expect(resolveFileMutationTarget(workspaceRoot, `ext:${path.join(workspaceRoot, "note.txt")}`)).rejects.toThrow("UNDO_CONFLICT");
  });

  it("Talk-Plan1013 Stage5 R6：ext: 目标父链接被替换到其他目录后 canonical 身份失配 → UNDO_CONFLICT", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "undo-ext-r6-"));
    temporaryRoots.push(base);
    const workspaceRoot = path.join(base, "ws");
    const dirA = path.join(base, "A");
    const dirB = path.join(base, "B");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = path.join(dirA, "f.txt");
    const fileB = path.join(dirB, "f.txt");
    // B/f 放置与 WAL afterSha 相同的字节：SHA 校验无法区分，只有 canonical 身份比较能发现转移。
    await writeFile(fileA, "same-bytes", "utf8");
    await writeFile(fileB, "same-bytes", "utf8");
    // 基线：未替换时共享预检还原同一 canonical 身份，正常返回。
    const before = await resolveFileMutationTarget(workspaceRoot, `ext:${fileA}`);
    expect(before.exists).toBe(true);
    expect(before.absolutePath.toLowerCase()).toBe(fileA.toLowerCase());
    // 父链接替换：A 目录改为指向 B 的 junction。
    await rm(dirA, { recursive: true, force: true });
    await symlink(dirB, dirA, "junction");
    await expect(resolveFileMutationTarget(workspaceRoot, `ext:${fileA}`)).rejects.toThrow("UNDO_CONFLICT");
  });

  it("Talk-Plan1013 Stage5 R6：外部恢复写入前 deny/ask 收紧即 UNDO_CONFLICT 停止，目标零变化", async () => {
    for (const restriction of ["deny", "ask"] as const) {
      const base = await mkdtemp(path.join(os.tmpdir(), "undo-ext-r6-gate-"));
      temporaryRoots.push(base);
      const workspaceRoot = path.join(base, "ws");
      const outsideRoot = path.join(base, "outside");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      const targetFile = path.join(outsideRoot, "gated.txt");
      const before = Buffer.from("before-bytes", "utf8");
      const after = Buffer.from("after-bytes", "utf8");
      await writeFile(targetFile, after);
      const ports = { ...createMemoryPorts(workspaceRoot), externalPermissionProjector: createUndoProjector({ [restriction]: [`Write(${targetFile})`] }) };
      await ports.sessionStore.save({ id: "s-r6", status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: "t-r6" });
      await ports.turnStore.save({ id: "t-r6", sessionId: "s-r6", status: "completed", startedAt: 1, completedAt: 2, schemaVersion: 1, frozenRunConfig: { workspaceRoot, workspaceTrusted: true, permissionMode: "ask" } });
      const mutation = await ports.fileMutationStore.prepare({ sessionId: "s-r6", turnId: "t-r6", toolCallId: "call-r6", path: `ext:${targetFile}`, operation: "overwrite", before, after, createdAt: 10 });
      mutation.status = "applied";
      await ports.fileMutationStore.save(mutation);
      const undo = createUndoService(ports);
      // 身份与 SHA 均正常，preview 可用；收紧只发生在写入门。
      await expect(undo.preview({ sessionId: "s-r6" })).resolves.toMatchObject({ status: "available" });
      const result = await undo.execute({ sessionId: "s-r6", confirmed: true });
      expect(result.status).toBe("failed");
      expect(result.conflicts).toEqual([`ext:${targetFile}`]);
      // 被禁目标零变化：恢复未写入，自动补偿也未写入。
      expect(await readFile(targetFile, "utf8")).toBe("after-bytes");
    }
  });

  it("Talk-Plan1013 Stage5 R6：缺投影器时外部 Undo 不阻断，正常恢复 before（不回归）", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "undo-ext-r6-ok-"));
    temporaryRoots.push(base);
    const workspaceRoot = path.join(base, "ws");
    const outsideRoot = path.join(base, "outside");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    const targetFile = path.join(outsideRoot, "restored.txt");
    const before = Buffer.from("before-bytes", "utf8");
    const after = Buffer.from("after-bytes", "utf8");
    await writeFile(targetFile, after);
    const ports = createMemoryPorts(workspaceRoot);
    await ports.sessionStore.save({ id: "s-r6-ok", status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: "t-r6-ok" });
    await ports.turnStore.save({ id: "t-r6-ok", sessionId: "s-r6-ok", status: "completed", startedAt: 1, completedAt: 2, schemaVersion: 1, frozenRunConfig: { workspaceRoot, workspaceTrusted: true, permissionMode: "ask" } });
    const mutation = await ports.fileMutationStore.prepare({ sessionId: "s-r6-ok", turnId: "t-r6-ok", toolCallId: "call-r6-ok", path: `ext:${targetFile}`, operation: "overwrite", before, after, createdAt: 10 });
    mutation.status = "applied";
    await ports.fileMutationStore.save(mutation);
    const undo = createUndoService(ports);
    await expect(undo.preview({ sessionId: "s-r6-ok" })).resolves.toMatchObject({ status: "available" });
    await expect(undo.execute({ sessionId: "s-r6-ok", confirmed: true })).resolves.toMatchObject({ status: "completed", restoredPaths: [`ext:${targetFile}`] });
    expect(await readFile(targetFile, "utf8")).toBe("before-bytes");
  });
});
