/**
 * R6 端到端定向测试（web-runtime-20261016-investigation CR R6）：
 * macOS 上不同实际程序不得复用同一"记住此命令"持久授权；Windows 的 npm/npx 等价解析仍保持单一稳定身份。
 *
 * 实现方式：沿用仓库既有做法（mcp-runtime.test.ts）临时改写 process.platform，
 * 在 Windows 开发机上静态验证 darwin 身份语义；所有用例都在审批阶段结束，不 spawn 任何进程，
 * 因此不需要 macOS 实机（用户已要求暂缓实机测试）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunCommandTool } from "../../src/internal/tools/builtins/run-command-tool";
import { ToolExecutor } from "../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import type { SandboxMode, SandboxPort } from "../../src/runtime/ports";

const temporaryRoots: string[] = [];

/** 创建独立临时工作区。 */
async function createTemporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "r6-identity-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async function cleanupWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 创建记录查询到的约束、并按集合模拟"记住此命令"的执行器。 */
function createExecutor(workspaceRoot: string, fakePort: SandboxPort, mode: SandboxMode = "workspace-write") {
  const rememberedConstraints = new Set<string>();
  const seenConstraints: string[] = [];
  const registry = new ToolRegistry();
  registry.register(createRunCommandTool());
  const executor = new ToolExecutor(registry, {
    workspaceRoot,
    permissionMode: "ask",
    workspaceTrusted: false,
    sandbox: { port: fakePort, mode },
    resolvePersistentGrant: async function resolvePersistentGrant(request) {
      seenConstraints.push(request.constraint ?? "");
      return rememberedConstraints.has(request.constraint ?? "");
    },
  });
  return { executor, rememberedConstraints, seenConstraints };
}

/** 创建不会真正启动进程的最小沙箱 Port（本文件用例都在审批阶段结束）。 */
function createFakePort(): SandboxPort {
  return {
    async status() { return { platform: "macos", backend: "fake", enforcement: "full" }; },
    async setup() { throw new Error("fake sandbox setup 不可用"); },
    async prepare(request) { return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement: "full" }; },
    async release() {},
    async shutdown() {},
  };
}

/** 临时改写 process.platform，并在回调结束后恢复原描述符。 */
async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  if (!original) throw new Error("process.platform descriptor missing");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("R6 精确命令授权身份", () => {
  it("darwin：记住 check 后 check.exe 与大小写变体都必须重新审批，不复用同一 grant", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const { executor, rememberedConstraints, seenConstraints } = createExecutor(workspaceRoot, createFakePort());
    await withPlatform("darwin", async () => {
      const first = await executor.execute({ callId: "r6-1", toolName: "run_command", input: { program: "check", args: ["--flag"], cwd: "." } });
      expect(first.status).toBe("approval_required");
      rememberedConstraints.add(seenConstraints[0]!);

      // 完全相同的命令命中记忆：审批边界不再拦截（实际 '' 会进入 spawn，本机无该可执行文件不影响本断言）。
      const repeat = await executor.execute({ callId: "r6-2", toolName: "run_command", input: { program: "check", args: ["--flag"], cwd: "." } });
      expect(repeat.status).not.toBe("approval_required");

      // macOS 实际执行不删除扩展名：check.exe 是另一个可执行文件，必须重新审批。
      const withExtension = await executor.execute({ callId: "r6-3", toolName: "run_command", input: { program: "check.exe", args: ["--flag"], cwd: "." } });
      expect(withExtension.status).toBe("approval_required");

      // 大小写 likewise 属于不同文件身份。
      const upper = await executor.execute({ callId: "r6-4", toolName: "run_command", input: { program: "Check", args: ["--flag"], cwd: "." } });
      expect(upper.status).toBe("approval_required");
      expect(new Set(seenConstraints).size).toBe(3);
    });
  });

  it("win32：npm 与 npm.cmd 的等价解析仍映射到同一约束（未命中 grant 时同样只剩一张审批卡）", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const { executor, seenConstraints } = createExecutor(workspaceRoot, createFakePort());
    await withPlatform("win32", async () => {
      await executor.execute({ callId: "r6-5", toolName: "run_command", input: { program: "npm", args: ["install"], cwd: "." } });
      await executor.execute({ callId: "r6-6", toolName: "run_command", input: { program: "npm.cmd", args: ["install"], cwd: "." } });
      expect(seenConstraints).toHaveLength(2);
      expect(seenConstraints[0]).toBe(seenConstraints[1]);
    });
  });
});
