/**
 * Web 信任存储兼容入口；trust.json 的读写实现统一位于共享 Node Adapter 包。
 */

import {
  createNodeTrustStore,
  resolveNodeStateRoot,
  resolveNodeTrustRoot,
  type NodeTrustEntry,
} from "@autopilot-agent/adapters";

export type TrustStatus = NodeTrustEntry["status"];
export type TrustEntry = NodeTrustEntry;

/** 每次按 canonical workspace 解析稳定 trust 根，避免模块加载时冻结 process.cwd()。 */
function getTrustStore(workspaceRoot: string) {
  const stateRoot = resolveNodeStateRoot({ workspaceRoot });
  return createNodeTrustStore({ stateRoot, trustRoot: resolveNodeTrustRoot({ stateRoot }) });
}

/** 读取指定工作区的信任记录。 */
export function getTrustEntry(workspaceRoot: string): TrustEntry {
  return getTrustStore(workspaceRoot).getTrustEntry(workspaceRoot);
}

/** 判断工作区是否已受信任。 */
export function isTrusted(workspaceRoot: string): boolean {
  return getTrustStore(workspaceRoot).isTrusted(workspaceRoot);
}

/** 显式授予工作区信任。 */
export function grantTrust(workspaceRoot: string, options: { expiresAt?: number; source?: TrustEntry["source"]; reason?: string } = {}): TrustEntry {
  return getTrustStore(workspaceRoot).grantTrust(workspaceRoot, options);
}

/** 显式拒绝工作区信任。 */
export function denyTrust(workspaceRoot: string, reason?: string): TrustEntry {
  return getTrustStore(workspaceRoot).denyTrust(workspaceRoot, reason);
}

/** 撤销工作区信任。 */
export function revokeTrust(workspaceRoot: string): TrustEntry {
  return getTrustStore(workspaceRoot).revokeTrust(workspaceRoot);
}

/** 列出全部信任记录。 */
export function listTrustEntries(): TrustEntry[] {
  return getTrustStore(process.cwd()).listTrustEntries();
}
