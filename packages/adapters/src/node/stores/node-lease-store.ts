/**
 * Node LeaseStore：在显式 stateRoot/leases 下以跨进程文件锁维护 Session Turn ownership。
 */

import fs from "node:fs";
import type { AgentLease, LeaseStore } from "@autopilot-agent/core";
import { atomicReplace, readJsonFile, safeFilePath, withFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";

interface NodeLeaseRecord {
  sessionId: string;
  turnId: string;
  lease: AgentLease;
}

/** 创建基于共享状态根的跨进程 LeaseStore。 */
export function createNodeLeaseStore(options: NodeStoreOptions): LeaseStore {
  const paths = getNodeStatePaths(options.stateRoot);

  /** 确保存储目录存在并校验状态 schema。 */
  function ensureDir(): void {
    const state = ensureNodeStateRoot(paths.root);
    fs.mkdirSync(state.leasesDir, { recursive: true });
  }

  /** 返回指定 Session 租约文件的安全路径。 */
  function filePath(sessionId: string): string {
    return safeFilePath(paths.leasesDir, sessionId, ".json");
  }

  /** 判断租约心跳是否仍在 stale 阈值内。 */
  function isFresh(record: NodeLeaseRecord, now: number, staleAfterMs: number): boolean {
    return now - record.lease.heartbeatAt <= staleAfterMs;
  }

  return {
    async acquire(input): Promise<AgentLease | null> {
      ensureDir();
      const target = filePath(input.sessionId);
      return withFileLock(target, () => {
        const current = readJsonFile<NodeLeaseRecord>(target);
        if (current && isFresh(current, input.now, input.staleAfterMs)) return null;
        const record: NodeLeaseRecord = { sessionId: input.sessionId, turnId: input.turnId, lease: { ...input.lease } };
        atomicReplace(target, JSON.stringify(record, null, 2));
        return { ...record.lease };
      });
    },

    async heartbeat(input): Promise<boolean> {
      ensureDir();
      const target = filePath(input.sessionId);
      return withFileLock(target, () => {
        const current = readJsonFile<NodeLeaseRecord>(target);
        if (!current || current.lease.leaseId !== input.lease.leaseId || current.lease.ownerId !== input.lease.ownerId) return false;
        const lease = { ...input.lease, heartbeatAt: input.now };
        atomicReplace(target, JSON.stringify({ ...current, lease }, null, 2));
        return true;
      });
    },

    async release(input): Promise<boolean> {
      ensureDir();
      const target = filePath(input.sessionId);
      return withFileLock(target, () => {
        const current = readJsonFile<NodeLeaseRecord>(target);
        if (!current || current.lease.leaseId !== input.lease.leaseId || current.lease.ownerId !== input.lease.ownerId) return false;
        if (fs.existsSync(target)) fs.unlinkSync(target);
        return true;
      });
    },

    async deleteBySession(sessionId: string): Promise<void> {
      ensureDir();
      const target = filePath(sessionId);
      await withFileLock(target, () => {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      });
    },
  };
}
