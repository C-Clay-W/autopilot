/**
 * node/sandbox/node-host-execution-sandbox-port.ts — Windows 宿主执行模式的 SandboxPort（Talk-Plan1022 S1）。
 *
 * 受信宿主在 Windows 停用进程沙箱：本 port 不加载 SRT、不要求 provision、不执行任何
 * 系统变更，只提供"停用"能力事实与 fail-closed 边界——prepare 无条件拒绝（不存在沙箱
 * 包装），setup 不触发 UAC 仅返回停用报告，release/shutdown 幂等空操作。进程类调用
 * 的放行由 PolicyEngine 的宿主逐次审批决定；执行器以 status() 的 backend
 * "host-execution" 识别本模式并构造宿主执行范围。本实现绝不报告任何隔离能力。
 */
import {
  SANDBOX_ERROR_CODES,
  SandboxPortError,
  type SandboxCapabilityReport,
  type SandboxExecutionRequest,
  type SandboxPort,
  type SandboxPreparedCommand,
} from "@autopilot-agent/core";

/** Windows 宿主执行模式的停用能力报告；diagnostics 面向审批卡与 doctor 展示。 */
function hostExecutionCapabilityReport(): SandboxCapabilityReport {
  return {
    platform: "windows",
    backend: "host-execution",
    enforcement: "unavailable",
    installed: false,
    provisioned: false,
    diagnostics: [
      "Windows 宿主执行模式：进程沙箱已停用，进程调用经用户逐次审批后在宿主以当前用户权限直接执行",
    ],
  };
}

/** 创建 Windows 宿主执行 port；无状态、无可变资源，全部沙箱包装请求 fail-closed。 */
export function createNodeHostExecutionSandboxPort(): SandboxPort {
  return {
    // Talk-Plan1022 CR R2：静态声明宿主执行方式，供 Turn 冻结与恢复比对，不依赖 status 探测。
    execution: "host",
    async status() { return hostExecutionCapabilityReport(); },
    async setup() { return hostExecutionCapabilityReport(); },
    async prepare(_request: SandboxExecutionRequest): Promise<SandboxPreparedCommand> {
      throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "宿主执行模式不提供沙箱包装，命令未通过沙箱启动");
    },
    async release() {},
    async shutdown() {},
  };
}
