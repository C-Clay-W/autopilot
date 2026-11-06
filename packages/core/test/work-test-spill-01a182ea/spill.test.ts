/** spill 安全边界及原有回读行为的定向回归。 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRunCommandTool } from "../../src/internal/tools/builtins/run-command-tool";
import { createReadFileTool } from "../../src/internal/tools/builtins/read-file-tool";
import type { SandboxPort } from "../../src/runtime/ports";

const root = path.resolve(process.cwd(), "../../.agent-tests/work-test/01a182ea-14e6-7432-9060-009b54430c99");
const port = { async prepare(request) { return { executionId: request.commandId, executable: request.program, args: request.args, env: {}, enforcement: "full" }; }, async release() {} } as SandboxPort;
/** 创建隔离工作区及透传的冻结沙箱策略。 */
async function fixture(mode: "read-only" | "workspace-write" = "workspace-write") {
  const workspaceRoot = await mkdtemp(path.join(root, "workspace-"));
  return { workspaceRoot, permissionMode: "full_access" as const, executionSessionId: "session", toolCallId: "call", sandboxPolicy: { port, policy: { mode, workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] } } };
}
/** 执行受控 Node 子进程以构造输出或进程终态。 */
function run(context: Awaited<ReturnType<typeof fixture>> & { signal?: AbortSignal }, script: string, timeoutMs = 5000) {
  return createRunCommandTool().execute({ program: process.execPath, args: ["-e", script], cwd: ".", timeoutMs }, context);
}

describe("spill 修复", function () {
  it("只读超限仍成功且不写入工作区", async function () {
    const context = await fixture("read-only");
    const output = await run(context, "process.stdout.write('x'.repeat(31001))");
    expect(output).toMatchObject({ exitCode: 0, stdoutTruncated: true, totalStdoutBytes: 31001 });
    expect(output.spilledOutput).toBeUndefined();
    expect(output.spillHint).toContain("无法回读");
    expect(await readdir(context.workspaceRoot)).toEqual([]);
  });
  it("双流完整落盘并可分页读取，小输出不落盘", async function () {
    const context = await fixture();
    const output = await run(context, "process.stdout.write('a\\n'.repeat(16000));process.stderr.write('b\\n'.repeat(16000))");
    const paths = output.spilledOutput as { stdout: string; stderr: string };
    expect(await readFile(path.join(context.workspaceRoot, paths.stdout), "utf8")).toBe("a\n".repeat(16000));
    expect(await readFile(path.join(context.workspaceRoot, paths.stderr), "utf8")).toBe("b\n".repeat(16000));
    const read = createReadFileTool();
    const page = await read.execute({ path: paths.stderr, offset: 2, limit: 2 }, context);
    expect(page).toMatchObject({ content: "b\nb", startLine: 2, endLine: 3 });
    const small = await run({ ...context, toolCallId: "small" }, "process.stdout.write('small')");
    expect(small.spilledOutput).toBeUndefined();
    expect((await readdir(path.dirname(path.join(context.workspaceRoot, paths.stdout)))).length).toBe(2);
  });
  it("同一调用 ID 重试和清洗碰撞不覆写已有日志", async function () {
    const context = await fixture();
    const first = await run({ ...context, toolCallId: "a".repeat(64) + "1" }, "process.stdout.write('x'.repeat(31001))");
    const firstPath = (first.spilledOutput as { stdout: string }).stdout;
    const second = await run({ ...context, toolCallId: "a".repeat(64) + "2" }, "process.stdout.write('y'.repeat(31001))");
    expect((second.spilledOutput as { stdout: string }).stdout).not.toBe(firstPath);
    const retry = await run({ ...context, toolCallId: "a".repeat(64) + "1" }, "process.stdout.write('z'.repeat(31001))");
    expect(retry.spilledOutput).toBeUndefined();
    expect(await readFile(path.join(context.workspaceRoot, firstPath), "utf8")).toBe("x".repeat(31001));
  });
  it("外部链接拒绝后超时与启动失败不会删除哨兵或创建外部目录", async function () {
    const context = await fixture();
    const external = await mkdtemp(path.join(root, "external-"));
    const name = `call-${createHash("sha256").update("call").digest("hex").slice(0, 16)}.stdout.log`;
    await mkdir(path.join(external, "session"));
    await writeFile(path.join(external, "session", name), "safe");
    await mkdir(path.join(context.workspaceRoot, ".autopilot"));
    await symlink(external, path.join(context.workspaceRoot, ".autopilot", "tmp"), process.platform === "win32" ? "junction" : "dir");
    await expect(run(context, "process.stdout.write('x'.repeat(31001));setInterval(()=>{},1000)", 400)).rejects.toMatchObject({ toolError: { code: "EXECUTION_TIMEOUT" } });
    const controller = new AbortController();
    const cancel = run({ ...context, signal: controller.signal }, "process.stdout.write('x'.repeat(31001));setInterval(()=>{},1000)");
    setTimeout(function abort() { controller.abort(); }, 400);
    await expect(cancel).rejects.toMatchObject({ toolError: { code: "EXECUTION_CANCELLED" } });
    await expect(createRunCommandTool().execute({ program: "missing-spill-executable-123", args: [], cwd: ".", timeoutMs: 1000 }, context)).rejects.toBeDefined();
    expect(await readdir(external)).toEqual(["session"]);
    expect(await readdir(path.join(external, "session"))).toEqual([name]);
    expect(await readFile(path.join(external, "session", name), "utf8")).toBe("safe");
    const missing = { ...context, executionSessionId: "new-session" };
    await run(missing, "process.stdout.write('x'.repeat(31001))");
    expect(await readdir(external)).toEqual(["session"]);
  });
  it("超时清理实际创建的半成品", async function () {
    const context = await fixture();
    await expect(run(context, "process.stdout.write('x'.repeat(31001));setInterval(()=>{},1000)", 400)).rejects.toMatchObject({ toolError: { code: "EXECUTION_TIMEOUT" } });
    expect(await readdir(path.join(context.workspaceRoot, ".autopilot/tmp/session"))).toEqual([]);
  });
});

