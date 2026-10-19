/**
 * runtime/ports/external-permission-projector.ts — 外部权限规则投影端口（Talk-Plan1013 Stage 2）
 *
 * grant（grants.jsonl）是审批事实权威；local settings 的 `permissions.allow` 精确规则只是投影。
 * 二者同时匹配才自动放行；判定以 grant 为准。Core 只定义契约，文件读写由 Node Adapter 实现。
 */

/** 投影与 deny 快照；allow 仅来自 workspace local 投影，deny 为全部来源并集。 */
export interface ExternalPermissionSnapshot {
  allow: readonly string[];
  deny: readonly string[];
  /** 最新显式 ask 同样收窄持久放行；旧投影器未提供时按无额外 ask。 */
  ask?: readonly string[];
}

/** 外部权限规则投影端口；写失败抛错，由调用方把 grant 标记为 pending。 */
export interface ExternalPermissionProjector {
  /** 记住（add）或撤销（remove）一条精确外部规则；只写 workspace 的 settings.local.json。 */
  project(input: { workspaceRoot: string; rule: string; action: "add" | "remove" }): Promise<void>;

  /** 读取 allow 投影与 deny 并集快照，供双边一致性校验。 */
  read(workspaceRoot: string): Promise<ExternalPermissionSnapshot>;
}
