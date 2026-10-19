/**
 * internal/tools/sandbox-policy-resolver.ts — 审批与沙箱的正交组合判定（Talk-Plan0917 Stage 1）
 *
 * 把冻结 sandboxMode、Trust、审批模式与沙箱能力报告组合为单一 SandboxPolicy 与可执行性
 * 结论。审批（PolicyEngine）回答"是否允许尝试"，本 resolver 回答"获准执行后最多能碰到
 * 什么"；任何审批范围都不能关闭路径、网络或进程隔离，unavailable 一律 fail-closed。
 */
import type { SandboxCapabilityReport, SandboxEnforcement, SandboxMode, SandboxPolicy } from "../../runtime/domain/sandbox-policy";
import type { ToolPermissionMode } from "./types";
import type { ExternalWriteCapability } from "../../runtime/domain/external-execution";

/** resolver 的输入；mode 与 workspaceRoot/tempRoot 必须来自宿主冻结配置。 */
export interface SandboxResolverInput {
  /** 仅执行器在真实批准后提供的每调用能力；请求声明不进入此字段。 */
  externalWriteCapability?: ExternalWriteCapability;
  /** 来自 FrozenRunConfig 的宿主冻结模式。 */
  mode: SandboxMode;
  /** 已 canonical 化的工作区根。 */
  workspaceRoot?: string;
  /** 宿主显式验证的受控临时目录；缺省不继承环境 TEMP/TMP。 */
  tempRoot?: string;
  /** SandboxPort.status() 的能力报告。 */
  capability: SandboxCapabilityReport;
  /** 宿主 settings 提供的网络 allowlist；Stage 2 前为空，禁止 `*`。 */
  allowedDomains?: readonly string[];
  /** 宿主 settings 提供的敏感读拒绝路径。 */
  deniedRead?: readonly string[];
  /** 宿主 settings 提供的写拒绝路径。 */
  deniedWrite?: readonly string[];
  /** 仅参与正交组合判定；resolver 不基于审批模式放宽隔离。 */
  permissionMode: ToolPermissionMode;
  workspaceTrusted: boolean;
}

/** resolver 的唯一决策结果。 */
export interface SandboxResolution {
  policy: SandboxPolicy;
  enforcement: SandboxEnforcement;
  /**
   * false：进程类调用必须 fail-closed（SANDBOX_UNAVAILABLE），不得进入审批或裸跑。
   * partial 仍可执行，但对外展示不得宣称 full。
   */
  executable: boolean;
  /**
   * G4：仅 auto_approve + Trust + 沙箱可执行时，进程类调用才具备自动放行前提；
   * PolicyEngine 消费该事实，未同时满足时必须走审批或 fail-closed，不裸跑。
   */
  canSandboxAutoAllow: boolean;
}

/** 正交组合冻结模式、Trust、审批模式与沙箱能力；纯函数，无 IO。 */
export function resolveSandboxPolicy(input: SandboxResolverInput): SandboxResolution {
  const { mode, workspaceRoot, tempRoot, capability } = input;
  const policy: SandboxPolicy = {
    mode,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(tempRoot !== undefined ? { tempRoot } : {}),
    allowedDomains: Object.freeze([...(input.allowedDomains ?? [])]),
    deniedRead: Object.freeze([...(input.deniedRead ?? [])]),
    deniedWrite: Object.freeze([...(input.deniedWrite ?? [])]),
    ...(input.externalWriteCapability ? { externalWriteCapability: input.externalWriteCapability } : {}),
  };
  const enforcement = capability.enforcement;
  const executable = enforcement === "full" || enforcement === "partial";
  return {
    policy,
    enforcement,
    executable,
    canSandboxAutoAllow: executable && input.permissionMode === "auto_approve" && input.workspaceTrusted === true,
  };
}
