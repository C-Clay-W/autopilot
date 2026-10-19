/** 内存 FileMutationStore：为 Runtime contract test 提供隔离的 WAL/blob/锁语义。 */

import { createHash, randomUUID } from "node:crypto";
import type { FileMutation, PrepareFileMutationInput, UndoTransaction } from "../../domain";
import type { FileMutationStore } from "../../ports";
import { normalizeComparablePath } from "../../domain/external-permissions";

const targetLocks = new Map<string, Promise<void>>();

/** 内存 Port 在同进程的多个实例之间按序共享目标锁，不模拟跨进程 OS 隔离。 */
async function withMemoryTargetLocks<T>(targets: readonly string[], operation: () => Promise<T>): Promise<T> {
  const keys = [...new Set(targets.map(normalizeComparablePath))].sort();
  /** 等待前持有者并在成功或异常后释放当前目标，所有实例遵循同一顺序。 */
  async function lockNext(index: number): Promise<T> {
    if (index === keys.length) return operation();
    const key = keys[index]!;
    const previous = targetLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>(function setRelease(resolve) { release = resolve; });
    const queued = previous.then(function waitForRelease() { return next; });
    targetLocks.set(key, queued);
    await previous;
    try { return await lockNext(index + 1); }
    finally { release(); if (targetLocks.get(key) === queued) targetLocks.delete(key); }
  }
  return lockNext(0);
}

/** 计算原始字节 SHA-256，保持与 Node blob 文件名一致。 */
function sha256(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }

/** 创建内存 mutation store；配额与 Node Adapter 一致，避免测试绕过安全上限。 */
export class MemoryFileMutationStore implements FileMutationStore {
  private readonly mutations = new Map<string, FileMutation>();
  private readonly blobs = new Map<string, Buffer>();
  private readonly transactions = new Map<string, UndoTransaction>();
  private lock = Promise.resolve();

  /** 写入 prepared mutation；超过安全上限时保留不可撤销审计记录。 */
  async prepare(input: PrepareFileMutationInput): Promise<FileMutation> {
    const byteCount = (input.before?.byteLength ?? 0) + (input.after?.byteLength ?? 0);
    const used = [...this.mutations.values()].filter(function sameSession(item) { return item.sessionId === input.sessionId; })
      .reduce((total, item) => total + (item.beforeRef ? (this.blobs.get(item.beforeRef)?.byteLength ?? 0) : 0) + (item.afterRef ? (this.blobs.get(item.afterRef)?.byteLength ?? 0) : 0), 0);
    const binary = Boolean(input.before?.includes(0) || input.after?.includes(0));
    const reversible = !binary && byteCount <= 512 * 1024 && used + byteCount <= 5 * 1024 * 1024;
    const beforeRef = input.before ? sha256(input.before) : undefined;
    const afterRef = input.after ? sha256(input.after) : undefined;
    if (reversible) {
      if (input.before) this.blobs.set(beforeRef!, Buffer.from(input.before));
      if (input.after) this.blobs.set(afterRef!, Buffer.from(input.after));
    }
    const mutation: FileMutation = {
      id: randomUUID(), sessionId: input.sessionId, turnId: input.turnId, toolCallId: input.toolCallId,
      path: input.path, operation: input.operation, beforeSha: input.before ? sha256(input.before) : null,
      afterSha: input.after ? sha256(input.after) : null, beforeRef: reversible ? beforeRef : undefined, afterRef: reversible ? afterRef : undefined,
      status: "prepared", reversible, nonReversibleReason: reversible ? undefined : (binary ? "BINARY_FILE" : byteCount > 512 * 1024 ? "FILE_SIZE_LIMIT" : "SESSION_SIZE_LIMIT"), createdAt: input.createdAt,
    };
    this.mutations.set(mutation.id, structuredClone(mutation));
    return structuredClone(mutation);
  }

  /** 保存 mutation 的下一有限状态。 */
  async save(mutation: FileMutation): Promise<void> { this.mutations.set(mutation.id, structuredClone(mutation)); }
  /** 读取私有 blob 副本。 */
  async getBlob(ref: string): Promise<Buffer | null> { const value = this.blobs.get(ref); return value ? Buffer.from(value) : null; }
  /** 返回 Session mutation 的时间序快照。 */
  async listBySession(sessionId: string): Promise<FileMutation[]> { return [...this.mutations.values()].filter((item) => item.sessionId === sessionId).map((item) => structuredClone(item)); }
  /** 保存 Undo transaction journal。 */
  async saveUndoTransaction(transaction: UndoTransaction): Promise<void> { this.transactions.set(transaction.id, structuredClone(transaction)); }
  /** 返回 Session 的 journal 快照。 */
  async listUndoTransactions(sessionId: string): Promise<UndoTransaction[]> { return [...this.transactions.values()].filter((item) => item.sessionId === sessionId).map((item) => structuredClone(item)); }
  /** 删除 Session 记录并仅回收不再被任何 mutation 引用的 blob。 */
  async deleteBySession(sessionId: string): Promise<void> {
    for (const [id, mutation] of this.mutations) if (mutation.sessionId === sessionId) this.mutations.delete(id);
    for (const [id, transaction] of this.transactions) if (transaction.sessionId === sessionId) this.transactions.delete(id);
    const referenced = new Set([...this.mutations.values()].flatMap((item) => [item.beforeRef, item.afterRef]).filter((ref): ref is string => Boolean(ref)));
    for (const ref of this.blobs.keys()) if (!referenced.has(ref)) this.blobs.delete(ref);
  }
  /** 进程内串行化 workspace 文件变更。 */
  async withWorkspaceLock<T>(_workspaceRoot: string, operation: () => Promise<T>, canonicalTargets: readonly string[] = []): Promise<T> {
    const previous = this.lock;
    let release: () => void = () => undefined;
    this.lock = new Promise<void>(function setRelease(resolve) { release = resolve; });
    await previous;
    try { return await withMemoryTargetLocks(canonicalTargets, operation); } finally { release(); }
  }
}
