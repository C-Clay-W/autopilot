/**
 * Node WorkspaceAdapter：解析 canonical workspaceRoot，并仅提供工作区内的只读标记信息。
 */

import fs from "node:fs";
import path from "node:path";
import type { WorkspaceAdapter, WorkspaceInfo } from "@autopilot-agent/core";
import { canonicalizeNodePath } from "./state-root";
import type { NodeWorkspaceAdapterOptions } from "./types";

/** 从候选目录向上查找包含 npm workspaces 的 monorepo 根。 */
function findWorkspaceRoot(startDirectory: string): string {
  let current = canonicalizeNodePath(startDirectory);
  while (true) {
    const manifestPath = path.join(current, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { workspaces?: unknown };
        if (manifest.workspaces) return canonicalizeNodePath(current);
      } catch {
        // 继续向上寻找可解析的 workspace manifest。
      }
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("无法定位 Agent 工作区；请设置 AGENT_WORKSPACE_ROOT");
    current = parent;
  }
}

/** 创建 Node WorkspaceAdapter；宿主可显式固定 workspaceRoot，避免使用请求体路径。 */
export function createNodeWorkspaceAdapter(options: NodeWorkspaceAdapterOptions = {}): WorkspaceAdapter {
  const env = options.env ?? process.env;

  /** 解析宿主默认 workspaceRoot。 */
  function resolveWorkspaceRoot(): string {
    const candidate = options.workspaceRoot ?? env.AGENT_WORKSPACE_ROOT;
    if (candidate) return canonicalizeNodePath(candidate, options.cwd);
    return findWorkspaceRoot(options.cwd ?? process.cwd());
  }

  /** 将工作区候选路径规范化为 canonical 绝对路径。 */
  function canonicalizeWorkspaceRoot(candidate: string): string {
    return canonicalizeNodePath(candidate, options.cwd);
  }

  /** 读取工作区信任标记，不修改工作区或信任状态。 */
  function getWorkspaceInfo(workspaceRoot: string): WorkspaceInfo {
    const root = canonicalizeWorkspaceRoot(workspaceRoot);
    const markers: string[] = [];
    for (const marker of ["AGENTS.md", ".autopilot", ".claude"]) {
      if (fs.existsSync(path.join(root, marker))) markers.push(marker);
    }
    return {
      root,
      hasTrustMarker: markers.length > 0,
      trustMarkers: markers,
      displayName: path.basename(root),
    };
  }

  return { resolveWorkspaceRoot, canonicalizeWorkspaceRoot, getWorkspaceInfo };
}
