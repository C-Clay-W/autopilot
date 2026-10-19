/**
 * runtime/domain/sandbox-policy.ts — 平台无关沙箱契约（Talk-Plan0917 Stage 1）
 *
 * 冻结 SandboxMode / SandboxPolicy / capability 报告与稳定错误词汇。Core 与工具层只
 * 消费本文件与 SandboxPort，不得直接 import 任何平台沙箱实现（SRT 只允许出现在
 * Node Adapter）。审批与沙箱正交：审批回答"是否允许尝试"，本文件定义的 policy 回答
 * "获准执行后最多能碰到什么"；任何审批范围都不能关闭路径、网络或进程隔离。
 * danger-full-access 只能来自可信宿主的冻结配置；模型输入、工具参数与持久 grant
 * 均不能提升到该模式。
 */
import { createHash } from "node:crypto";
import type { ExternalWriteCapability } from "./external-execution";

/** OS 沙箱能力模式；与审批 permissionMode 正交，默认 workspace-write。 */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** 沙箱执行保障等级；partial/unavailable 不得对外显示为 full。 */
export type SandboxEnforcement = "full" | "partial" | "unavailable";

/** 单个 Turn 冻结的沙箱策略；敏感路径明细不进入对外 DTO，持久化只保存安全摘要。 */
export interface SandboxPolicy {
  mode: SandboxMode;
  /** 已 canonical 化的工作区根；workspace-write 下进程可写的唯一工作区。 */
  workspaceRoot?: string;
  /** 宿主显式验证的受控临时目录；缺失时不得回退环境 TEMP/TMP。 */
  tempRoot?: string;
  /** 网络 allowlist；默认拒绝，禁止用 `*` 兜底。 */
  allowedDomains: readonly string[];
  deniedRead: readonly string[];
  deniedWrite: readonly string[];
  /** Core 本调用真实批准后签发；不是工具/配置的裸根声明。 */
  externalWriteCapability?: ExternalWriteCapability;
}

/** 沙箱能力报告；diagnostics 只允许脱敏内容（无凭据、完整环境变量、敏感路径列表或命令正文）。 */
export interface SandboxCapabilityReport {
  platform: "macos" | "windows" | "linux" | "unknown";
  backend: string;
  enforcement: SandboxEnforcement;
  installed?: boolean;
  provisioned?: boolean;
  version?: string;
  diagnostics?: readonly string[];
}

/** SandboxPort.prepare 的唯一合法输入；必须已完成路径校验并携带冻结 policy。 */
export interface SandboxExecutionRequest {
  commandId: string;
  program: string;
  args: readonly string[];
  /** 已 canonical 化的执行目录。 */
  cwd: string;
  policy: SandboxPolicy;
  /** 受管后台任务请求独立执行控制；前台命令不请求此能力。 */
  managed?: boolean;
}

/** 宿主创建的私有双向字节通道；不含目标的标准输入输出。 */
export interface ManagedExecutionChannel {
  incoming: AsyncIterable<Uint8Array>;
  send(bytes: Uint8Array): void;
  close(): void;
}

/** 每次 prepare 独立的执行能力；绑定一次，停止成功必须说明实际确认范围。 */
export interface ManagedExecutionControl {
  /** 当前私有通道协议；宿主按能力创建额外 pipe，未知版本拒绝。 */
  protocolVersion: 1;
  bind(channel: ManagedExecutionChannel): void;
  stop(): Promise<{ evidence: "container_empty" }>;
}

/** SandboxPort.prepare 的输出；可直接交给 spawn，不返回拼接 shell 字符串供工具自行解释。 */
export interface SandboxPreparedCommand {
  executionId: string;
  executable: string;
  args: readonly string[];
  env: Record<string, string>;
  enforcement: SandboxEnforcement;
  /** 可选受管执行能力；缺失不表示平台已确认全树停止。 */
  control?: ManagedExecutionControl;
}

/** Plan 冻结的稳定沙箱错误码；底层平台文案只进脱敏诊断，不作为业务分支依据。 */
export const SANDBOX_ERROR_CODES = {
  /** 沙箱不可用（未安装/未初始化/shutdown 后）：目标命令未启动。 */
  UNAVAILABLE: "SANDBOX_UNAVAILABLE",
  /** 平台未完成 provision（如 Windows 专用账户/WFP/ACL）：目标命令未启动。 */
  NOT_PROVISIONED: "SANDBOX_NOT_PROVISIONED",
  /** 沙箱正常工作并拒绝了动作；与 runner failure 语义不同，禁止混淆。 */
  POLICY_DENIED: "SANDBOX_POLICY_DENIED",
  /** 沙箱 runner 自身失败导致命令未安全启动：目标命令未运行。 */
  RUNNER_FAILED: "SANDBOX_RUNNER_FAILED",
  /** 检测到另一个 canonical workspaceRoot 并行使用：拒绝热切全局沙箱状态。 */
  SCOPE_CONFLICT: "SANDBOX_SCOPE_CONFLICT",
  /** release/cleanup 失败；不得静默吞掉，需要可行动诊断。 */
  CLEANUP_FAILED: "SANDBOX_CLEANUP_FAILED",
} as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[keyof typeof SANDBOX_ERROR_CODES];

/** 判断错误码是否为"沙箱正常工作并拒绝动作"；此时目标命令可能已启动但动作被 OS 拒绝。 */
export function isSandboxPolicyDenialCode(code: string): boolean {
  return code === SANDBOX_ERROR_CODES.POLICY_DENIED;
}

/** 判断错误码是否为"目标命令未被安全启动"类失败（unavailable/not provisioned/runner failed）。 */
export function isSandboxAvailabilityFailureCode(code: string): boolean {
  return code === SANDBOX_ERROR_CODES.UNAVAILABLE
    || code === SANDBOX_ERROR_CODES.NOT_PROVISIONED
    || code === SANDBOX_ERROR_CODES.RUNNER_FAILED;
}

/** 沙箱冻结语义版本；旧 checkpoint 缺省时在恢复边界按 fail-safe 范式迁移。 */
export const SANDBOX_POLICY_VERSION = 1;

/** 无沙箱直接执行的稳定约束（CR 20261016 R2 fail-closed 后执行链不再签发；约束与 R1 冻结/消费
 *  底座保留休眠，供未来受控执行方式复用。绑定本次调用完整输入，只允许 allow_once/deny，不产生持久授权）。 */
export const NO_SANDBOX_EXEC_CONSTRAINT = "no-sandbox-exec:v1";

/** 判断约束是否为沙箱降级直接执行审批约束。 */
export function isNoSandboxExecConstraint(constraint: string | undefined): boolean {
  return constraint === NO_SANDBOX_EXEC_CONSTRAINT;
}

/**
 * R1：沙箱降级审批的私有冻结记录。与 external_file_request 并列存放于同一授权存储，
 * 用独立 recordType 区分；只冻结可验证身份（constraint/callId/inputHash）与 TTL，
 * 本身不是批准。恢复路径据此区分降级批准与普通批准，并做持久原子一次消费。
 */
export interface SandboxDegradeApproval {
  recordType: "sandbox_degrade_request";
  sessionId: string;
  turnId: string;
  approvalId: string;
  callId: string;
  toolName: string;
  normalizedInputHash: string;
  constraint: string;
  expiresAt: string;
}

/** 校验宿主提供的 sandboxMode；未知值 fail-closed 拒绝，不接受静默回退或模型提供的任意字符串。 */
export function resolveSandboxMode(value: unknown): SandboxMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value;
  throw new Error(`SANDBOX_MODE_INVALID: 不支持的沙箱模式 ${String(value)}`);
}

/** 计算冻结 policy 的安全摘要；只覆盖非敏感结构字段，不包含敏感路径明细本身。 */
export function computeSandboxPolicyDigest(input: { mode: SandboxMode; workspaceRoot?: string; tempRoot?: string; externalWriteCapability?: ExternalWriteCapability }): string {
  return createHash("sha256")
    .update(JSON.stringify({ mode: input.mode, workspaceRoot: input.workspaceRoot ?? null, tempRoot: input.tempRoot ?? null, ...(input.externalWriteCapability ? { externalWriteCapabilityVersion: input.externalWriteCapability.schemaVersion, capabilityDigest: input.externalWriteCapability.capabilityDigest } : {}) }))
    .digest("hex");
}
