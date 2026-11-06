/** CLI 协作命令分发契约：验证 Project 绑定、JSON 输出与固定退出码。 */
import { ThreadServiceError, type AgentRuntime, type ThreadFacade } from "@autopilot-agent/core";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { main, type CliMainDependencies, type CliMainStreams, type CliSignalSource } from "../../src/main.js";
import type { CliCompositionRoot } from "../../src/composition-root.js";

/** 捕获 stdout/stderr 的测试流；需要 stdin 时显式注入。 */
function createStreams(stdin?: NodeJS.ReadableStream) {
  const stdout = { value: "", write(chunk: string) { stdout.value += chunk; } };
  const stderr = { value: "", write(chunk: string) { stderr.value += chunk; } };
  const streams = { stdout, stderr, ...(stdin ? { stdin } : {}) } as CliMainStreams & { stdout: { value: string }; stderr: { value: string } };
  return streams;
}

/** 不注册真实进程监听器的信号 double。 */
function createSignalSource(): CliSignalSource & { emit(signal: "SIGINT" | "SIGTERM"): void } {
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
  };
}

/** 只提供协作命令所需的 Runtime 事实；不创建真实 Turn 或 Provider。 */
function createRuntimeDouble(options: { project: boolean }): AgentRuntime {
  return {
    projects: {
      list: async function list() {
        return options.project ? [{ id: "project-1", name: "workspace", workspaceRoot: "C:/workspace", createdAt: 1, updatedAt: 1 }] : [];
      },
    },
    shutdown: async function shutdown() { return undefined; },
  } as unknown as AgentRuntime;
}

/** 创建测试 Composition Root；记录 Project 绑定并返回给定协作入口。 */
function createRoot(facade: ThreadFacade, options: { project?: boolean } = {}) {
  const bound: string[] = [];
  const root = {
    stateRoot: "C:/state",
    ensureUserConfigDirectory: function ensureUserConfigDirectory() { return undefined; },
    ensureProjectAutopilotDirectory: function ensureProjectAutopilotDirectory() { return undefined; },
    resolveTrust: async function resolveTrust() { return { workspaceRoot: "C:/workspace", trustEntry: { workspaceRoot: "C:/workspace", status: "trusted", source: "test" } }; },
    createRuntime: async function createRuntime() { return createRuntimeDouble({ project: options.project !== false }); },
    bindThreadsProject: function bindThreadsProject(projectId: string) { bound.push(projectId); },
    createHumanThreads: function createHumanThreads() { return facade; },
    createThreadHost: function createThreadHost() { return { start: function start() { return undefined; }, stop: async function stop() { return undefined; }, isRunning: function isRunning() { return false; } }; },
  } as unknown as CliCompositionRoot;
  return { root, bound };
}

/** 组装最小依赖；thread 命令不触碰 TTY 或 TUI。 */
function dependenciesFor(root: CliCompositionRoot, signalSource: CliSignalSource): CliMainDependencies {
  return { createCompositionRoot: function createCompositionRoot() { return root; }, signalSource, cwd: "C:/workspace" };
}

describe("CLI 协作命令分发", function threadMainSuite() {
  it("group enable 绑定 Project 并输出 JSON", async function bindsProjectAndPrintsJson() {
    const facade = {
      enable: async function enable() { return { protocolVersion: 1, group: { groupId: "g1", rootThreadId: "root-1", enabled: true, members: [] } }; },
    } as unknown as ThreadFacade;
    const { root, bound } = createRoot(facade);
    const streams = createStreams();

    await expect(main(["thread", "group", "enable", "--thread", "root-1", "--request-id", "req-1"], streams, dependenciesFor(root, createSignalSource()))).resolves.toBe(0);
    expect(bound).toEqual(["project-1"]);
    expect(JSON.parse(streams.stdout.value)).toMatchObject({ group: { groupId: "g1", enabled: true } });
    expect(streams.stderr.value).toBe("");
  });

  it("缺少 Project 时明确失败且不伪造协作结果", async function failsWithoutProject() {
    const facade = {} as ThreadFacade;
    const { root, bound } = createRoot(facade, { project: false });
    const streams = createStreams();

    await expect(main(["thread", "list", "--group", "g1"], streams, dependenciesFor(root, createSignalSource()))).resolves.toBe(1);
    expect(streams.stderr.value).toContain("THREADS_UNAVAILABLE");
    expect(streams.stdout.value).toBe("");
    expect(bound).toEqual([]);
  });

  it("领域冲突按运行期失败返回，参数错误按 usage 返回", async function mapsDomainErrors() {
    const conflict = {
      list: async function list() { throw new ThreadServiceError("THREAD_STATE_CONFLICT"); },
    } as unknown as ThreadFacade;
    const conflictStreams = createStreams();
    await expect(main(["thread", "list", "--group", "g1"], conflictStreams, dependenciesFor(createRoot(conflict).root, createSignalSource()))).resolves.toBe(1);
    expect(conflictStreams.stderr.value).toBe("THREAD_STATE_CONFLICT\n");

    const invalid = {
      list: async function list() { throw new ThreadServiceError("INVALID_INPUT"); },
    } as unknown as ThreadFacade;
    const invalidStreams = createStreams();
    await expect(main(["thread", "list", "--group", "g1"], invalidStreams, dependenciesFor(createRoot(invalid).root, createSignalSource()))).resolves.toBe(2);
    expect(invalidStreams.stderr.value).toBe("INVALID_INPUT\n");
  });

  it("send 从 stdin 读取正文，不经过 shell 二次解释", async function readsContentFromStdin() {
    const received: Array<Record<string, unknown>> = [];
    const facade = {
      send: async function send(input: Record<string, unknown>) {
        received.push(input);
        return { protocolVersion: 1, messageId: "m1", deliverySeq: 1, deliveryStatus: "pending", accepted: true };
      },
    } as unknown as ThreadFacade;
    const streams = createStreams(Readable.from(["含 \"引号\" 与 $变量 的正文"]));

    await expect(main(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "run", "--request-id", "req", "--message-stdin"], streams, dependenciesFor(createRoot(facade).root, createSignalSource()))).resolves.toBe(0);
    expect(received[0]).toMatchObject({ mode: "run", content: "含 \"引号\" 与 $变量 的正文" });
    // 回执只表示已接受，不写“已启动/已完成”。
    expect(JSON.parse(streams.stdout.value)).toMatchObject({ accepted: true, deliveryStatus: "pending" });
  });

  it("等待期间收到 SIGINT 只结束观察并返回 130", async function abortsWaitWithoutCancellingTargets() {
    const signals: AbortSignal[] = [];
    const facade = {
      wait: async function wait(input: { signal?: AbortSignal }) {
        if (input.signal) signals.push(input.signal);
        await new Promise<void>(function waitForAbort(resolve) {
          if (input.signal?.aborted) return resolve();
          input.signal?.addEventListener("abort", function abort() { resolve(); }, { once: true });
        });
        return { protocolVersion: 1, results: [], timedOut: false };
      },
    } as unknown as ThreadFacade;
    const signalSource = createSignalSource();
    const streams = createStreams();

    const pending = main(["thread", "wait", "--group", "g1", "--thread", "t1", "--timeout-ms", "30000"], streams, dependenciesFor(createRoot(facade).root, signalSource));
    await new Promise<void>(function waitForStart(resolve) { setTimeout(resolve, 10); });
    signalSource.emit("SIGINT");
    await expect(pending).resolves.toBe(130);
    expect(signals[0]?.aborted).toBe(true);
  });
});
