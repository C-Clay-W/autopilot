/**
 * path-access-policy 契约测试（Talk-Plan1013 Stage 1）：目标预检的内外判定、canonical 身份、
 * 危险形态拒绝与 env 真实工作区冒烟。真实工作区仅在老大指定的 AGENT_WORKSPACE_ROOT /
 * AGENT_WORKSPACE_ROOT_OUTSIDE 存在时执行，全部使用合成临时文件并用后清理。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExternalConstraint, getReadStateKey, resolveFileTarget } from "./path-access-policy";
import { TOOL_ERROR_CODES } from "../tool-error";

const temporaryRoots: string[] = [];

/** 创建隔离临时工作区与其外部的目标目录，两者互不嵌套。 */
async function createWorkspaceWithOutside(): Promise<{ workspaceRoot: string; outsideRoot: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "talk-plan1013-"));
  temporaryRoots.push(base);
  const workspaceRoot = path.join(base, "ws");
  const outsideRoot = path.join(base, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  return { workspaceRoot, outsideRoot };
}

/** 清理本文件创建的全部临时目录，避免 fixture 残留。 */
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 断言预检抛出指定稳定错误码。 */
async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ toolError: { code } });
}

describe("resolveFileTarget", () => {
  it("工作区内相对路径解析为内部目标并给出相对路径", async () => {
    const { workspaceRoot } = await createWorkspaceWithOutside();
    await writeFile(path.join(workspaceRoot, "note.txt"), "x", "utf8");
    const target = await resolveFileTarget(workspaceRoot, "note.txt");
    expect(target).toMatchObject({ isExternal: false, exists: true, relativePath: "note.txt" });
    expect(path.win32.relative(workspaceRoot.toLowerCase(), target.canonicalTarget.toLowerCase())).toBe("note.txt");
  });

  it("工作区内绝对路径输入同样解析为内部目标（读取例外允许绝对路径）", async () => {
    const { workspaceRoot } = await createWorkspaceWithOutside();
    const inside = path.join(workspaceRoot, "nested");
    await mkdir(inside, { recursive: true });
    const target = await resolveFileTarget(workspaceRoot, inside);
    expect(target.isExternal).toBe(false);
    expect(target.relativePath).toBe("nested");
  });

  it("外部绝对路径解析为外部目标，relativePath 缺省", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const target = await resolveFileTarget(workspaceRoot, outsideRoot);
    expect(target).toMatchObject({ isExternal: true, exists: true });
    expect(target.relativePath).toBeUndefined();
    expect(target.canonicalTarget.toLowerCase()).toBe(path.resolve(outsideRoot).toLowerCase());
  });

  it("相对路径 `..` 逃逸解析为外部目标，不再抛 PATH_TRAVERSAL（外部修改仍由 gate 强制授权）", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const target = await resolveFileTarget(workspaceRoot, path.join("..", path.basename(outsideRoot), "file.txt"));
    expect(target.isExternal).toBe(true);
    expect(target.exists).toBe(false);
  });

  it("未存在目标通过最近存在祖先还原 canonical 身份", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const target = await resolveFileTarget(workspaceRoot, path.join(outsideRoot, "new-dir", "new.txt"));
    expect(target.isExternal).toBe(true);
    expect(target.exists).toBe(false);
    expect(target.canonicalTarget.toLowerCase()).toBe(path.join(outsideRoot, "new-dir", "new.txt").toLowerCase());
  });

  it("Windows 路径大小写与分隔符不影响内外判定（非 Windows 跳过）", async () => {
    if (process.platform !== "win32") return;
    const { workspaceRoot } = await createWorkspaceWithOutside();
    const flipped = workspaceRoot.replace(/[a-z]/, (character) => character.toUpperCase()).replace(/\\/g, "/");
    const target = await resolveFileTarget(workspaceRoot, flipped);
    expect(target.isExternal).toBe(false);
  });

  it("拒绝 NUL、UNC、设备命名空间、ADS 与盘符相对路径", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    await expectErrorCode(resolveFileTarget(workspaceRoot, "bad\0path"), TOOL_ERROR_CODES.INVALID_INPUT);
    await expectErrorCode(resolveFileTarget(workspaceRoot, "\\\\server\\share\\x"), TOOL_ERROR_CODES.PATH_OUTSIDE_WORKSPACE);
    await expectErrorCode(resolveFileTarget(workspaceRoot, `\\\\?\\${outsideRoot}`), TOOL_ERROR_CODES.PATH_OUTSIDE_WORKSPACE);
    await expectErrorCode(resolveFileTarget(workspaceRoot, `${outsideRoot}\\file.txt:stream`), TOOL_ERROR_CODES.INVALID_INPUT);
    await expectErrorCode(resolveFileTarget(workspaceRoot, "C:relative.txt"), TOOL_ERROR_CODES.INVALID_INPUT);
  });

  it("read state 键：内部用相对路径，外部用 ext: canonical 身份；外部约束稳定绑定 canonical 目标", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    const internal = await resolveFileTarget(workspaceRoot, "a.txt");
    const external = await resolveFileTarget(workspaceRoot, path.join(outsideRoot, "a.txt"));
    expect(getReadStateKey(internal)).toBe("a.txt");
    expect(getReadStateKey(external)).toBe(`ext:${path.join(outsideRoot, "a.txt")}`);
    expect(buildExternalConstraint(external.canonicalTarget)).toBe(`ext-file:${path.join(outsideRoot, "a.txt")}`);
  });

  it("env 真实工作区冒烟：AGENT_WORKSPACE_ROOT 内部、AGENT_WORKSPACE_ROOT_OUTSIDE 外部（env 缺失跳过）", async () => {
    const realWorkspaceRoot = process.env.AGENT_WORKSPACE_ROOT;
    const realOutsideRoot = process.env.AGENT_WORKSPACE_ROOT_OUTSIDE;
    if (!realWorkspaceRoot || !realOutsideRoot) return;
    const insideDir = path.join(realWorkspaceRoot, "talk-plan1013-stage1");
    const outsideDir = path.join(realOutsideRoot, "talk-plan1013-stage1");
    await mkdir(insideDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    try {
      await writeFile(path.join(insideDir, "inside.txt"), "inside", "utf8");
      await writeFile(path.join(outsideDir, "outside.txt"), "outside", "utf8");
      const internal = await resolveFileTarget(realWorkspaceRoot, path.join("talk-plan1013-stage1", "inside.txt"));
      const external = await resolveFileTarget(realWorkspaceRoot, path.join(realOutsideRoot, "talk-plan1013-stage1", "outside.txt"));
      expect(internal.isExternal).toBe(false);
      expect(external.isExternal).toBe(true);
    } finally {
      await rm(insideDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
