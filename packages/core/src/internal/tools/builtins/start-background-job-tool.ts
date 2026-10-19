/** 后台 Job 工具：通过 ToolExecutor/PolicyEngine 授权后启动受管非 PTY 子进程。 */

import { z } from "zod";
import { decideCommandPermission, normalizeProgramName } from "../permissions/command-policy";
import { createToolError } from "../tool-error";
import type { JobService } from "../../../runtime/application/job-service";
import type { Job } from "../../../runtime/domain";
import { SANDBOX_ERROR_CODES } from "../../../runtime/domain/sandbox-policy";
import { SandboxPortError } from "../../../runtime/ports";
import type { AgentToolDefinition } from "../types";
import { claimExternalWriteCapability, externalExecutionTargetLabel, resolveExternalExecutionTarget } from "../permissions/external-execution-policy";
import { computeExternalExecutionConstraint } from "../../../runtime/domain/external-execution";

const schema = z.object({
  program: z.string().min(1).max(200),
  args: z.array(z.string().max(4_000)).max(50).default([]),
  cwd: z.string().min(1).default("."),
  externalWriteTarget: z.string().min(1).max(4_000).optional(),
}).strict();
/** 审批恢复复用同一严格schema/defaults，不另造输入哈希语义。 */
export const startBackgroundJobSchema = schema;

/** 创建仅在明确 Session/Turn 绑定下可注册的后台 Job 工具。 */
export function createStartBackgroundJobTool(input: { jobs: JobService; workspaceId: string; workspaceRoot: string; sessionId: string; turnId: string }): AgentToolDefinition<z.infer<typeof schema>, Record<string, unknown>> {
  return {
    name: "start_background_job",
    description: "在当前工作区启动受管的非交互后台命令并返回安全 Job 引用。命令不使用 Shell；成功只表示已启动，最终完成状态必须再用 read_background_job 确认。",
    inputSchema: schema,
    metadata: { effect: "dynamic", destructive: false, concurrency: { max: 4, resourceKey: "workspace:background-job" }, retry: { safe: false }, timeout: { defaultMs: 10_000, maxMs: 10_000 } },
    async createActionFacts(value, context) {
      const result = decideCommandPermission(value.program, value.args);
      const target = await resolveExternalExecutionTarget(context.workspaceRoot, value);
      return {
        toolName: "start_background_job",
        effect: target ? "external" : result.risk === "read_only" ? "none" : result.risk === "workspace_mutating" ? "workspace" : "external",
        destructive: result.risk === "destructive",
        operation: "command",
        resource: normalizeProgramName(value.program),
        risk: target ? "external_side_effect" : result.risk,
        stableConstraint: target ? computeExternalExecutionConstraint("start_background_job", target) : `program:${normalizeProgramName(value.program)}`,
        ...(target ? { externalMutation: true, externalExecutionTarget: target } : {}),
        hardDenyReason: result.decision === "deny" ? result.reason : undefined,
        requiresApproval: result.decision !== "deny",
        approval: { reason: target ? "后台命令请求修改一个工作区外精确文件，需要明确用户授权" : result.reason, preview: { program: value.program, args: value.args, cwd: value.cwd, background: true, ...(target ? { externalWriteTarget: externalExecutionTargetLabel(target), operation: "write" } : {}) } },
      };
    },
    /** PolicyEngine 放行且沙箱范围已解析后才调用 JobService，防止后台路径绕开命令策略或沙箱。 */
    async execute(value, context) {
      // 与 run_command 相同的 fail-closed：绕过 ToolExecutor 的直接调用缺少已解析沙箱范围时不启动进程。
      const sandbox = context.sandboxPolicy;
      if (!sandbox) throw createToolError(SANDBOX_ERROR_CODES.UNAVAILABLE, "沙箱未就绪，无法提供已隔离执行，后台 Job 未启动");
      await claimExternalWriteCapability("start_background_job", value, context);
      let job: Job;
      try {
        job = await input.jobs.start({ ...input, ...value, toolCallId: context.toolCallId, signal: context.signal, sandbox: { port: sandbox.port, policy: sandbox.policy } });
      } catch (error) {
        // JobService 透出的稳定沙箱错误码必须原样投影为工具错误码，不得降级为通用执行失败。
        if (error instanceof SandboxPortError) throw createToolError(error.code, error.message);
        throw error;
      }
      return { jobId: job.id, status: job.status, startedAt: job.startedAt, sandbox: { mode: sandbox.policy.mode } };
    },
    serializeOutput(output) { return output; },
  };
}
