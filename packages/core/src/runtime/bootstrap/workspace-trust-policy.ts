/**
 * runtime/bootstrap/workspace-trust-policy.ts — 工作区信任策略
 *
 * 定义 Core 与宿主之间关于工作区信任的契约。
 * trust 是初始化边界：trust 建立前，Provider、MCP、Skill、Memory 等可执行能力不得加载。
 */

/** 工作区信任状态。 */
export type WorkspaceTrustStatus =
  | "trusted"
  | "denied"
  | "pending"
  | "expired";

/** 单条工作区信任记录。 */
export interface WorkspaceTrustEntry {
  /** 工作区 canonical 路径。 */
  workspaceRoot: string;

  /** 当前状态。 */
  status: WorkspaceTrustStatus;

  /** 授权时间（毫秒时间戳）。 */
  grantedAt?: number;

  /** 过期时间（毫秒时间戳）；未设置表示长期有效。 */
  expiresAt?: number;

  /** 来源：用户显式确认 / 默认策略 / 自动继承。 */
  source: "user" | "default" | "inherit";

  /** 可选备注，如拒绝原因。 */
  reason?: string;
}

/** 工作区信任策略接口；宿主提供具体持久化实现。 */
export interface WorkspaceTrustPolicy {
  /** 读取指定工作区的信任状态。 */
  getTrustStatus(workspaceRoot: string): Promise<WorkspaceTrustEntry>;

  /** 是否已受信任且未过期。 */
  isTrusted(workspaceRoot: string): Promise<boolean>;

  /** 显式授予信任。 */
  grantTrust(
    workspaceRoot: string,
    options?: { expiresAt?: number; source?: WorkspaceTrustEntry["source"]; reason?: string },
  ): Promise<WorkspaceTrustEntry>;

  /** 显式拒绝信任。 */
  denyTrust(workspaceRoot: string, reason?: string): Promise<WorkspaceTrustEntry>;

  /** 撤销已授予的信任。 */
  revokeTrust(workspaceRoot: string): Promise<WorkspaceTrustEntry>;

  /** 列出所有已知信任记录（可选；用于设置页展示）。 */
  listTrustEntries?(): Promise<WorkspaceTrustEntry[]>;
}

/** trust 检查失败时抛出的错误。 */
export class WorkspaceTrustError extends Error {
  constructor(
    public readonly workspaceRoot: string,
    public readonly status: WorkspaceTrustStatus,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceTrustError";
  }
}
