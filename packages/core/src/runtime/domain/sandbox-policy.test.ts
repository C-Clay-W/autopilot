/**
 * runtime/domain/sandbox-policy.test.ts — 沙箱领域契约测试（A 组，Talk-Plan0917 Stage 1）
 *
 * 验证 mode 枚举冻结、稳定错误码集合、policy denial 与 runner failure 语义区分、
 * sandboxMode 校验的 fail-closed 行为与 policy 摘要的确定性。
 */
import { describe, expect, it } from "vitest";
import {
  SANDBOX_ERROR_CODES,
  SANDBOX_POLICY_VERSION,
  computeSandboxPolicyDigest,
  isSandboxAvailabilityFailureCode,
  isSandboxPolicyDenialCode,
  resolveSandboxMode,
} from "./sandbox-policy";

describe("sandbox policy domain contract", () => {
  it("错误码集合与 Plan 冻结契约完全一致", () => {
    expect(SANDBOX_ERROR_CODES).toEqual({
      UNAVAILABLE: "SANDBOX_UNAVAILABLE",
      NOT_PROVISIONED: "SANDBOX_NOT_PROVISIONED",
      POLICY_DENIED: "SANDBOX_POLICY_DENIED",
      RUNNER_FAILED: "SANDBOX_RUNNER_FAILED",
      SCOPE_CONFLICT: "SANDBOX_SCOPE_CONFLICT",
      CLEANUP_FAILED: "SANDBOX_CLEANUP_FAILED",
    });
    expect(SANDBOX_POLICY_VERSION).toBe(1);
  });

  it("policy denial 与 availability failure 是互斥语义，不得混淆", () => {
    expect(isSandboxPolicyDenialCode(SANDBOX_ERROR_CODES.POLICY_DENIED)).toBe(true);
    expect(isSandboxPolicyDenialCode(SANDBOX_ERROR_CODES.UNAVAILABLE)).toBe(false);
    expect(isSandboxPolicyDenialCode(SANDBOX_ERROR_CODES.RUNNER_FAILED)).toBe(false);
    expect(isSandboxAvailabilityFailureCode(SANDBOX_ERROR_CODES.UNAVAILABLE)).toBe(true);
    expect(isSandboxAvailabilityFailureCode(SANDBOX_ERROR_CODES.NOT_PROVISIONED)).toBe(true);
    expect(isSandboxAvailabilityFailureCode(SANDBOX_ERROR_CODES.RUNNER_FAILED)).toBe(true);
    expect(isSandboxAvailabilityFailureCode(SANDBOX_ERROR_CODES.POLICY_DENIED)).toBe(false);
  });

  it("resolveSandboxMode 只接受三个冻结枚举值，未知值 fail-closed 拒绝", () => {
    expect(resolveSandboxMode("read-only")).toBe("read-only");
    expect(resolveSandboxMode("workspace-write")).toBe("workspace-write");
    expect(resolveSandboxMode("danger-full-access")).toBe("danger-full-access");
    expect(() => resolveSandboxMode("yolo")).toThrow(/SANDBOX_MODE_INVALID/);
    expect(() => resolveSandboxMode(undefined)).toThrow(/SANDBOX_MODE_INVALID/);
    expect(() => resolveSandboxMode(1)).toThrow(/SANDBOX_MODE_INVALID/);
  });

  it("policy 摘要对相同输入确定，且对 mode/workspaceRoot/tempRoot 任一变化敏感", () => {
    const base = { mode: "workspace-write" as const, workspaceRoot: "/ws", tempRoot: "/ws/.autopilot/tmp" };
    const digest = computeSandboxPolicyDigest(base);
    expect(computeSandboxPolicyDigest({ ...base })).toBe(digest);
    expect(computeSandboxPolicyDigest({ ...base, mode: "read-only" })).not.toBe(digest);
    expect(computeSandboxPolicyDigest({ ...base, tempRoot: "/other/tmp" })).not.toBe(digest);
    expect(computeSandboxPolicyDigest({ mode: "workspace-write" })).not.toBe(digest);
  });

  it("policy 摘要不泄露 workspaceRoot 明文", () => {
    const digest = computeSandboxPolicyDigest({ mode: "workspace-write", workspaceRoot: "/Users/someone/secret-project" });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("secret-project");
  });
});
