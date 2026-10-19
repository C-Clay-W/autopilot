/**
 * Web TrustPolicy 兼容入口；实现统一位于 @autopilot-agent/adapters，并保持既有 trust 根布局。
 */

import type { WorkspaceTrustPolicy } from "@autopilot-agent/core";
import { createNodeTrustPolicy, resolveNodeStateRoot } from "@autopilot-agent/adapters";

/** 创建 Web 兼容 TrustPolicy；可显式注入 stateRoot 以供测试和跨宿主复用。 */
export function createWebTrustPolicy(options: { stateRoot?: string; trustRoot?: string; workspaceRoot?: string } = {}): WorkspaceTrustPolicy {
  const stateRoot = resolveNodeStateRoot({ stateRoot: options.stateRoot, workspaceRoot: options.workspaceRoot });
  return createNodeTrustPolicy({ stateRoot, trustRoot: options.trustRoot });
}
