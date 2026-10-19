/**
 * test/node-sandbox-port.test.ts — Node SRT adapter 单测（Talk-Plan0917 Stage 2）
 *
 * 用注入的 fake SRT 模块验证：结构化命令序列化与 TMPDIR 覆盖、mode → SRT config 映射、
 * 惰性初始化与 policy 变化收敛、单 root guard、shutdown/release 幂等、错误码映射、
 * 非 darwin prepare fail-closed，以及 Windows status/setup 的脱敏投影与 UAC 取消语义。
 * 不加载真实 SRT，不做系统级安装。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SANDBOX_ERROR_CODES, SandboxPortError, type SandboxExecutionRequest, type SandboxPolicy } from "@autopilot-agent/core";
import { buildSrtRuntimeConfig, createNodeSandboxPort, serializePosixCommand } from "../src/node/sandbox/node-sandbox-port";
import { readWindowsSandboxCapability, runWindowsSandboxSetup } from "../src/node/sandbox/windows-sandbox-setup";
import type { SrtRuntimeSurface } from "../src/node/sandbox/srt-module";
import { finalizeWindowsSandboxArgv, resolveWindowsSandboxCommand } from "../src/node/sandbox/windows-sandbox-command";

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

/** 构造 fake SRT 运行时面；记录调用供断言。 */
function createFakeSrt(overrides: Partial<SrtRuntimeSurface> = {}): SrtRuntimeSurface {
  const manager = {
    initialize: vi.fn(async () => {}),
    isSupportedPlatform: vi.fn(() => true),
    isSandboxingEnabled: vi.fn(() => true),
    checkDependencies: vi.fn(() => ({ warnings: [], errors: [] })),
    waitForNetworkInitialization: vi.fn(async () => true),
    wrapWithSandboxArgv: vi.fn(async (command: string, shell?: string | { exe: string; args: readonly string[] }) => ({ argv: typeof shell === "object" ? ["C:\\vendor\\srt-win.exe", "exec", "--", shell.exe, ...shell.args, command] : ["/bin/bash", "-c", command], env: {} })),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(async () => {}),
    updateConfig: vi.fn(),
  };
  return {
    SandboxManager: manager,
    checkWindowsSandboxStatusAsync: vi.fn(async () => ({ user: { provisioned: true, credPresent: true, realUserSid: "S-1-5-TEST" }, wfp: { state: "installed" as const, filters: 3 } })),
    installWindowsSandboxAsync: vi.fn(async () => ({ wfp: { state: "installed", filters: 3 }, user: { provisioned: true, credPresent: true } })),
    WindowsSandboxError: class extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.name = "WindowsSandboxError";
        this.code = code;
      }
    },
    VENDORED_SRT_WIN_EXE: "C:\\vendor\\srt-win.exe",
    ...overrides,
  } as SrtRuntimeSurface;
}

/** 临时替换 process.platform；返回恢复函数。 */
function stubPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return () => Object.defineProperty(process, "platform", { value: original, configurable: true });
}

describe("serializePosixCommand", () => {
  it("用 POSIX 单引号转义 program/args，含空格与单引号不产生插值", () => {
    expect(serializePosixCommand("/bin/node", ["script.js", "--flag", "value with space"])).toBe("'/bin/node' 'script.js' '--flag' 'value with space'");
    expect(serializePosixCommand("/bin/sh", ["-c", "echo 'hi'; rm -rf /"])).toBe("'/bin/sh' '-c' 'echo '\\''hi'\\''; rm -rf /'");
  });

  it("tempRoot 存在时以 TMPDIR 环境前缀覆盖 SRT 注入的 /tmp/claude", () => {
    expect(serializePosixCommand("/bin/node", ["x"], "/ws/.autopilot/tmp")).toBe("TMPDIR='/ws/.autopilot/tmp' '/bin/node' 'x'");
    expect(serializePosixCommand("/bin/node", ["x"])).toBe("'/bin/node' 'x'");
  });
});

describe("buildSrtRuntimeConfig", () => {
  it("workspace-write 仅授权 canonical 工作区，网络默认拒绝且 allowAppleEvents 固定关闭", () => {
    const config = buildSrtRuntimeConfig(createRequest().policy) as { filesystem: { allowWrite: string[] }; network: { allowedDomains: string[] }; allowAppleEvents: boolean };
    expect(config.filesystem.allowWrite).toEqual(["/ws", "/ws/.autopilot/tmp"]);
    expect(config.network.allowedDomains).toEqual([]);
    expect(config.allowAppleEvents).toBe(false);
  });

  it("read-only 无任何写授权；danger-full-access 仍不授予外部写且保留 deny 列表", () => {
    const policy = { ...createRequest().policy, deniedRead: ["/secret"] };
    const readOnly = buildSrtRuntimeConfig({ ...policy, mode: "read-only" }) as { filesystem: { allowWrite: string[]; denyRead: string[] } };
    expect(readOnly.filesystem.allowWrite).toEqual([]);
    expect(readOnly.filesystem.denyRead).toEqual(["/secret"]);
    const danger = buildSrtRuntimeConfig({ ...policy, mode: "danger-full-access" }) as { filesystem: { allowWrite: string[]; denyRead: string[] } };
    expect(danger.filesystem.allowWrite).toEqual(["/ws", "/ws/.autopilot/tmp"]);
    expect(danger.filesystem.denyRead).toEqual(["/secret"]);
  });
});

describe("createNodeSandboxPort (darwin)", () => {
  let restore: () => void;
  beforeEach(function useMacPlatform() { restore = stubPlatform("darwin"); });
  afterEach(function restorePlatform() { restore(); });
  it("prepare 惰性初始化并返回可直接 spawn 的结构化 argv + env", async () => {
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", tempRoot: "/ws/.autopilot/tmp", loadModule: async () => srt });
    const prepared = await port.prepare(createRequest({ args: ["a b", "--x"] }));
    expect(srt.SandboxManager.initialize).toHaveBeenCalledTimes(1);
    expect(prepared.executable).toBe("/bin/bash");
    expect(prepared.args).toEqual(["-c", "TMPDIR='/ws/.autopilot/tmp' '/bin/node' 'a b' '--x'"]);
    expect(prepared.enforcement).toBe("full");
    expect(prepared.executionId).toBe("call-1");
  });

  it("policy 结构变化时用 updateConfig 收敛，不重复 initialize", async () => {
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async () => srt });
    await port.prepare(createRequest());
    await port.release("call-1");
    await port.prepare(createRequest({ policy: { ...createRequest().policy, mode: "read-only" } }));
    expect(srt.SandboxManager.initialize).toHaveBeenCalledTimes(1);
    expect(srt.SandboxManager.updateConfig).toHaveBeenCalledTimes(1);
  });

  it("policy.workspaceRoot 与绑定 root 不一致时抛 SANDBOX_SCOPE_CONFLICT", async () => {
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async () => srt });
    await expect(port.prepare(createRequest({ policy: { ...createRequest().policy, workspaceRoot: "/other" } })))
      .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.SCOPE_CONFLICT });
    expect(srt.SandboxManager.initialize).not.toHaveBeenCalled();
  });

  it("依赖缺失时 prepare 抛 SANDBOX_UNAVAILABLE，status 报告 unavailable", async () => {
    const srt = createFakeSrt();
    (srt.SandboxManager.checkDependencies as ReturnType<typeof vi.fn>).mockReturnValue({ warnings: [], errors: ["missing"] });
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async () => srt });
    await expect(port.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
    const report = await port.status();
    expect(report.enforcement).toBe("unavailable");
    expect(JSON.stringify(report.diagnostics ?? [])).not.toContain("missing");
  });

  it("waitForNetworkInitialization 失败视为 runner failure，目标命令不启动", async () => {
    const srt = createFakeSrt();
    (srt.SandboxManager.waitForNetworkInitialization as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async () => srt });
    await expect(port.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RUNNER_FAILED });
    expect(srt.SandboxManager.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it("wrap 失败映射为 SANDBOX_RUNNER_FAILED 且不透传原始文案", async () => {
    const srt = createFakeSrt();
    (srt.SandboxManager.wrapWithSandboxArgv as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("/secret/path leaked by srt"));
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async () => srt });
    await expect(port.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RUNNER_FAILED });
    const error = await port.prepare(createRequest()).catch((caught: SandboxPortError) => caught);
    expect(error.message).not.toContain("/secret/path");
  });

  it("release 幂等并调用 cleanupAfterCommand；shutdown 幂等且之后 prepare 抛 UNAVAILABLE", async () => {
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async () => srt });
    await port.prepare(createRequest());
    await port.release("call-1");
    await port.release("call-1");
    expect(srt.SandboxManager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    await port.shutdown();
    await port.shutdown();
    expect(srt.SandboxManager.reset).toHaveBeenCalledTimes(1);
    await expect(port.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
  });

  it("status 在 darwin 报告 full 与 backend 事实，不含敏感明细", async () => {
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async () => srt });
    const report = await port.status();
    expect(report).toMatchObject({ platform: "macos", backend: "srt-seatbelt", enforcement: "full" });
  });
});

describe("Windows 与其他平台 fail-closed", () => {
  it("win32 用原生 argv 包装，无 shell 插值，透传公共 runner 与冻结 temp", async () => {
    const restore = stubPlatform("win32");
    try {
      const srt = createFakeSrt();
      const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", windowsSrtWinExe: "C:\\public\\srt-win.exe", loadModule: async () => srt });
      const args = ["", "中文", 'a"b', "$literal; & echo unsafe", "a b"];
      const prepared = await port.prepare(createRequest({ program: process.execPath, args }));
      expect(prepared.args.slice(-args.length - 1)).toEqual([process.execPath, ...args]);
      expect(prepared.args).toContain("TEMP=/ws/.autopilot/tmp");
      expect(srt.SandboxManager.initialize).toHaveBeenCalledWith(expect.objectContaining({ windows: { srtWin: { path: "C:\\public\\srt-win.exe" } } }));
      await port.release("call-1");
      await port.shutdown();
    } finally {
      restore();
    }
  });

  it("win32 status 在初始化和 WFP 行为验证成功后报告 full，不泄露 SID", async () => {
    const restore = stubPlatform("win32");
    try {
      const srt = createFakeSrt();
      const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async () => srt });
      const report = await port.status();
      expect(report.platform).toBe("windows");
      expect(report.provisioned).toBe(true);
      expect(report.enforcement).toBe("full");
      expect(srt.SandboxManager.waitForNetworkInitialization).toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain("S-1-5-TEST");
    } finally {
      restore();
    }
  });

  it("win32 setup 显式触发安装；UAC 取消不视为错误并在诊断中说明", async () => {
    const restore = stubPlatform("win32");
    try {
      const srt = createFakeSrt();
      (srt.installWindowsSandboxAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ wfp: { state: "absent", filters: 0 }, user: { provisioned: false, credPresent: false }, cancelled: true });
      const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async () => srt });
      const report = await port.setup();
      expect(srt.installWindowsSandboxAsync).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(report.diagnostics ?? [])).toContain("install_cancelled");
    } finally {
      restore();
    }
  });

  it("linux prepare/status 均 unavailable，不宣称跨平台能力", async () => {
    const restore = stubPlatform("linux");
    try {
      const srt = createFakeSrt();
      const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async () => srt });
      await expect(port.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
      expect((await port.status()).enforcement).toBe("unavailable");
    } finally {
      restore();
    }
  });
});

describe("Windows 会话安全边界", function windowsSessionTests() {
  let restore: () => void;
  beforeEach(function useWindowsPlatform() { restore = stubPlatform("win32"); });
  afterEach(function restorePlatform() { restore(); });

  it("网络验证失败时 status unavailable 且 prepare 不包装目标", async function rejectsInactiveFence() {
    const srt = createFakeSrt();
    vi.mocked(srt.SandboxManager.waitForNetworkInitialization).mockResolvedValue(false);
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async function load() { return srt; } });
    expect((await port.status()).enforcement).toBe("unavailable");
    await expect(port.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RUNNER_FAILED });
    expect(srt.SandboxManager.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it("活动命令阻止策略切换，释放后 reset/initialize 真正替换会话 ACL", async function resetsAclBeforePolicyChange() {
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async function load() { return srt; } });
    const request = createRequest({ program: process.execPath });
    await port.prepare(request);
    const readonlyRequest = { ...request, policy: { ...request.policy, mode: "read-only" as const } };
    await expect(port.prepare(readonlyRequest)).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.SCOPE_CONFLICT });
    await port.release(request.commandId);
    await port.prepare(readonlyRequest);
    expect(srt.SandboxManager.reset).toHaveBeenCalledTimes(1);
    expect(srt.SandboxManager.initialize).toHaveBeenCalledTimes(2);
    expect(srt.SandboxManager.updateConfig).not.toHaveBeenCalled();
    await port.release(request.commandId);
    await port.shutdown();
  });

  it("另一 Port 不能并行占用全局 Windows manager", async function rejectsSecondPort() {
    const srt = createFakeSrt();
    const first = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async function load() { return srt; } });
    const second = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/other", loadModule: async function load() { return srt; } });
    await first.status();
    await expect(second.prepare(createRequest({ policy: { ...createRequest().policy, workspaceRoot: "/other" } }))).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.SCOPE_CONFLICT });
    await first.shutdown();
    expect((await second.status()).enforcement).toBe("full");
    await second.shutdown();
  });

  it("拒绝异常包装结构，不以裸 argv 降级", function rejectsMalformedWrapper() {
    expect(function invalid() { finalizeWindowsSandboxArgv(["node.exe"], { exe: "node.exe", args: [] }); }).toThrow(SandboxPortError);
  });

  it("npm/npx/pnpm 只解析可信 JS 入口并保留结构化参数", function resolvesTrustedPackageManagers() {
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation(function samePath(value) { return String(value); });
    const stat = vi.spyOn(fs, "statSync").mockReturnValue({ isFile: function file() { return true; } } as fs.Stats);
    try {
      for (const [program, suffix] of [["npm.cmd", "npm-cli.js"], ["npx.cmd", "npx-cli.js"], ["pnpm.cmd", "pnpm.mjs"]] as const) {
        const resolved = resolveWindowsSandboxCommand(program, ["--no-install", "tsc"]);
        expect(resolved.exe).toBe(process.execPath);
        expect(resolved.args[0]).toMatch(new RegExp(`${suffix.replace(".", "\\.")}$`));
        expect(resolved.args.slice(1)).toEqual(["--no-install", "tsc"]);
      }
    } finally {
      realpath.mockRestore();
      stat.mockRestore();
    }
  });

  it("可信工具链入口被重定向到工作区时 fail-closed", function rejectsPackageManagerSymlink() {
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation(function redirected(value) {
      const candidate = String(value);
      return candidate.endsWith("pnpm.mjs") ? "C:\\workspace\\pnpm.mjs" : candidate;
    });
    try {
      expect(function resolve() { resolveWindowsSandboxCommand("pnpm.cmd", []); }).toThrow(SandboxPortError);
    } finally {
      realpath.mockRestore();
    }
  });

  it("status 只报告阶段与白名单底层码，不泄露底层文案", async function reportsSanitizedFailurePhase() {
    const srt = createFakeSrt();
    vi.mocked(srt.checkWindowsSandboxStatusAsync).mockRejectedValue(Object.assign(new Error("secret path and token"), { code: "EACCES", win32Code: 5 }));
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async function load() { return srt; } });
    const report = await port.status();
    expect(report.enforcement).toBe("unavailable");
    expect(report.diagnostics).toEqual(["phase=capability-probe;cause=EACCES;win32=0x00000005"]);
    expect(JSON.stringify(report)).not.toContain("secret");
    await port.shutdown();
  });

  it("模块加载、初始化与包装分别保留脱敏阶段", async function separatesPortFailures() {
    const moduleFailure = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async function failLoad() { throw Object.assign(new Error("secret module"), { code: "EPERM" }); } });
    expect((await moduleFailure.status()).diagnostics).toEqual(["phase=module-load;cause=EPERM"]);

    const initializingSrt = createFakeSrt();
    vi.mocked(initializingSrt.SandboxManager.initialize).mockRejectedValue(Object.assign(new Error("secret init"), { code: "EACCES" }));
    const initializingPort = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async function load() { return initializingSrt; } });
    expect((await initializingPort.status()).diagnostics).toEqual(["phase=initialize;cause=EACCES"]);
    await initializingPort.shutdown();

    const wrappingSrt = createFakeSrt();
    vi.mocked(wrappingSrt.SandboxManager.wrapWithSandboxArgv).mockRejectedValue(Object.assign(new Error("secret wrap"), { code: "EPERM" }));
    const wrappingPort = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async function load() { return wrappingSrt; } });
    const error = await wrappingPort.prepare(createRequest({ program: process.execPath })).catch(function capture(caught: SandboxPortError) { return caught; });
    expect(error).toMatchObject({ code: SANDBOX_ERROR_CODES.RUNNER_FAILED, message: "phase=wrap;cause=EPERM" });
    await wrappingPort.shutdown();
  });

  it("包管理器入口文件访问异常属于 command-resolve UNAVAILABLE，目标不包装", async function classifiesCommandResolutionFailure() {
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation(function deny() { throw Object.assign(new Error("secret file path"), { code: "EACCES" }); });
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ stateRoot: "/authority", workspaceRoot: "/ws", loadModule: async function load() { return srt; } });
    try {
      const error = await port.prepare(createRequest({ program: "npx.cmd", args: ["--no-install", "tsc"] })).catch(function capture(caught: SandboxPortError) { return caught; });
      expect(error).toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE, message: "phase=command-resolve;cause=EACCES" });
      expect(srt.SandboxManager.wrapWithSandboxArgv).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
      await port.shutdown();
    }
  });
});

describe("Stage3 执行边界（纯 mock，不证明 OS）", () => {
  let restore: () => void;
  beforeEach(function useMacPlatform() { restore = stubPlatform("darwin"); });
  afterEach(function restorePlatform() { restore(); });

  it("单目标capability在配置编译/prepare前明确unsupported，不上提父目录或初始化", async function rejectsExactFileCapability() {
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ workspaceRoot: "/ws", stateRoot: "/authority", loadModule: async function load() { return srt; } });
    const policy = { ...createRequest().policy, externalWriteCapability: { schemaVersion: 1, target: { canonicalTarget: "/outside/file.txt", scope: "file" } } };
    expect(function compile() { buildSrtRuntimeConfig(policy); }).toThrow(SandboxPortError);
    await expect(port.prepare(createRequest({ policy }))).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
    expect(srt.SandboxManager.initialize).not.toHaveBeenCalled();
    expect(srt.SandboxManager.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it("活动执行阻止策略变更、重复 ID 和 shutdown；release 后才可切换", async function guardsLifetime() {
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ workspaceRoot: "/ws", stateRoot: "/authority", loadModule: async function load() { return srt; } });
    await port.prepare(createRequest());
    await expect(port.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.SCOPE_CONFLICT });
    const changed = createRequest({ commandId: "second", policy: { ...createRequest().policy, mode: "read-only" } });
    await expect(port.prepare(changed)).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.SCOPE_CONFLICT });
    await expect(port.shutdown()).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.CLEANUP_FAILED });
    expect(srt.SandboxManager.updateConfig).not.toHaveBeenCalled();
    await port.release("call-1");
    await port.prepare(changed);
    await port.release("second");
    await port.shutdown();
  });

  it("所有平台共享 Manager 不跨 Port 混权；owner 释放后可重新绑定", async function guardsSharedManager() {
    const srt = createFakeSrt();
    const first = createNodeSandboxPort({ workspaceRoot: "/ws", stateRoot: "/authority", loadModule: async function load() { return srt; } });
    const second = createNodeSandboxPort({ workspaceRoot: "/ws", stateRoot: "/authority", loadModule: async function load() { return srt; } });
    await first.prepare(createRequest());
    await expect(second.prepare(createRequest({ commandId: "second" }))).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.SCOPE_CONFLICT });
    await first.release("call-1");
    await first.shutdown();
    await second.prepare(createRequest());
    await second.release("call-1");
    await second.shutdown();
  });

  it("并发 prepare 预约完整 lifetime，不在异步 wrap 时切换策略", async function guardsPreparingRace() {
    const srt = createFakeSrt();
    let finishWrap!: () => void;
    const gate = new Promise<void>(function createGate(resolve) { finishWrap = resolve; });
    vi.mocked(srt.SandboxManager.wrapWithSandboxArgv).mockImplementationOnce(async function waitWrap() { await gate; return { argv: ["/wrapper"], env: {} }; });
    const port = createNodeSandboxPort({ workspaceRoot: "/ws", stateRoot: "/authority", loadModule: async function load() { return srt; } });
    const first = port.prepare(createRequest());
    const second = port.prepare(createRequest({ commandId: "second", policy: { ...createRequest().policy, mode: "read-only" } }));
    const rejected = expect(second).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.SCOPE_CONFLICT });
    finishWrap();
    await first;
    await rejected;
    await port.release("call-1");
    await port.shutdown();
  });

  it("清理失败锁定后续 prepare，不能通过另一次 release 清掉失败", async function guardsCleanupFailure() {
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ workspaceRoot: "/ws", stateRoot: "/authority", loadModule: async function load() { return srt; } });
    await port.prepare(createRequest());
    vi.mocked(srt.SandboxManager.cleanupAfterCommand).mockImplementation(function failCleanup() { throw new Error("fixture"); });
    await port.release("call-1");
    await port.release("call-1");
    await expect(port.prepare(createRequest({ commandId: "next" }))).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.CLEANUP_FAILED });
    expect(srt.SandboxManager.wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
    await port.shutdown();
  });

  it("状态根及授权配置注入 deny；外部 cwd 与脚本内容不扩写根", async function protectsAuthority() {
    const srt = createFakeSrt();
    const port = createNodeSandboxPort({ workspaceRoot: "/ws", stateRoot: "/authority", loadModule: async function load() { return srt; } });
    await port.prepare(createRequest({ cwd: "/outside", args: ["hidden-writer.js"] }));
    const config = vi.mocked(srt.SandboxManager.initialize).mock.calls[0]![0] as { filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] } };
    expect(config.filesystem.allowWrite).toEqual(["/ws", "/ws/.autopilot/tmp"]);
    expect(config.filesystem.denyRead).toContain("/authority");
    expect(config.filesystem.denyWrite).toContain("/authority");
    expect(config.filesystem.denyWrite).toContain(path.join("/ws", ".autopilot", "settings.local.json"));
    await port.release("call-1");
    await port.shutdown();
  });

  it("缺少状态保护域时不加载平台；Windows 必要 allowRead 不覆盖敏感 deny", async function rejectsReadDenyOverlap() {
    const srt = createFakeSrt();
    const missing = createNodeSandboxPort({ workspaceRoot: "/ws", loadModule: async function load() { return srt; } });
    await expect(missing.prepare(createRequest())).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
    expect(srt.SandboxManager.initialize).not.toHaveBeenCalled();
    const restoreWindows = stubPlatform("win32");
    try {
      const port = createNodeSandboxPort({ workspaceRoot: "/ws", stateRoot: "/authority", loadModule: async function load() { return srt; } });
      await expect(port.prepare(createRequest({ policy: { ...createRequest().policy, mode: "read-only", deniedRead: ["/ws/.env"] } }))).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.POLICY_DENIED });
      expect(srt.SandboxManager.initialize).not.toHaveBeenCalled();
      expect(srt.SandboxManager.wrapWithSandboxArgv).not.toHaveBeenCalled();
    } finally { restoreWindows(); }
  });
});

describe("readWindowsSandboxCapability / runWindowsSandboxSetup", () => {
  it("未 provision 时 status 报告 unavailable，setup 抛 NOT_PROVISIONED 之外的探测失败映射 UNAVAILABLE", async () => {
    const srt = createFakeSrt();
    (srt.checkWindowsSandboxStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { provisioned: false, credPresent: false, realUserSid: "S-1-5" }, wfp: { state: "absent", filters: 0 } });
    const report = await readWindowsSandboxCapability({ loadModule: async () => srt });
    expect(report.provisioned).toBe(false);
    expect(report.enforcement).toBe("unavailable");
  });

  it("探测异常映射为稳定 UNAVAILABLE 且不透传底层文案", async () => {
    const srt = createFakeSrt();
    (srt.checkWindowsSandboxStatusAsync as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("secret probe detail"));
    await expect(readWindowsSandboxCapability({ loadModule: async () => srt })).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
    const error = await readWindowsSandboxCapability({ loadModule: async () => srt }).catch((caught: SandboxPortError) => caught);
    expect(error.message).not.toContain("secret probe detail");
  });
});
