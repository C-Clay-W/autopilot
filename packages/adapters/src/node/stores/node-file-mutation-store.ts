/** Node FileMutationStore：私有 WAL、content-addressed blob 与跨 canonical 文件工具的 workspace 锁。 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FileMutation, FileMutationStore, PrepareFileMutationInput, UndoTransaction } from "@autopilot-agent/core";
import { atomicReplace, safeFilePath, withFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";
import { withNodeFileMutationLocks } from "../file-mutation-locks";

const MAX_FILE_SNAPSHOT_BYTES = 512 * 1024;
const MAX_SESSION_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/** 计算 content-addressed blob ref；ref 只含 hash，不泄露原路径或正文。 */
function sha256(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }

/** 将 blob 原子写入同目录并 fsync，已有同 hash 内容直接复用。 */
function writeBlob(blobPath: string, content: Buffer): void {
  if (fs.existsSync(blobPath)) return;
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  const temporary = `${blobPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, "wx");
    try { fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try { fs.renameSync(temporary, blobPath); } catch (error) {
      if (!fs.existsSync(blobPath)) throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** 创建共享 stateRoot 下的 FileMutationStore；所有公开结果只允许消费 mutation 元数据。 */
export function createNodeFileMutationStore(options: NodeStoreOptions): FileMutationStore {
  const paths = getNodeStatePaths(options.stateRoot);
  /** 确保目录已处于当前 schema。 */
  function ensureDir(): void {
    const state = ensureNodeStateRoot(paths.root);
    fs.mkdirSync(state.mutationsDir, { recursive: true });
    fs.mkdirSync(state.mutationBlobsDir, { recursive: true });
    fs.mkdirSync(state.mutationLocksDir, { recursive: true });
    fs.mkdirSync(state.undoTransactionsDir, { recursive: true });
  }
  /** 返回 mutation 的安全独立 JSON 文件。 */
  function mutationPath(id: string): string { return safeFilePath(paths.mutationsDir, id, ".json"); }
  /** 返回 transaction journal 的安全路径。 */
  function transactionPath(id: string): string { return safeFilePath(paths.undoTransactionsDir, id, ".json"); }
  /** blob ref 只允许完整小写 SHA-256，避免 stateRoot 路径逃逸。 */
  function blobPath(ref: string): string {
    if (!/^[a-f0-9]{64}$/u.test(ref)) throw new Error("mutation blob ref 非法");
    return safeFilePath(paths.mutationBlobsDir, ref, ".blob");
  }
  /** 读取有效 mutation；损坏记录不作为 Undo 候选，保持 fail closed。 */
  function readAll(): FileMutation[] {
    ensureDir();
    return fs.readdirSync(paths.mutationsDir).filter((entry) => entry.endsWith(".json")).flatMap((entry) => {
      try { return [JSON.parse(fs.readFileSync(mutationPath(entry.slice(0, -5)), "utf8")) as FileMutation]; } catch { return []; }
    });
  }
  /** 读取未损坏 journal；损坏 journal 不允许被自动恢复。 */
  function readTransactions(): UndoTransaction[] {
    ensureDir();
    return fs.readdirSync(paths.undoTransactionsDir).filter((entry) => entry.endsWith(".json")).flatMap((entry) => {
      try { return [JSON.parse(fs.readFileSync(transactionPath(entry.slice(0, -5)), "utf8")) as UndoTransaction]; } catch { return []; }
    });
  }
  /** 计算 Session 已占用的去重 blob 字节，保证总量不能被同 hash 重复计算绕开。 */
  function sessionBlobBytes(sessionId: string): number {
    const refs = new Set(readAll().filter((item) => item.sessionId === sessionId).flatMap((item) => [item.beforeRef, item.afterRef]).filter((ref): ref is string => Boolean(ref)));
    return [...refs].reduce((total, ref) => total + (fs.statSync(blobPath(ref), { throwIfNoEntry: false })?.size ?? 0), 0);
  }
  return {
    async prepare(input: PrepareFileMutationInput): Promise<FileMutation> {
      ensureDir();
      const beforeRef = input.before ? sha256(input.before) : undefined;
      const afterRef = input.after ? sha256(input.after) : undefined;
      const refs = new Map<string, Buffer>();
      if (input.before) refs.set(beforeRef!, input.before);
      if (input.after) refs.set(afterRef!, input.after);
      const additionalBytes = [...refs.entries()].filter(([ref]) => !fs.existsSync(blobPath(ref))).reduce((total, [, content]) => total + content.byteLength, 0);
      const byteCount = (input.before?.byteLength ?? 0) + (input.after?.byteLength ?? 0);
      const binary = Boolean(input.before?.includes(0) || input.after?.includes(0));
      const reversible = !binary && byteCount <= MAX_FILE_SNAPSHOT_BYTES && sessionBlobBytes(input.sessionId) + additionalBytes <= MAX_SESSION_SNAPSHOT_BYTES;
      if (reversible) for (const [ref, content] of refs) writeBlob(blobPath(ref), content);
      const mutation: FileMutation = {
        id: randomUUID(), sessionId: input.sessionId, turnId: input.turnId, toolCallId: input.toolCallId,
        path: input.path, operation: input.operation, beforeSha: input.before ? sha256(input.before) : null, afterSha: input.after ? sha256(input.after) : null,
        beforeRef: reversible ? beforeRef : undefined, afterRef: reversible ? afterRef : undefined,
        status: "prepared", reversible, nonReversibleReason: reversible ? undefined : (binary ? "BINARY_FILE" : byteCount > MAX_FILE_SNAPSHOT_BYTES ? "FILE_SIZE_LIMIT" : "SESSION_SIZE_LIMIT"), createdAt: input.createdAt,
      };
      atomicReplace(mutationPath(mutation.id), JSON.stringify(mutation, null, 2));
      return structuredClone(mutation);
    },
    async save(mutation: FileMutation): Promise<void> { ensureDir(); await withFileLock(mutationPath(mutation.id), () => atomicReplace(mutationPath(mutation.id), JSON.stringify(mutation, null, 2))); },
    async getBlob(ref: string): Promise<Buffer | null> {
      ensureDir();
      try {
        const content = fs.readFileSync(blobPath(ref));
        return sha256(content) === ref ? content : null;
      } catch { return null; }
    },
    async listBySession(sessionId: string): Promise<FileMutation[]> { return readAll().filter((item) => item.sessionId === sessionId).map((item) => structuredClone(item)); },
    async saveUndoTransaction(transaction: UndoTransaction): Promise<void> { ensureDir(); await withFileLock(transactionPath(transaction.id), () => atomicReplace(transactionPath(transaction.id), JSON.stringify(transaction, null, 2))); },
    async listUndoTransactions(sessionId: string): Promise<UndoTransaction[]> { return readTransactions().filter((item) => item.sessionId === sessionId).map((item) => structuredClone(item)); },
    async deleteBySession(sessionId: string): Promise<void> {
      ensureDir();
      for (const mutation of readAll().filter((item) => item.sessionId === sessionId)) fs.rmSync(mutationPath(mutation.id), { force: true });
      for (const transaction of readTransactions().filter((item) => item.sessionId === sessionId)) fs.rmSync(transactionPath(transaction.id), { force: true });
      const referenced = new Set(readAll().flatMap((item) => [item.beforeRef, item.afterRef]).filter((ref): ref is string => Boolean(ref)));
      for (const entry of fs.readdirSync(paths.mutationBlobsDir).filter((item) => item.endsWith(".blob"))) if (!referenced.has(entry.slice(0, -5))) fs.rmSync(path.join(paths.mutationBlobsDir, entry), { force: true });
    },
    async withWorkspaceLock<T>(workspaceRoot: string, operation: () => Promise<T>, canonicalTargets: readonly string[] = []): Promise<T> {
      ensureDir();
      const lockId = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex");
      return withFileLock(safeFilePath(paths.mutationLocksDir, lockId, ".lock-target"), function lockTargets() { return withNodeFileMutationLocks(canonicalTargets, operation); }, { requireExitedOwner: true });
    },
  };
}
