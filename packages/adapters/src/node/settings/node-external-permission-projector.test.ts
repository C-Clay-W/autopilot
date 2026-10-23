/**
 * Node 外部权限规则投影器测试（Talk-Plan1013 Stage 2）：
 * settings.local.json 投影写入/移除、deny 并集读取、非法规则拒绝、链接安全 fail-safe。
 * env 真实工作区冒烟只读（不写 test-agent 的配置文件）。
 */
import fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeExternalPermissionProjector } from "./node-external-permission-projector";
import { isValidExternalPermissionRule, resolveAutopilotSettings } from "@autopilot-agent/core";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 创建隔离 workspace 与隔离 User home 的投影器 fixture。 */
async function createProjectorFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "ext-projector-"));
  temporaryRoots.push(base);
  const workspaceRoot = path.join(base, "ws");
  const home = path.join(base, "home");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  return { workspaceRoot, home, projector: createNodeExternalPermissionProjector({ homeDirectory: home }), localPath: path.join(workspaceRoot, ".autopilot", "settings.local.json") };
}

describe("createNodeExternalPermissionProjector", () => {
  it("记住规则：写入 settings.local.json 并通过 Core schema 校验，read 返回 allow", async () => {
    const { workspaceRoot, projector, localPath } = await createProjectorFixture();
    await projector.project({ workspaceRoot, rule: "Write(C:\\outside\\a.txt)", action: "add" });
    expect(fs.existsSync(localPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(localPath, "utf8"));
    expect(parsed.permissions.allow).toEqual(["Write(C:\\outside\\a.txt)"]);
    const snapshot = await projector.read(workspaceRoot);
    expect(snapshot.allow).toEqual(["Write(C:\\outside\\a.txt)"]);
    expect(snapshot.deny).toEqual([]);
  });

  it("重复记住幂等；撤销后 allow 清空且 permissions 键收敛", async () => {
    const { workspaceRoot, projector, localPath } = await createProjectorFixture();
    await projector.project({ workspaceRoot, rule: "Edit(C:\\outside\\b.txt)", action: "add" });
    await projector.project({ workspaceRoot, rule: "Edit(C:\\outside\\b.txt)", action: "add" });
    expect(JSON.parse(fs.readFileSync(localPath, "utf8")).permissions.allow).toEqual(["Edit(C:\\outside\\b.txt)"]);
    await projector.project({ workspaceRoot, rule: "Edit(C:\\outside\\b.txt)", action: "remove" });
    const parsed = JSON.parse(fs.readFileSync(localPath, "utf8"));
    expect(parsed.permissions).toBeUndefined();
    const snapshot = await projector.read(workspaceRoot);
    expect(snapshot.allow).toEqual([]);
  });

  it("deny 并集：User 层 deny 与 local deny 合并返回，allow 仍仅 local", async () => {
    const { workspaceRoot, home, projector } = await createProjectorFixture();
    const userSettingsDir = path.join(home, ".autopilot");
    await mkdir(userSettingsDir, { recursive: true });
    await writeFile(path.join(userSettingsDir, "settings.json"), JSON.stringify({ permissions: { deny: ["Write(C:\\outside\\**)"] } }), "utf8");
    await projector.project({ workspaceRoot, rule: "Write(C:\\outside\\a.txt)", action: "add" });
    const snapshot = await projector.read(workspaceRoot);
    expect(snapshot.allow).toEqual(["Write(C:\\outside\\a.txt)"]);
    expect(snapshot.deny).toEqual(["Write(C:\\outside\\**)"]);
  });

  it("非法规则语法拒绝写入，local 文件不被创建", async () => {
    const { workspaceRoot, projector, localPath } = await createProjectorFixture();
    await expect(projector.project({ workspaceRoot, rule: "write_file", action: "add" })).rejects.toThrow("EXTERNAL_RULE_INVALID");
    expect(fs.existsSync(localPath)).toBe(false);
  });

  it("deny 条目不影响 allow 投影写入口（write入口只写 allow）", async () => {
    const { workspaceRoot, projector } = await createProjectorFixture();
    await projector.project({ workspaceRoot, rule: "Read(C:\\outside\\c.txt)", action: "add" });
    const snapshot = await projector.read(workspaceRoot);
    expect(snapshot.allow).toEqual(["Read(C:\\outside\\c.txt)"]);
    expect(resolveAutopilotSettings([{ scope: "local", value: { permissions: { allow: ["Read(C:\\outside\\c.txt)"] } } }]).permissions.allow).toEqual(["Read(C:\\outside\\c.txt)"]);
  });

  it("H3：deny/ask 无法解释时 read 标记 restricted 并拒绝写入", async () => {
    const { workspaceRoot, home, projector, localPath } = await createProjectorFixture();
    const userSettingsDir = path.join(home, ".autopilot");
    await mkdir(userSettingsDir, { recursive: true });
    await writeFile(path.join(userSettingsDir, "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"] } }), "utf8");
    const snapshot = await projector.read(workspaceRoot);
    expect(snapshot.restricted).toBe(true);
    expect(snapshot.deny).toEqual([]);

    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, JSON.stringify({ permissions: { deny: ["Bash(ls)"] } }), "utf8");
    await expect(projector.project({ workspaceRoot, rule: "Write(C:\\outside\\a.txt)", action: "add" })).rejects.toThrow("EXTERNAL_RULE_PERMISSIONS_UNSAFE");
  });

  it("H3：现有 permissions 不是对象时拒绝写入并保留原字节", async () => {
    const { workspaceRoot, projector, localPath } = await createProjectorFixture();
    await mkdir(path.dirname(localPath), { recursive: true });
    const original = JSON.stringify({ permissions: ["Read(C:\\outside\\a.txt)"] });
    await writeFile(localPath, original, "utf8");
    await expect(projector.project({ workspaceRoot, rule: "Write(C:\\outside\\a.txt)", action: "add" })).rejects.toThrow("EXTERNAL_RULE_PERMISSIONS_UNSAFE");
    expect(fs.readFileSync(localPath, "utf8")).toBe(original);
  });

  it("env 真实工作区冒烟：只读 AGENT_WORKSPACE_ROOT 快照与外部规则格式（env 缺失跳过，不写真实配置）", async () => {
    const realWorkspaceRoot = process.env.AGENT_WORKSPACE_ROOT;
    const realOutsideRoot = process.env.AGENT_WORKSPACE_ROOT_OUTSIDE;
    if (!realWorkspaceRoot || !realOutsideRoot) return;
    const projector = createNodeExternalPermissionProjector();
    const snapshot = await projector.read(realWorkspaceRoot);
    expect(Array.isArray(snapshot.allow)).toBe(true);
    expect(Array.isArray(snapshot.deny)).toBe(true);
    // 外部目标规则使用 AGENT_WORKSPACE_ROOT_OUTSIDE 下的合成路径；仅验证语法接受，不落盘真实工作区。
    const rule = `Write(${path.join(realOutsideRoot, "stage2", "memo.txt")})`;
    expect(isValidExternalPermissionRule(rule)).toBe(true);
  });
});
