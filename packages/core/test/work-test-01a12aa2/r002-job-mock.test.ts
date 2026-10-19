/** r002JobService回归：只用模拟包装进程验证安全事实持久化和停止失败边界。 */
import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createJobService } from "../../src/runtime/application/job-service";
import type { SandboxPort } from "../../src/runtime/ports";

const mocked = vi.hoisted(function createMocks() { return { spawn: vi.fn(), terminate: vi.fn() }; });
vi.mock("node:child_process", async function mockChildProcess(importOriginal) {
  return { ...await importOriginal<typeof import("node:child_process")>(), spawn: mocked.spawn };
});
vi.mock("../../src/internal/tools/process-utils", async function mockStop(importOriginal) {
  return { ...await importOriginal<typeof import("../../src/internal/tools/process-utils")>(), terminateManagedProcessTree: mocked.terminate };
});

/** 注入事件发射器，spawn/close均由用例控制，绝不接触OS进程。 */
async function fixture(id: string) {
  const workspaceRoot = process.cwd();
  const ports = createMemoryPorts(workspaceRoot);
  await createSessionService(ports).create({ id });
  const child = Object.assign(new EventEmitter(), { pid: 101, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  mocked.spawn.mockImplementation(function spawnFake() { queueMicrotask(function spawned() { child.emit("spawn"); }); return child; });
  mocked.terminate.mockReset();
  const port: SandboxPort = {
    status: async function status() { throw new Error("status forbidden"); },
    setup: async function setup() { throw new Error("setup forbidden"); },
    prepare: async function prepare(request) { return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement: "full" }; },
    release: async function release() {}, shutdown: async function shutdown() {},
  };
  const jobs = createJobService({ store: ports.jobStore, sessionStore: ports.sessionStore, projectStore: ports.projectStore, ownerProbe: ports.jobOwnerProbe });
  const started = await jobs.start({ sessionId: id, turnId: "mock-turn", workspaceId: workspaceRoot, workspaceRoot, program: process.execPath, args: [], cwd: ".", sandbox: { port, policy: { mode: "workspace-write", workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] } } });
  return { ports, jobs, child, started, scoped: jobs.forSession({ workspaceId: workspaceRoot, sessionId: id }) };
}

it("模拟close的reported诊断持久化并进入安全Job视图，终态stop幂等", async function persistsCloseFacts() {
  const f = await fixture("r002-close");
  expect(f.started.execution).toEqual({ phase: "wrapper_running", targetState: "unknown" });
  f.child.stderr.emit("data", Buffer.from("srt-win: error: CreateProcessAsUserW(C:\\private\\node.exe): denied (0x80070005)\nsecret=private-token"));
  f.child.emit("close", 1, "SIGTERM");
  const completed = await f.jobs.get(f.started.id);
  expect(completed).toMatchObject({ status: "failed", execution: { phase: "target_spawn_error_reported", targetState: "unknown", signal: "SIGTERM", win32Code: "0x80070005" } });
  expect((await f.ports.jobStore.get(f.started.id))?.execution).toEqual(completed?.execution);
  const safe = await f.scoped.read({ jobId: f.started.id });
  expect(safe.job.execution).toEqual(completed?.execution);
  expect(JSON.stringify(safe)).not.toContain("private-token");
  expect(JSON.stringify(safe.job)).not.toContain("node.exe");
  const stopped = await f.scoped.stop({ jobId: f.started.id, source: "agent" });
  expect(stopped.status).toBe("failed");
  expect(mocked.terminate).not.toHaveBeenCalled();
  await f.jobs.shutdown();
});

it("重复stop共用一次底层mock，包装close和停止失败不能伪造stopped", async function failsClosedAfterWrapperClose() {
  const f = await fixture("r002-stop-failure");
  let rejectStop!: (error: Error) => void;
  let notifyStarted!: () => void;
  const pending = new Promise<void>(function stopGate(_resolve, reject) { rejectStop = reject; });
  const called = new Promise<void>(function notify(resolve) { notifyStarted = resolve; });
  mocked.terminate.mockImplementation(function blockedStop() { notifyStarted(); return pending; });
  const first = f.scoped.stop({ jobId: f.started.id, source: "agent" });
  const second = f.scoped.stop({ jobId: f.started.id, source: "agent" });
  const results = Promise.allSettled([first, second]);
  await called;
  await new Promise<void>(function drain(resolve) { setImmediate(resolve); });
  expect(mocked.terminate).toHaveBeenCalledTimes(1);
  f.child.emit("close", 1, "SIGTERM");
  rejectStop(new Error("mock tree stop failed"));
  expect((await results).every(function failed(result) { return result.status === "rejected"; })).toBe(true);
  expect(await f.jobs.get(f.started.id)).toMatchObject({ status: "stopping", failureCode: "JOB_STOP_FAILED" });
  expect(await f.ports.jobStore.get(f.started.id)).toMatchObject({ status: "stopping", failureCode: "JOB_STOP_FAILED" });
});
