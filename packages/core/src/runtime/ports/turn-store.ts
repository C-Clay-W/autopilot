/**
 * runtime/ports/turn-store.ts — Turn 持久化端口
 *
 * Phase 3 引入；存储 Turn 实体及其冻结的 FrozenRunConfig。
 * TurnService.start 时写入；continue 时读取最新 Turn 的 frozenRunConfig。
 * 与 CheckpointStore 解耦：TurnStore 只存 Turn 元数据与冻结配置，不存 checkpoint 消息状态。
 */

import type { Turn } from "../domain";

/** Turn 存储端口。 */
export interface TurnStore {
  /** 根据 ID 读取 Turn；不存在时返回 null。 */
  get(id: string): Promise<Turn | null>;

  /** 保存或更新 Turn。 */
  save(turn: Turn): Promise<void>;

  /** 列出指定 Session 下的全部 Turn；未提供 sessionId 时返回空数组。 */
  list(sessionId: string): Promise<Turn[]>;

  /** 获取指定 Session 下最新的 Turn；无 Turn 时返回 null。 */
  getLatest(sessionId: string): Promise<Turn | null>;

  /** 删除指定 Session 的全部 Turn。 */
  deleteBySession(sessionId: string): Promise<void>;
}
