/**
 * LeaseStore Port：管理跨宿主共享的 Session 前台 Turn 租约。
 *
 * Runtime 通过该 Port 原子取得、续租和释放 Session ownership；宿主不得自行复制租约状态机。
 */

import type { AgentLease } from "../../internal/agent-runtime";

/** 跨进程租约持久化接口。 */
export interface LeaseStore {
  /** 原子取得 Session 租约；存在新鲜租约时返回 null。 */
  acquire(input: {
    sessionId: string;
    turnId: string;
    lease: AgentLease;
    now: number;
    staleAfterMs: number;
  }): Promise<AgentLease | null>;

  /** 仅允许当前 lease owner 更新心跳；返回是否仍持有租约。 */
  heartbeat(input: { sessionId: string; lease: AgentLease; now: number }): Promise<boolean>;

  /** 仅允许当前 lease owner 释放租约；返回是否完成释放。 */
  release(input: { sessionId: string; lease: AgentLease }): Promise<boolean>;

  /** 删除指定 Session 的租约；仅用于已确认停止的 Session 级级联删除。 */
  deleteBySession(sessionId: string): Promise<void>;
}
