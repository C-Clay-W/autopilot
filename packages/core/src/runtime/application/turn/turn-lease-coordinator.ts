/**
 * runtime/application/turn/turn-lease-coordinator.ts — Turn lease 协调
 *
 * 统一 stale 判断、跨进程 lease 获取和本进程 active turn 标识；
 * heartbeat 写入仍由执行协调器在持有完整 checkpoint 状态时驱动。
 */

import { randomUUID } from "node:crypto";
import type { AgentLease } from "../../../internal/agent-runtime";
import type { AgentCheckpoint } from "../../protocol";
import { AgentRuntimeError as RuntimeError } from "../../protocol";
import type { RuntimePorts } from "../../ports";

/** 运行租约超过此时长未有 Runtime 心跳时，允许宿主恢复 checkpoint。 */
export const STALE_AGENT_LEASE_MS = 45_000;

/** Turn lease 协调器公开的内部职责。 */
export interface TurnLeaseCoordinator {
  hasFresh(checkpoint: AgentCheckpoint | null, now: number): boolean;
  assertNoFresh(sessionId: string): Promise<void>;
  acquire(sessionId: string, turnId: string): Promise<AgentLease>;
  release(sessionId: string, lease: AgentLease): Promise<void>;
  isActive(turnId: string): boolean;
}

/** 创建只管理 lease ownership 的协调器。 */
export function createTurnLeaseCoordinator(ports: RuntimePorts, activeTurns: Map<string, AbortController>): TurnLeaseCoordinator {
  /** 判断 checkpoint 是否仍由未过期的 lease 持有。 */
  function hasFresh(checkpoint: AgentCheckpoint | null, now: number): boolean {
    return Boolean(checkpoint && checkpoint.status === "running" && checkpoint.lease && now - checkpoint.lease.heartbeatAt <= STALE_AGENT_LEASE_MS);
  }

  /** 在创建新 Turn 前拒绝其他宿主的有效 lease。 */
  async function assertNoFresh(sessionId: string): Promise<void> {
    const checkpoint = await ports.checkpointStore.recoverStale(sessionId, ports.clock.now(), STALE_AGENT_LEASE_MS);
    if (hasFresh(checkpoint, ports.clock.now())) throw new RuntimeError("TURN_ALREADY_RUNNING", `Session ${sessionId} 已有正在运行的 Turn`);
  }

  /** 原子获取本次 Turn 的跨进程 lease。 */
  async function acquire(sessionId: string, turnId: string): Promise<AgentLease> {
    const lease: AgentLease = { leaseId: randomUUID(), ownerId: randomUUID(), heartbeatAt: ports.clock.now(), safeBoundarySeq: 0 };
    const acquired = await ports.leaseStore.acquire({ sessionId, turnId, lease, now: ports.clock.now(), staleAfterMs: STALE_AGENT_LEASE_MS });
    if (!acquired) throw new RuntimeError("TURN_ALREADY_RUNNING", `Session ${sessionId} 已有正在运行的 Turn`);
    return acquired;
  }

  /** 释放已持有的 lease；Store 自行校验 owner identity。 */
  async function release(sessionId: string, lease: AgentLease): Promise<void> {
    await ports.leaseStore.release({ sessionId, lease });
  }

  /** 判断当前进程是否正在执行给定 Turn。 */
  function isActive(turnId: string): boolean {
    return activeTurns.has(turnId);
  }

  return { hasFresh, assertNoFresh, acquire, release, isActive };
}
