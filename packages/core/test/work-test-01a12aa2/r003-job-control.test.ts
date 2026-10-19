/** r003受管Job控制：内存包装进程只验证回执/close与失败状态，不接触OS目标。 */
import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createJobService } from "../../src/runtime/application/job-service";
import type { ManagedExecutionControl } from "../../src/runtime/domain";
import type { SandboxPort } from "../../src/runtime/ports";

const mocked = vi.hoisted(function mocks() { return { spawn: vi.fn(), terminate: vi.fn() }; });
vi.mock("node:child_process", async function mockSpawn(importOriginal) { return { ...await importOriginal<typeof import("node:child_process")>(), spawn: mocked.spawn }; });
vi.mock("../../src/internal/tools/process-utils", async function mockLegacy(importOriginal) { return { ...await importOriginal<typeof import("../../src/internal/tools/process-utils")>(), terminateManagedProcessTree: mocked.terminate }; });

/** 装配实际JobService与独立控制能力，spawn/close均只由用例发出。 */
async function fixture(id: string, controlled = true) {
  const ports = createMemoryPorts(process.cwd());
  await createSessionService(ports).create({ id });
  const stream = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 101, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, stream] });
  mocked.spawn.mockImplementation(function spawn() { queueMicrotask(function started() { child.emit("spawn"); }); return child; });
  mocked.terminate.mockReset();
  let resolve!: (value: { evidence: "container_empty" }) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<{ evidence: "container_empty" }>(function pending(done, failed) { resolve = done; reject = failed; });
  const stop = vi.fn(function stop() { return result; });
  const bind = vi.fn();
  const control: ManagedExecutionControl = { protocolVersion: 1, bind, stop };
  const release = vi.fn(async function release() {});
  const port: SandboxPort = { status: async function status() { throw new Error("forbidden"); }, setup: async function setup() { throw new Error("forbidden"); }, prepare: async function prepare(request) { return { executionId: request.commandId, executable: request.program, args: request.args, env: {}, enforcement: "full", ...(controlled ? { control } : {}) }; }, release, shutdown: async function shutdown() {} };
  const jobs = createJobService({ store: ports.jobStore, sessionStore: ports.sessionStore, projectStore: ports.projectStore, ownerProbe: ports.jobOwnerProbe });
  const started = await jobs.start({ sessionId: id, turnId: "r003", workspaceId: process.cwd(), workspaceRoot: process.cwd(), cwd: ".", program: process.execPath, args: [], sandbox: { port, policy: { mode: "workspace-write", workspaceRoot: process.cwd(), allowedDomains: [], deniedRead: [], deniedWrite: [] } } });
  return { jobs, child, started, stop, bind, release, resolve, reject, scoped: jobs.forSession({ workspaceId: process.cwd(), sessionId: id }) };
}

/** 等待异步存储状态与底层stop调用进入稳定点。 */
async function drain() { await new Promise<void>(function next(resolve) { setImmediate(resolve); }); }

it("容器回执先到仍等包装close，重复stop共用能力并终态幂等", async function receiptBeforeClose() {
  const f = await fixture("r003-receipt-first");
  expect(f.bind).toHaveBeenCalledTimes(1);
  expect(mocked.spawn.mock.calls.at(-1)?.[2].stdio).toEqual(["pipe", "pipe", "pipe", "pipe"]);
  const first = f.scoped.stop({ jobId: f.started.id });
  const second = f.scoped.stop({ jobId: f.started.id });
  await drain();
  expect(f.stop).toHaveBeenCalledTimes(1);
  f.resolve({ evidence: "container_empty" });
  await drain();
  expect(await f.jobs.get(f.started.id)).toMatchObject({ status: "stopping" });
  expect(f.release).not.toHaveBeenCalled();
  f.child.emit("close", 1, null);
  expect((await Promise.all([first, second])).every(function stopped(job) { return job.status === "stopped"; })).toBe(true);
  expect((await f.scoped.stop({ jobId: f.started.id })).status).toBe("stopped");
  expect(mocked.terminate).not.toHaveBeenCalled();
});

it("包装close先到但能力失败仍stopping且保留执行资源", async function closeWithoutEvidence() {
  const f = await fixture("r003-close-first");
  const result = expect(f.scoped.stop({ jobId: f.started.id })).rejects.toMatchObject({ code: "JOB_STOP_FAILED" });
  await drain();
  f.child.emit("close", 1, null);
  f.reject(new Error("container query failed"));
  await result;
  expect(await f.jobs.get(f.started.id)).toMatchObject({ status: "stopping", failureCode: "JOB_STOP_FAILED" });
  expect(f.release).not.toHaveBeenCalled();
  expect(mocked.terminate).not.toHaveBeenCalled();
});

it("Windows旧runner即便taskkill成功且包装close仍缺容器证据", async function legacyCannotConfirm() {
  expect(process.platform).toBe("win32");
  const f = await fixture("r003-no-control", false);
  mocked.terminate.mockImplementation(async function legacyStop() { f.child.emit("close", 1, null); });
  await expect(f.scoped.stop({ jobId: f.started.id })).rejects.toMatchObject({ code: "JOB_STOP_FAILED" });
  expect(await f.jobs.get(f.started.id)).toMatchObject({ status: "stopping", failureCode: "JOB_STOP_FAILED" });
  expect(f.release).not.toHaveBeenCalled();
  expect(f.bind).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
});
