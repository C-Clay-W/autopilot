/** Stage2 后台 Job 工具测试：验证受限 schema、审批、取消、注册与安全展示事实。 */

import { describe, expect, it, vi } from "vitest";
import type { JobOutputView, JobReadView, JobView } from "../../../runtime/domain";
import type { JobService, SessionJobService } from "../../../runtime/application/job-service";
import { createAgentRuntime } from "../../agent-runtime";
import { ToolExecutor } from "../tool-executor";
import { ToolRegistry } from "../tool-registry";
import type { AgentToolDefinition } from "../types";
import { createListBackgroundJobsTool, createReadBackgroundJobTool, createStopBackgroundJobTool } from "./background-job-tools";

/** 创建不含进程私有字段的安全 Job 视图。 */
function jobView(status: JobView["status"] = "running"): JobView {
  return { jobId: "job-1", status, controlState: status === "running" ? "owned" : "terminal", canStop: status === "running", revision: 2, startedAt: 1, updatedAt: 2, stdoutBytes: 0, stderrBytes: 0, outputTruncated: false };
}

/** 创建空的双流安全输出。 */
function emptyOutput(): JobOutputView {
  const stream = { text: "", nextCursor: "next", startCursor: "start", gap: false, resetRequired: false, truncated: false };
  return { stdout: { ...stream }, stderr: { ...stream } };
}

/** 创建只实现本组测试行为的 Session Job double。 */
function createScopedJobs(): { jobs: SessionJobService; stops: ReturnType<typeof vi.fn> } {
  const stops = vi.fn(async function stop() { return jobView("stopped"); });
  return {
    stops,
    jobs: {
      async list() { return { jobs: [jobView()], nextPageCursor: "opaque" }; },
      async read(): Promise<JobReadView> { return { job: jobView(), output: emptyOutput(), waitOutcome: "snapshot" }; },
      stop: stops,
      async verifyServiceOwnership() { return "unverifiable"; },
    },
  };
}

/** 为工具创建统一的可信 Work 执行器。 */
function executorFor(definitions: Array<AgentToolDefinition<any, any>>, permissionMode: "ask" | "auto_approve" | "full_access" = "full_access", resolvePersistentGrant?: () => Promise<boolean>): ToolExecutor {
  const registry = new ToolRegistry({ productMode: "work" });
  for (const definition of definitions) registry.register(definition);
  return new ToolExecutor(registry, { capabilityCeiling: { productMode: "work" }, permissionMode, workspaceTrusted: true, resolvePersistentGrant });
}

describe("Stage2 background job tools", function suite() {
  it("list/read 只生成有限安全事实且拒绝超限输入", async function readsSafeFacts() {
    const fake = createScopedJobs();
    const executor = executorFor([createListBackgroundJobsTool(fake.jobs), createReadBackgroundJobTool(fake.jobs)]);
    const invalid = await executor.execute({ callId: "invalid", toolName: "list_background_jobs", input: { limit: 101 } });
    expect(invalid).toMatchObject({ status: "error", error: { code: "INVALID_INPUT" } });
    const listed = await executor.execute({ callId: "list", toolName: "list_background_jobs", input: {} });
    expect(listed).toMatchObject({ status: "success", display: { job: { action: "list", observedCount: 1, hasMore: true } } });
    const read = await executor.execute({ callId: "read", toolName: "read_background_job", input: { jobId: "job-1", waitMs: 0 } });
    expect(read).toMatchObject({ status: "success", display: { job: { action: "read", jobId: "job-1", observedStatus: "running", waitOutcome: "snapshot" } } });
    expect(JSON.stringify(read)).not.toContain("program");
  });

  it("read 等待随执行 signal 取消且不调用 stop", async function cancelsWaitOnly() {
    const fake = createScopedJobs();
    fake.jobs.read = async function wait(input): Promise<JobReadView> {
      return new Promise(function pending(_resolve, reject) {
        function rejectCancelled(): void { const error = new Error("cancelled"); error.name = "AbortError"; reject(error); }
        if (input.signal?.aborted) rejectCancelled();
        else input.signal?.addEventListener("abort", rejectCancelled, { once: true });
      });
    };
    const executor = executorFor([createReadBackgroundJobTool(fake.jobs)]);
    const controller = new AbortController();
    const resultPromise = executor.execute({ callId: "read", toolName: "read_background_job", input: { jobId: "job-1", waitMs: 30_000 } }, { signal: controller.signal });
    controller.abort();
    await expect(resultPromise).resolves.toMatchObject({ status: "cancelled", error: { code: "EXECUTION_CANCELLED" } });
    expect(fake.stops).not.toHaveBeenCalled();
  });

  it("stop 当前归属精确 Job 免审批，不复用 grant，拒绝外部归属和 PID", async function stopsOwnedJob() {
    const fake = createScopedJobs();
    const granted = vi.fn(async function grant() { return true; });
    const stopTool = createStopBackgroundJobTool(fake.jobs);
    const resourceKey = stopTool.metadata.concurrency.resourceKey;
    expect(typeof resourceKey === "function" && resourceKey({ jobId: "job-1" })).toBe("job:job-1");
    expect(stopTool.metadata.retry.safe).toBe(false);
    const executor = executorFor([stopTool], "auto_approve", granted);
    const pending = await executor.execute({ callId: "stop", toolName: "stop_background_job", input: { jobId: "job-1" } });
    expect(pending).toMatchObject({ status: "success" });
    expect(granted).not.toHaveBeenCalled();
    const asked = await executorFor([stopTool], "ask", granted).execute({ callId: "asked-stop", toolName: "stop_background_job", input: { jobId: "job-1" } });
    expect(asked.status).toBe("success");
    fake.stops.mockClear();
    fake.jobs.read = async function foreignRead() { return { job: { ...jobView(), controlState: "foreign_owner", canStop: false }, output: emptyOutput(), waitOutcome: "snapshot" }; };
    const denied = await executor.execute({ callId: "foreign", toolName: "stop_background_job", input: { jobId: "job-1" } });
    expect(denied).toMatchObject({ status: "error", error: { code: "JOB_OWNER_UNAVAILABLE" } });
    expect(fake.stops).not.toHaveBeenCalled();
    const invalid = await executor.execute({ callId: "pid", toolName: "stop_background_job", input: { jobId: "job-1", pid: 123 } });
    expect(invalid).toMatchObject({ status: "error", error: { code: "INVALID_INPUT" } });
    fake.jobs.read = async function ownedRead() { return { job: jobView(), output: emptyOutput(), waitOutcome: "snapshot" }; };
    const allowed = await executorFor([createStopBackgroundJobTool(fake.jobs)]).execute({ callId: "allowed", toolName: "stop_background_job", input: { jobId: "job-1" } });
    expect(allowed).toMatchObject({ status: "success", display: { job: { action: "stop", jobId: "job-1", observedStatus: "stopped" } } });
    expect(fake.stops).toHaveBeenCalledWith({ jobId: "job-1", source: "agent" });
  });

  it("Work 注册四个 Job 工具，Chat 即使被伪造注入也不触碰 Job capability", function registersWorkOnly() {
    const scoped = createScopedJobs();
    const forSession = vi.fn(function bind() { return scoped.jobs; });
    const jobs = { forSession } as unknown as JobService;
    const workTools = createAgentRuntime({ capabilityCeiling: { productMode: "work" }, workspaceRoot: "/workspace", jobs, jobBinding: { workspaceId: "/workspace", sessionId: "s1", turnId: "t1" } }).getToolDefinitions().map(function name(tool) { return tool.name; });
    expect(workTools).toEqual(expect.arrayContaining(["start_background_job", "list_background_jobs", "read_background_job", "stop_background_job"]));
    const chatTools = createAgentRuntime({ capabilityCeiling: { productMode: "chat", chatRetrievalMode: "none", allowedTools: [] }, workspaceRoot: "/private", jobs, jobBinding: { workspaceId: "/private", sessionId: "chat", turnId: "t2" } }).getToolDefinitions().map(function name(tool) { return tool.name; });
    expect(chatTools).not.toEqual(expect.arrayContaining(["start_background_job", "list_background_jobs", "read_background_job", "stop_background_job"]));
    expect(forSession).toHaveBeenCalledTimes(1);
  });
});
