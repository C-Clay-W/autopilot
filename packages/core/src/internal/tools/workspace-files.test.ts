/**
 * listWorkspaceFiles 契约测试：覆盖排除规则、稳定排序、maxFiles 截断、空工作区与错误收敛。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntimeError } from "../../runtime/protocol/error-code";
import { listWorkspaceFiles } from "./workspace-files";

const temporaryRoots: string[] = [];

/** 创建带源码、忽略文件和高噪声干扰目录的独立枚举工作区。 */
async function createSearchWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "autopilot-workspace-files-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "coverage"), { recursive: true });
  await mkdir(path.join(root, "src", "components"), { recursive: true });
  await mkdir(path.join(root, "ignored"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
  await writeFile(path.join(root, ".env"), "KEY=value\n", "utf8");
  await writeFile(path.join(root, "src", "agent.ts"), "export {}\n", "utf8");
  await writeFile(path.join(root, "src", "components", "Panel.tsx"), "export {}\n", "utf8");
  await writeFile(path.join(root, ".git", "config"), "[core]\n", "utf8");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n", "utf8");
  await writeFile(path.join(root, "dist", "bundle.js"), "console.log(1);\n", "utf8");
  await writeFile(path.join(root, "coverage", "lcov.info"), "TN:\n", "utf8");
  await writeFile(path.join(root, "ignored", "hidden.ts"), "export {}\n", "utf8");
  return root;
}

/** 清理自动化测试创建的临时工作区。 */
afterEach(async function cleanupWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map(function removeRoot(root) {
    return rm(root, { recursive: true, force: true });
  }));
});

describe("listWorkspaceFiles", function workspaceFilesSuite() {
  it("返回稳定排序的正斜杠相对路径，并排除高噪声目录与 gitignore 条目", async function excludesAndSorts() {
    const root = await createSearchWorkspace();
    const result = await listWorkspaceFiles({ workspaceRoot: root });
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual([
      ".env",
      ".gitignore",
      "README.md",
      "src/agent.ts",
      "src/components/Panel.tsx",
    ]);
  });

  it("maxFiles 截断列表并标注 truncated", async function maxFilesTruncation() {
    const root = await createSearchWorkspace();
    const result = await listWorkspaceFiles({ workspaceRoot: root, maxFiles: 2 });
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("空工作区返回空列表且不标注截断", async function emptyWorkspace() {
    const root = await mkdtemp(path.join(os.tmpdir(), "autopilot-workspace-empty-"));
    temporaryRoots.push(root);
    const result = await listWorkspaceFiles({ workspaceRoot: root });
    expect(result).toEqual({ files: [], truncated: false });
  });

  it("目录不存在时抛 AgentRuntimeError(INVALID_INPUT)", async function missingRoot() {
    await expect(listWorkspaceFiles({ workspaceRoot: path.join(os.tmpdir(), "autopilot-missing-root") }))
      .rejects.toMatchObject({ name: "AgentRuntimeError", code: "INVALID_INPUT" });
  });

  it("已取消的 signal 收敛为 AgentRuntimeError", async function abortedSignal() {
    const root = await createSearchWorkspace();
    const controller = new AbortController();
    controller.abort();
    await expect(listWorkspaceFiles({ workspaceRoot: root, signal: controller.signal }))
      .rejects.toBeInstanceOf(AgentRuntimeError);
  });
});
