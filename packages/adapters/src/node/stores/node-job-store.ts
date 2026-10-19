/** Node JobStore：在显式 stateRoot/jobs 下原子保存受限后台 Job 快照。 */

import fs from "node:fs";
import path from "node:path";
import type { Job, JobOwner, JobStore, JobStoreWriteCondition } from "@autopilot-agent/core";
import { atomicReplace, readJsonFile, safeFilePath, withFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";

/** 创建基于共享状态根的 JobStore。 */
export function createNodeJobStore(options: NodeStoreOptions): JobStore {
  const paths = getNodeStatePaths(options.stateRoot);
  /** 确保 jobs 目录存在且 schema 已完成迁移。 */
  function ensureDir(): void { const state = ensureNodeStateRoot(paths.root); fs.mkdirSync(state.jobsDir, { recursive: true }); }
  /** 返回 Job ID 的安全文件路径。 */
  function filePath(id: string): string { return safeFilePath(paths.jobsDir, id, ".json"); }
  /** 返回 Session 资源临界区使用的独立锁目标。 */
  function sessionLockPath(sessionId: string): string { return safeFilePath(path.join(paths.jobsDir, ".session-locks"), sessionId, ".guard"); }
  /** 比较完整 owner，禁止仅凭 PID 条件写。 */
  function sameOwner(first: JobOwner | undefined, second: JobOwner): boolean {
    return first?.runtimeInstanceId === second.runtimeInstanceId && first.hostProcessId === second.hostProcessId;
  }
  /** 读取全部 Job，损坏单文件按既有 Store 语义忽略。 */
  function readAll(): Job[] {
    ensureDir();
    return fs.readdirSync(paths.jobsDir).filter((file) => file.endsWith(".json")).flatMap((file) => {
      const job = readJsonFile<Job>(filePath(file.slice(0, -5)));
      return job ? [job] : [];
    });
  }
  return {
    async save(job: Job): Promise<void> { ensureDir(); await withFileLock(filePath(job.id), () => atomicReplace(filePath(job.id), JSON.stringify(job, null, 2))); },
    async create(job: Job): Promise<boolean> {
      ensureDir();
      return withFileLock(filePath(job.id), function createIfMissing() {
        if (fs.existsSync(filePath(job.id))) return false;
        atomicReplace(filePath(job.id), JSON.stringify(job, null, 2));
        return true;
      });
    },
    async compareAndSave(job: Job, condition: JobStoreWriteCondition): Promise<boolean> {
      ensureDir();
      return withFileLock(filePath(job.id), function compareAndReplace() {
        const current = readJsonFile<Job>(filePath(job.id));
        if (!current || current.revision !== condition.expectedRevision || !sameOwner(current.owner, condition.expectedOwner)) return false;
        if (job.revision !== condition.expectedRevision + 1 || !sameOwner(job.owner, condition.expectedOwner)) return false;
        atomicReplace(filePath(job.id), JSON.stringify(job, null, 2));
        return true;
      });
    },
    async get(id: string): Promise<Job | null> { ensureDir(); return withFileLock(filePath(id), () => readJsonFile<Job>(filePath(id))); },
    async list(workspaceId: string): Promise<Job[]> { return readAll().filter((job) => job.workspaceId === workspaceId); },
    async listBySession(sessionId: string): Promise<Job[]> { return readAll().filter((job) => job.sessionId === sessionId); },
    async deleteBySession(sessionId: string): Promise<void> {
      for (const job of await this.listBySession(sessionId)) {
        const target = filePath(job.id);
        await withFileLock(target, () => { if (fs.existsSync(target)) fs.unlinkSync(target); });
      }
    },
    async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
      ensureDir();
      return withFileLock(sessionLockPath(sessionId), operation);
    },
  };
}
