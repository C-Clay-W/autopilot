/**
 * runtime/ports/workspace-adapter.ts — 工作区适配器端口
 *
 * WorkspaceAdapter 负责解析 canonical 工作区根目录，并提供与信任策略相关的只读工作区信息。
 * Core 不直接读取 process.cwd() 或环境变量，所有工作区解析都通过该端口由宿主注入。
 */

/** 工作区信息快照。 */
export interface WorkspaceInfo {
  /** canonical 工作区根目录。 */
  root: string;

  /** 是否存在 AGENTS.md 等需要显式信任的标记文件。 */
  hasTrustMarker: boolean;

  /** 信任标记文件列表（相对路径）。 */
  trustMarkers: string[];

  /** 工作区显示名称。 */
  displayName: string;
}

/** 工作区适配器端口。 */
export interface WorkspaceAdapter {
  /** 解析当前宿主上下文中的工作区根目录。 */
  resolveWorkspaceRoot(): Promise<string> | string;

  /** 将路径规范化为 canonical 绝对路径。 */
  canonicalizeWorkspaceRoot(candidate: string): Promise<string> | string;

  /** 获取工作区信息快照（不修改信任状态）。 */
  getWorkspaceInfo(workspaceRoot: string): Promise<WorkspaceInfo> | WorkspaceInfo;
}
