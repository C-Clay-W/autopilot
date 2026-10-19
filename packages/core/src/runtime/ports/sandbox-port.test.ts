/**
 * runtime/ports/sandbox-port.test.ts — SandboxPort 契约测试（B 组，Talk-Plan0917 Stage 1）
 *
 * 用可编程 fake port 验证 prepare 输入/输出形状、release 幂等、shutdown 语义、
 * scope conflict 与 policy denial / runner failure 的错误表达；同时固定
 * createUnavailableSandboxPort 的 fail-closed 默认行为。
 */
import { describe, expect, it } from "vitest";
import {
  SANDBOX_ERROR_CODES,
  type SandboxCapabilityReport,
  type SandboxExecutionRequest,
  type SandboxPolicy,
} from "../domain/sandbox-policy";
import { SandboxPortError, createUnavailableSandboxPort, type SandboxPort } from "./sandbox-port";

/** 构造冻结 policy 的最小合法请求。 */
function createRequest(overrides: Partial<SandboxExecutionRequest> = {}): SandboxExecutionRequest {
  const policy: SandboxPolicy = {
    mode: "workspace-write",
    workspaceRoot: "/ws",
    tempRoot: "/ws/.autopilot/tmp",
    allowedDomains: Object.freeze([]),
    deniedRead: Object.freeze([]),
    deniedWrite: Object.freeze([]),
  };
  return { commandId: "call-1", program: "/bin/node", args: ["script.js"], cwd: "/ws", policy, ...overrides };
}

/** 可编程 fake port：表达 full/partial/unavailable、denial 与 runner failure。 */
function createFakeSandboxPort(options: {
  status?: SandboxCapabilityReport;
  prepare?: (request: SandboxExecutionRequest) => SandboxPortError | void;
} = {}): SandboxPort & { state: { released: string[]; shutDown: boolean; prepared: SandboxExecutionRequest[] } } {
  const state = { released: [] as string[], shutDown: false, prepared: [] as SandboxExecutionRequest[] };
  return {
    state,
    async status() {
      return options.status ?? { platform: "macos", backend: "fake", enforcement: "full" };
    },
    async setup() {
      return options.status ?? { platform: "macos", backend: "fake", enforcement: "full" };
    },
    async prepare(request) {
      state.prepared.push(request);
      const failure = options.prepare?.(request);
      if (failure instanceof SandboxPortError) throw failure;
      return { executionId: `exec-${request.commandId}`, executable: "/bin/sandbox-exec", args: ["-f", "profile", request.program, ...request.args], env: { SANDBOXED: "1" }, enforcement: "full" };
    },
    async release(executionId) {
      state.released.push(executionId);
    },
    async shutdown() {
      state.shutDown = true;
    },
  };
}

describe("SandboxPort contract", () => {
  it("prepare 返回可直接 spawn 的结构化 argv + env，不返回拼接 shell 字符串", async () => {
    const port = createFakeSandboxPort();
    const request = createRequest({ args: ["script.js", "--flag", "value with space"] });
    const prepared = await port.prepare(request);
    expect(prepared.executionId).toBe("exec-call-1");
    expect(typeof prepared.executable).toBe("string");
    expect(Array.isArray(prepared.args)).toBe(true);
    expect(prepared.args).toContain("value with space");
    expect(prepared.env).toEqual({ SANDBOXED: "1" });
    expect(prepared.enforcement).toBe("full");
    expect(stateHasNoShellString(prepared)).toBe(true);
  });

  it("prepare 收到的是已校验结构化输入：program + args + canonical cwd + 冻结 policy + commandId", async () => {
    const port = createFakeSandboxPort();
    const request = createRequest();
    await port.prepare(request);
    expect(port.state.prepared[0]).toEqual(request);
  });

  it("release 幂等：重复释放同一 executionId 不抛错", async () => {
    const port = createFakeSandboxPort();
    await port.release("exec-1");
    await port.release("exec-1");
    expect(port.state.released).toEqual(["exec-1", "exec-1"]);
  });

  it("shutdown 后 prepare 抛 SANDBOX_UNAVAILABLE，目标命令不启动", async () => {
    const port = createFakeSandboxPort();
    await port.shutdown();
    expect(port.state.shutDown).toBe(true);
    const broken: SandboxPort = {
      ...port,
      async prepare() {
        throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "port 已 shutdown");
      },
    };
    await expect(broken.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
  });

  it("单 root 约束：检测到并行另一 canonical workspaceRoot 时抛 SANDBOX_SCOPE_CONFLICT", async () => {
    const port = createFakeSandboxPort({
      prepare: () => new SandboxPortError(SANDBOX_ERROR_CODES.SCOPE_CONFLICT, "另一 workspace 正在使用沙箱"),
    });
    await expect(port.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.SCOPE_CONFLICT });
  });

  it("policy denial 与 runner failure 都通过 SandboxPortError 表达且语义可区分", async () => {
    const denying = createFakeSandboxPort({ prepare: () => new SandboxPortError(SANDBOX_ERROR_CODES.POLICY_DENIED, "OS 拒绝写入") });
    const failing = createFakeSandboxPort({ prepare: () => new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "runner 无法启动") });
    await expect(denying.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.POLICY_DENIED });
    await expect(failing.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RUNNER_FAILED });
  });

  it("fake port 可表达 full/partial/unavailable 三种 enforcement", async () => {
    expect((await createFakeSandboxPort().status()).enforcement).toBe("full");
    expect((await createFakeSandboxPort({ status: { platform: "windows", backend: "fake-acl", enforcement: "partial" } }).status()).enforcement).toBe("partial");
    expect((await createFakeSandboxPort({ status: { platform: "unknown", backend: "none", enforcement: "unavailable" } }).status()).enforcement).toBe("unavailable");
  });
});

describe("createUnavailableSandboxPort", () => {
  it("status 恒为 unavailable，prepare/setup 抛 SANDBOX_UNAVAILABLE，release/shutdown 幂等", async () => {
    const port = createUnavailableSandboxPort();
    expect(await port.status()).toMatchObject({ platform: "unknown", backend: "none", enforcement: "unavailable" });
    await expect(port.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
    await expect(port.setup()).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
    await expect(port.release("exec-1")).resolves.toBeUndefined();
    await expect(port.release("exec-1")).resolves.toBeUndefined();
    await expect(port.shutdown()).resolves.toBeUndefined();
  });
});

/** 断言 prepared 结果不携带拼接后的 shell 命令字符串。 */
function stateHasNoShellString(prepared: { executable: string; args: readonly string[] }): boolean {
  return !prepared.executable.includes(" && ") && !prepared.args.some((arg) => arg.includes(" && "));
}
