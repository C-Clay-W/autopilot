/**
 * runtime/ports/sandbox-port.ts — 平台无关的沙箱执行边界（Talk-Plan0917 Stage 1）
 *
 * Core 与工具层只通过本 Port 使用沙箱；禁止 Core import 任何平台实现（SRT 只允许
 * 出现在 Node Adapter）。实现方契约：
 * - prepare 输入必须是已校验的结构化 program + args + canonical cwd + 冻结 policy；
 * - prepare 输出必须是可直接 spawn 的 argv + env + enforcement，不返回拼接 shell 字符串；
 * - release 在前台 close、Job 真实终态、spawn 失败与取消路径都必须调用，且幂等；
 * - shutdown 由 Runtime 生命周期最后调用；之后 prepare 必须抛 SANDBOX_UNAVAILABLE；
 * - 实现绑定单一 canonical workspaceRoot，检测到并行另一 root 时抛 SANDBOX_SCOPE_CONFLICT，
 *   不得 reset+initialize 热切正在运行的沙箱。
 */
import {
  SANDBOX_ERROR_CODES,
  type SandboxCapabilityReport,
  type SandboxExecutionRequest,
  type SandboxPreparedCommand,
} from "../domain/sandbox-policy";

/** 沙箱 Port 的稳定错误；code 必须来自 SANDBOX_ERROR_CODES，message 仅用于诊断展示。 */
export class SandboxPortError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SandboxPortError";
    this.code = code;
  }
}

/** 平台沙箱 Port；运行时在 Composition Root 装配，Core 不感知具体平台实现。 */
export interface SandboxPort {
  /** 报告当前平台能力；不得包含敏感明细（凭据、真实路径列表、命令正文等）。 */
  status(): Promise<SandboxCapabilityReport>;
  /** 显式系统变更入口（如 Windows provision）；只能由用户显式命令触发，禁止在工具执行期调用。 */
  setup(): Promise<SandboxCapabilityReport>;
  /** 为已校验的结构化命令生成沙箱包装；沙箱不可用时抛 SandboxPortError 而不是降级裸跑。 */
  prepare(request: SandboxExecutionRequest): Promise<SandboxPreparedCommand>;
  /** 释放执行资源；幂等，重复调用不抛错。 */
  release(executionId: string): Promise<void>;
  /** Runtime shutdown 最后调用；调用后 prepare 必须抛 SANDBOX_UNAVAILABLE。 */
  shutdown(): Promise<void>;
}

/**
 * 默认 fail-closed stub：真实 backend 未接入（Stage 2 之前）或装配缺失时，
 * 一切进程执行一律 SANDBOX_UNAVAILABLE，不允许静默裸跑。
 */
export function createUnavailableSandboxPort(diagnostics?: readonly string[]): SandboxPort {
  return {
    async status() {
      return { platform: "unknown", backend: "none", enforcement: "unavailable", ...(diagnostics ? { diagnostics } : {}) };
    },
    async setup() {
      throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "沙箱 backend 未接入，无法执行 setup");
    },
    async prepare() {
      throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "沙箱 backend 未接入，已隔离执行不可用");
    },
    async release() {},
    async shutdown() {},
  };
}
