/**
 * runtime/adapters/memory/memory-workspace-adapter.ts — 内存工作区适配器
 *
 * 用于测试与 headless smoke；不依赖真实文件系统，允许调用方显式指定工作区根目录。
 */

import type { WorkspaceAdapter, WorkspaceInfo } from "../../ports/workspace-adapter";

/** 内存工作区适配器。 */
export class MemoryWorkspaceAdapter implements WorkspaceAdapter {
  constructor(private readonly root: string, private readonly markers: string[] = []) {}

  resolveWorkspaceRoot(): string {
    return this.root;
  }

  canonicalizeWorkspaceRoot(candidate: string): string {
    return candidate;
  }

  getWorkspaceInfo(workspaceRoot: string): WorkspaceInfo {
    return {
      root: workspaceRoot,
      hasTrustMarker: this.markers.length > 0,
      trustMarkers: this.markers,
      displayName: workspaceRoot,
    };
  }
}
