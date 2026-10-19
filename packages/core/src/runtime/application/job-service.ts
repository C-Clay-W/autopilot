/**
 * runtime/application/job-service.ts — 受管非 PTY Background Job 用例与进程生命周期。
 *
 * 进程句柄只属于创建它的 Runtime；durable 更新必须同时匹配 owner 与 revision。
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import type { Job, JobControlState, JobListView, JobOutputView, JobOwner, JobOwnerLiveness, JobPollResult, JobReadView, JobView, PollJobInput, StartJobInput } from "../domain";
import { JOB_RECORD_VERSION } from "../domain";
import { readSessionIdentity } from "../domain/product-mode";
import { SANDBOX_ERROR_CODES, SANDBOX_POLICY_VERSION, computeSandboxPolicyDigest, type SandboxPreparedCommand, type ManagedExecutionControl } from "../domain/sandbox-policy";
import { SandboxPortError, type JobOwnerProbe, type JobStore, type ProjectStore, type SandboxPort, type SessionStore } from "../ports";
import { AgentRuntimeError as RuntimeError } from "../protocol";
import { resolveFileTarget } from "../../internal/tools/permissions/path-access-policy";
import { assertExternalJobDispatch } from "../../internal/tools/permissions/external-execution-policy";
import { BoundedOutputBuffer, ProcessTreeTerminationError, resolveManagedCommand, terminateManagedProcessTree } from "../../internal/tools/process-utils";
import { JobOutputProjector, readStoredJobOutput } from "./job-output-projection";
import { projectJobCloseFacts } from "./job-execution-facts";

const JOB_OUTPUT_LIMIT = 30_000;
const JOB_STDIN_SINGLE_LIMIT = 8_000;
const JOB_STDIN_TOTAL_LIMIT = 64_000;
const OUTPUT_PERSIST_INTERVAL_MS = 1_000;
const SAFE_READ_STREAM_LIMIT = 8 * 1024;
const activeRuntimeIds = new Set<string>();
const disposedRuntimeIds = new Set<string>();

/** JobService 对外稳定操作；start 必须只由已通过 ToolExecutor 的后台工具调用。 */
export interface JobService {
  start(input: StartJobInput): Promise<Job>;
  poll(input: PollJobInput): Promise<JobPollResult>;
  readOutput(input: { id: string; stdoutCursor?: string; stderrCursor?: string }): Promise<JobOutputView>;
  write(input: { id: string; data: string }): Promise<void>;
  kill(id: string): Promise<Job>;
  list(workspaceId: string): Promise<Job[]>;
  get(id: string): Promise<Job | null>;
  hasActiveJobs(sessionId: string): Promise<boolean>;
  forSession(binding: { workspaceId: string; sessionId: string }): SessionJobService;
  shutdown(): Promise<void>;
}

/** 已绑定 Work Session 的安全管理操作；Agent 与宿主不得传入另一 Session 身份。 */
export interface SessionJobService {
  list(input?: { limit?: number; pageCursor?: string }): Promise<JobListView>;
  read(input: { jobId: string; stdoutCursor?: string; stderrCursor?: string; waitMs?: number; signal?: AbortSignal }): Promise<JobReadView>;
  stop(input: { jobId: string; source: "agent" | "host" }): Promise<JobView>;
}

/** SessionService 使用的内部协调接口，不通过 AgentRuntime.jobs 暴露。 */
export interface InternalJobService extends JobService {
  withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
}

/** 创建 JobService 所需 Port；runtimeInstanceId 仅供确定性测试注入。 */
export interface CreateJobServiceOptions {
  store: JobStore;
  ownerProbe: JobOwnerProbe;
  sessionStore: SessionStore;
  projectStore?: ProjectStore;
  runtimeInstanceId?: string;
  hostProcessId?: number;
  now?: () => number;
}

interface ActiveJob {
  child: ChildProcess;
  job: Job;
  stdout: BoundedOutputBuffer;
  stderr: BoundedOutputBuffer;
  projector: JobOutputProjector;
  stdinBytes: number;
  stdinClosed: boolean;
  outputDirty: boolean;
  outputTimer?: ReturnType<typeof setTimeout>;
  transitionTail: Promise<void>;
  closeResult?: { exitCode: number | null; signal?: NodeJS.Signals | null };
  initialized: boolean;
  projectorFlushed: boolean;
  finalizePromise?: Promise<Job>;
  stopPromise?: Promise<Job>;
  stopConfirmed?: boolean;
  storageFailure?: RuntimeError;
  /** 已 prepare 的沙箱执行范围；与进程树同生共死，真实终态（spawn 失败/close 后终态化）时释放。 */
  sandboxExecution?: { port: SandboxPort; executionId: string; control?: ManagedExecutionControl };
}

/** 释放 Job 绑定的沙箱执行资源；幂等且不中断终态流程，适配器内部自行记录清理诊断。 */
function releaseSandbox(active: Pick<ActiveJob, "sandboxExecution">): void {
  const execution = active.sandboxExecution;
  if (!execution) return;
  active.sandboxExecution = undefined;
  void execution.port.release(execution.executionId).catch(function ignoreCleanupFailure() { /* release 契约幂等不抛；防御 Port 实现异常。 */ });
}

/** 当前 Runtime 的进程句柄表；不持久化、不跨进程暴露，只由 JobService 编排。 */
export class ProcessManager {
  private readonly active = new Map<string, ActiveJob>();
  /** 读取本 Runtime 拥有的活动 Job。 */
  get(id: string): ActiveJob | undefined { return this.active.get(id); }
  /** 记录刚启动的 Job 进程。 */
  set(id: string, job: ActiveJob): void { this.active.set(id, job); }
  /** 移除已退出且终态已持久化的 Job 进程。 */
  delete(id: string): void { this.active.delete(id); }
  /** 判断 Job 是否仍由当前 Runtime 持有。 */
  has(id: string): boolean { return this.active.has(id); }
  /** 返回当前 Runtime 所有活动 Job ID。 */
  ids(): string[] { return [...this.active.keys()]; }
}

/** 判断是否为仍需控制或阻断删除的活动状态。 */
function isActiveStatus(status: Job["status"]): boolean { return status === "starting" || status === "running" || status === "stopping"; }

/** 比较完整 owner，禁止只凭 PID 认领。 */
function sameOwner(first: JobOwner | undefined, second: JobOwner): boolean {
  return first?.runtimeInstanceId === second.runtimeInstanceId && first.hostProcessId === second.hostProcessId;
}

/** 复制 Job，保证调用方不会持有进程管理器内部状态。 */
function copy(job: Job): Job { return structuredClone(job); }

/** 从可控 buffer 更新 Job 的原始兼容快照与安全投影快照。 */
function syncOutput(active: ActiveJob, target: Job): void {
  const stdout = active.stdout.readSince(0);
  const stderr = active.stderr.readSince(0);
  target.output = {
    stdout: stdout.output, stderr: stderr.output,
    stdoutCursor: active.stdout.byteLength, stderrCursor: active.stderr.byteLength,
    stdoutStartCursor: stdout.startCursor, stderrStartCursor: stderr.startCursor,
    totalStdoutBytes: active.stdout.byteLength, totalStderrBytes: active.stderr.byteLength,
    stdoutTruncated: active.stdout.truncated, stderrTruncated: active.stderr.truncated,
  };
  target.safeOutput = active.projector.snapshot();
}

/** 从重启后保留的原始尾部窗口读取兼容增量。 */
function readStoredOutput(output: string, startCursor: number, endCursor: number, cursor: number | undefined): { output: string; truncated: boolean } {
  if (cursor === undefined) return { output, truncated: startCursor > 0 };
  const requestedCursor = Math.max(0, Math.min(cursor, endCursor));
  if (requestedCursor >= endCursor) return { output: "", truncated: false };
  const bytes = Buffer.from(output, "utf8");
  return { output: bytes.subarray(Math.max(0, requestedCursor - startCursor)).toString("utf8"), truncated: requestedCursor < startCursor };
}

/** 将未知 Store 能力稳定归类，避免旧自定义 Port 在运行中部分写入。 */
function assertStoreCapabilities(store: JobStore): void {
  if (typeof store.create !== "function" || typeof store.compareAndSave !== "function" || typeof store.withSessionLock !== "function") {
    throw new RuntimeError("JOB_STORE_CAPABILITY_UNSUPPORTED", "JobStore 不支持 Stage1 owner/revision 条件写契约");
  }
}

/** 创建 JobService；每个 Runtime 只管理自身启动的进程树。 */
export function createJobService(options: CreateJobServiceOptions): InternalJobService {
  assertStoreCapabilities(options.store);
  const { store, ownerProbe, sessionStore } = options;
  const processes = new ProcessManager();
  const now = options.now ?? Date.now;
  const owner: JobOwner = { runtimeInstanceId: options.runtimeInstanceId ?? randomUUID(), hostProcessId: options.hostProcessId ?? process.pid };
  const pageCursorKey = randomBytes(32);
  const waiters = new Map<string, Set<() => void>>();
  activeRuntimeIds.add(owner.runtimeInstanceId);
  disposedRuntimeIds.delete(owner.runtimeInstanceId);

  /** 将 Adapter 异常收敛为稳定存储错误。 */
  function storageError(error: unknown): RuntimeError {
    return error instanceof RuntimeError ? error : new RuntimeError("JOB_STORAGE_FAILED", "Job 状态持久化失败", error);
  }

  /** 唤醒等候指定 Job 安全快照变化的读取者。 */
  function notifyJobChanged(jobId: string): void {
    const listeners = waiters.get(jobId);
    if (!listeners) return;
    waiters.delete(jobId);
    for (const listener of listeners) listener();
  }

  /** 在有界时间内等待 Job 变化；取消只结束读取，不改变 Job。 */
  function waitForJobChange(jobId: string, waitMs: number, signal?: AbortSignal): Promise<"updated" | "timeout"> {
    return new Promise(function wait(resolve, reject) {
      let settled = false;
      const listeners = waiters.get(jobId) ?? new Set<() => void>();
      waiters.set(jobId, listeners);
      /** 清理当前等待者的 timer 与 signal 监听。 */
      function cleanup(): void {
        clearTimeout(timer);
        listeners.delete(onChanged);
        if (listeners.size === 0) waiters.delete(jobId);
        signal?.removeEventListener("abort", onAbort);
      }
      /** 只结算一次等待结果。 */
      function finish(outcome: "updated" | "timeout"): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      }
      /** Job 变化时立即唤醒读取。 */
      function onChanged(): void { finish("updated"); }
      /** 取消只拒绝当前等待，不修改 Job。 */
      function onAbort(): void {
        if (settled) return;
        settled = true;
        cleanup();
        const error = new Error("后台 Job 读取已取消");
        error.name = "AbortError";
        reject(error);
      }
      listeners.add(onChanged);
      const timer = setTimeout(function timedOut() { finish("timeout"); }, waitMs);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 串行执行一次 owner/revision 条件更新，并只在成功后替换内存快照。 */
  async function transition(active: ActiveJob, mutate: (next: Job) => void): Promise<Job> {
    let result: Job | undefined;
    let failure: unknown;
    const operation = active.transitionTail.then(async function persistTransition() {
      const current = active.job;
      if (!current.owner || current.revision === undefined) throw new RuntimeError("JOB_STATE_CONFLICT", "活动 Job 缺少 owner/revision");
      const next = copy(current);
      syncOutput(active, next);
      mutate(next);
      next.updatedAt = now();
      next.revision = current.revision + 1;
      let saved: boolean;
      try { saved = await store.compareAndSave(next, { expectedRevision: current.revision, expectedOwner: current.owner }); }
      catch (error) { throw storageError(error); }
      if (!saved) throw new RuntimeError("JOB_STATE_CONFLICT", "Job owner/revision 条件更新冲突");
      active.job = next;
      active.outputDirty = false;
      active.storageFailure = undefined;
      result = copy(next);
      notifyJobChanged(next.id);
    }).catch(function rememberFailure(error) { failure = error; });
    active.transitionTail = operation;
    await operation;
    if (failure) throw failure;
    return result!;
  }

  /** 持久化活动输出；无变化时不增加 revision。 */
  async function persistOutput(active: ActiveJob): Promise<Job> {
    if (active.storageFailure) throw active.storageFailure;
    if (!active.outputDirty) return copy(active.job);
    return transition(active, function keepState() {});
  }

  /** 最多每秒合并一次活动输出持久化。 */
  function scheduleOutputPersist(active: ActiveJob): void {
    if (active.outputTimer) return;
    active.outputTimer = setTimeout(function persistLater() {
      active.outputTimer = undefined;
      void persistOutput(active).catch(function remember(error) { active.storageFailure = storageError(error); });
    }, OUTPUT_PERSIST_INTERVAL_MS);
  }

  /** 终态强制 flush 输出和 cursor，并在成功持久化后释放句柄。 */
  async function finalize(active: ActiveJob): Promise<Job> {
    await active.transitionTail;
    if (active.job.status === "stopping" && !active.stopConfirmed) return copy(active.job);
    if (active.finalizePromise) return active.finalizePromise;
    active.finalizePromise = (async function persistTerminal() {
      if (!active.closeResult) throw new RuntimeError("JOB_STATE_CONFLICT", "进程尚未产生真实 close");
      // POSIX 根自然退出也须清空原受管组；否则 close 可早于同组子孙，release 会丢失执行域。
      if (process.platform !== "win32" && !active.stopConfirmed) {
        try { await terminateManagedProcessTree(active.child); }
        catch (error) {
          const code = error instanceof ProcessTreeTerminationError && error.code === "TIMEOUT" ? "JOB_STOP_TIMEOUT" : "JOB_STOP_FAILED";
          await transition(active, function retainGroup(next) { next.status = "stopping"; next.failureCode = code; });
          throw new RuntimeError(code, "后台 Job 原进程组清理未确认", error);
        }
      }
      // 进程已产生真实 close，无论终态持久化成败都立即释放沙箱执行资源（cleanup 不依赖存储成功）。
      releaseSandbox(active);
      if (active.outputTimer) { clearTimeout(active.outputTimer); active.outputTimer = undefined; }
      if (!active.projectorFlushed) { active.projector.flush(); active.projectorFlushed = true; active.outputDirty = true; }
      const terminal = await transition(active, function markTerminal(next) {
        next.status = next.status === "stopping" ? "stopped" : next.status === "starting" ? "failed" : active.closeResult!.exitCode === 0 ? "completed" : "failed";
        if (next.status === "stopped") delete next.failureCode;
        if (active.job.status === "starting") next.failureCode = "JOB_STORAGE_FAILED";
        next.exitCode = active.closeResult!.exitCode ?? undefined;
        // 只识别 runner 固定的目标启动失败签名，不把任意工具 stderr 推断为沙箱错误。
        next.execution = projectJobCloseFacts(active.stderr.readSince(0).output, active.closeResult!.signal);
        next.finishedAt = now();
      });
      processes.delete(active.job.id);
      return terminal;
    })();
    try { return await active.finalizePromise; }
    catch (error) { active.finalizePromise = undefined; active.storageFailure = storageError(error); throw error; }
  }

  /** owner 探测先处理当前进程内 Runtime 注册表，再调用 Adapter 的 PID 三态。 */
  async function probeStoredOwner(jobOwner: JobOwner): Promise<JobOwnerLiveness> {
    if (jobOwner.hostProcessId === process.pid) {
      if (activeRuntimeIds.has(jobOwner.runtimeInstanceId)) return "alive";
      if (disposedRuntimeIds.has(jobOwner.runtimeInstanceId)) return "dead";
      return "unknown";
    }
    try { return await ownerProbe.probe(jobOwner); }
    catch { return "unknown"; }
  }

  /** 只在 owner 明确死亡时以 CAS 将新格式活动记录恢复为 interrupted。 */
  async function recoverStored(job: Job): Promise<Job> {
    if (!isActiveStatus(job.status) || processes.has(job.id)) return job;
    if (job.jobRecordVersion !== JOB_RECORD_VERSION || !job.owner || job.revision === undefined) return job;
    const liveness = await probeStoredOwner(job.owner);
    if (liveness !== "dead") return job;
    const next = copy(job);
    next.status = "interrupted";
    next.finishedAt = now();
    next.updatedAt = next.finishedAt;
    next.revision = job.revision + 1;
    let saved: boolean;
    try { saved = await store.compareAndSave(next, { expectedRevision: job.revision, expectedOwner: job.owner }); }
    catch (error) { throw storageError(error); }
    if (saved) return next;
    const current = await store.get(job.id);
    if (!current) throw new RuntimeError("JOB_STATE_CONFLICT", "Job 恢复时记录已消失");
    return current;
  }

  /** 创建并持久化 spawn 失败终态，不把 starting 留作伪活动记录。 */
  async function failStartingJob(active: ActiveJob): Promise<Job> {
    // 目标进程从未成功启动，已 prepare 的沙箱包装资源立即释放，不等待后续 close。
    releaseSandbox(active);
    if (!active.projectorFlushed) { active.projector.flush(); active.projectorFlushed = true; }
    const failed = await transition(active, function markSpawnFailure(next) {
      next.status = "failed";
      next.failureCode = "JOB_SPAWN_FAILED";
      next.execution = { phase: "wrapper_spawn_failed", targetState: "not_started" };
      next.finishedAt = now();
    });
    processes.delete(active.job.id);
    return failed;
  }

  /** 启动一个经 ToolExecutor 授权且已确认可沙箱执行的非 shell 子进程。 */
  async function start(input: StartJobInput): Promise<Job> {
    input.signal?.throwIfAborted();
    // 后台与前台共用同一边界：没有已解析的冻结沙箱范围就不创建任何进程，
    // 防止绕过 ToolExecutor 的直接调用退化为裸 spawn（fail-closed，不降级）。
    const sandboxBinding = input.sandbox;
    if (!sandboxBinding) throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "沙箱未就绪，无法提供已隔离执行，后台 Job 未启动");
    await assertExternalJobDispatch({ program: input.program, args: input.args, cwd: input.cwd, ...(input.externalWriteTarget !== undefined ? { externalWriteTarget: input.externalWriteTarget } : {}) }, { workspaceRoot: input.workspaceRoot, permissionMode: "ask", executionSessionId: input.sessionId, toolCallId: input.toolCallId, sandboxPolicy: sandboxBinding });
    return store.withSessionLock(input.sessionId, async function registerJob() {
      input.signal?.throwIfAborted();
      const session = await sessionStore.get(input.sessionId);
      if (!session) throw new RuntimeError("SESSION_NOT_FOUND", "后台 Job 所属 Session 不存在");
      const cwd = await resolveFileTarget(input.workspaceRoot, input.cwd);
      if (!cwd.exists) throw new RuntimeError("INVALID_INPUT", "后台 Job 工作目录不存在");
      input.signal?.throwIfAborted();
      const startedAt = now();
      const projector = new JobOutputProjector({ sensitiveValues: Object.entries(process.env).filter(function sensitiveEntry([key]) { return /API[_-]?KEY|TOKEN|PASSWORD|SECRET/i.test(key); }).map(function secretValue([, value]) { return value ?? ""; }) });
      const job: Job = {
        jobRecordVersion: JOB_RECORD_VERSION,
        id: randomUUID(), workspaceId: input.workspaceId, sessionId: input.sessionId, turnId: input.turnId,
        program: input.program, args: [...input.args], cwd: cwd.isExternal ? cwd.canonicalTarget : cwd.relativePath!, status: "starting", owner, revision: 0,
        startedAt, updatedAt: startedAt,
        output: { stdout: "", stderr: "", stdoutCursor: 0, stderrCursor: 0, stdoutStartCursor: 0, stderrStartCursor: 0, totalStdoutBytes: 0, totalStderrBytes: 0, stdoutTruncated: false, stderrTruncated: false },
        safeOutput: projector.snapshot(),
        // durable 记录只保存安全 policy 摘要：模式 + 冻结摘要 + 版本，不含代理 env、deny 路径明细或执行句柄。
        sandbox: {
          mode: sandboxBinding.policy.mode,
          policyDigest: computeSandboxPolicyDigest(sandboxBinding.policy),
          policyVersion: SANDBOX_POLICY_VERSION,
        },
      };
      let created: boolean;
      try { created = await store.create(job); }
      catch (error) { throw storageError(error); }
      if (!created) throw new RuntimeError("JOB_STATE_CONFLICT", "Job ID 已存在");

      let child: ChildProcess;
      let prepared: SandboxPreparedCommand | undefined;
      let spawnObserved = false;
      let spawnPromise: Promise<void>;
      try {
        input.signal?.throwIfAborted();
        // 包装顺序固定：受信解析（含 Windows npm/npx 固定 CLI 与 realpath containment）
        // → SandboxPort.prepare 生成沙箱包装 argv → spawn；平台解析结果不回退拼接 shell。
        const command = resolveManagedCommand(input.program, input.args);
        prepared = await sandboxBinding.port.prepare({
          commandId: sandboxBinding.policy.externalWriteCapability?.executionId ?? randomUUID(),
          program: command.executable,
          args: command.args,
          cwd: cwd.canonicalTarget,
          policy: sandboxBinding.policy,
          managed: true,
        });
        if (prepared.control && prepared.control.protocolVersion !== 1) throw new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "未知执行控制协议");
        child = spawn(prepared.executable, [...prepared.args], { cwd: cwd.canonicalTarget, detached: process.platform !== "win32", shell: false, windowsHide: true, stdio: prepared.control ? ["pipe", "pipe", "pipe", "pipe"] : "pipe", env: { ...process.env, ...prepared.env } });
        // 先观察真实启动/error，再绑定私有通道；bind 抛错也不能遗漏异步 ENOENT 或活跃 wrapper。
        spawnPromise = new Promise<void>(function observeSpawn(resolve, reject) {
          child.once("spawn", function spawned() { spawnObserved = true; resolve(); });
          child.on("error", function failed(error) { reject(error); });
        });
        void spawnPromise.catch(function retainSpawnFailureUntilHandled() {});
      }
      catch (error) {
        const placeholder = { child: { pid: undefined } as ChildProcess, job, stdout: new BoundedOutputBuffer(JOB_OUTPUT_LIMIT), stderr: new BoundedOutputBuffer(JOB_OUTPUT_LIMIT), projector, stdinBytes: 0, stdinClosed: true, outputDirty: false, transitionTail: Promise.resolve(), closeResult: { exitCode: null }, initialized: true, projectorFlushed: false, ...(prepared ? { sandboxExecution: { port: sandboxBinding.port, executionId: prepared.executionId } } : {}) } satisfies ActiveJob;
        await failStartingJob(placeholder);
        input.signal?.throwIfAborted();
        // 沙箱拒绝/runner 失败是稳定的沙箱错误词汇，原样透出由工具层投影稳定错误码。
        if (error instanceof SandboxPortError) throw error;
        throw new RuntimeError("JOB_SPAWN_FAILED", "后台 Job 启动失败", error);
      }

      const active: ActiveJob = { child, job, stdout: new BoundedOutputBuffer(JOB_OUTPUT_LIMIT), stderr: new BoundedOutputBuffer(JOB_OUTPUT_LIMIT), projector, stdinBytes: 0, stdinClosed: false, outputDirty: false, transitionTail: Promise.resolve(), initialized: false, projectorFlushed: false, sandboxExecution: { port: sandboxBinding.port, executionId: prepared.executionId, control: prepared.control } };
      processes.set(job.id, active);
      child.stdout?.on("data", function captureStdout(chunk: Buffer) { active.stdout.append(chunk); active.projector.append("stdout", chunk); active.outputDirty = true; scheduleOutputPersist(active); notifyJobChanged(job.id); });
      child.stderr?.on("data", function captureStderr(chunk: Buffer) { active.stderr.append(chunk); active.projector.append("stderr", chunk); active.outputDirty = true; scheduleOutputPersist(active); notifyJobChanged(job.id); });
      child.once("close", function recordClose(exitCode, signal) {
        active.closeResult = { exitCode, signal };
        if (active.initialized) void finalize(active).catch(function remember(error) { active.storageFailure = storageError(error); });
      });

      try {
        if (prepared.control) {
          const stream = child.stdio[3] as Duplex | null;
          if (!stream) throw new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "私有执行控制通道缺失");
          prepared.control.bind({ incoming: stream, send: function send(bytes) { stream.write(bytes); }, close: function close() { stream.destroy(); } });
        }
        await spawnPromise;
      } catch (error) {
        active.stdinClosed = true;
        // 没有 PID 时等待启动观察，只有明确未创建包装进程的异步 error 才能落 not_started。
        let neverSpawned = false;
        if (!spawnObserved && child.pid === undefined) {
          try { await spawnPromise; }
          catch { neverSpawned = !spawnObserved && child.pid === undefined; }
        }
        if (neverSpawned) {
          await failStartingJob(active);
        } else {
          await transition(active, function retainFailedBinding(next) {
            next.status = "stopping";
            next.failureCode = "JOB_SPAWN_FAILED";
            next.execution = { phase: "wrapper_running", targetState: "unknown" };
          });
          active.initialized = true;
          // 与正常停止共用容器空/close门禁；确认失败保留注册和资源，后续 close 不抢先释放。
          try { await stopActive(active, "agent"); }
          catch { /* stopActive 已保存失败状态；原启动失败仍返回调用方。 */ }
        }
        throw new RuntimeError("JOB_SPAWN_FAILED", "后台 Job 启动失败", error);
      }

      try { await transition(active, function markRunning(next) { next.status = "running"; next.execution = { phase: "wrapper_running", targetState: "unknown" }; }); }
      catch (error) {
        active.stdinClosed = true;
        try { await terminateManagedProcessTree(child); } catch { /* 句柄继续由 ProcessManager 保留，供 shutdown 重试。 */ }
        if (active.closeResult) {
          try { await finalize(active); } catch { /* 返回最初的稳定存储错误，终态写入仍可由后续 close/get 重试。 */ }
        }
        throw storageError(error);
      }
      active.initialized = true;
      if (input.signal?.aborted) {
        await stopActive(active, "agent");
        input.signal.throwIfAborted();
      }
      if (active.closeResult) return finalize(active);
      return copy(active.job);
    });
  }

  /** 按原始字节 cursor 返回兼容增量；新模型／宿主必须改用 readOutput。 */
  async function poll(input: PollJobInput): Promise<JobPollResult> {
    const active = processes.get(input.id);
    if (active?.closeResult) await finalize(active);
    else if (active) await persistOutput(active);
    const job = active?.job ?? await get(input.id);
    if (!job) throw new RuntimeError("JOB_NOT_FOUND", `Job ${input.id} 不存在`);
    const stdout = active ? active.stdout.readSince(input.stdoutCursor) : readStoredOutput(job.output.stdout, job.output.stdoutStartCursor ?? 0, job.output.stdoutCursor, input.stdoutCursor);
    const stderr = active ? active.stderr.readSince(input.stderrCursor) : readStoredOutput(job.output.stderr, job.output.stderrStartCursor ?? 0, job.output.stderrCursor, input.stderrCursor);
    return { job: copy(job), stdout: stdout.output, stderr: stderr.output, nextStdoutCursor: job.output.stdoutCursor, nextStderrCursor: job.output.stderrCursor, stdoutStartCursor: job.output.stdoutStartCursor ?? 0, stderrStartCursor: job.output.stderrStartCursor ?? 0, truncated: job.output.stdoutTruncated || job.output.stderrTruncated || stdout.truncated || stderr.truncated };
  }

  /** 返回安全双流输出；旧记录从受限原始快照生成只读窗口。 */
  async function readOutput(input: { id: string; stdoutCursor?: string; stderrCursor?: string; maxBytesPerStream?: number }): Promise<JobOutputView> {
    const active = processes.get(input.id);
    if (active?.closeResult) await finalize(active);
    else if (active) await persistOutput(active);
    if (active) return active.projector.read(input);
    const stored = await store.get(input.id);
    if (!stored) throw new RuntimeError("JOB_NOT_FOUND", `Job ${input.id} 不存在`);
    if (stored.safeOutput) return readStoredJobOutput(stored.safeOutput, input);
    const legacy = new JobOutputProjector({ epoch: `legacy-${stored.id}` });
    legacy.append("stdout", Buffer.from(stored.output.stdout, "utf8"));
    legacy.append("stderr", Buffer.from(stored.output.stderr, "utf8"));
    legacy.flush();
    return legacy.read(input);
  }

  /** 向活动 Job 写入受限 stdin；关闭后的 stdin 不允许重开。 */
  async function write(input: { id: string; data: string }): Promise<void> {
    const active = processes.get(input.id);
    if (!active || active.stdinClosed || active.job.status !== "running" || !active.child.stdin?.writable) throw new RuntimeError("JOB_OWNER_UNAVAILABLE", "Job stdin 已关闭或不属于当前 Runtime");
    const bytes = Buffer.byteLength(input.data, "utf8");
    if (bytes > JOB_STDIN_SINGLE_LIMIT || active.stdinBytes + bytes > JOB_STDIN_TOTAL_LIMIT) throw new RuntimeError("JOB_INPUT_INVALID", "Job stdin 超出受限字节预算");
    active.stdinBytes += bytes;
    await new Promise<void>(function writeStdin(resolve, reject) { active.child.stdin!.write(input.data, function written(error) { if (error) reject(error); else resolve(); }); });
  }

  /** 真正停止当前 Runtime 拥有的 Job；失败或超时保留句柄和 stopping。 */
  async function stopActive(active: ActiveJob, source: "agent" | "host" | "legacy_api"): Promise<Job> {
    if (active.stopPromise) return active.stopPromise;
    active.stopPromise = (async function stopOwnedProcess() {
      if (active.closeResult && active.job.status !== "stopping") return finalize(active);
      if (active.closeResult && !active.stopConfirmed && !active.sandboxExecution?.control) throw new RuntimeError("JOB_STOP_FAILED", "父进程已退出但进程树停止尚未确认");
      active.stdinClosed = true;
      await transition(active, function markStopping(next) {
        if (active.closeResult && next.status !== "stopping") return;
        next.status = "stopping";
        next.lastControl = { action: "stop", source, at: now() };
      });
      if (active.closeResult && active.job.status !== "stopping") return finalize(active);
      try {
        if (active.sandboxExecution?.control) {
          const confirmation = await active.sandboxExecution.control.stop();
          if (confirmation.evidence !== "container_empty") throw new ProcessTreeTerminationError("FAILED");
          // 私有回执只证明容器空；仍独立等待包装 close 后才能落 stopped。
          if (!active.closeResult) await new Promise<void>(function waitForWrapper(resolve, reject) {
            const timeout = setTimeout(function timedOut() { active.child.off("close", closed); reject(new ProcessTreeTerminationError("TIMEOUT")); }, 5_000);
            function closed() { clearTimeout(timeout); resolve(); }
            active.child.once("close", closed);
            if (active.closeResult) { active.child.off("close", closed); closed(); }
          });
        } else {
          await terminateManagedProcessTree(active.child);
          if (process.platform === "win32" && active.sandboxExecution) throw new ProcessTreeTerminationError("FAILED");
        }
      }
      catch (error) {
        const code = error instanceof ProcessTreeTerminationError && error.code === "TIMEOUT" ? "JOB_STOP_TIMEOUT" : "JOB_STOP_FAILED";
        await transition(active, function recordStopFailure(next) { next.failureCode = code; });
        throw new RuntimeError(code, code === "JOB_STOP_TIMEOUT" ? "后台 Job 停止超时" : "后台 Job 停止失败", error);
      }
      if (!active.closeResult) throw new RuntimeError("JOB_STOP_FAILED", "停止命令完成但未观察到目标进程 close");
      active.stopConfirmed = true;
      return finalize(active);
    })();
    try { return await active.stopPromise; }
    catch (error) { active.stopPromise = undefined; throw error; }
  }

  /** 停止指定 Job；非 owner 活动记录只返回稳定拒绝，终态重复调用幂等。 */
  async function killWithSource(id: string, source: "agent" | "host" | "legacy_api"): Promise<Job> {
    const active = processes.get(id);
    if (active) return stopActive(active, source);
    const stored = await store.get(id);
    if (!stored) throw new RuntimeError("JOB_NOT_FOUND", `Job ${id} 不存在`);
    if (!isActiveStatus(stored.status)) return stored;
    const recovered = await recoverStored(stored);
    if (!isActiveStatus(recovered.status)) return recovered;
    if (!recovered.owner || recovered.revision === undefined) throw new RuntimeError("JOB_OWNER_UNKNOWN", "Job owner 无法确认，禁止停止");
    const liveness = await probeStoredOwner(recovered.owner);
    throw new RuntimeError(liveness === "unknown" ? "JOB_OWNER_UNKNOWN" : "JOB_OWNER_UNAVAILABLE", "Job 不属于当前 Runtime，禁止停止");
  }

  /** 兼容旧公共入口；新工具和宿主必须使用 forSession 的绑定操作。 */
  async function kill(id: string): Promise<Job> { return killWithSource(id, "legacy_api"); }

  /** 列出 workspace Job；只恢复 owner 明确死亡的新格式活动记录。 */
  async function list(workspaceId: string): Promise<Job[]> { return Promise.all((await store.list(workspaceId)).map(recoverStored)); }

  /** 读取 Job；活动 owner 的输出先按需持久化。 */
  async function get(id: string): Promise<Job | null> {
    const active = processes.get(id);
    if (active?.closeResult) return finalize(active);
    if (active) return persistOutput(active);
    const stored = await store.get(id);
    return stored ? recoverStored(stored) : null;
  }

  /** 判断 Session 是否仍有活动或不明 owner Job，供删除冲突门禁使用。 */
  async function hasActiveJobs(sessionId: string): Promise<boolean> {
    const recovered = await Promise.all((await store.listBySession(sessionId)).map(recoverStored));
    return recovered.some(function activeJob(job) { return isActiveStatus(job.status); });
  }

  /** 校验 durable Session 的 Work 身份及其 canonical Project 工作区。 */
  async function validateSessionBinding(binding: { workspaceId: string; sessionId: string }): Promise<void> {
    const session = await sessionStore.get(binding.sessionId);
    if (!session) throw new RuntimeError("SESSION_NOT_FOUND", "后台 Job 所属 Session 不存在");
    if (readSessionIdentity(session).productMode !== "work") throw new RuntimeError("SESSION_MODE_MISMATCH", "Chat Session 不提供后台 Job 管理能力");
    if (!options.projectStore || !session.projectId) throw new RuntimeError("WORKSPACE_REQUIRED", "后台 Job 管理需要可验证的 Work Project 归属");
    const project = await options.projectStore.get(session.projectId);
    if (!project || project.workspaceRoot !== binding.workspaceId) throw new RuntimeError("WORKSPACE_REQUIRED", "Session 不属于当前工作区");
  }

  /** 将内部 Job 投影为不含命令、路径、PID 与 owner 的安全视图。 */
  async function createJobView(job: Job): Promise<JobView> {
    let controlState: JobControlState;
    if (!isActiveStatus(job.status)) controlState = "terminal";
    else if (processes.has(job.id)) controlState = "owned";
    else if (!job.owner || job.revision === undefined || sameOwner(job.owner, owner)) controlState = "owner_unknown";
    else controlState = await probeStoredOwner(job.owner) === "alive" ? "foreign_owner" : "owner_unknown";
    return {
      jobId: job.id,
      status: job.status,
      controlState,
      canStop: controlState === "owned" && isActiveStatus(job.status),
      revision: job.revision,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      execution: job.execution ? { ...job.execution } : undefined,
      failureCode: job.failureCode,
      stdoutBytes: job.output.totalStdoutBytes,
      stderrBytes: job.output.totalStderrBytes,
      outputTruncated: job.output.stdoutTruncated || job.output.stderrTruncated || Boolean(job.safeOutput?.stdout.truncated || job.safeOutput?.stderr.truncated),
      lastControl: job.lastControl ? { ...job.lastControl } : undefined,
    };
  }

  /** 为当前 Runtime 的分页游标签名，防止跨 Session/Workspace 重放。 */
  function encodePageCursor(binding: { workspaceId: string; sessionId: string }, offset: number): string {
    const scope = createHmac("sha256", pageCursorKey).update(`${binding.workspaceId}\0${binding.sessionId}`).digest("base64url");
    const signature = createHmac("sha256", pageCursorKey).update(`${scope}:${offset}`).digest("base64url");
    return Buffer.from(JSON.stringify({ offset, signature }), "utf8").toString("base64url");
  }

  /** 解码并验证分页游标；畸形、跨绑定或进程重启后的游标稳定拒绝。 */
  function decodePageCursor(binding: { workspaceId: string; sessionId: string }, cursor: string | undefined): number {
    if (!cursor) return 0;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown; signature?: unknown };
      if (!Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0 || typeof parsed.signature !== "string") throw new Error("invalid");
      const scope = createHmac("sha256", pageCursorKey).update(`${binding.workspaceId}\0${binding.sessionId}`).digest("base64url");
      const expected = Buffer.from(createHmac("sha256", pageCursorKey).update(`${scope}:${parsed.offset}`).digest("base64url"));
      const actual = Buffer.from(parsed.signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid");
      return parsed.offset as number;
    } catch {
      throw new RuntimeError("JOB_CURSOR_INVALID", "后台 Job 分页游标无效或已过期");
    }
  }

  /** 读取并校验当前绑定中的单个 Job；越界 ID 不泄露其真实归属。 */
  async function getScopedJob(binding: { workspaceId: string; sessionId: string }, jobId: string): Promise<Job> {
    const job = await store.get(jobId);
    if (!job || job.workspaceId !== binding.workspaceId || job.sessionId !== binding.sessionId) throw new RuntimeError("JOB_NOT_FOUND", "当前 Session 中不存在该 Job");
    const current = await get(jobId);
    if (!current || current.workspaceId !== binding.workspaceId || current.sessionId !== binding.sessionId) throw new RuntimeError("JOB_NOT_FOUND", "当前 Session 中不存在该 Job");
    return current;
  }

  /** 创建绑定当前 Work Session 的 list/read/stop 管理视图。 */
  function forSession(binding: { workspaceId: string; sessionId: string }): SessionJobService {
    const scopedBinding = { ...binding };

    /** 活动任务优先，终态按完成时间倒序，ID 保证稳定次排序。 */
    async function listScoped(input: { limit?: number; pageCursor?: string } = {}): Promise<JobListView> {
      await validateSessionBinding(scopedBinding);
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RuntimeError("INVALID_INPUT", "后台 Job 列表 limit 必须在 1 到 100 之间");
      const offset = decodePageCursor(scopedBinding, input.pageCursor);
      const jobs = await Promise.all((await store.list(scopedBinding.workspaceId))
        .filter(function sameSession(job) { return job.sessionId === scopedBinding.sessionId; })
        .map(recoverStored));
      jobs.sort(function compareJobs(left, right) {
        const leftActive = isActiveStatus(left.status) ? 1 : 0;
        const rightActive = isActiveStatus(right.status) ? 1 : 0;
        if (leftActive !== rightActive) return rightActive - leftActive;
        if (leftActive) return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
        return (right.finishedAt ?? right.updatedAt) - (left.finishedAt ?? left.updatedAt) || left.id.localeCompare(right.id);
      });
      const selected = jobs.slice(offset, offset + limit);
      return {
        jobs: await Promise.all(selected.map(createJobView)),
        totalCount: jobs.length,
        activeCount: jobs.filter(function activeJob(job) { return isActiveStatus(job.status); }).length,
        nextPageCursor: offset + selected.length < jobs.length ? encodePageCursor(scopedBinding, offset + selected.length) : undefined,
      };
    }

    /** 读取有限安全输出；只在无新观察且仍活动时进入有界等待。 */
    async function readScoped(input: { jobId: string; stdoutCursor?: string; stderrCursor?: string; waitMs?: number; signal?: AbortSignal }): Promise<JobReadView> {
      await validateSessionBinding(scopedBinding);
      const waitMs = input.waitMs ?? 0;
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new RuntimeError("INVALID_INPUT", "后台 Job 读取 waitMs 必须在 0 到 30000 之间");
      const deadline = now() + waitMs;
      while (true) {
        const job = await getScopedJob(scopedBinding, input.jobId);
        const output = await readOutput({ id: job.id, stdoutCursor: input.stdoutCursor, stderrCursor: input.stderrCursor, maxBytesPerStream: SAFE_READ_STREAM_LIMIT });
        const terminal = !isActiveStatus(job.status);
        const observed = output.stdout.text.length > 0 || output.stderr.text.length > 0 || output.stdout.gap || output.stderr.gap || output.stdout.resetRequired || output.stderr.resetRequired;
        if (terminal) return { job: await createJobView(job), output, waitOutcome: "terminal" };
        if (waitMs === 0 || observed) return { job: await createJobView(job), output, waitOutcome: "snapshot" };
        const remaining = deadline - now();
        if (remaining <= 0) return { job: await createJobView(job), output, waitOutcome: "timeout" };
        const outcome = await waitForJobChange(job.id, remaining, input.signal);
        if (outcome === "timeout") {
          const latest = await getScopedJob(scopedBinding, input.jobId);
          const latestOutput = await readOutput({ id: latest.id, stdoutCursor: input.stdoutCursor, stderrCursor: input.stderrCursor, maxBytesPerStream: SAFE_READ_STREAM_LIMIT });
          return { job: await createJobView(latest), output: latestOutput, waitOutcome: isActiveStatus(latest.status) ? "timeout" : "terminal" };
        }
      }
    }

    /** 在归属校验后停止当前 Runtime 持有的 Job，并返回真实安全终态。 */
    async function stopScoped(input: { jobId: string; source: "agent" | "host" }): Promise<JobView> {
      await validateSessionBinding(scopedBinding);
      await getScopedJob(scopedBinding, input.jobId);
      return createJobView(await killWithSource(input.jobId, input.source));
    }

    return { list: listScoped, read: readScoped, stop: stopScoped };
  }

  /** Runtime 退出时有界停止全部自有 Job；全部成功后才记录 dispose。 */
  async function shutdown(): Promise<void> {
    await Promise.all(processes.ids().map(function stop(id) { return kill(id); }));
    activeRuntimeIds.delete(owner.runtimeInstanceId);
    disposedRuntimeIds.add(owner.runtimeInstanceId);
  }

  /** 串行化 Session 删除与 Job 启动登记。 */
  function withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> { return store.withSessionLock(sessionId, operation); }

  return { start, poll, readOutput, write, kill, list, get, hasActiveJobs, forSession, shutdown, withSessionLock };
}
