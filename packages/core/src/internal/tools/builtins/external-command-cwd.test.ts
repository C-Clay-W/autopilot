/** Stage3 cwd 合成测试：验证拒绝契约及成功结果安全标签；spawn 只用 mock，不启动命令或真实沙箱。 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunCommandTool } from "./run-command-tool";
import { SANDBOX_ERROR_CODES, type SandboxExecutionRequest, type SandboxPolicy } from "../../../runtime/domain/sandbox-policy";
import { SandboxPortError, type SandboxPort } from "../../../runtime/ports";

/** 保留 child_process 其他导出，只替换本文件需要观察的 spawn。 */
vi.mock("node:child_process", async function mockChildProcess(importOriginal) {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn() };
});

describe("Stage3 外部命令 cwd", function externalCommandCwd() {
  afterEach(function clearSpawnMock() { vi.mocked(spawn).mockReset(); });
  it("合法外部 cwd 到达 prepare，但隐藏脚本与 cwd 都不扩写根", async function recordsCanonicalCwd() {
    const root = await mkdtemp(path.join(os.tmpdir(), "stage3-cwd-"));
    try {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      await mkdir(workspace);
      await mkdir(outside);
      const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: await realpath(workspace), allowedDomains: [], deniedRead: [], deniedWrite: [] };
      const requests: SandboxExecutionRequest[] = [];
      const port: SandboxPort = {
        async status() { throw new Error("禁止真实 status"); },
        async setup() { throw new Error("禁止 setup"); },
        async prepare(request) { requests.push(request); throw new SandboxPortError(SANDBOX_ERROR_CODES.POLICY_DENIED, "fixture rejection"); },
        async release() {},
        async shutdown() {},
      };
      const tool = createRunCommandTool();
      const input = tool.inputSchema.parse({ program: "node", args: ["hidden-writer.js"], cwd: outside });
      await expect(tool.execute(input, { workspaceRoot: workspace, permissionMode: "full_access", sandboxPolicy: { port, policy } })).rejects.toMatchObject({ toolError: { code: SANDBOX_ERROR_CODES.POLICY_DENIED } });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.cwd).toBe(await realpath(outside));
      expect(requests[0]?.policy).toBe(policy);
      expect(Object.keys(policy)).not.toContain("allowedExternalWriteRoots");
      const forged = { ...input, allowedExternalWriteRoots: [outside] };
      expect(tool.inputSchema.safeParse(forged).success).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("成功结果隐藏外部 canonical cwd，内部 cwd 仍返回相对路径", async function hidesExternalCwdOutput() {
    const root = await mkdtemp(path.join(os.tmpdir(), "stage3-cwd-output-"));
    try {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      const inner = path.join(workspace, "inner");
      await mkdir(inner, { recursive: true });
      await mkdir(outside);
      const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: await realpath(workspace), allowedDomains: [], deniedRead: [], deniedWrite: [] };
      const requests: SandboxExecutionRequest[] = [];
      const released: string[] = [];
      const port: SandboxPort = {
        async status() { throw new Error("禁止真实 status"); },
        async setup() { throw new Error("禁止 setup"); },
        async prepare(request) {
          requests.push(request);
          return { executionId: request.commandId, executable: "mock-wrapper", args: [], env: {}, enforcement: "full" };
        },
        async release(executionId) { released.push(executionId); },
        async shutdown() {},
      };
      const tool = createRunCommandTool();
      for (const scenario of [{ requested: outside, target: outside, label: "[外部目录]" }, { requested: "inner", target: inner, label: "inner" }]) {
        const child = new EventEmitter();
        /** 模拟成功 close；微任务保证工具已经注册监听器，不启动任何真实进程。 */
        vi.mocked(spawn).mockImplementationOnce(function closeMockChild() {
          queueMicrotask(function emitClose() { child.emit("close", 0); });
          return child as unknown as ChildProcess;
        });
        const input = tool.inputSchema.parse({ program: "node", args: [], cwd: scenario.requested });
        const output = await tool.execute(input, { workspaceRoot: workspace, permissionMode: "full_access", sandboxPolicy: { port, policy } });
        expect(output).toMatchObject({ cwd: scenario.label, exitCode: 0, stdout: "", stderr: "" });
        expect(tool.serializeOutput(output)).toEqual(output);
        const serialized = JSON.stringify(tool.serializeOutput(output));
        expect(serialized).not.toContain(JSON.stringify(await realpath(outside)).slice(1, -1));
        expect(serialized).not.toContain(JSON.stringify(await realpath(root)).slice(1, -1));
        expect(requests[requests.length - 1]).toMatchObject({ cwd: await realpath(scenario.target), policy });
        expect(vi.mocked(spawn).mock.lastCall?.[2]).toMatchObject({ cwd: await realpath(scenario.target), shell: false });
        expect(released[released.length - 1]).toBe(requests[requests.length - 1]?.commandId);
      }
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
