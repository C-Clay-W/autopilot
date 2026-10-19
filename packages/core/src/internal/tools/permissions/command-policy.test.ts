/** command-policy 单元测试：验证工作区内精确命令约束的绑定与识别（问题 2.2"记住此命令"的基础身份）。 */
import { describe, expect, it } from "vitest";
import { computeWorkspaceCommandConstraint, isWorkspaceCommandConstraint, resolveCommandAuthorizationIdentity } from "./command-policy";

describe("computeWorkspaceCommandConstraint", function commandConstraintSuite() {
  const base = { workspaceRoot: "C:\\ws", cwd: "C:\\ws\\sub", program: "npx.CMD", args: ["--no-install", "tsc"], platform: "win32" as NodeJS.Platform };

  it("相同命令身份生成相同约束，Windows 程序名折叠大小写与扩展名", function identicalCommandsShareConstraint() {
    expect(computeWorkspaceCommandConstraint(base)).toBe(computeWorkspaceCommandConstraint({ ...base, program: "NPX.cmd" }));
  });

  it("Windows 路径大小写与分隔符差异不改变身份", function windowsPathVariantsShareConstraint() {
    expect(computeWorkspaceCommandConstraint(base)).toBe(computeWorkspaceCommandConstraint({ ...base, cwd: "c:/ws/sub" }));
  });

  it("参数、工作目录或工作区变化都生成不同约束", function anyIdentityChangeChangesConstraint() {
    expect(computeWorkspaceCommandConstraint({ ...base, args: ["--no-install", "eslint"] })).not.toBe(computeWorkspaceCommandConstraint(base));
    expect(computeWorkspaceCommandConstraint({ ...base, cwd: "C:\\ws" })).not.toBe(computeWorkspaceCommandConstraint(base));
    expect(computeWorkspaceCommandConstraint({ ...base, workspaceRoot: "C:\\other" })).not.toBe(computeWorkspaceCommandConstraint(base));
  });

  it("isWorkspaceCommandConstraint 识别当前精确命令约束前缀", function recognizesOnlyPrecisePrefix() {
    expect(isWorkspaceCommandConstraint(computeWorkspaceCommandConstraint(base))).toBe(true);
    expect(isWorkspaceCommandConstraint("program:npx")).toBe(false);
    expect(isWorkspaceCommandConstraint(undefined)).toBe(false);
  });
});

// CR 20261016 R6：精确命令授权不得把 macOS 上不同的实际程序合并为同一身份。
describe("resolveCommandAuthorizationIdentity（R6：分类名与授权身份分离）", function authorizationIdentitySuite() {
  it("darwin 不折叠扩展名与大小写：check、check.exe、Check 互不复用持久授权", function darwinKeepsDistinctProgramsDistinct() {
    const darwinBase = { workspaceRoot: "/w", cwd: "/w/sub", args: ["--flag"], platform: "darwin" as NodeJS.Platform };
    expect(resolveCommandAuthorizationIdentity("check", "darwin")).toBe("check");
    expect(resolveCommandAuthorizationIdentity("check.exe", "darwin")).toBe("check.exe");
    expect(resolveCommandAuthorizationIdentity("Check", "darwin")).toBe("Check");
    const plain = computeWorkspaceCommandConstraint({ ...darwinBase, program: "check" });
    const withExtension = computeWorkspaceCommandConstraint({ ...darwinBase, program: "check.exe" });
    const upper = computeWorkspaceCommandConstraint({ ...darwinBase, program: "Check" });
    expect(withExtension).not.toBe(plain);
    expect(upper).not.toBe(plain);
    expect(new Set([plain, withExtension, upper]).size).toBe(3);
  });

  it("darwin 不同可执行路径不共享授权", function darwinKeepsDistinctPathsDistinct() {
    const constraintOf = (program: string): string => computeWorkspaceCommandConstraint({ workspaceRoot: "/w", cwd: "/w", args: [], program, platform: "darwin" });
    expect(constraintOf("/w/bin/check")).not.toBe(constraintOf("/w/other/check"));
  });

  it("win32 等价解析仍稳定：npm ≡ npm.cmd ≡ NPM.EXE，绝对路径大写同样折叠", function windowsEquivalentResolutionStaysStable() {
    const constraintOf = (program: string): string => computeWorkspaceCommandConstraint({ workspaceRoot: "C:\\ws", cwd: "C:\\ws", args: ["install"], program, platform: "win32" });
    expect(constraintOf("npm")).toBe(constraintOf("npm.cmd"));
    expect(constraintOf("npm")).toBe(constraintOf("NPM.EXE"));
    expect(resolveCommandAuthorizationIdentity("C:\\Tools\\Check.EXE", "win32")).toBe("c:/tools/check");
    expect(constraintOf("C:\\Tools\\Check.EXE")).toBe(constraintOf("c:\\tools\\check"));
  });

  it("同一命令在 darwin 与 win32 下身份不同，避免跨系统沿用 grant", function platformParticipatesInIdentity() {
    const shared = { workspaceRoot: "/w", cwd: "/w", args: ["--flag"], program: "Check" };
    expect(computeWorkspaceCommandConstraint({ ...shared, platform: "darwin" })).not.toBe(computeWorkspaceCommandConstraint({ ...shared, platform: "win32" }));
  });

  it("约束版本化为 cmd:v2；遗留 cmd:v1 仅可识别但不再签发", function constraintVersionMigration() {
    const current = computeWorkspaceCommandConstraint({ workspaceRoot: "C:\\ws", cwd: "C:\\ws", args: [], program: "node", platform: "win32" });
    expect(current.startsWith("cmd:v2:")).toBe(true);
    expect(isWorkspaceCommandConstraint("cmd:v1:legacy-hash")).toBe(true);
    expect(current.startsWith("cmd:v1:")).toBe(false);
  });
});
