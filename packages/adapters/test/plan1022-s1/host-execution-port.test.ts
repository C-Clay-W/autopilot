/**
 * test/plan1022-s1/host-execution-port.test.ts — Talk-Plan1022 S1 宿主执行 port 定向单测。
 *
 * 覆盖：status/setup 返回 Windows 停用能力报告（backend host-execution，不宣称隔离），
 * prepare 恒拒 SANDBOX_UNAVAILABLE（不存在沙箱包装），release/shutdown 幂等不抛。
 * 纯内存实现，无 IO、无 SRT 加载。
 */
import { describe, expect, it } from "vitest";
import { SANDBOX_ERROR_CODES, SandboxPortError, type SandboxExecutionRequest } from "@autopilot-agent/core";
import { createNodeHostExecutionSandboxPort } from "../../src/node/sandbox/node-host-execution-sandbox-port";

describe("Talk-Plan1022 S1 宿主执行 port", function hostExecutionPort() {
  it("status/setup 返回停用报告：backend host-execution、enforcement unavailable、不宣称已安装", async function reportsDisabledCapability() {
    const port = createNodeHostExecutionSandboxPort();
    const status = await port.status();
    expect(status).toMatchObject({ platform: "windows", backend: "host-execution", enforcement: "unavailable", installed: false, provisioned: false });
    expect(status.diagnostics?.[0]).toContain("进程沙箱已停用");
    const setup = await port.setup();
    expect(setup.backend).toBe("host-execution");
  });

  it("prepare 恒拒 SANDBOX_UNAVAILABLE：宿主执行不提供任何沙箱包装", async function prepareAlwaysFails() {
    const port = createNodeHostExecutionSandboxPort();
    const request: SandboxExecutionRequest = {
      commandId: "c1",
      program: "node",
      args: ["--version"],
      cwd: "C:/tmp/ws",
      policy: { mode: "workspace-write", allowedDomains: Object.freeze([]), deniedRead: Object.freeze([]), deniedWrite: Object.freeze([]) },
    };
    await expect(port.prepare(request)).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.UNAVAILABLE });
    await expect(port.prepare(request)).rejects.toBeInstanceOf(SandboxPortError);
  });

  it("release/shutdown 幂等不抛：宿主执行无可变沙箱资源", async function releaseAndShutdownIdempotent() {
    const port = createNodeHostExecutionSandboxPort();
    await expect(port.release("any")).resolves.toBeUndefined();
    await expect(port.release("any")).resolves.toBeUndefined();
    await expect(port.shutdown()).resolves.toBeUndefined();
  });
});
