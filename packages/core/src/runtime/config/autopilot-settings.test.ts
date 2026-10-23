/**
 * 外部权限段解析测试（H3）：Claude Code 的 defaultMode/Bash 写法只产生诊断且不产生授权，
 * 合法 deny/ask 收窄必须保留；deny/ask 无法解释时整段快照按不可信（restricted）处理。
 */

import { describe, expect, it } from "vitest";
import { resolveAutopilotSettings } from "./autopilot-settings";

/** 解析单个 scope 的 permissions 段，返回权限快照与“错误码:字段”诊断。 */
function resolvePermissions(permissions: unknown, scope: "user" | "project" | "local" = "user") {
  const resolved = resolveAutopilotSettings([{ scope, value: { permissions } }]);
  return {
    permissions: resolved.permissions,
    codes: resolved.diagnostics.map(function label(diagnostic) { return `${diagnostic.code}:${diagnostic.field ?? ""}`; }),
  };
}

describe("外部权限段解析（H3）", function externalPermissionsSuite() {
  it("Claude Code 字段与 user allow 只记诊断，合法 deny 收窄保留且不产生授权", function keepsValidNarrowing() {
    const result = resolvePermissions({ defaultMode: "acceptEdits", allow: ["Bash(rm -rf /)", "Write(C:\\outside\\a.txt)"], deny: ["Write(C:\\secret\\a.txt)"], ask: [] });
    expect(result.codes).toEqual(expect.arrayContaining([
      "SETTINGS_PERMISSIONS_UNSUPPORTED:permissions.defaultMode",
      "SETTINGS_PERMISSIONS_SCOPE_FORBIDDEN:permissions.allow",
    ]));
    expect(result.permissions.allow).toEqual([]);
    expect(result.permissions.deny).toEqual(["Write(C:\\secret\\a.txt)"]);
    expect(result.permissions.restricted).toBeUndefined();
  });

  it("local allow 的合法规则仍然生效，未知字段不影响该列表", function keepsValidLocalAllow() {
    const result = resolvePermissions({ allow: ["Write(C:\\outside\\a.txt)"], defaultMode: "plan" }, "local");
    expect(result.codes).toContain("SETTINGS_PERMISSIONS_UNSUPPORTED:permissions.defaultMode");
    expect(result.permissions.allow).toEqual(["Write(C:\\outside\\a.txt)"]);
    expect(result.permissions.restricted).toBeUndefined();
  });

  it("deny/ask 无法解释时置 restricted，不能只丢条目后继续放行", function restrictsUnsafeNarrowing() {
    for (const field of ["deny", "ask"] as const) {
      const result = resolvePermissions({ [field]: ["Bash(rm -rf /)"] });
      expect(result.codes).toContain(`SETTINGS_PERMISSIONS_UNSAFE:permissions.${field}`);
      expect(result.permissions.restricted).toBe(true);
      expect(result.permissions[field]).toEqual([]);
    }
    expect(resolvePermissions({ deny: "Write(C:\\secret\\a.txt)" }).permissions.restricted).toBe(true);
  });

  it("permissions 不是对象时整段不可信", function restrictsNonObject() {
    const result = resolvePermissions(["Write(C:\\outside\\a.txt)"]);
    expect(result.codes).toContain("SETTINGS_PERMISSIONS_INVALID:permissions");
    expect(result.permissions.restricted).toBe(true);
  });

  it("restricted 只累积不放宽，后续 layer 的合法规则不能解除", function keepsRestrictedAcrossSources() {
    const resolved = resolveAutopilotSettings([
      { scope: "user", value: { permissions: { deny: ["Bash(rm)"] } } },
      { scope: "local", value: { permissions: { allow: ["Write(C:\\outside\\a.txt)"], deny: ["Write(C:\\secret\\b.txt)"] } } },
    ]);
    expect(resolved.permissions.restricted).toBe(true);
    expect(resolved.permissions.allow).toEqual(["Write(C:\\outside\\a.txt)"]);
    expect(resolved.permissions.deny).toEqual(["Write(C:\\secret\\b.txt)"]);
  });
});
