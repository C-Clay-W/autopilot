/**
 * 内存 LeaseStore：为 Runtime contract test 提供同一进程内的原子租约语义。
 */

import type { AgentLease } from "../../../internal/agent-runtime";
import type { LeaseStore } from "../../ports";

/** 记录租约所属 Turn，便于诊断并保持与 durable 记录一致。 */
interface MemoryLeaseRecord {
  turnId: string;
  lease: AgentLease;
}

/** 内存 LeaseStore 实现；每个实例只服务一组隔离的 Memory Ports。 */
export class MemoryLeaseStore implements LeaseStore {
  private leases = new Map<string, MemoryLeaseRecord>();

  /** 原子取得 Session 租约；新鲜租约存在时拒绝第二个 owner。 */
  async acquire(input: { sessionId: string; turnId: string; lease: AgentLease; now: number; staleAfterMs: number }): Promise<AgentLease | null> {
    const current = this.leases.get(input.sessionId);
    if (current && input.now - current.lease.heartbeatAt <= input.staleAfterMs) return null;
    this.leases.set(input.sessionId, { turnId: input.turnId, lease: { ...input.lease } });
    return { ...input.lease };
  }

  /** 仅当前 owner 可以续租。 */
  async heartbeat(input: { sessionId: string; lease: AgentLease; now: number }): Promise<boolean> {
    const current = this.leases.get(input.sessionId);
    if (!current || current.lease.leaseId !== input.lease.leaseId || current.lease.ownerId !== input.lease.ownerId) return false;
    this.leases.set(input.sessionId, { ...current, lease: { ...input.lease, heartbeatAt: input.now } });
    return true;
  }

  /** 仅当前 owner 可以释放租约。 */
  async release(input: { sessionId: string; lease: AgentLease }): Promise<boolean> {
    const current = this.leases.get(input.sessionId);
    if (!current || current.lease.leaseId !== input.lease.leaseId || current.lease.ownerId !== input.lease.ownerId) return false;
    this.leases.delete(input.sessionId);
    return true;
  }

  async deleteBySession(sessionId: string): Promise<void> {
    this.leases.delete(sessionId);
  }
}
