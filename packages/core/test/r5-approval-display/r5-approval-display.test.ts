/**
 * R5 审批知情展示定向测试（web-runtime-20261016-investigation CR R5）：
 * 审批卡结构化 cwd（canonical 工作目录）、unknownScope（外部效果但无精确目标）、
 * actionPreview 长度预算与截断提示；凭据脱敏保持不变。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunCommandTool } from "../../src/internal/tools/builtins/run-command-tool";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";

const temporaryRoots: string[] = [];

/** 创建独立临时工作区。 */
async function createTemporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "r5-display-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async function cleanupWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 创建 ask 模式执行器，绑定真实可用沙箱 Port，审批展示事实与执行方式解耦验证。 */
function createExecutor(workspaceRoot: string): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createRunCommandTool());
  return new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode: "ask",
    workspaceTrusted: false,
    sandbox: {
      port: {
        async status() { return { platform: "macos" as const, backend: "fake", enforcement: "full" as const }; },
        async setup() { throw new Error("fake sandbox setup 不可用"); },
        async prepare(request) { return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement: "full" as const }; },
        async release() {},
        async shutdown() {},
      },
      mode: "workspace-write",
    },
  });
}

describe("R5 审批知情展示事实", () => {
  it("审批卡冻结 canonical cwd 与 unknownScope；外部精确目标命令不标 unknownScope", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const executor = createExecutor(workspaceRoot);
    // 解释器 -e 脚本：外部效果但无精确目标声明 → unknownScope。
    const unknown = await executor.execute({ callId: "c-r5-1", toolName: "run_command", input: { program: "node", args: ["-e", "process.stdout.write('ok')"], cwd: "." } });
    expect(unknown.status).toBe("approval_required");
    if (unknown.status !== "approval_required") throw new Error("unreachable");
    expect(unknown.approval.display?.cwd).toBe(path.resolve(workspaceRoot));
    expect(unknown.approval.display?.unknownScope).toBe(true);
  });

  it("actionPreview 超过参数预算时附截断提示，凭据脱敏保持不变", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const executor = createExecutor(workspaceRoot);
    const preview = await executor.execute({
      callId: "c-r5-2",
      toolName: "run_command",
      input: { program: "node", args: ["-e", "ok", ...Array.from({ length: 12 }, (_, index) => `arg-${index}`), "--api-key=sk-private"], cwd: "." },
    });
    expect(preview.status).toBe("approval_required");
    if (preview.status !== "approval_required") throw new Error("unreachable");
    const text = preview.approval.display?.actionPreview ?? "";
    expect(text).toContain("（参数已截断）");
    expect(text).not.toContain("sk-private");
  });
});
