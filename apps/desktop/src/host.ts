// 主进程通过稳定公开入口核对共享包，不读取用户配置或初始化持久会话。
import { resolveAutopilotSettings } from "@autopilot-agent/core";
import { createNodeClock } from "@autopilot-agent/adapters";
import { createPresentationState } from "@autopilot-agent/presentation";
import type { DesktopBootstrap } from "./contract";

/** 仅投影无凭据、路径及会话身份的启动摘要。 */
export function getDesktopBootstrap(appVersion: string): DesktopBootstrap {
  return {
    appVersion,
    electronVersion: process.versions.electron ?? "unavailable",
    nodeVersion: process.versions.node,
    checkedAt: createNodeClock().timestamp(),
    settingsDiagnosticCount: resolveAutopilotSettings([]).diagnostics.length,
    presentationItemCount: createPresentationState().items.length,
  };
}
