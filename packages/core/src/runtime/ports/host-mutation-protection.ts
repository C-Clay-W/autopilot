/** 宿主提供的文件修改保护域；只描述真实权威位置，不是可由模型请求的权限。 */
export interface ProtectedMutationTarget {
  path: string;
  scope: "file" | "directory";
}

/** 受信RuntimePorts来源；不放入RunConfig、Session或工具schema。 */
export interface HostMutationProtection {
  getProtectedTargets(workspaceRoot: string): Promise<readonly ProtectedMutationTarget[]>;
}
