/**
 * p1fix-r001 Tester 回归用例：R5 必测 #4 的 glob/grep 部分（Talk-Plan1013 Stage5 CR R5）。
 *
 * 合同要求（CR R5 verification + Plan §7.4）：显式读取限制须在读正文前生效——
 *   deny → 任何正文/结果读取前硬拒绝（零结果输出）；ask → 该次调用逐次确认
 *   （allowedDecisions 仅 ["allow_once","deny"]，不写持久规则）；allow → 维持
 *   “读取免新增路径审批”现状。Executor 本轮新增用例只覆盖 read_file/edit_file，
 *   glob_files/grep_files 的 facts 限制接入无任何动态覆盖，本文件补齐。
 *
 * 本文件只新增测试断言，不修改任何产品源码。fixture 全部合成临时目录，用后清理；
 * glob/grep 执行走真实 ripgrep 子进程（与既有 file-search-tools.test.ts 同方式）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGlobFilesTool } from "../../src/internal/tools/builtins/glob-files-tool";
import { createGrepFilesTool } from "../../src/internal/tools/builtins/grep-files-tool";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import { TOOL_ERROR_CODES } from "../../src/internal/tools/tool-error";
import type { ToolExecutionContext } from "../../src/internal/tools/types";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 创建独立临时工作区与其外部的目标根，两者互不嵌套。 */
async function createWorkspaceWithOutside(): Promise<{ workspaceRoot: string; outsideRoot: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "p1fix-r001-search-"));
  temporaryRoots.push(base);
  const workspaceRoot = path.join(base, "ws");
  const outsideRoot = path.join(base, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  return { workspaceRoot, outsideRoot };
}

/** 构造带 glob/grep 工具的执行器；restriction 为当前外部 Read 限制判定。 */
function createSearchExecutor(workspaceRoot: string, restriction: "allow" | "ask" | "deny"): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createGlobFilesTool());
  registry.register(createGrepFilesTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode: "full_access",
    workspaceTrusted: false,
    fileReadStates: new Map(),
    resolveExternalRestriction: async () => restriction,
  });
}

describe("p1fix-r001 R5 外部搜索目标 Read 限制（Talk-Plan1013 Stage5 CR R5 必测 #4）", () => {
  it("glob_files 外部目标 deny 在任何结果列举前硬拒绝（零结果输出）", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    await writeFile(path.join(outsideRoot, "listed-secret.txt"), "listed-body", "utf8");
    const denied = await createSearchExecutor(workspaceRoot, "deny")
      .execute({ callId: "glob-deny", toolName: "glob_files", input: { pattern: "**/*.txt", path: outsideRoot } });
    expect(denied.status).toBe("denied");
    expect(denied.status === "denied" && denied.error.code).toBe(TOOL_ERROR_CODES.COMMAND_FORBIDDEN);
    expect(JSON.stringify(denied)).not.toContain("listed-secret.txt");
  });

  it("grep_files 外部目标 deny 在任何正文匹配前硬拒绝（零匹配输出）", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    await writeFile(path.join(outsideRoot, "grepped-secret.txt"), "needle-secret-body\n", "utf8");
    const denied = await createSearchExecutor(workspaceRoot, "deny")
      .execute({ callId: "grep-deny", toolName: "grep_files", input: { pattern: "needle-secret", path: outsideRoot } });
    expect(denied.status).toBe("denied");
    expect(denied.status === "denied" && denied.error.code).toBe(TOOL_ERROR_CODES.COMMAND_FORBIDDEN);
    expect(JSON.stringify(denied)).not.toContain("needle-secret-body");
    expect(JSON.stringify(denied)).not.toContain("grepped-secret.txt");
  });

  it("glob_files/grep_files 外部目标 ask 逐次确认（仅 allow_once/deny），确认后放行且返回结果", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    await writeFile(path.join(outsideRoot, "asked-secret.txt"), "needle-asked-body\n", "utf8");

    const globExecutor = createSearchExecutor(workspaceRoot, "ask");
    const globPending = await globExecutor.execute({ callId: "glob-ask", toolName: "glob_files", input: { pattern: "**/*.txt", path: outsideRoot } });
    expect(globPending.status).toBe("approval_required");
    if (globPending.status !== "approval_required") throw new Error("expected glob approval request");
    expect(globPending.approval.allowedDecisions).toEqual(["allow_once", "deny"]);
    const globDone = await globExecutor.execute({
      callId: "glob-ask",
      toolName: "glob_files",
      input: { pattern: "**/*.txt", path: outsideRoot },
      approval: { approvalId: globPending.approval.approvalId, decision: "allow_once" },
    });
    expect(globDone.status).toBe("success");
    expect(globDone.status === "success" && (globDone.output as { files: string[] }).files.some((file) => file.toLowerCase().endsWith("asked-secret.txt"))).toBe(true);

    const grepExecutor = createSearchExecutor(workspaceRoot, "ask");
    const grepPending = await grepExecutor.execute({ callId: "grep-ask", toolName: "grep_files", input: { pattern: "needle-asked", path: outsideRoot } });
    expect(grepPending.status).toBe("approval_required");
    if (grepPending.status !== "approval_required") throw new Error("expected grep approval request");
    expect(grepPending.approval.allowedDecisions).toEqual(["allow_once", "deny"]);
    const grepDone = await grepExecutor.execute({
      callId: "grep-ask",
      toolName: "grep_files",
      input: { pattern: "needle-asked", path: outsideRoot },
      approval: { approvalId: grepPending.approval.approvalId, decision: "allow_once" },
    });
    expect(grepDone.status).toBe("success");
    expect(JSON.stringify(grepDone.status === "success" ? grepDone.output : {})).toContain("needle-asked-body");
  });

  it("glob_files/grep_files 外部目标 allow 维持免新增路径审批（不回归）", async () => {
    const { workspaceRoot, outsideRoot } = await createWorkspaceWithOutside();
    await writeFile(path.join(outsideRoot, "allowed-secret.txt"), "needle-allowed-body\n", "utf8");
    const glob = await createSearchExecutor(workspaceRoot, "allow")
      .execute({ callId: "glob-allow", toolName: "glob_files", input: { pattern: "**/*.txt", path: outsideRoot } });
    expect(glob.status).toBe("success");
    expect(glob.status === "success" && (glob.output as { files: string[] }).files.some((file) => file.toLowerCase().endsWith("allowed-secret.txt"))).toBe(true);
    const grep = await createSearchExecutor(workspaceRoot, "allow")
      .execute({ callId: "grep-allow", toolName: "grep_files", input: { pattern: "needle-allowed", path: outsideRoot } });
    expect(grep.status).toBe("success");
    expect(JSON.stringify(grep.status === "success" ? grep.output : {})).toContain("needle-allowed-body");
  });
});
