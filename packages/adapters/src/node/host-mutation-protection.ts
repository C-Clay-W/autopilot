/** 从真实Node装配位置生成宿主文件修改保护域；普通配置/审批受控writer不经过模型guard。 */
import path from "node:path";
import type { HostMutationProtection, ProtectedMutationTarget } from "@autopilot-agent/core";
import { canonicalizeNodePath, resolveNodeTrustRoot } from "./state-root";
import { resolveNodeSettingsPaths } from "./settings/node-settings-loader";
import { getNodeFileMutationLockRoot } from "./file-mutation-locks";

/** 只接受Native宿主已有选项，不从模型或RunConfig取保护域。 */
export function createNodeHostMutationProtection(options: { stateRoot: string; workspaceRoot?: string; trustRoot?: string; userSettingsPath?: string }): HostMutationProtection {
  const stateRoot = path.resolve(options.stateRoot);
  const trustFile = path.join(resolveNodeTrustRoot(options), "trust.json");
  const fixedTargets: ProtectedMutationTarget[] = [
    { path: getNodeFileMutationLockRoot(), scope: "directory" },
    { path: stateRoot, scope: "directory" },
    { path: canonicalizeNodePath(stateRoot), scope: "directory" },
    { path: trustFile, scope: "file" },
    ...(options.userSettingsPath ? [{ path: path.resolve(options.userSettingsPath), scope: "file" as const }] : []),
  ];
  return {
    /** 权限配置路径复用真实User/Project/Local resolver，每次保留原路径与canonical判定。 */
    async getProtectedTargets(workspaceRoot) {
      const settings = resolveNodeSettingsPaths(options.workspaceRoot ?? workspaceRoot);
      return Object.freeze([...fixedTargets, ...[settings.user, settings.project, settings.local].map(function configTarget(filePath) { return { path: filePath, scope: "file" as const }; })].map(function freezeTarget(target) { return Object.freeze({ ...target }); }));
    },
  };
}
