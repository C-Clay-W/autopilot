/**
 * cr-r3 Windows 包管理器直接执行回归（web-runtime-20261016 CR R3）：
 * 1. 共享受信解析：Windows 下 npm/npx（含 .cmd 输入）解析为 process.execPath + 对应 CLI 脚本，
 *    结构化 argv 原样保留（含空格/引号参数）；非包管理器返回 null；pnpm 按真实安装状态解析或
 *    SANDBOX_UNAVAILABLE（均不产生 .cmd、不回退 shell）。
 * 2. danger-full-access 沙箱不可用直执 `npm --version`：真实 spawn 成功一次，不经过 prepare，
 *    enforcement=unavailable（修复前 `spawn(npx.cmd/npm.cmd, {shell:false})` 直接 EINVAL）。
 * macOS 原生执行为独立平台分支（解析器返回 null），按用户裁决实机验证暂缓。
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWindowsPackageManagerCommand } from "../../src/internal/tools/process-utils";
import { createRunCommandTool } from "../../src/internal/tools/builtins/run-command-tool";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import type { SandboxExecutionBinding } from "../../src/internal/tools/types";
import type { SandboxPort } from "../../src/runtime/ports";

const isWindows = process.platform === "win32";

const temporaryRoots: string[] = [];

afterEach(async function cleanupWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 可控沙箱 Port：status 恒定不可用（带脱敏诊断），prepare 计数且不应被直执路径调用。 */
function createUnavailableSandboxPort() {
  let prepared = 0;
  const port: SandboxPort = {
    async status() {
      return { platform: "windows" as const, backend: "fake-srt", enforcement: "unavailable" as const, diagnostics: ["provision 未完成：测试模拟"] };
    },
    async setup() {
      throw new Error("fake sandbox setup 不可用");
    },
    async prepare(request) {
      prepared++;
      return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement: "full" as const };
    },
    async release() {},
    async shutdown() {},
  };
  return { port, getPrepared: () => prepared };
}

/** 创建 run_command 执行器（auto_approve 覆盖策略审批，聚焦执行链本身）。 */
function createCommandExecutor(workspaceRoot: string, binding: SandboxExecutionBinding): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createRunCommandTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode: "auto_approve",
    workspaceTrusted: true,
    sandbox: binding,
  });
}

describe.skipIf(!isWindows)("cr-r3 Windows 包管理器共享受信解析", () => {
  it("npm/npx（含 .cmd 输入）解析为 process.execPath + 对应 CLI 脚本，结构化 argv 原样保留", () => {
    const args = ["install", "--save-exact", "left pad", "a\"b"];
    for (const [program, suffix] of [["npm", "npm-cli.js"], ["npm.cmd", "npm-cli.js"], ["npx", "npx-cli.js"], ["npx.cmd", "npx-cli.js"]] as const) {
      const resolved = resolveWindowsPackageManagerCommand(program, args);
      expect(resolved, program).not.toBeNull();
      expect(resolved!.executable).toBe(process.execPath);
      expect(resolved!.args[0]).toMatch(new RegExp(`${suffix.replace(".", "\\.")}$`));
      // 结构化 argv 不经 shell 插值：空格/引号参数逐项原样保留。
      expect(resolved!.args.slice(1)).toEqual(args);
    }
  });

  it("非包管理器返回 null（保持原生程序执行路径）；pnpm 按真实安装状态解析或 fail-closed", () => {
    expect(resolveWindowsPackageManagerCommand("node", ["--version"])).toBeNull();
    expect(resolveWindowsPackageManagerCommand("git", ["status"])).toBeNull();
    try {
      const resolved = resolveWindowsPackageManagerCommand("pnpm.cmd", ["--version"]);
      expect(resolved?.executable).toBe(process.execPath);
      expect(resolved?.args[0]).toMatch(/pnpm\.mjs$/);
    } catch (error) {
      // 本机未安装 pnpm 时受信 CLI 不可用必须 fail-closed，不得回退 .cmd/shell。
      expect((error as { code?: string }).code).toBe("SANDBOX_UNAVAILABLE");
      expect((error as { code?: string }).name).toBe("SandboxPortError");
    }
  });
});

describe.skipIf(!isWindows)("cr-r3 danger-full-access 直执 npm（真实 spawn，无网络）", () => {
  it("沙箱不可用时 npm --version 经受信解析真实执行一次：不经过 prepare、enforcement=unavailable", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "cr-r3-npm-"));
    temporaryRoots.push(workspaceRoot);
    const sandbox = createUnavailableSandboxPort();
    const executor = createCommandExecutor(workspaceRoot, { port: sandbox.port, mode: "danger-full-access" });
    const result = await executor.execute({ callId: "c-r3-npm", toolName: "run_command", input: { program: "npm", args: ["--version"], cwd: "." } });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error(`expected success, got ${result.status}: ${JSON.stringify(result.error ?? {})}`);
    const output = result.output as { exitCode?: number; stdout?: string; sandbox?: { enforcement?: string; mode?: string } };
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toMatch(/^\d+\.\d+\.\d+/);
    expect(output.sandbox).toMatchObject({ enforcement: "unavailable", mode: "danger-full-access" });
    // 直执路径不经过沙箱 prepare；一次调用恰好一次 spawn（无重试）。
    expect(sandbox.getPrepared()).toBe(0);
  });
});

describe.skipIf(isWindows)("非 Windows 平台解析器直接返回 null", () => {
  it("npm/npx 交给平台原生程序执行，不做 Windows 解析", () => {
    expect(resolveWindowsPackageManagerCommand("npm", ["--version"])).toBeNull();
  });
});
