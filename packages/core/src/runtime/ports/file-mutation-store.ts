/** FileMutationStore Port — Undo 私有 journal、blob 与跨工具 workspace 锁的唯一持久化边界。 */

import type { FileMutation, PrepareFileMutationInput, UndoTransaction } from "../domain";

/** Core 通过该 Port 写前落盘 mutation/blob；Adapter 绝不把正文投影到公开状态。 */
export interface FileMutationStore {
  /** 在真实文件变更前保存 content-addressed blob 与 prepared 记录。 */
  prepare(input: PrepareFileMutationInput): Promise<FileMutation>;
  /** 保存状态变化或 undo 关联；调用方必须提供完整、可序列化记录。 */
  save(mutation: FileMutation): Promise<void>;
  /** 读取私有 blob；缺失或 hash 不匹配由调用方 fail closed。 */
  getBlob(ref: string): Promise<Buffer | null>;
  /** 按 Session 读取 mutation，供当前会话选择最近可撤销 Turn。 */
  listBySession(sessionId: string): Promise<FileMutation[]>;
  /** 保存或更新 Undo transaction journal。 */
  saveUndoTransaction(transaction: UndoTransaction): Promise<void>;
  /** 读取 Session 尚未完成的 Undo transaction，供重启后收敛或安全重试。 */
  listUndoTransactions(sessionId: string): Promise<UndoTransaction[]>;
  /** 删除 Session 的索引和无引用 blob。 */
  deleteBySession(sessionId: string): Promise<void>;
  /** workspace 锁内按序锁定全部 canonical 目标；生产实现的目标锁域必须跨 workspace/stateRoot 共同有效。 */
  withWorkspaceLock<T>(workspaceRoot: string, operation: () => Promise<T>, canonicalTargets?: readonly string[]): Promise<T>;
}
