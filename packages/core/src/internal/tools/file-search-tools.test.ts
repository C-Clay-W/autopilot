/**
 * 文件搜索工具自动化测试：覆盖工作区边界、分页、模式输出、敏感排除和错误终态。
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGlobFilesTool } from "./builtins/glob-files-tool";
import { createGrepFilesTool } from "./builtins/grep-files-tool";
import { resolveRipgrepExecutable } from "./file-search";
import { ToolExecutor } from "./tool-executor";
import { ToolRegistry } from "./tool-registry";
import type { ToolExecutionResult } from "./types";

const temporaryRoots: string[] = [];

/** 创建带代码、忽略文件和敏感文件的独立搜索工作区。 */
async function createSearchWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rag-next-search-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, "src", "components"), { recursive: true });
  await mkdir(path.join(root, "ignored"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8");
  await writeFile(path.join(root, "src", "agent.ts"), "export function createAgent() {\n  return 'agent';\n}\n", "utf8");
  await writeFile(path.join(root, "src", "components", "Panel.tsx"), "export function Panel() {\n  return <div>Agent panel</div>;\n}\n", "utf8");
  await writeFile(path.join(root, "src", "components", "Empty.tsx"), "export function Empty() {\n  return null;\n}\n", "utf8");
  await writeFile(path.join(root, "ignored", "hidden.ts"), "export const hidden = 'Agent secret';\n", "utf8");
  await writeFile(path.join(root, ".env"), "API_KEY=AgentSecret\n", "utf8");
  await writeFile(path.join(root, ".env.example"), "API_KEY=example\n", "utf8");
  return root;
}

/** 创建只注册两个文件搜索工具的受控执行器。 */
function createSearchExecutor(workspaceRoot: string): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createGlobFilesTool());
  registry.register(createGrepFilesTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode: "ask",
    agentFlow: {
      async search() { return []; },
      async searchAcrossTables() { return { results: [] }; },
    },
  });
}

/** 执行搜索工具并返回结构化终态。 */
async function executeSearch(
  executor: ToolExecutor,
  toolName: "glob_files" | "grep_files",
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  return await executor.execute({
    callId: `${toolName}-${Math.random()}`,
    toolName,
    input,
  });
}

/** 清理自动化测试创建的临时工作区。 */
afterEach(async function cleanupSearchWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map(function removeRoot(root) {
    return rm(root, { recursive: true, force: true });
  }));
});

describe("文件搜索工具", function fileSearchToolsSuite() {
  it("使用项目固定的 ripgrep 平台包", async function fixedRipgrepPackage() {
    const executable = resolveRipgrepExecutable();
    const fileStats = await stat(executable);
    expect(fileStats.isFile()).toBe(true);
    expect(path.basename(executable).toLowerCase()).toMatch(/^rg(?:\.exe)?$/);
  });

  it("glob_files 返回稳定分页路径并尊重 gitignore", async function globFilesPagination() {
    const workspaceRoot = await createSearchWorkspace();
    const executor = createSearchExecutor(workspaceRoot);
    const first = await executeSearch(executor, "glob_files", {
      pattern: "**/*.tsx",
      path: ".",
      limit: 1,
    });
    expect(first.status).toBe("success");
    if (first.status !== "success") throw new Error("expected glob_files success");
    expect(first.output).toMatchObject({
      files: ["src/components/Empty.tsx"],
      returned: 1,
      offset: 0,
      truncated: true,
    });

    const second = await executeSearch(executor, "glob_files", {
      pattern: "**/*.tsx",
      path: ".",
      limit: 1,
      offset: 1,
    });
    expect(second.status).toBe("success");
    if (second.status !== "success") throw new Error("expected glob_files success");
    expect(second.output).toMatchObject({
      files: ["src/components/Panel.tsx"],
      returned: 1,
      offset: 1,
      truncated: false,
    });
  });

  it("grep_files 返回行号，并支持文件列表和计数模式", async function grepFilesModes() {
    const workspaceRoot = await createSearchWorkspace();
    const executor = createSearchExecutor(workspaceRoot);
    const content = await executeSearch(executor, "grep_files", {
      pattern: "Agent",
      path: "src",
      glob: "**/*.{ts,tsx}",
    });
    expect(content.status).toBe("success");
    if (content.status !== "success") throw new Error("expected grep_files content success");
    const contentOutput = content.output as { mode: string; matches: Array<{ path: string; line: number; text: string }> };
    expect(contentOutput.mode).toBe("content");
    expect(contentOutput.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/components/Panel.tsx", line: 2, text: expect.stringContaining("Agent panel") }),
      expect.objectContaining({ path: "src/agent.ts", line: 1, text: expect.stringContaining("createAgent") }),
    ]));

    const files = await executeSearch(executor, "grep_files", {
      pattern: "Agent",
      path: "src",
      outputMode: "files_with_matches",
    });
    expect(files.status).toBe("success");
    if (files.status !== "success") throw new Error("expected grep_files files success");
    expect(files.output).toMatchObject({
      mode: "files_with_matches",
      matches: [
        { path: "src/agent.ts" },
        { path: "src/components/Panel.tsx" },
      ],
    });

    const counts = await executeSearch(executor, "grep_files", {
      pattern: "Agent",
      path: "src",
      outputMode: "count",
    });
    expect(counts.status).toBe("success");
    if (counts.status !== "success") throw new Error("expected grep_files count success");
    expect(counts.output).toMatchObject({
      mode: "count",
      matches: [
        { path: "src/agent.ts", count: 1 },
        { path: "src/components/Panel.tsx", count: 1 },
      ],
    });
  });

  it("grep_files 不搜索 gitignore 和敏感文件正文", async function grepFilesSensitiveExcludes() {
    const workspaceRoot = await createSearchWorkspace();
    const executor = createSearchExecutor(workspaceRoot);
    const result = await executeSearch(executor, "grep_files", {
      pattern: "AgentSecret|Agent secret",
      path: ".",
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected grep_files success");
    expect(result.output).toMatchObject({
      mode: "content",
      matches: [],
      returned: 0,
      truncated: false,
    });
  });

  it("搜索外部目标免新增路径审批、不存在时报 FILE_NOT_READ，非法正则仍拒绝（Talk-Plan1013 Stage 1）", async function searchErrors() {
    const workspaceRoot = await createSearchWorkspace();
    const executor = createSearchExecutor(workspaceRoot);
    // Talk-Plan1013 Stage 1：`../outside` 不再抛 PATH_TRAVERSAL；目标不存在收敛为 FILE_NOT_READ。
    const missingOutside = await executeSearch(executor, "glob_files", {
      pattern: "**/*",
      path: "../outside",
    });
    expect(missingOutside.status === "error" && missingOutside.error.code).toBe("FILE_NOT_READ");

    const invalidRegex = await executeSearch(executor, "grep_files", {
      pattern: "(",
      path: ".",
    });
    expect(invalidRegex.status === "error" && invalidRegex.error.code).toBe("INVALID_INPUT");
  });

  it("取消前不会启动搜索子进程", async function cancelledSearch() {
    const workspaceRoot = await createSearchWorkspace();
    const executor = createSearchExecutor(workspaceRoot);
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute({
      callId: "grep-cancelled",
      toolName: "grep_files",
      input: { pattern: "Agent", path: "." },
    }, { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(result.status === "cancelled" && result.interruption.safeToRetry).toBe(true);
  });
});
