/** 后台 Job 管理工具：只暴露当前 Work Session 的安全 list/read/stop 契约。 */

import { z } from "zod";
import type { SessionJobService } from "../../../runtime/application/job-service";
import { AgentRuntimeError } from "../../../runtime/protocol";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { AgentToolDefinition, ToolExecutionContext } from "../types";

const jobIdSchema = z.string().min(1).max(200);
const cursorSchema = z.string().min(1).max(2_048);
const listSchema = z.object({ limit: z.number().int().min(1).max(100).default(20), pageCursor: cursorSchema.optional() }).strict();
const readSchema = z.object({ jobId: jobIdSchema, stdoutCursor: cursorSchema.optional(), stderrCursor: cursorSchema.optional(), waitMs: z.number().int().min(0).max(30_000).default(0) }).strict();
const stopSchema = z.object({ jobId: jobIdSchema }).strict();

/** 生成同一 Job 串行执行所需的 scheduler 资源键。 */
function getStopResourceKey(input: unknown): string { return `job:${(input as { jobId?: unknown }).jobId ?? "invalid"}`; }

/** 将 Runtime 的稳定 Job 错误转换为工具错误，并把取消交给 ToolExecutor 形成 cancelled 终态。 */
function throwSafeJobToolError(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted || error instanceof Error && error.name === "AbortError") throw createToolError(TOOL_ERROR_CODES.EXECUTION_CANCELLED, "后台 Job 读取已取消");
  if (error instanceof AgentRuntimeError) throw createToolError(error.code, error.message);
  throw error;
}

/** 创建当前 Session 的只读 Job 列表工具。 */
export function createListBackgroundJobsTool(jobs: SessionJobService): AgentToolDefinition<z.infer<typeof listSchema>, Awaited<ReturnType<SessionJobService["list"]>>> {
  return {
    name: "list_background_jobs",
    description: "列出当前 Work Session 的安全后台任务摘要。默认 20 条，最多 100 条；pageCursor 只能原样回传。",
    inputSchema: listSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 4, resourceKey: "session:background-jobs:read" }, retry: { safe: true, maxRetries: 1 }, timeout: { defaultMs: 5_000, maxMs: 5_000 } },
    createActionFacts() { return { toolName: "list_background_jobs", effect: "none", destructive: false, operation: "list", risk: "read_only" }; },
    async execute(value) {
      try { return await jobs.list(value); }
      catch (error) { throwSafeJobToolError(error); }
    },
    serializeOutput(output) { return output; },
  };
}

/** 创建当前 Session 的安全输出读取工具；等待可由本次执行 signal 取消。 */
export function createReadBackgroundJobTool(jobs: SessionJobService): AgentToolDefinition<z.infer<typeof readSchema>, Awaited<ReturnType<SessionJobService["read"]>>> {
  return {
    name: "read_background_job",
    description: "读取当前 Work Session 中一个 Job 的有限安全 stdout/stderr。waitMs 最多 30000；cursor 失效时按 resetRequired 替换旧窗口，不拼接不同代次。",
    inputSchema: readSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 4, resourceKey: "session:background-jobs:read" }, retry: { safe: true, maxRetries: 1 }, timeout: { defaultMs: 35_000, maxMs: 35_000 } },
    createActionFacts(value) { return { toolName: "read_background_job", effect: "none", destructive: false, operation: "read", resource: value.jobId, risk: "read_only" }; },
    async execute(value, context: ToolExecutionContext) {
      try { return await jobs.read({ ...value, signal: context.signal }); }
      catch (error) { throwSafeJobToolError(error, context.signal); }
    },
    serializeOutput(output) { return output; },
  };
}

/** 创建按精确 Job ID 校验当前 Session/Runtime 归属且不可自动重试的停止工具。 */
export function createStopBackgroundJobTool(jobs: SessionJobService): AgentToolDefinition<z.infer<typeof stopSchema>, Awaited<ReturnType<SessionJobService["stop"]>>> {
  return {
    name: "stop_background_job",
    description: "停止当前 Work Session 中由本 Runtime 持有的指定 Job。只接受 Job ID，不接受 PID、signal、命令或 Session ID。",
    inputSchema: stopSchema,
    metadata: { effect: "external", destructive: false, concurrency: { max: 1, resourceKey: getStopResourceKey }, retry: { safe: false }, timeout: { defaultMs: 7_000, maxMs: 7_000 } },
    async createActionFacts(value) {
      // 在操作审批前读取绑定视图；执行时 stop 再次检查归属，避免检查后所有权变化。
      const { job } = await jobs.read({ jobId: value.jobId, waitMs: 0 });
      if (job.controlState !== "owned" && job.controlState !== "terminal") throw createToolError("JOB_OWNER_UNAVAILABLE", "后台 Job 不属于当前 Runtime，不能停止");
      return {
        toolName: "stop_background_job",
        effect: "external",
        destructive: false,
        operation: "stop",
        resource: value.jobId,
        risk: "external_side_effect",
        stableConstraint: `job:${value.jobId}`,
        requiresApproval: false,
        approval: { reason: "精确 Job 已由当前 Session/Runtime 校验归属", preview: { action: "stop", jobId: value.jobId } },
      };
    },
    async execute(value) {
      try { return await jobs.stop({ jobId: value.jobId, source: "agent" }); }
      catch (error) { throwSafeJobToolError(error); }
    },
    serializeOutput(output) { return output; },
  };
}
