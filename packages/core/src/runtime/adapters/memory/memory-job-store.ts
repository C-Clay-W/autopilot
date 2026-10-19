/** 内存 JobStore：供 Runtime contract test 与 headless 场景隔离使用。 */

import type { Job, JobOwner } from "../../domain";
import type { JobStore, JobStoreWriteCondition } from "../../ports";

/** 深复制可序列化 Job，避免调用方修改 Store 内部状态。 */
function copy(job: Job): Job { return structuredClone(job); }

/** 比较两个私有 owner，避免仅凭 PID 接受条件写。 */
function sameOwner(first: JobOwner | undefined, second: JobOwner): boolean {
  return first?.runtimeInstanceId === second.runtimeInstanceId && first.hostProcessId === second.hostProcessId;
}

/** 创建内存 JobStore。 */
export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly sessionLocks = new Map<string, Promise<void>>();

  /** 保存 Job 快照。 */
  async save(job: Job): Promise<void> { this.jobs.set(job.id, copy(job)); }
  /** 仅创建不存在的记录。 */
  async create(job: Job): Promise<boolean> {
    if (this.jobs.has(job.id)) return false;
    this.jobs.set(job.id, copy(job));
    return true;
  }
  /** 在内存临界区内执行 owner/revision 条件更新。 */
  async compareAndSave(job: Job, condition: JobStoreWriteCondition): Promise<boolean> {
    const current = this.jobs.get(job.id);
    if (!current || current.revision !== condition.expectedRevision || !sameOwner(current.owner, condition.expectedOwner)) return false;
    if (job.revision !== condition.expectedRevision + 1 || !sameOwner(job.owner, condition.expectedOwner)) return false;
    this.jobs.set(job.id, copy(job));
    return true;
  }
  /** 读取 Job 快照。 */
  async get(id: string): Promise<Job | null> { const job = this.jobs.get(id); return job ? copy(job) : null; }
  /** 按 workspace 列出 Job。 */
  async list(workspaceId: string): Promise<Job[]> { return [...this.jobs.values()].filter((job) => job.workspaceId === workspaceId).map(copy); }
  /** 按 Session 列出 Job。 */
  async listBySession(sessionId: string): Promise<Job[]> { return [...this.jobs.values()].filter((job) => job.sessionId === sessionId).map(copy); }
  /** 删除 Session Job。 */
  async deleteBySession(sessionId: string): Promise<void> { for (const job of this.jobs.values()) if (job.sessionId === sessionId) this.jobs.delete(job.id); }
  /** 以内存 Promise 队列串行化同一 Session 的资源临界区。 */
  async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>(function createRelease(resolve) { release = resolve; });
    const queued = previous.then(function waitCurrent() { return next; });
    this.sessionLocks.set(sessionId, queued);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.sessionLocks.get(sessionId) === queued) this.sessionLocks.delete(sessionId);
    }
  }
}
