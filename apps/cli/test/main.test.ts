/** CLI 入口契约测试：帮助、usage error 和 Step 5.3 Runtime 委托。 */

import { AgentRuntimeError, type AgentEvent, type AgentRuntime } from "@autopilot-agent/core";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { exitCodeForSignal, main, type CliMainDependencies, type CliSignalSource } from "../src/main.js";
import type { CliCompositionRoot } from "../src/composition-root.js";

/** 创建可捕获 stdout/stderr 的测试流。 */
function createStreams(): { stdout: { write(chunk: string): void; value: string }; stderr: { write(chunk: string): void; value: string }; stdin?: NodeJS.ReadableStream } {
  const stdout = { value: "", write(chunk: string) { stdout.value += chunk; } };
  const stderr = { value: "", write(chunk: string) { stderr.value += chunk; } };
  return { stdout, stderr };
}

/** 将测试事件转换为 CLI Runtime 所需的异步事件流。 */
async function* eventStream(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const event of events) yield event;
}

/** 创建不会注册真实进程监听器的信号 double。 */
function createSignalSource(): CliSignalSource & { emit(signal: "SIGINT" | "SIGTERM"): void; listenerCount(signal: "SIGINT" | "SIGTERM"): number } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    on(signal, listener) {
      const group = listeners.get(signal) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(signal, group);
    },
    removeListener(signal, listener) {
      listeners.get(signal)?.delete(listener);
    },
    emit(signal) {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
    listenerCount(signal) {
      return listeners.get(signal)?.size ?? 0;
    },
  };
}

/** 创建最小 Core Runtime double，验证 argv 到 Project/Session/Turn 的纵向委托。 */
function createRuntimeDouble(): AgentRuntime {
  return {
    projects: {
      list: async function list() { return []; },
      create: async function create(input) { return { id: "project-1", name: input.name, workspaceRoot: input.workspaceRoot, createdAt: 1, updatedAt: 1 }; },
      get: async function get() { return null; },
      save: async function save() { return undefined; },
      delete: async function deleteProject() { return false; },
    },
    sessions: {
      create: async function create(input) { return { id: "session-1", projectId: input.projectId, persistenceMode: "durable", status: "idle", createdAt: 1, updatedAt: 1 }; },
      get: async function get() { return null; },
      list: async function list() { return []; },
      save: async function save() { return undefined; },
      setDefaultRunConfig: async function setDefaultRunConfig() { throw new Error("unused"); },
      rename: async function rename() { throw new Error("unused"); },
      delete: async function deleteSession() { return false; },
    },
    turns: {
      start: function start() {
        return eventStream([
          { type: "turn_started", turnId: "turn-1", stepCount: 0 },
          { type: "answer_delta", turnId: "turn-1", stepId: "step-1", delta: "done" },
          { type: "turn_completed", turnId: "turn-1", checkpoint: { turnId: "turn-1", status: "completed", stepCount: 1, messages: [], completedCallIds: [] } },
        ] as AgentEvent[]);
      },
      continue: function continueTurn() { return eventStream([]); },
      cancel: async function cancel() { return undefined; },
      steer: async function steer() { throw new Error("unused"); },
      compact: async function compact() { throw new Error("unused"); },
      getState: async function getState() { return { turn: null, checkpoint: null, events: [] }; },
      getRecoverableState: async function getRecoverableState() { return null; },
    },
    approvals: {
      submit: async function submit() { throw new Error("unused"); },
      getDecision: async function getDecision() { return null; },
      hasPersistentGrant: async function hasPersistentGrant() { return false; },
    },
    inbox: {} as AgentRuntime["inbox"],
  } as AgentRuntime;
}

/** 鍒涘缓浼氬湪 turn 鎵ц涓瓑寰呭彇娑堢殑 Runtime double锛岀敤浜庡疄闃呮鏌ョ洿鎺ュ彿澶勭悊銆?*/
function createCancellableRuntime(state: { started: boolean; cancelled: boolean; release?: () => void }): AgentRuntime {
  const runtime = createRuntimeDouble();
  runtime.turns.start = function start() {
    return (async function* cancellableEvents(): AsyncGenerator<AgentEvent> {
      state.started = true;
      yield { type: "turn_started", turnId: "turn-1", stepCount: 0 } as AgentEvent;
      await new Promise<void>(function waitForCancel(resolve) { state.release = resolve; });
      yield {
        type: "turn_interrupted",
        turnId: "turn-1",
        checkpoint: { turnId: "turn-1", status: "interrupted", stepCount: 1, messages: [], completedCallIds: [] },
      } as AgentEvent;
    })();
  };
  runtime.turns.cancel = async function cancel() {
    state.cancelled = true;
    state.release?.();
  };
  return runtime;
}

/** 创建测试 Composition Root；信任和 Runtime 均不触碰真实工作区。 */
function createCompositionRoot(): { root: CliCompositionRoot; dependencies: CliMainDependencies } {
  const runtime = createRuntimeDouble();
  const root = {
    stateRoot: "C:/state",
    ensureUserConfigDirectory: function ensureUserConfigDirectory() { return undefined; },
    ensureProjectAutopilotDirectory: function ensureProjectAutopilotDirectory() { return undefined; },
    establishTrust: async function establishTrust() { return { workspaceRoot: "C:/workspace", trustEntry: { workspaceRoot: "C:/workspace", status: "trusted", source: "test" } }; },
    resolveTrust: async function resolveTrust() { return { workspaceRoot: "C:/workspace", trustEntry: { workspaceRoot: "C:/workspace", status: "trusted", source: "test" } }; },
    grantTrust: async function grantTrust() { return { workspaceRoot: "C:/workspace", status: "trusted", source: "test" }; },
    getTrustStatus: async function getTrustStatus() { return { workspaceRoot: "C:/workspace", status: "trusted", source: "test" }; },
    createRuntime: async function createRuntime() { return runtime; },
    bootstrap: async function bootstrap() { return runtime; },
    getBootstrapService: function getBootstrapService() { throw new Error("unused"); },
    getStartupConfigurationError: function getStartupConfigurationError() { return undefined; },
    getRuntimeStatusDefaults: function getRuntimeStatusDefaults() { return {}; },
    listSkills: async function listSkills() { return []; },
    resolveSkill: async function resolveSkill() { return { skillId: "skill-1", contentHash: "hash-1" }; },
  } as unknown as CliCompositionRoot;
  return { root, dependencies: { createCompositionRoot: function createCompositionRoot() { return root; }, signalSource: createSignalSource(), cwd: "C:/workspace" } };
}

describe("CLI main", function cliMainSuite() {
  it("帮助返回 0 并写 stdout", async function returnsSuccessForHelp() {
    const streams = createStreams();
    await expect(main(["--help"], streams)).resolves.toBe(0);
    expect(streams.stdout.value).toContain("Usage:");
    expect(streams.stderr.value).toBe("");
  });

  it("未知参数返回 2 并写 stderr", async function returnsUsageError() {
    const streams = createStreams();
    await expect(main(["--unknown"], streams)).resolves.toBe(2);
    expect(streams.stderr.value).toContain("未知选项 --unknown");
    expect(streams.stdout.value).toBe("");
  });

  it("Runtime 错误写入 stderr 前会移除凭据和绝对路径", async function sanitizesRuntimeErrorOutput() {
    const streams = createStreams();
    const setup = createCompositionRoot();
    setup.root.resolveTrust = async function resolveTrustFailure() {
      throw new AgentRuntimeError("INVALID_INPUT", "api_key=runtime-secret-value C:/private/workspace.txt");
    };

    await expect(main(["chat", "hello", "--output", "text"], streams, setup.dependencies)).resolves.toBe(1);
    expect(streams.stdout.value).toBe("");
    expect(streams.stderr.value).toContain("INVALID_INPUT");
    expect(streams.stderr.value).toContain("api_key=[redacted]");
    expect(streams.stderr.value).toContain("[path]");
    expect(streams.stderr.value).not.toContain("runtime-secret-value");
    expect(streams.stderr.value).not.toContain("private/workspace.txt");
  });

  it("chat 通过 Composition Root 创建 Project/Session 后委托 Runtime start", async function delegatesRuntimeStart() {
    const streams = createStreams();
    const setup = createCompositionRoot();
    await expect(main(["chat", "hello", "--output", "text"], streams, setup.dependencies)).resolves.toBe(0);
    expect(streams.stdout.value).toContain("answer: done");
    // 非 TTY 执行业务命令会先向 stderr 写联网数据流告知（r003 起固定行为）。
    expect(streams.stderr.value).toContain("启用网络搜索");
  });

  it("未信任工作区在非 TTY 下 fail closed 且不创建 Runtime", async function failsClosedForUntrustedNonTty() {
    const streams = createStreams();
    const setup = createCompositionRoot();
    const ensureProjectAutopilotDirectory = vi.fn();
    setup.root.ensureProjectAutopilotDirectory = ensureProjectAutopilotDirectory;
    setup.root.resolveTrust = async function resolveUntrusted() {
      return { workspaceRoot: "C:/workspace", trustEntry: { workspaceRoot: "C:/workspace", status: "pending", source: "default" } };
    };
    let runtimeCreated = false;
    setup.root.createRuntime = async function createRuntime() {
      runtimeCreated = true;
      return createRuntimeDouble();
    };

    await expect(main(["chat", "hello", "--output", "text"], streams, setup.dependencies)).resolves.toBe(1);
    expect(streams.stdout.value).toBe("");
    expect(streams.stderr.value).toContain("WORKSPACE_TRUST_REQUIRED: pending");
    expect(runtimeCreated).toBe(false);
    expect(ensureProjectAutopilotDirectory).not.toHaveBeenCalled();
  });

  it("Stage 10 Session 管理通过 Core Public API，非 TTY 删除必须显式 --yes", async function managesSessionsThroughCoreApi() {
    const streams = createStreams();
    const setup = createCompositionRoot();
    const runtime = createRuntimeDouble();
    const session = { id: "session-managed", projectId: "project-1", persistenceMode: "durable" as const, status: "idle" as const, title: "会话", createdAt: 1, updatedAt: 2 };
    let deleted = false;
    runtime.sessions.list = async function list() { return [session]; };
    runtime.sessions.rename = async function rename(id, title) { return { ...session, id, title, updatedAt: 3 }; };
    runtime.sessions.delete = async function deleteSession(id) { deleted = id === session.id; return deleted; };
    setup.root.createRuntime = async function createRuntime() { return runtime; };

    await expect(main(["session", "list"], streams, setup.dependencies)).resolves.toBe(0);
    expect(streams.stdout.value).toContain("session-managed");
    const noConfirmation = createStreams();
    await expect(main(["session", "delete", "session-managed"], noConfirmation, setup.dependencies)).resolves.toBe(2);
    expect(deleted).toBe(false);
    const confirmed = createStreams();
    await expect(main(["session", "delete", "session-managed", "--yes"], confirmed, setup.dependencies)).resolves.toBe(0);
    expect(deleted).toBe(true);
  });

  it("Stage 2 Job 管理只输出安全摘要，不回显命令参数、cwd 或受限输出", async function redactsJobManagementOutput() {
    const streams = createStreams();
    const setup = createCompositionRoot();
    const runtime = createRuntimeDouble();
    const job = {
      id: "job-safe",
      workspaceId: "C:/workspace",
      sessionId: "session-safe",
      turnId: "turn-safe",
      program: "node",
      args: ["--token=RAW_JOB_TOKEN"],
      cwd: "C:/private/workspace",
      status: "completed" as const,
      startedAt: 1,
      updatedAt: 2,
      exitCode: 0,
      output: { stdout: "RAW_JOB_STDOUT", stderr: "RAW_JOB_STDERR", stdoutCursor: 1, stderrCursor: 1, stdoutStartCursor: 0, stderrStartCursor: 0, totalStdoutBytes: 10, totalStderrBytes: 20, stdoutTruncated: false, stderrTruncated: false },
    };
    runtime.jobs = {
      start: async function start() { return job; },
      list: async function list() { return Array.from({ length: 24 }, function createJob(_, index) { return { ...job, id: `job-safe-${index}` }; }); },
      get: async function get() { return job; },
      kill: async function kill() { return job; },
      poll: async function poll() { throw new Error("unused"); },
      write: async function write() { return undefined; },
      forSession: function forSession() {
        const view = { jobId: job.id, status: job.status, controlState: "terminal" as const, canStop: false, startedAt: job.startedAt, updatedAt: job.updatedAt, exitCode: job.exitCode, stdoutBytes: 10, stderrBytes: 20, outputTruncated: false };
        const stream = { text: "safe output", nextCursor: "next", startCursor: "start", gap: false, resetRequired: false, truncated: false };
        return {
          list: async function list() { return { jobs: [view] }; },
          read: async function read(input) { return { job: { ...view, jobId: input.jobId }, output: { stdout: stream, stderr: stream }, waitOutcome: "terminal" as const }; },
          stop: async function stop() { return view; },
        };
      },
    };
    setup.root.createRuntime = async function createRuntime() { return runtime; };

    await expect(main(["job", "show", "job-safe"], streams, setup.dependencies)).resolves.toBe(0);
    expect(streams.stdout.value).toContain("job-safe");
    expect(streams.stdout.value).toContain("stdoutBytes");
    expect(streams.stdout.value).not.toContain("RAW_JOB_");
    expect(streams.stdout.value).not.toContain("private/workspace");
    expect(function parseCompleteJson() { return JSON.parse(streams.stdout.value); }).not.toThrow();
    const listStreams = createStreams();
    await expect(main(["job", "list"], listStreams, setup.dependencies)).resolves.toBe(0);
    expect(JSON.parse(listStreams.stdout.value)).toHaveLength(24);
    expect(listStreams.stdout.value.length).toBeGreaterThan(500);
  });

  it("MCP 管理展示执行隔离事实，但不回显启动参数或 cwd", async function redactsMcpManagementOutput() {
    const streams = createStreams();
    const setup = createCompositionRoot();
    setup.root.listMcp = async function listMcp() {
      return [{ serverName: "fixture-mcp", program: "node", args: ["--token=RAW_MCP_TOKEN"], cwd: "C:/private/mcp", approved: true, executionMode: "host", isolation: "unisolated" }];
    };

    await expect(main(["mcp", "list"], streams, setup.dependencies)).resolves.toBe(0);
    expect(streams.stdout.value).toContain("fixture-mcp");
    expect(streams.stdout.value).toContain("approved");
    expect(streams.stdout.value).toContain("\"executionMode\":\"host\"");
    expect(streams.stdout.value).toContain("\"isolation\":\"unisolated\"");
    expect(streams.stdout.value).not.toContain("RAW_MCP_TOKEN");
    expect(streams.stdout.value).not.toContain("private/mcp");
  });

  it("MCP host 授权前明确警告未隔离，结果保留执行边界", async function warnsBeforeApprovingHostMcp() {
    const streams = createStreams();
    const setup = createCompositionRoot();
    setup.root.listMcp = async function listMcp() {
      return [{ serverName: "fixture-mcp", program: "node", args: [], cwd: ".", approved: false, executionMode: "host", isolation: "unisolated" }];
    };
    setup.root.approveMcp = async function approveMcp(_workspaceRoot, serverName) { return { serverName }; };

    await expect(main(["mcp", "approve", "fixture-mcp", "--yes"], streams, setup.dependencies)).resolves.toBe(0);
    expect(streams.stderr.value).toContain("without OS sandbox isolation");
    expect(JSON.parse(streams.stdout.value)).toMatchObject({ serverName: "fixture-mcp", approved: true, executionMode: "host", isolation: "unisolated" });
  });

  it("Stage 5 项目移除和撤销信任明确说明不会删除哪些数据与后续边界", async function writesManagementBoundaryCopy() {
    const removeStreams = createStreams();
    const removeSetup = createCompositionRoot();
    removeSetup.root.removeWorkspaceRegistry = function removeWorkspaceRegistry() { return true; };
    await expect(main(["project", "remove", "workspace-1"], removeStreams, removeSetup.dependencies)).resolves.toBe(0);
    expect(removeStreams.stdout.value).toContain("source files, sessions, and trust were not deleted");

    const trustStreams = createStreams();
    const trustSetup = createCompositionRoot();
    trustSetup.root.revokeTrust = async function revokeTrust() { return { workspaceRoot: "C:/workspace", status: "revoked", source: "test" }; };
    await expect(main(["trust", "revoke"], trustStreams, trustSetup.dependencies)).resolves.toBe(0);
    expect(trustStreams.stdout.value).toContain("future capability, Runtime, and Provider initialization is blocked");
  });

  it("Stage 10 Doctor 不创建 Runtime，未信任 project config 不读取工作区 settings", async function keepsDoctorAndConfigWithinTrustBoundary() {
    const doctorStreams = createStreams();
    const doctorSetup = createCompositionRoot();
    let runtimeCreated = false;
    doctorSetup.root.createRuntime = async function createRuntime() { runtimeCreated = true; return createRuntimeDouble(); };
    doctorSetup.root.doctor = async function doctor() { return [{ name: "trust", status: "SKIP", detail: "workspace not trusted" }]; };
    await expect(main(["doctor"], doctorStreams, doctorSetup.dependencies)).resolves.toBe(0);
    expect(doctorStreams.stdout.value).toContain("SKIP trust");
    expect(runtimeCreated).toBe(false);

    const configStreams = createStreams();
    const configSetup = createCompositionRoot();
    configSetup.root.resolveTrust = async function resolveUntrusted() {
      return { workspaceRoot: "C:/workspace", trustEntry: { workspaceRoot: "C:/workspace", status: "pending", source: "default" } };
    };
    let settingsRead = false;
    configSetup.root.showConfig = function showConfig() { settingsRead = true; return {}; };
    await expect(main(["config", "show", "--scope", "project"], configStreams, configSetup.dependencies)).resolves.toBe(1);
    expect(configStreams.stderr.value).toContain("WORKSPACE_TRUST_REQUIRED: pending");
    expect(settingsRead).toBe(false);
  });

  it("无 prompt 时使用 Plain line loop，并在 EOF 后正常退出", async function exitsAtEof() {
    const streams = createStreams();
    streams.stdin = Readable.from(["hello\n"]);
    const setup = createCompositionRoot();
    await expect(main(["chat", "--output", "text"], streams, setup.dependencies)).resolves.toBe(0);
    expect(streams.stdout.value).toContain("> ");
    expect(streams.stdout.value).toContain("answer: done");
  });

  it("只在已解析的业务命令创建用户配置目录和项目运行目录", async function ensuresConfigDirectoriesOnlyForBusinessCommand() {
    const streams = createStreams();
    const setup = createCompositionRoot();
    const ensureUserConfigDirectory = vi.fn();
    const ensureProjectAutopilotDirectory = vi.fn();
    setup.root.ensureUserConfigDirectory = ensureUserConfigDirectory;
    setup.root.ensureProjectAutopilotDirectory = ensureProjectAutopilotDirectory;

    await expect(main(["--help"], streams, setup.dependencies)).resolves.toBe(0);
    expect(ensureUserConfigDirectory).not.toHaveBeenCalled();
    expect(ensureProjectAutopilotDirectory).not.toHaveBeenCalled();

    await expect(main(["chat", "hello", "--output", "text"], streams, setup.dependencies)).resolves.toBe(0);
    expect(ensureUserConfigDirectory).toHaveBeenCalledTimes(1);
    expect(ensureProjectAutopilotDirectory).toHaveBeenCalledWith("C:/workspace");
  });

  it("打开 Web 等待结构化回答的 Session 时只输出安全摘要", async function reportsWebOnlyQuestionSession() {
    const streams = createStreams();
    const setup = createCompositionRoot();
    const runtime = createRuntimeDouble();
    runtime.sessions.get = async function get() {
      return { id: "session-web-question", projectId: "project-1", persistenceMode: "durable", status: "waiting_user_input", createdAt: 1, updatedAt: 1 };
    };
    runtime.turns.getRecoverableState = async function getRecoverableState() {
      return { sessionId: "session-web-question", turnId: "turn-web-question", status: "awaiting_user_input", recoverable: true, activeSkills: [] };
    };
    let started = false;
    runtime.turns.start = function start() {
      started = true;
      return eventStream([]);
    };
    setup.root.createRuntime = async function createRuntime() { return runtime; };

    await expect(main(["chat", "--session", "session-web-question", "--output", "text"], streams, setup.dependencies)).resolves.toBe(0);
    expect(streams.stdout.value).toContain("请在支持结构化回答的 Web 中处理");
    expect(started).toBe(false);
  });

  it("裸命令（无 argv）进入聊天链路，非 TTY 回落到 Plain", async function entersChatForBareCommand() {
    const streams = createStreams();
    streams.stdin = Readable.from(["hello\n"]);
    const setup = createCompositionRoot();
    await expect(main([], streams, setup.dependencies)).resolves.toBe(0);
    expect(streams.stdout.value).toContain("answer: done");
    // 非 TTY 执行业务命令会先向 stderr 写联网数据流告知（r003 起固定行为）。
    expect(streams.stderr.value).toContain("启用网络搜索");
  });

  it("SIGINT calls Runtime cancel, waits for interruption, and returns 130", async function cancelsActiveTurnOnSigint() {
    const streams = createStreams();
    const state: { started: boolean; cancelled: boolean; release?: () => void } = { started: false, cancelled: false };
    const runtime = createCancellableRuntime(state);
    const signalSource = createSignalSource();
    const root = {
      stateRoot: "C:/state",
      ensureUserConfigDirectory: function ensureUserConfigDirectory() { return undefined; },
      ensureProjectAutopilotDirectory: function ensureProjectAutopilotDirectory() { return undefined; },
      establishTrust: async function establishTrust() { return { workspaceRoot: "C:/workspace", trustEntry: { workspaceRoot: "C:/workspace", status: "trusted", source: "test" } }; },
      resolveTrust: async function resolveTrust() { return { workspaceRoot: "C:/workspace", trustEntry: { workspaceRoot: "C:/workspace", status: "trusted", source: "test" } }; },
      grantTrust: async function grantTrust() { return { workspaceRoot: "C:/workspace", status: "trusted", source: "test" }; },
      getTrustStatus: async function getTrustStatus() { return { workspaceRoot: "C:/workspace", status: "trusted", source: "test" }; },
      createRuntime: async function createRuntime() { return runtime; },
      bootstrap: async function bootstrap() { return runtime; },
      getBootstrapService: function getBootstrapService() { throw new Error("unused"); },
      getStartupConfigurationError: function getStartupConfigurationError() { return undefined; },
      getRuntimeStatusDefaults: function getRuntimeStatusDefaults() { return {}; },
      listSkills: async function listSkills() { return []; },
      resolveSkill: async function resolveSkill() { return { skillId: "skill-1", contentHash: "hash-1" }; },
    } as unknown as CliCompositionRoot;
    const dependencies: CliMainDependencies = {
      createCompositionRoot: function createCompositionRoot() { return root; },
      signalSource,
      cwd: "C:/workspace",
    };

    const pending = main(["chat", "hello", "--output", "text"], streams, dependencies);
    await new Promise<void>(function waitForTurnStart(resolve) { setTimeout(resolve, 10); });
    expect(state.started).toBe(true);
    signalSource.emit("SIGINT");

    await expect(pending).resolves.toBe(130);
    expect(state.cancelled).toBe(true);
    expect(streams.stdout.value).toContain("status: interrupted");
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("固定 SIGINT/SIGTERM 退出码", function mapsSignals() {
    expect(exitCodeForSignal("SIGINT")).toBe(130);
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
  });
  it("interactive non-TTY fallback", async function fallsBackFromInteractiveNonTty() {
    const streams = createStreams();
    const setup = createCompositionRoot();
    await expect(main(["chat", "hello"], streams, setup.dependencies)).resolves.toBe(0);
    expect(streams.stdout.value).toContain("answer: done");
    expect(streams.stdout.value).not.toContain("> ");
  });
});
