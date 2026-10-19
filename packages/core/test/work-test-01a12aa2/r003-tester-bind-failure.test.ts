/** r003独立Tester：私有通道绑定失败时必须保留尚未close的包装进程控制能力。 */
import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createJobService } from "../../src/runtime/application/job-service";
import type { SandboxPort } from "../../src/runtime/ports";

const mocked = vi.hoisted(function mocks() { return { spawn: vi.fn(), terminate: vi.fn() }; });
vi.mock("node:child_process", async function mockSpawn(importOriginal) { return { ...await importOriginal<typeof import("node:child_process")>(), spawn: mocked.spawn }; });
vi.mock("../../src/internal/tools/process-utils", async function mockTermination(importOriginal) { return { ...await importOriginal<typeof import("../../src/internal/tools/process-utils")>(), terminateManagedProcessTree: mocked.terminate }; });

/** 实际spawn已返回而绑定抛错，未发送close或任何停止确认，不能声称已无执行资源。 */
it("绑定失败但wrapper未close时不得释放资源或丢失活动控制", async function bindFailureRetainsWrapper() {
  expect(process.platform).toBe("win32");
  const ports = createMemoryPorts(process.cwd());
  const sessionId = "r003-tester-bind-failure";
  await createSessionService(ports).create({ id: sessionId });
  const child = Object.assign(new EventEmitter(), { pid: 101, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, new PassThrough()] });
  mocked.spawn.mockReturnValue(child);
  const stop = vi.fn(async function failedStop(): Promise<{ evidence: "container_empty" }> { throw new Error("no confirmation"); });
  const release = vi.fn(async function release() {});
  const port: SandboxPort = {
    status: async function status() { throw new Error("forbidden"); },
    setup: async function setup() { throw new Error("forbidden"); },
    prepare: async function prepare(request) { return { executionId: request.commandId, executable: request.program, args: request.args, env: {}, enforcement: "full", control: { protocolVersion: 1, bind: function bind() { throw new Error("private pipe binding failed"); }, stop } }; },
    release,
    shutdown: async function shutdown() {},
  };
  const jobs = createJobService({ store: ports.jobStore, sessionStore: ports.sessionStore, projectStore: ports.projectStore, ownerProbe: ports.jobOwnerProbe });
  await expect(jobs.start({ sessionId, turnId: "r003", workspaceId: process.cwd(), workspaceRoot: process.cwd(), cwd: ".", program: process.execPath, args: [], sandbox: { port, policy: { mode: "workspace-write", workspaceRoot: process.cwd(), allowedDomains: [], deniedRead: [], deniedWrite: [] } } })).rejects.toMatchObject({ code: "JOB_SPAWN_FAILED" });
  expect(mocked.spawn).toHaveBeenCalledTimes(1);
  expect(release, "未close且无容器空回执，必须保留执行资源").not.toHaveBeenCalled();
});
