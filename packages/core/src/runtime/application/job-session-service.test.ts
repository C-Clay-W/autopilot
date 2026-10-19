/** Stage2 Session Job 视图测试：用内存状态验证归属、分页与安全 DTO，不启动真实进程。 */

import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import type { Job, Session } from "../domain";
import { createJobService } from "./job-service";

const workspaceRoot = "/stage2-workspace";

/** 创建一个终态 legacy Job，借此验证读取不会暴露命令、路径或敏感原文。 */
function completedJob(id: string, sessionId: string, updatedAt: number): Job {
  const stdout = "API_KEY=secret-canary\n/home/private/file.txt\n";
  return { id, workspaceId: workspaceRoot, sessionId, program: "private-program", args: ["secret-arg"], cwd: "/private/cwd", status: "completed", startedAt: 1, updatedAt, finishedAt: updatedAt, exitCode: 0, output: { stdout, stderr: "", stdoutCursor: Buffer.byteLength(stdout), stderrCursor: 0, stdoutStartCursor: 0, stderrStartCursor: 0, totalStdoutBytes: Buffer.byteLength(stdout), totalStderrBytes: 0, stdoutTruncated: false, stderrTruncated: false } };
}

/** 创建没有本 Runtime 句柄的活动记录，验证只读等待不会误接管或停止。 */
function activeUnknownJob(id: string, sessionId: string): Job {
  return { ...completedJob(id, sessionId, 2), jobRecordVersion: 2, status: "running", owner: { runtimeInstanceId: "foreign", hostProcessId: process.pid + 100_000 }, revision: 1, finishedAt: undefined, exitCode: undefined, output: { stdout: "", stderr: "", stdoutCursor: 0, stderrCursor: 0, stdoutStartCursor: 0, stderrStartCursor: 0, totalStdoutBytes: 0, totalStderrBytes: 0, stdoutTruncated: false, stderrTruncated: false } };
}

/** 保存一个明确属于指定 Project 的 Work Session。 */
async function saveSession(ports: ReturnType<typeof createMemoryPorts>, id: string, projectId: string): Promise<void> {
  const session: Session = { workContextVersion: 1, id, productMode: "work", projectId, persistenceMode: "durable", status: "idle", createdAt: 1, updatedAt: 1 };
  await ports.sessionStore.save(session);
}

describe("Stage2 SessionJobService", function suite() {
  it("CR 跨 Session 请求不能先恢复外部 Job", async function rejectsBeforeRecovery() {
    const ports = createMemoryPorts(workspaceRoot);
    const project = await ports.projectStore.create({ name: "fixture", workspaceRoot });
    await saveSession(ports, "s1", project.id);
    await saveSession(ports, "s2", project.id);
    await ports.jobStore.create(activeUnknownJob("foreign-dead", "s2"));
    const service = createJobService({ store: ports.jobStore, ownerProbe: { async probe() { return "dead"; } }, sessionStore: ports.sessionStore, projectStore: ports.projectStore });
    try {
      await expect(service.forSession({ workspaceId: workspaceRoot, sessionId: "s1" }).read({ jobId: "foreign-dead" })).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
      expect(await ports.jobStore.get("foreign-dead")).toMatchObject({ status: "running", revision: 1 });
    } finally { await service.shutdown(); }
  });
  it("只列当前绑定并验证分页游标，DTO 不包含进程私有字段", async function listsScopedViews() {
    const ports = createMemoryPorts(workspaceRoot);
    const project = await ports.projectStore.create({ name: "fixture", workspaceRoot });
    await saveSession(ports, "s1", project.id);
    await saveSession(ports, "s2", project.id);
    await ports.jobStore.create!(completedJob("job-a", "s1", 2));
    await ports.jobStore.create!(completedJob("job-b", "s1", 3));
    await ports.jobStore.create!(completedJob("job-other", "s2", 4));
    const service = createJobService({ store: ports.jobStore, ownerProbe: ports.jobOwnerProbe, sessionStore: ports.sessionStore, projectStore: ports.projectStore, runtimeInstanceId: "stage2" });
    const scoped = service.forSession({ workspaceId: workspaceRoot, sessionId: "s1" });
    const first = await scoped.list({ limit: 1 });
    expect(first).toMatchObject({ totalCount: 2, activeCount: 0 });
    expect(first.jobs.map(function id(job) { return job.jobId; })).toEqual(["job-b"]);
    expect(first.nextPageCursor).toBeTypeOf("string");
    const second = await scoped.list({ limit: 1, pageCursor: first.nextPageCursor });
    expect(second.jobs.map(function id(job) { return job.jobId; })).toEqual(["job-a"]);
    expect(JSON.stringify(first)).not.toMatch(/private-program|secret-arg|\/private\/cwd|owner|hostProcessId/);
    await expect(scoped.list({ pageCursor: "forged" })).rejects.toMatchObject({ code: "JOB_CURSOR_INVALID" });
  });

  it("跨 Session/Workspace ID 稳定拒绝，读取只返回脱敏安全窗口", async function rejectsForeignScope() {
    const ports = createMemoryPorts(workspaceRoot);
    const project = await ports.projectStore.create({ name: "fixture", workspaceRoot });
    await saveSession(ports, "s1", project.id);
    await saveSession(ports, "s2", project.id);
    await ports.jobStore.create!({ ...completedJob("job-1", "s1", 2), execution: { phase: "target_spawn_error_reported", targetState: "unknown", win32Code: "0x80070005" } });
    await ports.jobStore.create!(completedJob("job-2", "s2", 3));
    const service = createJobService({ store: ports.jobStore, ownerProbe: ports.jobOwnerProbe, sessionStore: ports.sessionStore, projectStore: ports.projectStore, runtimeInstanceId: "stage2" });
    const scoped = service.forSession({ workspaceId: workspaceRoot, sessionId: "s1" });
    const read = await scoped.read({ jobId: "job-1" });
    expect(read.waitOutcome).toBe("terminal");
    expect(read.job.execution).toEqual({ phase: "target_spawn_error_reported", targetState: "unknown", win32Code: "0x80070005" });
    expect(read.output.stdout.text).toContain("API_KEY=[REDACTED]");
    expect(read.output.stdout.text).toContain("[ABSOLUTE_PATH]");
    expect(JSON.stringify(read)).not.toContain("secret-canary");
    await expect(scoped.read({ jobId: "job-2" })).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(service.forSession({ workspaceId: "/other", sessionId: "s1" }).list()).rejects.toMatchObject({ code: "WORKSPACE_REQUIRED" });
  });

  it("waitMs 的超时、上限与取消彼此区分且不改变活动 Job", async function boundsWaits() {
    const ports = createMemoryPorts(workspaceRoot);
    const project = await ports.projectStore.create({ name: "fixture", workspaceRoot });
    await saveSession(ports, "s1", project.id);
    await ports.jobStore.create!(activeUnknownJob("job-wait", "s1"));
    const service = createJobService({ store: ports.jobStore, ownerProbe: ports.jobOwnerProbe, sessionStore: ports.sessionStore, projectStore: ports.projectStore, runtimeInstanceId: "stage2" });
    const scoped = service.forSession({ workspaceId: workspaceRoot, sessionId: "s1" });
    await expect(scoped.read({ jobId: "job-wait", waitMs: 1 })).resolves.toMatchObject({ waitOutcome: "timeout", job: { status: "running", controlState: "owner_unknown", canStop: false } });
    await expect(scoped.read({ jobId: "job-wait", waitMs: 30_001 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const controller = new AbortController();
    controller.abort();
    await expect(scoped.read({ jobId: "job-wait", waitMs: 30_000, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(service.get("job-wait")).resolves.toMatchObject({ status: "running", revision: 1 });
  });
});
