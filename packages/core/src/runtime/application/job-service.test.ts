/**
 * JobService 测试：验证 owner/CAS、真实终态、恢复、Session 删除互斥，
 * 以及后台 Job 全生命周期的沙箱隔离（prepare→spawn 包装顺序、全终态 release、
 * durable 记录只含安全 policy 摘要、缺范围 fail-closed）。
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import * as processUtils from "../../internal/tools/process-utils";
import { SANDBOX_ERROR_CODES, type SandboxExecutionRequest, type SandboxPolicy, type SandboxPreparedCommand } from "../domain/sandbox-policy";
import { SandboxPortError, type JobOwnerProbe, type SandboxPort } from "../ports";
import type { StartJobInput } from "../domain";
import { createMemoryPorts } from "../adapters/memory";
import { createSessionService } from "./session-service";
import { createJobService } from "./job-service";
import type { JobServiceOwnershipProbe } from "./job-service-ownership";

/** 真实子进程只允许在 env 指向的测试工作区运行。 */
function getTestWorkspaceRoot(): string {
  const root = process.env.AGENT_WORKSPACE_ROOT?.trim();
  if (!root) throw new Error("AGENT_WORKSPACE_ROOT 未配置，拒绝运行 JobService 实机测试");
  return path.resolve(root);
}

/** 透传式 fake 沙箱 Port：prepare 原样返回 argv（不包装），记录调用供测试断言。 */
function createFakeSandboxPort() {
  const prepared: Array<{ commandId: string; program: string; args: readonly string[]; cwd: string }> = [];
  const released: string[] = [];
  const port: SandboxPort = {
    async status() {
      return { platform: "macos", backend: "fake", enforcement: "full" };
    },
    async setup() {
      throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "fake sandbox setup 不可用");
    },
    async prepare(request: SandboxExecutionRequest): Promise<SandboxPreparedCommand> {
      prepared.push({ commandId: request.commandId, program: request.program, args: request.args, cwd: request.cwd });
      return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement: "full" };
    },
    async release(executionId: string) {
      released.push(executionId);
    },
    async shutdown() {},
  };
  return { port, prepared, released };
}

/** 创建带合法 Session 的内存 Runtime Job 夹具，并附带透传 fake 沙箱范围。 */
async function createFixture(sessionId = "s1", runtimeInstanceId?: string, ownerProbe?: JobOwnerProbe) {
  const workspaceRoot = getTestWorkspaceRoot();
  const ports = createMemoryPorts(workspaceRoot);
  await createSessionService(ports).create({ id: sessionId });
  const jobs = createJobService({ store: ports.jobStore, ownerProbe: ownerProbe ?? ports.jobOwnerProbe, sessionStore: ports.sessionStore, projectStore: ports.projectStore, runtimeInstanceId });
  const sandbox = createFakeSandboxPort();
  /** 构造与当前工作区对应的冻结沙箱范围；每次调用生成独立 policy 对象。 */
  function sandboxBinding(): StartJobInput["sandbox"] {
    const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] };
    return { port: sandbox.port, policy };
  }
  return { workspaceRoot, ports, jobs, sessionId, sandbox, sandboxBinding };
}

/** 等待短生命周期子进程写入输出或进入终态。 */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 80; index += 1) {
    if (await check()) return;
    await new Promise(function wait(resolve) { setTimeout(resolve, 25); });
  }
  throw new Error("Job 未在预期时间内完成");
}

/** 未配置 AGENT_WORKSPACE_ROOT 时整组跳过：这些用例会启动真实子进程，属实机测试。 */
const hasWorkspaceRoot = Boolean(process.env.AGENT_WORKSPACE_ROOT?.trim());

describe.skipIf(!hasWorkspaceRoot)("JobService Stage1", function suite() {
  it("CR 启动交付前取消清理进程，交付后取消保留 Job", async function cancelsOnlyStartup() {
    const f = await createFixture("cr-cancel");
    const abort = new AbortController();
    const save = f.ports.jobStore.compareAndSave.bind(f.ports.jobStore);
    f.ports.jobStore.compareAndSave = async function cancelAtRunning(job, condition) {
      const saved = await save(job, condition);
      if (job.status === "running") abort.abort();
      return saved;
    };
    const input = { workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", "setInterval(function tick(){},1000)"], cwd: ".", sandbox: f.sandboxBinding() };
    try {
      await expect(f.jobs.start({ ...input, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(await f.jobs.list(f.workspaceRoot)).toEqual([expect.objectContaining({ status: "stopped" })]);
      f.ports.jobStore.compareAndSave = save;
      const after = new AbortController();
      const running = await f.jobs.start({ ...input, signal: after.signal });
      after.abort();
      expect(await f.jobs.get(running.id)).toMatchObject({ status: "running" });
    } finally { await f.jobs.shutdown(); }
  });

  it("CR 父进程 close 后必须等待进程树停止回执", async function waitsForTreeConfirmation() {
    const f = await createFixture("cr-stop");
    const realTerminate = processUtils.terminateManagedProcessTree;
    let release!: () => void;
    let closed!: () => void;
    const gate = new Promise<void>(function pending(resolve) { release = resolve; });
    const observed = new Promise<void>(function pending(resolve) { closed = resolve; });
    const mock = vi.spyOn(processUtils, "terminateManagedProcessTree").mockImplementation(async function delayed(child) {
      await realTerminate(child);
      closed();
      await gate;
    });
    try {
      const job = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", "setInterval(function tick(){},1000)"], cwd: ".", sandbox: f.sandboxBinding() });
      const stopping = f.jobs.kill(job.id);
      await observed;
      expect(await f.jobs.get(job.id)).toMatchObject({ status: "stopping" });
      expect(await f.jobs.hasActiveJobs(f.sessionId)).toBe(true);
      release();
      await expect(stopping).resolves.toMatchObject({ status: "stopped" });
    } finally { release(); mock.mockRestore(); await f.jobs.shutdown(); }
  });
  it("可并行启动、轮询并在真实 close 后幂等停止", async function runsManagedJobs() {
    const f = await createFixture();
    const first = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, turnId: "t1", program: process.execPath, args: ["-e", "setTimeout(function done() { process.stdout.write('first'); }, 20)"], cwd: ".", sandbox: f.sandboxBinding() });
    const second = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, turnId: "t1", program: process.execPath, args: ["-e", "setInterval(function tick() { process.stdout.write('tick'); }, 25)"], cwd: ".", sandbox: f.sandboxBinding() });
    await waitFor(async function completed() { return (await f.jobs.get(first.id))?.status === "completed"; });
    expect((await f.jobs.poll({ id: first.id })).stdout).toContain("first");
    const stopped = await f.jobs.forSession({ workspaceId: f.workspaceRoot, sessionId: f.sessionId }).stop({ jobId: second.id, source: "agent" });
    expect(stopped.status).toBe("stopped");
    expect(stopped.finishedAt).toEqual(expect.any(Number));
    expect(stopped.lastControl).toMatchObject({ action: "stop", source: "agent", at: expect.any(Number) });
    await expect(f.jobs.forSession({ workspaceId: f.workspaceRoot, sessionId: f.sessionId }).stop({ jobId: second.id, source: "agent" })).resolves.toMatchObject({ status: "stopped", revision: stopped.revision });
    await f.jobs.shutdown();
  });

  it("Runtime B 查询不再改写 Runtime A，且不能停止外 owner", async function preservesForeignOwner() {
    const f = await createFixture("shared", "runtime-a");
    const runtimeB = createJobService({ store: f.ports.jobStore, ownerProbe: f.ports.jobOwnerProbe, sessionStore: f.ports.sessionStore, runtimeInstanceId: "runtime-b" });
    const job = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", "setInterval(function keepAlive() {}, 1000)"], cwd: ".", sandbox: f.sandboxBinding() });
    try {
      expect((await runtimeB.list(f.workspaceRoot)).find(function same(entry) { return entry.id === job.id; })).toMatchObject({ status: "running", revision: job.revision });
      await expect(runtimeB.kill(job.id)).rejects.toMatchObject({ code: "JOB_OWNER_UNAVAILABLE" });
      expect(await f.ports.jobStore.get(job.id)).toMatchObject({ status: "running", revision: job.revision });
    } finally {
      await f.jobs.kill(job.id);
      await runtimeB.shutdown();
    }
  });

  it("只恢复明确 dead owner，新旧未知 owner 保持活动并阻断删除", async function recoversOnlyDeadOwner() {
    const f = await createFixture("recover", "runtime-current", { async probe() { return "dead"; } });
    const owner = { runtimeInstanceId: "runtime-exited", hostProcessId: process.pid + 100_000 };
    await f.ports.jobStore.save({ jobRecordVersion: 2, id: "dead", workspaceId: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: [], cwd: ".", status: "running", owner, revision: 3, startedAt: 1, updatedAt: 1, output: { stdout: "", stderr: "", stdoutCursor: 0, stderrCursor: 0, stdoutStartCursor: 0, stderrStartCursor: 0, totalStdoutBytes: 0, totalStderrBytes: 0, stdoutTruncated: false, stderrTruncated: false } });
    await f.ports.jobStore.save({ id: "legacy", workspaceId: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: [], cwd: ".", status: "running", startedAt: 1, updatedAt: 1, output: { stdout: "legacy output\n", stderr: "", stdoutCursor: 14, stderrCursor: 0, stdoutStartCursor: 0, stderrStartCursor: 0, totalStdoutBytes: 14, totalStderrBytes: 0, stdoutTruncated: false, stderrTruncated: false } });
    expect((await f.jobs.get("dead"))).toMatchObject({ status: "interrupted", revision: 4 });
    expect((await f.jobs.get("legacy"))).toMatchObject({ status: "running" });
    const legacyOutput = await f.jobs.readOutput({ id: "legacy" });
    expect(await f.jobs.readOutput({ id: "legacy", stdoutCursor: legacyOutput.stdout.nextCursor })).toMatchObject({ stdout: { text: "", resetRequired: false } });
    await expect(createSessionService(f.ports, f.jobs).delete(f.sessionId)).rejects.toMatchObject({ code: "SESSION_HAS_ACTIVE_JOBS" });
  });

  it("spawn 失败持久化 failed，不能先返回 running", async function persistsSpawnFailure() {
    const f = await createFixture("spawn-failure");
    await expect(f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: "stage1-executable-does-not-exist", args: [], cwd: ".", sandbox: f.sandboxBinding() })).rejects.toMatchObject({ code: "JOB_SPAWN_FAILED" });
    expect(await f.jobs.list(f.workspaceRoot)).toEqual([expect.objectContaining({ status: "failed", failureCode: "JOB_SPAWN_FAILED", finishedAt: expect.any(Number) })]);
  });

  it.runIf(process.platform === "win32")("Windows npm 通过当前 Node 相邻 CLI 以非 Shell 方式启动", async function runsTrustedNpmCli() {
    const f = await createFixture("windows-npm");
    const job = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: "npm", args: ["--version"], cwd: ".", sandbox: f.sandboxBinding() });
    await waitFor(async function completed() { return (await f.jobs.get(job.id))?.status === "completed"; });
    expect((await f.jobs.poll({ id: job.id })).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("spawn 后首次状态写失败会清理半启动进程并留下失败记录", async function cleansUpAfterInitialStorageFailure() {
    const f = await createFixture("initial-storage-failure");
    const compareAndSave = f.ports.jobStore.compareAndSave.bind(f.ports.jobStore);
    let failedOnce = false;
    f.ports.jobStore.compareAndSave = async function failFirstTransition(job, condition) {
      if (!failedOnce) { failedOnce = true; throw new Error("synthetic storage failure"); }
      return compareAndSave(job, condition);
    };
    await expect(f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", "setInterval(function keepAlive() {}, 1000)"], cwd: ".", sandbox: f.sandboxBinding() })).rejects.toMatchObject({ code: "JOB_STORAGE_FAILED" });
    expect(await f.jobs.list(f.workspaceRoot)).toEqual([expect.objectContaining({ status: "failed", failureCode: "JOB_STORAGE_FAILED", finishedAt: expect.any(Number) })]);
    await f.jobs.shutdown();
  });

  it("限制大输出并保留原始 cursor 兼容读取", async function boundsOutput() {
    const f = await createFixture("output");
    const job = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(70000))"], cwd: ".", sandbox: f.sandboxBinding() });
    await waitFor(async function completed() { return (await f.jobs.get(job.id))?.status === "completed"; });
    const output = await f.jobs.poll({ id: job.id });
    expect(output.truncated).toBe(true);
    expect(output.job.output.totalStdoutBytes).toBe(70_000);
    expect(output.stdoutStartCursor).toBeGreaterThan(0);
  });

  it("poll 只返回上次 cursor 之后的增量输出", async function pollsIncrementally() {
    const f = await createFixture("poll");
    const job = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", "process.stdout.write('first'); setTimeout(function later() { process.stdout.write('second'); }, 300)"], cwd: ".", sandbox: f.sandboxBinding() });
    let first = await f.jobs.poll({ id: job.id });
    await waitFor(async function hasFirst() { first = await f.jobs.poll({ id: job.id }); return first.stdout === "first"; });
    await waitFor(async function completed() { return (await f.jobs.get(job.id))?.status === "completed"; });
    expect((await f.jobs.poll({ id: job.id, stdoutCursor: first.nextStdoutCursor })).stdout).toBe("second");
  });

  it("stdin 同时受单次与累计字节预算限制", async function limitsStdinWrites() {
    const f = await createFixture("stdin");
    const job = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", "process.stdin.resume(); setInterval(function keepAlive() {}, 1000)"], cwd: ".", sandbox: f.sandboxBinding() });
    await expect(f.jobs.write({ id: job.id, data: "x".repeat(8_001) })).rejects.toMatchObject({ code: "JOB_INPUT_INVALID" });
    for (let index = 0; index < 8; index += 1) await f.jobs.write({ id: job.id, data: "x".repeat(8_000) });
    await expect(f.jobs.write({ id: job.id, data: "x" })).rejects.toMatchObject({ code: "JOB_INPUT_INVALID" });
    await f.jobs.kill(job.id);
  });

  it("Session 删除和启动登记共用锁，不产生已删除 Session 的孤儿 Job", async function serializesDeleteAndStart() {
    const f = await createFixture("delete-race");
    let release: () => void = () => undefined;
    const blocker = f.ports.jobStore.withSessionLock(f.sessionId, function holdLock() { return new Promise<void>(function wait(resolve) { release = resolve; }); });
    await new Promise(function nextTick(resolve) { setTimeout(resolve, 0); });
    const deletion = createSessionService(f.ports, f.jobs).delete(f.sessionId);
    const start = f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["--version"], cwd: ".", sandbox: f.sandboxBinding() });
    release();
    await blocker;
    await expect(deletion).resolves.toBe(true);
    await expect(start).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(await f.ports.jobStore.listBySession(f.sessionId)).toEqual([]);
  });
});

describe.skipIf(!hasWorkspaceRoot)("JobService 沙箱生命周期", function sandboxSuite() {
  it("Job 启动必须经 SandboxPort.prepare 包装，durable 记录只保存安全 policy 摘要", async function preparesBeforeSpawn() {
    const f = await createFixture("sandbox-summary");
    const job = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["--version"], cwd: ".", sandbox: f.sandboxBinding() });
    await waitFor(async function completed() { return (await f.jobs.get(job.id))?.status === "completed"; });
    expect(f.sandbox.prepared).toHaveLength(1);
    // 受信解析发生在 prepare 之前：非 Windows 平台 resolveManagedCommand 原样透传 program/args。
    expect(f.sandbox.prepared[0]).toMatchObject({ program: process.execPath, args: ["--version"] });
    const stored = await f.ports.jobStore.get(job.id);
    expect(stored?.sandbox).toEqual({ mode: "workspace-write", policyDigest: expect.any(String), policyVersion: 1 });
    // 安全摘要之外不得出现代理 env、deny 路径明细或沙箱执行句柄。
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toMatch(/allowedDomains|deniedRead|deniedWrite|executionId|TMPDIR/);
    await f.jobs.shutdown();
  });

  it("completed 与 kill 终态都释放沙箱执行资源，且与 prepare 的 executionId 一致", async function releasesOnTerminalStates() {
    const f = await createFixture("sandbox-release");
    const short = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["--version"], cwd: ".", sandbox: f.sandboxBinding() });
    await waitFor(async function completed() { return (await f.jobs.get(short.id))?.status === "completed"; });
    expect(f.sandbox.released).toEqual([f.sandbox.prepared[0].commandId]);
    const long = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", "setInterval(function keepAlive() {}, 1000)"], cwd: ".", sandbox: f.sandboxBinding() });
    await f.jobs.kill(long.id);
    expect(await f.jobs.get(long.id)).toMatchObject({ status: "stopped" });
    expect(f.sandbox.released).toEqual([f.sandbox.prepared[0].commandId, f.sandbox.prepared[1].commandId]);
    await f.jobs.shutdown();
  });

  it("prepare 失败时真实 runner failure 不产生 running Job，稳定沙箱错误码原样透出", async function failsClosedOnPrepareFailure() {
    const f = await createFixture("sandbox-prepare-failure");
    f.sandbox.port.prepare = async function denyPrepare(): Promise<SandboxPreparedCommand> {
      throw new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "沙箱 runner 初始化失败，目标命令未启动");
    };
    await expect(f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["--version"], cwd: ".", sandbox: f.sandboxBinding() })).rejects.toMatchObject({ code: "SANDBOX_RUNNER_FAILED" });
    expect(await f.jobs.list(f.workspaceRoot)).toEqual([expect.objectContaining({ status: "failed", failureCode: "JOB_SPAWN_FAILED", finishedAt: expect.any(Number) })]);
    expect(f.sandbox.released).toEqual([]);
    await f.jobs.shutdown();
  });

  it("缺少冻结沙箱范围时 fail-closed，不创建任何 Job 记录", async function rejectsMissingSandboxScope() {
    const f = await createFixture("sandbox-missing");
    const input = { workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["--version"], cwd: "." } as unknown as StartJobInput;
    await expect(f.jobs.start(input)).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
    expect(await f.ports.jobStore.list(f.workspaceRoot)).toEqual([]);
    expect(f.sandbox.prepared).toHaveLength(0);
  });
});

describe("JobService 声明服务地址（Talk-Plan0908 R1）", function suite() {
  /** 端口检查发生在会话校验之后、cwd 解析与 spawn 之前，因此无需真实工作区或子进程。 */
  async function createUrlFixture(serviceProbe: JobServiceOwnershipProbe) {
    const workspaceRoot = "C:\\ws-url-fixture";
    const ports = createMemoryPorts(workspaceRoot);
    await createSessionService(ports).create({ id: "s-url" });
    const sandbox = createFakeSandboxPort();
    const jobs = createJobService({ store: ports.jobStore, ownerProbe: ports.jobOwnerProbe, sessionStore: ports.sessionStore, projectStore: ports.projectStore, serviceProbe });
    /** 沙箱范围仅用于通过启动前置检查；端口检查先于 spawn，不会真正创建进程。 */
    function sandboxBinding(): StartJobInput["sandbox"] {
      const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] };
      return { port: sandbox.port, policy };
    }
    return { workspaceRoot, ports, jobs, sandboxBinding };
  }

  /** 构造带声明服务地址的后台启动输入；cwd 不会被解析（端口检查先于目录解析）。 */
  function startInputWith(workspaceRoot: string, serviceUrl: string, sandboxBinding: () => StartJobInput["sandbox"]): StartJobInput {
    return { workspaceId: workspaceRoot, workspaceRoot, sessionId: "s-url", program: process.execPath, args: ["--version"], cwd: ".", serviceUrl, sandbox: sandboxBinding() } as unknown as StartJobInput;
  }

  it("声明的服务端口已被占用时拒绝启动，不创建任何 Job 记录", async function rejectsOccupiedDeclaredPort() {
    const serviceProbe: JobServiceOwnershipProbe = {
      async listenerPids(port) { return port === 5199 ? [4242] : []; },
      async ancestry() { return undefined; },
    };
    const { workspaceRoot, ports, jobs, sandboxBinding } = await createUrlFixture(serviceProbe);
    await expect(jobs.start(startInputWith(workspaceRoot, "http://127.0.0.1:5199/", sandboxBinding))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await ports.jobStore.list(workspaceRoot)).toEqual([]);
  });

  it("声明地址非法或非 loopback 时拒绝启动", async function rejectsIllegalServiceUrl() {
    const { workspaceRoot, jobs, sandboxBinding } = await createUrlFixture({ async listenerPids() { return []; }, async ancestry() { return undefined; } });
    await expect(jobs.start(startInputWith(workspaceRoot, "http://192.168.1.2:5199/", sandboxBinding))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(jobs.start(startInputWith(workspaceRoot, "not a url", sandboxBinding))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

/** Talk-Plan1022 S2 宿主执行合成夹具：无需真实工作区与子进程的 host 范围启动检查。 */
describe("JobService 宿主执行（Talk-Plan1022 S2 合成）", function suite() {
  async function createHostUrlFixture(serviceProbe: JobServiceOwnershipProbe) {
    const workspaceRoot = "C:\\ws-host-fixture";
    const ports = createMemoryPorts(workspaceRoot);
    await createSessionService(ports).create({ id: "s-host" });
    const sandbox = createFakeSandboxPort();
    const jobs = createJobService({ store: ports.jobStore, ownerProbe: ports.jobOwnerProbe, sessionStore: ports.sessionStore, projectStore: ports.projectStore, serviceProbe });
    function hostBinding(): StartJobInput["sandbox"] {
      const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] };
      return { execution: "host", policy };
    }
    return { workspaceRoot, ports, jobs, sandbox, hostBinding };
  }

  it("宿主范围同样执行启动前端口占用检查，prepare 零调用", async function hostRejectsOccupiedPort() {
    const serviceProbe: JobServiceOwnershipProbe = {
      async listenerPids(port) { return port === 5211 ? [4242] : []; },
      async ancestry() { return undefined; },
    };
    const { workspaceRoot, ports, jobs, sandbox, hostBinding } = await createHostUrlFixture(serviceProbe);
    const input: StartJobInput = { workspaceId: workspaceRoot, workspaceRoot, sessionId: "s-host", program: process.execPath, args: ["--version"], cwd: ".", serviceUrl: "http://127.0.0.1:5211/", sandbox: hostBinding() } as unknown as StartJobInput;
    await expect(jobs.start(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await ports.jobStore.list(workspaceRoot)).toEqual([]);
    expect(sandbox.prepared).toHaveLength(0);
  });

  it("宿主范围启动失败时按 host_spawn_failed 记录真实执行方式，不伪造 wrapper 事实", async function hostSpawnFailurePhase() {
    // workspaceRoot 必须 realpath 存在：start 在端口检查后解析 canonical cwd。
    const root = await mkdtemp(path.join(os.tmpdir(), "plan1022-hostfail-"));
    try {
      const workspaceRoot = await realpath(root);
      const ports = createMemoryPorts(workspaceRoot);
      await createSessionService(ports).create({ id: "s-host" });
      const local = createJobService({ store: ports.jobStore, ownerProbe: ports.jobOwnerProbe, sessionStore: ports.sessionStore, serviceProbe: { async listenerPids() { return []; }, async ancestry() { return undefined; } } });
      const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] };
      const input: StartJobInput = { workspaceId: workspaceRoot, workspaceRoot, sessionId: "s-host", program: "missing-host-tool-xyz", args: [], cwd: ".", sandbox: { execution: "host", policy } } as unknown as StartJobInput;
      await expect(local.start(input)).rejects.toMatchObject({ code: "JOB_SPAWN_FAILED" });
      const stored = (await ports.jobStore.list(workspaceRoot)).at(-1);
      expect(stored).toMatchObject({ status: "failed", failureCode: "JOB_SPAWN_FAILED" });
      expect(stored?.sandbox).toMatchObject({ mode: "workspace-write", execution: "host" });
      expect(stored?.execution?.phase).toBe("host_spawn_failed");
      expect(stored?.execution?.targetState).toBe("not_started");
      await local.shutdown();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe.skipIf(!hasWorkspaceRoot)("JobService 宿主执行实机组（Talk-Plan1022 S2）", function suite() {
  it("批准启动→running→owned→stop 确认关闭，零 prepare，摘要标记 execution host", async function hostJobLifecycle() {
    const f = await createFixture("host-lifecycle");
    const port = 18100 + Math.floor(Math.random() * 1000);
    const serviceUrl = `http://127.0.0.1:${port}`;
    const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: f.workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] };
    try {
      const job = await f.jobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", `require('http').createServer(function (req, res) { res.end('ok'); }).listen(${port}, '127.0.0.1');`], cwd: ".", serviceUrl, sandbox: { execution: "host", policy } });
      expect(job.status).toBe("running");
      expect(job.sandbox).toMatchObject({ mode: "workspace-write", execution: "host" });
      expect(f.sandbox.prepared).toHaveLength(0);
      // ready：宿主服务真实监听并响应。
      await waitFor(async function ready() {
        try { return (await fetch(serviceUrl)).status === 200; } catch { return false; }
      });
      const session = f.jobs.forSession({ workspaceId: f.workspaceRoot, sessionId: f.sessionId });
      const listView = await session.list();
      expect(listView.jobs.find(function same(candidate) { return candidate.jobId === job.id; })).toMatchObject({ controlState: "owned", canStop: true, serviceUrl });
      // 归属核验走 R1 既有链路：监听 PID 属于 Job 进程树 → owned，自动展开候选成立。
      await expect(session.verifyServiceOwnership({ jobId: job.id, serviceUrl })).resolves.toBe("owned");
      const stopped = await session.stop({ jobId: job.id, source: "agent" });
      expect(stopped.status).toBe("stopped");
      expect(stopped.lastControl).toMatchObject({ action: "stop", source: "agent" });
      await expect(fetch(serviceUrl)).rejects.toThrow();
    } finally { await f.jobs.shutdown(); }
  });

  it("非本 Job 监听与无法核验都不放行自动交付", async function hostOwnershipFailClosed() {
    // 归属核验只在 owner Runtime 内进行（非 owner 视角 processes.has 不成立即 unowned），
    // 因此两个场景各自用注入 probe 的 owner jobs：外部监听 PID 不在 Job 进程树 → unowned；
    // probe 无法核验 → unverifiable。两者都不产生自动展开候选。
    const f = await createFixture("host-unowned");
    const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: f.workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] };
    // probe 同时服务启动前端口检查与归属核验：serviceUp 之前返回空闲，之后才呈现外部监听/无法核验。
    let foreignServiceUp = false;
    let unverifiableServiceUp = false;
    const foreign: JobServiceOwnershipProbe = { async listenerPids() { return foreignServiceUp ? [999999] : []; }, async ancestry() { return [999999]; } };
    const unverifiable: JobServiceOwnershipProbe = { async listenerPids() { return unverifiableServiceUp ? undefined : []; }, async ancestry() { return undefined; } };
    const foreignJobs = createJobService({ store: f.ports.jobStore, ownerProbe: f.ports.jobOwnerProbe, sessionStore: f.ports.sessionStore, projectStore: f.ports.projectStore, serviceProbe: foreign });
    const unverifiableJobs = createJobService({ store: f.ports.jobStore, ownerProbe: f.ports.jobOwnerProbe, sessionStore: f.ports.sessionStore, projectStore: f.ports.projectStore, serviceProbe: unverifiable });
    try {
      const foreignJob = await foreignJobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", "setInterval(function tick(){},1000)"], cwd: ".", serviceUrl: "http://127.0.0.1:18200/", sandbox: { execution: "host", policy } });
      foreignServiceUp = true;
      await expect(foreignJobs.forSession({ workspaceId: f.workspaceRoot, sessionId: f.sessionId }).verifyServiceOwnership({ jobId: foreignJob.id, serviceUrl: "http://127.0.0.1:18200/" })).resolves.toBe("unowned");
      const unverifiableJob = await unverifiableJobs.start({ workspaceId: f.workspaceRoot, workspaceRoot: f.workspaceRoot, sessionId: f.sessionId, program: process.execPath, args: ["-e", "setInterval(function tick(){},1000)"], cwd: ".", serviceUrl: "http://127.0.0.1:18201/", sandbox: { execution: "host", policy } });
      unverifiableServiceUp = true;
      await expect(unverifiableJobs.forSession({ workspaceId: f.workspaceRoot, sessionId: f.sessionId }).verifyServiceOwnership({ jobId: unverifiableJob.id, serviceUrl: "http://127.0.0.1:18201/" })).resolves.toBe("unverifiable");
    } finally { await foreignJobs.shutdown(); await unverifiableJobs.shutdown(); await f.jobs.shutdown(); }
  });
});