/**
 * internal/tools/sandbox-policy-resolver.test.ts — 审批/沙箱正交组合矩阵测试（C 组，Talk-Plan0917 Stage 1）
 *
 * 逐行验证 Plan 第七节组合矩阵在 resolver 上的投影：unavailable × 任意 permissionMode
 * 一律 fail-closed；auto-allow 前提只由 auto_approve + Trust + 沙箱可执行构成；
 * tempRoot 不回退 ambient temp；danger-full-access 只透传宿主冻结值。
 */
import { describe, expect, it } from "vitest";
import { resolveSandboxPolicy, type SandboxResolverInput } from "./sandbox-policy-resolver";
import type { SandboxCapabilityReport } from "../../runtime/domain/sandbox-policy";

/** 构造能力报告的最小输入。 */
function createInput(overrides: Partial<SandboxResolverInput> = {}): SandboxResolverInput {
  const capability: SandboxCapabilityReport = { platform: "macos", backend: "seatbelt", enforcement: "full" };
  return {
    mode: "workspace-write",
    workspaceRoot: "/ws",
    tempRoot: "/ws/.autopilot/tmp",
    capability,
    permissionMode: "ask",
    workspaceTrusted: true,
    ...overrides,
  };
}

describe("sandbox policy resolver matrix", () => {
  it("C1/C3：ask 与 full_access × workspace-write × full 能力下沙箱照常执行，policy 冻结工作区与受控 tempRoot", () => {
    for (const permissionMode of ["ask", "full_access"] as const) {
      const resolution = resolveSandboxPolicy(createInput({ permissionMode }));
      expect(resolution.executable).toBe(true);
      expect(resolution.enforcement).toBe("full");
      expect(resolution.policy).toEqual({
        mode: "workspace-write",
        workspaceRoot: "/ws",
        tempRoot: "/ws/.autopilot/tmp",
        allowedDomains: [],
        deniedRead: [],
        deniedWrite: [],
      });
    }
  });

  it("C6：unavailable × 任意 permissionMode 一律 fail-closed，不可执行", () => {
    const capability: SandboxCapabilityReport = { platform: "unknown", backend: "none", enforcement: "unavailable" };
    for (const permissionMode of ["ask", "auto_approve", "full_access"] as const) {
      const resolution = resolveSandboxPolicy(createInput({ permissionMode, capability }));
      expect(resolution.executable).toBe(false);
      expect(resolution.canSandboxAutoAllow).toBe(false);
      expect(resolution.enforcement).toBe("unavailable");
    }
  });

  it("partial 仍可执行，但 enforcement 保持 partial，不得冒充 full", () => {
    const capability: SandboxCapabilityReport = { platform: "windows", backend: "fake-acl", enforcement: "partial" };
    const resolution = resolveSandboxPolicy(createInput({ capability }));
    expect(resolution.executable).toBe(true);
    expect(resolution.enforcement).toBe("partial");
  });

  it("C4：read-only 冻结为只读 policy，与 permissionMode 无关", () => {
    const resolution = resolveSandboxPolicy(createInput({ mode: "read-only", permissionMode: "full_access" }));
    expect(resolution.policy.mode).toBe("read-only");
    expect(resolution.executable).toBe(true);
  });

  it("C5：danger-full-access 只透传宿主冻结值，resolver 不做任何放宽转换", () => {
    const resolution = resolveSandboxPolicy(createInput({ mode: "danger-full-access", permissionMode: "full_access" }));
    expect(resolution.policy.mode).toBe("danger-full-access");
    expect(resolution.executable).toBe(true);
  });

  it("G4：auto-allow 前提仅由 auto_approve + Trust + 沙箱可执行构成", () => {
    expect(resolveSandboxPolicy(createInput({ permissionMode: "auto_approve" })).canSandboxAutoAllow).toBe(true);
    expect(resolveSandboxPolicy(createInput({ permissionMode: "auto_approve", workspaceTrusted: false })).canSandboxAutoAllow).toBe(false);
    expect(resolveSandboxPolicy(createInput({ permissionMode: "ask" })).canSandboxAutoAllow).toBe(false);
    expect(resolveSandboxPolicy(createInput({ permissionMode: "full_access" })).canSandboxAutoAllow).toBe(false);
    const unavailable: SandboxCapabilityReport = { platform: "unknown", backend: "none", enforcement: "unavailable" };
    expect(resolveSandboxPolicy(createInput({ permissionMode: "auto_approve", capability: unavailable })).canSandboxAutoAllow).toBe(false);
  });

  it("D4：tempRoot 只透传宿主显式验证值，缺省时不继承环境 TEMP/TMP 或工作区父目录", () => {
    const withoutTemp = resolveSandboxPolicy(createInput({ tempRoot: undefined }));
    expect(withoutTemp.policy.tempRoot).toBeUndefined();
    const withTemp = resolveSandboxPolicy(createInput({ tempRoot: "/ws/.autopilot/tmp" }));
    expect(withTemp.policy.tempRoot).toBe("/ws/.autopilot/tmp");
  });

  it("宿主未提供网络与路径策略时为空冻结数组，不出现默认放行", () => {
    const resolution = resolveSandboxPolicy(createInput({ allowedDomains: undefined, deniedRead: undefined, deniedWrite: undefined }));
    expect(resolution.policy.allowedDomains).toEqual([]);
    expect(resolution.policy.deniedRead).toEqual([]);
    expect(resolution.policy.deniedWrite).toEqual([]);
    expect(Object.isFrozen(resolution.policy.allowedDomains)).toBe(true);
  });
});
