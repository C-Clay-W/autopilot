/**
 * runtime/domain/turn.ts — Turn 实体
 *
 * 表示一次 Agent turn 的元数据与冻结配置。
 * TurnService.start 时创建并写入 TurnStore；continue 时从 TurnStore 读取 frozenRunConfig。
 * Turn.status 与 Session.status 解耦：Turn 完成后 Session 可继续 idle。
 */

import type { FrozenRunConfig } from "./frozen-run-config";
import type { FrozenProviderConfig } from "../provider/frozen-provider-config";

/** Turn 运行状态；与 SessionStatus 部分重叠但独立维护。 */
export type TurnStatus = "running" | "waiting_approval" | "waiting_user_input" | "completed" | "failed" | "interrupted";

/**
 * Turn 实体；写入 TurnStore 后 frozenRunConfig 不可变。
 * - id：Turn 唯一标识，通常为 UUID
 * - sessionId：所属 Session
 * - frozenRunConfig：冻结的运行配置，continue 时强制使用
 * - schemaVersion：持久化 schema 版本，未来迁移用
 */
export interface Turn {
  id: string;
  sessionId: string;
  status: TurnStatus;
  frozenRunConfig: FrozenRunConfig;
  /** 新 Turn 已观察到的人类选择；与冻结参数分开，避免覆盖单次 Turn 权限。 */
  permissionSelectionRevision?: string;
  /** 恢复租约边界的权限修订审计；原 frozenRunConfig 永不因此改写。 */
  permissionRevisions?: Array<{ permissionMode: NonNullable<FrozenRunConfig["permissionMode"]>; selectionRevision: string; changedAt: number; leaseId: string; approvalCutoffSeq: number }>;
  /** 私有 Provider 执行快照；公开 Runtime DTO 必须剥离该字段。 */
  frozenProviderConfig?: FrozenProviderConfig;
  /** Todo 当前任务链身份；claimed queue 继承上一 Turn，普通新 Turn 创建新链。 */
  todoChainId?: string;
  startedAt: number;
  completedAt?: number;
  /** 持久化 schema 版本；Phase 3 起为 1。 */
  schemaVersion?: number;
}
