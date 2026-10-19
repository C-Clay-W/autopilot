/**
 * 工具专用展示明细契约测试：锁定 read_file / glob_files / grep_files 的 display.detail。
 *
 * `ToolDisplayDetail` 从 Core 稳定入口导入，因此本文件同时验证该类型确实作为公开组成类型导出，
 * 而不是要求宿主导入 internal/*。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDisplayDetail } from "../../index";
import { createGlobFilesTool } from "./builtins/glob-files-tool";
import { createGrepFilesTool } from "./builtins/grep-files-tool";
import { createReadFileTool } from "./builtins/read-file-tool";
import { ToolExecutor } from "./tool-executor";
import { ToolRegistry } from "./tool-registry";
import type { AgentToolDefinition, ToolDisplayFacts, ToolExecutionResult } from "./types";

const temporaryRoots: string[] = [];

/** 创建只含相对路径可预期的最小工作区；registry.ts 刻意让单行出现多次命中。 */
async function createDetailWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rag-next-tool-detail-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "docs", "guide.md"), "# Guide\nalpha\nbeta\ngamma\ndelta", "utf8");
  await writeFile(path.join(root, "docs", "secret-note.md"), "sentinel READ_CONTENT_MUST_NOT_RENDER GREP_TEXT_MUST_NOT_RENDER", "utf8");
  await writeFile(path.join(root, "src", "agent.ts"), "export function createAgent() {\n  return \"agent\";\n}\n", "utf8");
  await writeFile(path.join(root, "src", "panel.tsx"), "export function Panel() {\n  return <div>Agent panel</div>;\n}\n", "utf8");
  await writeFile(path.join(root, "src", "registry.ts"), "import { Agent } from \"./agent\";\n\nexport const first: Agent = createAgent();\nexport const second: Agent = createAgent();\n", "utf8");
  await writeFile(path.join(root, "src", "empty.ts"), "export const nothing = null;\n", "utf8");
  return root;
}

/** 创建只注册三个只读探索工具的执行器，避免引入审批与写入语义。 */
function createDetailExecutor(workspaceRoot: string): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createGlobFilesTool());
  registry.register(createGrepFilesTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode: "ask",
    fileReadStates: new Map(),
    agentFlow: {
      async search() { return []; },
      async searchAcrossTables() { return { results: [] }; },
    },
  });
}

/** 执行一次只读工具并强制断言成功终态，使后续断言只面对 display。 */
async function executeSuccess(
  executor: ToolExecutor,
  toolName: "read_file" | "glob_files" | "grep_files",
  input: Record<string, unknown>,
  callId: string,
): Promise<Extract<ToolExecutionResult, { status: "success" }>> {
  const result = await executor.execute({ callId, toolName, input });
  if (result.status !== "success") throw new Error(`expected ${toolName} success, got ${result.status}`);
  return result;
}

/** 读取 Core 生成的专用展示明细。 */
function readDisplayDetail(display: ToolDisplayFacts | undefined): ToolDisplayDetail | undefined {
  return display?.detail;
}

/**
 * 注册一个冒用内置工具名的桩工具，用来直接控制 serialized output。
 * 这样才能在不依赖 1 MiB ripgrep 真实截断的前提下覆盖未知总数、展示预算和畸形输出分支。
 */
function createStubExecutor(toolName: "glob_files" | "grep_files" | "read_file", output: unknown): ToolExecutor {
  const registry = new ToolRegistry();
  const definition: AgentToolDefinition<Record<string, never>, unknown> = {
    name: toolName,
    description: "stub",
    inputSchema: z.object({}).strict(),
    metadata: { effect: "none", destructive: false, concurrency: { max: 1 }, retry: { safe: true } },
    createActionFacts: () => ({ toolName, effect: "none", destructive: false, operation: "search", risk: "read_only" }),
    async execute() { return output; },
    serializeOutput(value) { return value; },
  };
  registry.register(definition);
  return new ToolExecutor(registry, {
    permissionMode: "ask",
    agentFlow: {
      async search() { return []; },
      async searchAcrossTables() { return { results: [] }; },
    },
  });
}

/** 用桩工具执行一次并返回成功终态，使断言只面对由受控 output 生成的 display。 */
async function executeStub(
  toolName: "glob_files" | "grep_files" | "read_file",
  output: unknown,
): Promise<Extract<ToolExecutionResult, { status: "success" }>> {
  const result = await createStubExecutor(toolName, output).execute({ callId: `stub-${toolName}`, toolName, input: {} });
  if (result.status !== "success") throw new Error(`expected stub success, got ${result.status}`);
  return result;
}

/** 清理每个用例创建的临时工作区，避免测试留下副作用。 */
afterEach(async function cleanupDetailWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map(function removeRoot(root) {
    return rm(root, { recursive: true, force: true });
  }));
});

describe("工具专用展示明细契约", function toolDisplayDetailContractSuite() {
  it("read_file 的 display 携带相对路径、实际行范围与总行数", async function readDetailContract() {
    const workspaceRoot = await createDetailWorkspace();
    const executor = createDetailExecutor(workspaceRoot);

    const ranged = await executeSuccess(executor, "read_file", { path: "docs/guide.md", offset: 2, limit: 3 }, "read-range");
    const beyondEnd = await executeSuccess(executor, "read_file", { path: "docs/guide.md", offset: 99, limit: 10 }, "read-beyond");

    // read_file 走 path.relative()，输出的是 OS 分隔符；glob/grep 已由 normalizeSearchPath 归一。
    // 因此 Stage 1 的 read projector 必须自行归一为正斜杠，明细契约只接受 "docs/guide.md"。
    const osRelativePath = path.join("docs", "guide.md");
    // 工具输出当前已具备全部所需事实；offset 越界时 endLine < startLine，明细必须收敛为空范围。
    expect(ranged.output).toMatchObject({ path: osRelativePath, startLine: 2, endLine: 4, totalLines: 5, truncated: true });
    expect(beyondEnd.output).toMatchObject({ path: osRelativePath, startLine: 6, endLine: 5, totalLines: 5, truncated: false });

    expect(readDisplayDetail(ranged.display)).toEqual({
      kind: "read_file",
      path: "docs/guide.md",
      startLine: 2,
      endLine: 4,
      totalLines: 5,
      returnedLines: 3,
      truncated: true,
    });
    expect(readDisplayDetail(beyondEnd.display)).toEqual({
      kind: "read_file",
      path: "docs/guide.md",
      startLine: 6,
      endLine: null,
      totalLines: 5,
      returnedLines: 0,
      truncated: false,
    });
    expect(ranged.display?.target).toBe("docs/guide.md");
  });

  it("glob_files 的 display 携带受限相对路径、可证明总数与执行截断状态", async function globDetailContract() {
    const workspaceRoot = await createDetailWorkspace();
    const executor = createDetailExecutor(workspaceRoot);

    const found = await executeSuccess(executor, "glob_files", { pattern: "**/*.tsx", path: "." }, "glob-found");
    const empty = await executeSuccess(executor, "glob_files", { pattern: "**/*.nomatch", path: "." }, "glob-empty");
    const paged = await executeSuccess(executor, "glob_files", { pattern: "**/*.ts", path: ".", limit: 2 }, "glob-paged");

    // ripgrep 输出未截断，因此分页场景也能给出可证明的完整总数。
    expect(found.output).toMatchObject({ files: ["src/panel.tsx"], returned: 1, offset: 0, truncated: false, total: 1 });
    expect(empty.output).toMatchObject({ files: [], returned: 0, offset: 0, truncated: false, total: 0 });
    expect(paged.output).toMatchObject({ files: ["src/agent.ts", "src/empty.ts"], returned: 2, offset: 0, truncated: true, total: 3 });

    expect(readDisplayDetail(found.display)).toEqual({
      kind: "glob_files",
      paths: ["src/panel.tsx"],
      shownCount: 1,
      totalCount: 1,
      executionTruncated: false,
    });
    expect(readDisplayDetail(empty.display)).toEqual({
      kind: "glob_files",
      paths: [],
      shownCount: 0,
      totalCount: 0,
      executionTruncated: false,
    });
    expect(readDisplayDetail(paged.display)).toEqual({
      kind: "glob_files",
      paths: ["src/agent.ts", "src/empty.ts"],
      shownCount: 2,
      totalCount: 3,
      executionTruncated: false,
    });
  });

  it("grep_files 三种 outputMode 各自投影，且 content 只统计命中行", async function grepDetailContract() {
    const workspaceRoot = await createDetailWorkspace();
    const executor = createDetailExecutor(workspaceRoot);

    const content = await executeSuccess(executor, "grep_files", { pattern: "Agent", path: "src", glob: "**/*.{ts,tsx}" }, "grep-content");
    const pagedContent = await executeSuccess(executor, "grep_files", { pattern: "Agent", path: "src", glob: "**/*.{ts,tsx}", limit: 2 }, "grep-content-paged");
    const paths = await executeSuccess(executor, "grep_files", { pattern: "Agent", path: "src", glob: "**/*.{ts,tsx}", outputMode: "files_with_matches" }, "grep-paths");
    const counts = await executeSuccess(executor, "grep_files", { pattern: "Agent", path: "src", glob: "**/*.{ts,tsx}", outputMode: "count" }, "grep-counts");
    const contextual = await executeSuccess(executor, "grep_files", { pattern: "second", path: "src", glob: "**/*.ts", context: 2 }, "grep-context");
    const none = await executeSuccess(executor, "grep_files", { pattern: "ZZZ_NO_MATCH_ZZZ", path: "src" }, "grep-none");

    // content 的 matches 是 stdout 顺序且混有 context 行，明细的分组顺序与行号去重由 projector 冻结。
    // content 的 total 按命中行计（5），不含 context 行。
    expect(content.output).toMatchObject({ mode: "content", returned: 5, offset: 0, truncated: false, total: 5 });
    expect((content.output as { matches: unknown[] }).matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/agent.ts", line: 1, kind: "match" }),
      expect.objectContaining({ path: "src/panel.tsx", line: 2, kind: "match" }),
      expect.objectContaining({ path: "src/registry.ts", line: 1, kind: "match" }),
      expect.objectContaining({ path: "src/registry.ts", line: 3, kind: "match" }),
      expect.objectContaining({ path: "src/registry.ts", line: 4, kind: "match" }),
    ]));
    expect(pagedContent.output).toMatchObject({ mode: "content", returned: 2, offset: 0, truncated: true, total: 5 });
    expect(pagedContent.display?.detail).toMatchObject({ kind: "grep_content", executionTruncated: false, shownMatchedLineCount: 2, totalMatchedLineCount: 5 });
    expect(pagedContent.display?.summary).not.toContain("结果已截断");
    expect(paths.output).toMatchObject({
      mode: "files_with_matches",
      matches: [{ path: "src/agent.ts" }, { path: "src/panel.tsx" }, { path: "src/registry.ts" }],
      truncated: false,
      total: 3,
    });
    // registry.ts 的 count 为 5（submatch 次数），而命中行数只有 3：两种语义不得互换。
    expect(counts.output).toMatchObject({
      mode: "count",
      matches: [{ path: "src/agent.ts", count: 1 }, { path: "src/panel.tsx", count: 1 }, { path: "src/registry.ts", count: 5 }],
      truncated: false,
      total: 3,
    });
    expect((contextual.output as { matches: Array<{ line: number; kind: string }> }).matches.filter(function onlyMatch(entry) { return entry.kind === "match"; })).toEqual([
      expect.objectContaining({ path: "src/registry.ts", line: 4 }),
    ]);
    expect(none.output).toMatchObject({ mode: "content", matches: [], returned: 0, truncated: false });

    expect(readDisplayDetail(content.display)).toEqual({
      kind: "grep_content",
      files: [
        { path: "src/agent.ts", matchedLineCount: 1, lineNumbers: [1] },
        { path: "src/panel.tsx", matchedLineCount: 1, lineNumbers: [2] },
        { path: "src/registry.ts", matchedLineCount: 3, lineNumbers: [1, 3, 4] },
      ],
      shownMatchedLineCount: 5,
      totalMatchedLineCount: 5,
      executionTruncated: false,
    });
    expect(readDisplayDetail(paths.display)).toEqual({
      kind: "grep_paths",
      paths: ["src/agent.ts", "src/panel.tsx", "src/registry.ts"],
      shownCount: 3,
      totalCount: 3,
      executionTruncated: false,
    });
    expect(readDisplayDetail(counts.display)).toEqual({
      kind: "grep_counts",
      files: [
        { path: "src/agent.ts", count: 1 },
        { path: "src/panel.tsx", count: 1 },
        { path: "src/registry.ts", count: 5 },
      ],
      shownFileCount: 3,
      totalFileCount: 3,
      executionTruncated: false,
    });
    expect(readDisplayDetail(contextual.display)).toEqual({
      kind: "grep_content",
      files: [{ path: "src/registry.ts", matchedLineCount: 1, lineNumbers: [4] }],
      shownMatchedLineCount: 1,
      totalMatchedLineCount: 1,
      executionTruncated: false,
    });
    expect(readDisplayDetail(none.display)).toEqual({
      kind: "grep_content",
      files: [],
      shownMatchedLineCount: 0,
      totalMatchedLineCount: 0,
      executionTruncated: false,
    });
  });

  it("display 不携带 read 正文、grep 文本、内容哈希与绝对路径", async function displaySensitiveIsolation() {
    const workspaceRoot = await createDetailWorkspace();
    const executor = createDetailExecutor(workspaceRoot);

    const read = await executeSuccess(executor, "read_file", { path: "docs/secret-note.md" }, "read-secret");
    const grep = await executeSuccess(executor, "grep_files", { pattern: "sentinel", path: "docs" }, "grep-secret");
    const readOutput = read.output as { content: string; sha256: string | null };
    const grepOutput = grep.output as { matches: Array<{ text: string }> };
    const serialized = JSON.stringify([read.display, grep.display]);

    expect(readOutput.content).toContain("READ_CONTENT_MUST_NOT_RENDER");
    expect(grepOutput.matches[0]?.text).toContain("GREP_TEXT_MUST_NOT_RENDER");
    expect(readOutput.sha256).toEqual(expect.any(String));
    expect(serialized).not.toContain("READ_CONTENT_MUST_NOT_RENDER");
    expect(serialized).not.toContain("GREP_TEXT_MUST_NOT_RENDER");
    expect(serialized).not.toContain(String(readOutput.sha256));
    // Windows 绝对路径在 JSON 中会被转义，两种形态都要挡住。
    expect(serialized).not.toContain(JSON.stringify(workspaceRoot).slice(1, -1));
    expect(serialized).not.toContain(workspaceRoot.replace(/\\/g, "/"));
  });

  it("工具未提供可证明总数时不推断，执行截断事实仍保留", async function omitsUnprovableTotal() {
    const truncated = await executeStub("glob_files", { files: ["src/a.ts", "src/b.ts"], returned: 2, offset: 0, truncated: true });
    const detail = readDisplayDetail(truncated.display);

    expect(detail).toEqual({ kind: "glob_files", paths: ["src/a.ts", "src/b.ts"], shownCount: 2, executionTruncated: true });
    expect(detail && "totalCount" in detail).toBe(false);
    expect(truncated.display?.summary).toBe("显示 2 个路径，结果已截断");

    const grepTruncated = await executeStub("grep_files", { mode: "content", matches: [{ path: "src/a.ts", line: 3, text: "IGNORED", kind: "match" }], returned: 1, offset: 0, truncated: true });
    const grepDetail = readDisplayDetail(grepTruncated.display);

    expect(grepDetail).toEqual({
      kind: "grep_content",
      files: [{ path: "src/a.ts", matchedLineCount: 1, lineNumbers: [3] }],
      shownMatchedLineCount: 1,
      executionTruncated: true,
    });
    expect(grepDetail && "totalMatchedLineCount" in grepDetail).toBe(false);
  });

  it("长列表与长路径受 display 条目和字节预算约束，且显式标记 Core display 截断", async function boundsDisplayDetail() {
    const manyPaths = Array.from({ length: 400 }, function makePath(_unused, index) {
      return `packages/core/src/internal/module-${String(index).padStart(4, "0")}/index.ts`;
    });
    const many = await executeStub("glob_files", { files: manyPaths, returned: manyPaths.length, offset: 0, truncated: false, total: manyPaths.length });
    const manyDetail = readDisplayDetail(many.display);
    if (manyDetail?.kind !== "glob_files") throw new Error("expected glob_files detail");

    // 条目上限先生效；完整总数仍如实保留，不被 shownCount 覆盖。
    expect(manyDetail.paths).toHaveLength(100);
    expect(manyDetail.shownCount).toBe(100);
    expect(manyDetail.totalCount).toBe(400);
    expect(manyDetail.displayTruncated).toBe(true);

    const longPaths = Array.from({ length: 60 }, function makeLongPath(_unused, index) {
      return `packages/core/src/internal/${"deeply-nested-segment/".repeat(10)}module-${index}.ts`;
    });
    const long = await executeStub("glob_files", { files: longPaths, returned: longPaths.length, offset: 0, truncated: false, total: longPaths.length });
    const longDetail = readDisplayDetail(long.display);
    if (longDetail?.kind !== "glob_files") throw new Error("expected glob_files detail");

    // 字节预算先于条目上限生效，且保留的是完整路径而不是被裁断的字符串。
    expect(longDetail.paths.length).toBeLessThan(60);
    expect(longDetail.paths.every(function isComplete(value) { return value.endsWith(".ts"); })).toBe(true);
    expect(longDetail.displayTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(long.display), "utf8")).toBeLessThan(9 * 1024);

    const unprovable = await executeStub("glob_files", { files: manyPaths, returned: manyPaths.length, offset: 0, truncated: true });
    const unprovableDetail = readDisplayDetail(unprovable.display);
    if (unprovableDetail?.kind !== "glob_files") throw new Error("expected glob_files detail");

    expect(unprovableDetail).toMatchObject({ shownCount: 100, executionTruncated: true, displayTruncated: true });
    expect("totalCount" in unprovableDetail).toBe(false);
  });

  it("projector 只接受工作区相对路径，并限制 grep 单文件行号", async function validatesPathsAndBoundsLinesPerFile() {
    const unsafeRead = await executeStub("read_file", { path: "C:\\workspace\\secret.md", startLine: 1, endLine: 1, totalLines: 1, truncated: false });
    const unsafeGlob = await executeStub("glob_files", { files: ["/private/secret.md", "../escape.md", "C:relative-secret.md", "src/safe.ts"], truncated: false, total: 4 });
    const unsafeGrep = await executeStub("grep_files", {
      mode: "content",
      matches: [
        { path: "\\\\server\\share\\secret.md", line: 1, kind: "match", text: "MUST_NOT_RENDER" },
        { path: "src/safe.ts", line: 2, kind: "match", text: "MUST_NOT_RENDER" },
      ],
      truncated: false,
      total: 2,
    });

    expect(readDisplayDetail(unsafeRead.display)).toBeUndefined();
    expect(readDisplayDetail(unsafeGlob.display)).toMatchObject({ kind: "glob_files", paths: ["src/safe.ts"], shownCount: 1 });
    expect(readDisplayDetail(unsafeGrep.display)).toMatchObject({
      kind: "grep_content",
      files: [{ path: "src/safe.ts", matchedLineCount: 1, lineNumbers: [2] }],
    });
    expect(JSON.stringify([unsafeRead.display, unsafeGlob.display, unsafeGrep.display])).not.toContain("secret.md");

    const lineNumbers = Array.from({ length: 140 }, function makeLine(_unused, index) { return index + 1; });
    const manyLines = await executeStub("grep_files", {
      mode: "content",
      matches: lineNumbers.map(function toMatch(line) { return { path: "src/many.ts", line, kind: "match" }; }),
      truncated: false,
      total: lineNumbers.length,
    });
    const manyLinesDetail = readDisplayDetail(manyLines.display);
    if (manyLinesDetail?.kind !== "grep_content") throw new Error("expected grep_content detail");

    expect(manyLinesDetail).toMatchObject({
      files: [{ path: "src/many.ts", matchedLineCount: 100, lineNumbers: lineNumbers.slice(0, 100) }],
      shownMatchedLineCount: 100,
      totalMatchedLineCount: 140,
      displayTruncated: true,
    });
  });

  it("畸形输出与非成功终态都不生成明细，只回退到通用事实", async function skipsDetailWithoutTrustedOutput() {
    const malformedGlob = await executeStub("glob_files", { files: "not-an-array" });
    const unknownMode = await executeStub("grep_files", { mode: "unsupported", matches: [] });
    const malformedRead = await executeStub("read_file", { path: "docs/a.md", startLine: 1.5, endLine: 2, totalLines: 9 });

    expect(readDisplayDetail(malformedGlob.display)).toBeUndefined();
    expect(readDisplayDetail(unknownMode.display)).toBeUndefined();
    expect(readDisplayDetail(malformedRead.display)).toBeUndefined();
    expect(malformedGlob.display?.summary).toBe("search");

    const workspaceRoot = await createDetailWorkspace();
    const failed = await createDetailExecutor(workspaceRoot).execute({ callId: "read-outside", toolName: "read_file", input: { path: "../outside.md" } });

    expect(failed.status).toBe("error");
    expect(failed.display?.detail).toBeUndefined();
  });

  it("ToolDisplayDetail 的所有分支可由 TypeScript 穷尽检查", function exhaustsDetailUnion() {
    /** 覆盖全部 kind 的窄化函数；遗漏任一分支都会在编译期报错。 */
    function readShownScale(detail: ToolDisplayDetail): number {
      switch (detail.kind) {
        case "read_file": return detail.returnedLines;
        case "glob_files": return detail.shownCount;
        case "grep_content": return detail.shownMatchedLineCount;
        case "grep_paths": return detail.shownCount;
        case "grep_counts": return detail.shownFileCount;
        case "web_search": return detail.sourceCount;
        case "web_fetch": return 1;
        default: {
          const exhaustive: never = detail;
          return exhaustive;
        }
      }
    }

    expect(readShownScale({ kind: "glob_files", paths: [], shownCount: 0, executionTruncated: false })).toBe(0);
    expect(readShownScale({ kind: "read_file", path: "a.ts", startLine: 6, endLine: null, totalLines: 5, returnedLines: 0, truncated: false })).toBe(0);
    expect(readShownScale({ kind: "web_search", sourceCount: 2, truncated: false })).toBe(2);
    expect(readShownScale({ kind: "web_fetch", host: "example.com", contentType: "text/html", truncated: false })).toBe(1);
  });
});
