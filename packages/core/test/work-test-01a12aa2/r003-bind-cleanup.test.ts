/** r003绑定失败相邻回归：只用内存包装进程验证登记/ENOENT/确认清理和启动取消。 */
import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createJobService } from "../../src/runtime/application/job-service";
import type { SandboxPort } from "../../src/runtime/ports";

const mocked = vi.hoisted(function mocks() { return { spawn: vi.fn(), terminate: vi.fn() }; });
vi.mock("node:child_process", async function mockSpawn(importOriginal) { return { ...await importOriginal<typeof import("node:child_process")>(), spawn: mocked.spawn }; });
vi.mock("../../src/internal/tools/process-utils", async function mockTermination(importOriginal) { return { ...await importOriginal<typeof import("../../src/internal/tools/process-utils")>(), terminateManagedProcessTree: mocked.terminate }; });

/** 装配真实JobService，所有包装事件和停止证据由内存用例控制。 */
async function fixture(id: string, options: { neverSpawned?: boolean; missingPipe?: boolean; confirmed?: boolean; cancel?: boolean } = {}) {
  expect(process.platform).toBe("win32");
  const ports = createMemoryPorts(process.cwd());
  await createSessionService(ports).create({ id });
  const abort = new AbortController();
  const child = Object.assign(new EventEmitter(), { pid: options.neverSpawned ? undefined : 101, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, options.missingPipe ? null : new PassThrough()] });
  mocked.spawn.mockImplementation(function spawn() {
    queueMicrotask(function observeLaunch() {
      if (options.neverSpawned) child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      else { child.emit("spawn"); if (options.cancel) abort.abort(); }
    });
    return child;
  });
  mocked.terminate.mockReset();
  const stop = vi.fn(async function stop(): Promise<{ evidence: "container_empty" }> {
    if (!options.confirmed) throw new Error("unconfirmed range");
    child.emit("close", 1, null);
    return { evidence: "container_empty" };
  });
  const release = vi.fn(async function release() {});
  const port: SandboxPort = {
    status: async function status() { throw new Error("forbidden"); },
    setup: async function setup() { throw new Error("forbidden"); },
    prepare: async function prepare(request) {
      return { executionId: request.commandId, executable: request.program, args: request.args, env: {}, enforcement: "full", control: { protocolVersion: 1, bind: function bind() { if (!options.cancel) throw new Error("binding failed"); }, stop } };
    },
    release, shutdown: async function shutdown() {},
  };
  const jobs = createJobService({ store: ports.jobStore, sessionStore: ports.sessionStore, projectStore: ports.projectStore, ownerProbe: ports.jobOwnerProbe });
  const input = { sessionId: id, turnId: "r003-bind-fix", workspaceId: process.cwd(), workspaceRoot: process.cwd(), cwd: ".", program: process.execPath, args: [], signal: abort.signal, sandbox: { port, policy: { mode: "workspace-write" as const, workspaceRoot: process.cwd(), allowedDomains: [], deniedRead: [], deniedWrite: [] } } };
  return { ports, jobs, child, input, release, stop };
}

it("活跃wrapper绑定失败保留owner，后续error/close也不释放", async function failedBindingKeepsOwner() {
  const f = await fixture("r003-bind-owner");
  await expect(f.jobs.start(f.input)).rejects.toMatchObject({ code: "JOB_SPAWN_FAILED" });
  const [job] = await f.ports.jobStore.list(process.cwd());
  expect(job).toMatchObject({ status: "stopping", failureCode: "JOB_STOP_FAILED", execution: { phase: "wrapper_running", targetState: "unknown" } });
  expect(await f.jobs.hasActiveJobs(f.input.sessionId)).toBe(true);
  expect(function lateError() { f.child.emit("error", new Error("late wrapper error")); }).not.toThrow();
  f.child.emit("close", 1, null);
  expect(await f.jobs.get(job.id)).toMatchObject({ status: "stopping" });
  await expect(f.jobs.forSession({ workspaceId: process.cwd(), sessionId: f.input.sessionId }).stop({ jobId: job.id })).rejects.toMatchObject({ code: "JOB_STOP_FAILED" });
  expect(f.stop).toHaveBeenCalledTimes(2);
  expect(f.release).not.toHaveBeenCalled();
});

it("bind异常不遗漏真正ENOENT，未创建wrapper才释放并not_started", async function genuineSpawnFailure() {
  const f = await fixture("r003-bind-enoent", { neverSpawned: true });
  await expect(f.jobs.start(f.input)).rejects.toMatchObject({ code: "JOB_SPAWN_FAILED" });
  const [job] = await f.ports.jobStore.list(process.cwd());
  expect(job).toMatchObject({ status: "failed", execution: { phase: "wrapper_spawn_failed", targetState: "not_started" } });
  expect(await f.jobs.hasActiveJobs(f.input.sessionId)).toBe(false);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.stop).not.toHaveBeenCalled();
});

it("缺私有pipe时只在停止确认和close均满足后清理", async function missingPipeConfirmedCleanup() {
  const f = await fixture("r003-bind-missing", { missingPipe: true, confirmed: true });
  await expect(f.jobs.start(f.input)).rejects.toMatchObject({ code: "JOB_SPAWN_FAILED" });
  const [job] = await f.ports.jobStore.list(process.cwd());
  expect(job.status).toBe("stopped");
  expect(job.execution?.targetState).toBe("unknown");
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(await f.jobs.hasActiveJobs(f.input.sessionId)).toBe(false);
});

it("启动交付前取消仍共享停止确认再释放", async function cancelledDelivery() {
  const f = await fixture("r003-bind-cancel", { cancel: true, confirmed: true });
  await expect(f.jobs.start(f.input)).rejects.toMatchObject({ name: "AbortError" });
  const [job] = await f.ports.jobStore.list(process.cwd());
  expect(job.status).toBe("stopped");
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.release).toHaveBeenCalledTimes(1);
});
