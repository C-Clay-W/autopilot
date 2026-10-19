/** r003 Windows宿主候选装配：fake manager仅验证接口，不加载SRT或执行系统操作。 */
import { expect, it, vi } from "vitest";
import { createNodeSandboxPort } from "../../src/node/sandbox/node-sandbox-port";
import type { SrtRuntimeSurface } from "../../src/node/sandbox/srt-module";

/** 给出符合实际wrap尾部的固定模块，所有初始化/清理仅记录内存调用。 */
function fixture(enabled: boolean) {
  const reset = vi.fn(async function reset() {});
  const manager = {
    isSupportedPlatform: function supported() { return true; },
    initialize: async function initialize() {},
    waitForNetworkInitialization: async function initialized() { return true; },
    wrapWithSandboxArgv: async function wrap(_command: string, target: { exe: string; args: string[] }) { return { argv: ["C:\\candidate\\srt-win.exe", "exec", "--", target.exe, ...target.args, ""], env: {} }; },
    cleanupAfterCommand: function cleanup() {},
    reset,
  };
  const module = { SandboxManager: manager, VENDORED_SRT_WIN_EXE: "C:\\vendor\\srt-win.exe" } as unknown as SrtRuntimeSurface;
  const port = createNodeSandboxPort({ workspaceRoot: process.cwd(), windowsSrtWinExe: "C:\\candidate\\srt-win.exe", ...(enabled ? { managedExecutionProtocol: 1 as const } : {}), loadModule: async function load() { return module; } });
  const request = { commandId: "r003-capability", program: process.execPath, args: [], cwd: process.cwd(), managed: true, policy: { mode: "workspace-write" as const, workspaceRoot: process.cwd(), allowedDomains: [], deniedRead: [], deniedWrite: [] } };
  return { port, request, reset };
}

it("候选协议显式装配且活动范围不复用，release前shutdown拒绝", async function injectedLifecycle() {
  expect(process.platform).toBe("win32");
  const f = fixture(true);
  const prepared = await f.port.prepare(f.request);
  expect(prepared.control?.protocolVersion).toBe(1);
  expect(prepared.args).toContain("--job-control-v1");
  await expect(f.port.prepare(f.request)).rejects.toMatchObject({ code: "SANDBOX_SCOPE_CONFLICT" });
  await expect(f.port.shutdown()).rejects.toMatchObject({ code: "SANDBOX_CLEANUP_FAILED" });
  expect(f.reset).not.toHaveBeenCalled();
  await f.port.release(prepared.executionId);
  await f.port.release(prepared.executionId);
  await f.port.shutdown();
  expect(f.reset).toHaveBeenCalledTimes(1);
});

it("显式候选路径本身不冒充协议能力", async function legacyPathOnly() {
  const f = fixture(false);
  const prepared = await f.port.prepare(f.request);
  expect(prepared.control).toBeUndefined();
  expect(prepared.args).not.toContain("--job-control-v1");
  await f.port.release(prepared.executionId);
  await f.port.shutdown();
});
