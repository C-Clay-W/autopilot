/**
 * run_command 工具：以 shell:false 执行结构化 argv，并实施命令策略、超时、取消和输出截断。
 *
 * Talk-Plan0917 Stage 3：策略放行后必须经 SandboxPort.prepare 生成沙箱包装 argv 再 spawn。
 * 唯一无隔离例外是宿主可信配置的 danger-full-access：ToolExecutor 注入
 * sandboxExecutionOverride 后跳过包装直接执行（结果 enforcement=unavailable，展示层不得宣称隔离）。
 * 绑定缺失或沙箱不可用时按权限模式 fail-closed（SANDBOX_UNAVAILABLE），不转普通审批。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { computeWorkspaceCommandConstraint, decideCommandPermission, normalizeProgramName } from "../permissions/command-policy";
import { resolveFileTarget } from "../permissions/path-access-policy";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { AgentToolDefinition } from "../types";
import { BoundedOutputBuffer, getPlatformExecutable, isSandboxAvailabilityFailureCode, resolveWindowsPackageManagerCommand, SANDBOX_START_MAX_ATTEMPTS, SandboxPrepareExhaustedError, terminateProcessTree } from "../process-utils";
import { SANDBOX_ERROR_CODES, type SandboxPreparedCommand } from "../../../runtime/domain/sandbox-policy";
import { SandboxPortError } from "../../../runtime/ports";
import { claimExternalWriteCapability, externalExecutionTargetLabel, resolveExternalExecutionTarget } from "../permissions/external-execution-policy";
import { computeExternalExecutionConstraint } from "../../../runtime/domain/external-execution";

const outputLimit = 30_000;
export const runCommandSchema = z.object({
  program: z.string().min(1).max(200),
  args: z.array(z.string().max(4_000)).max(50).default([]),
  cwd: z.string().min(1).default("."),
  timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
  externalWriteTarget: z.string().min(1).max(4_000).optional(),
}).strict();


/** 为 Windows 下不存在的可执行程序补充可行动的纠偏提示，避免模型重复尝试 POSIX 或 Shell 内建命令。 */
function getExecutionErrorMessage(error: Error & { code?: string }): string {
  if (process.platform === "win32" && error.code === "ENOENT") {
    return `${error.message}。当前为 Windows 且 run_command 不使用 Shell；请改用 read_file/edit_file 定位文件，或执行 node、npm 等明确可执行程序。`;
  }
  return error.message;
}

/** 创建结构化前台命令工具，不支持 Shell 解释、多命令或交互式输入。 */
export function createRunCommandTool(): AgentToolDefinition<z.infer<typeof runCommandSchema>, Record<string, unknown>> {
  return {
    name: "run_command",
    description: "在工作区内以 program + args 执行单个前台命令；不使用 Shell，不支持管道或交互式输入。用户明确要求执行某个命令时必须使用本工具，不得改用功能等价的内置工具绕过审批。",
    inputSchema: runCommandSchema,
    metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1, resourceKey: "workspace:command" }, retry: { safe: false }, timeout: { defaultMs: 30_000, maxMs: 120_000 } },
    async createActionFacts(input, context) {
      const result = decideCommandPermission(input.program, input.args);
      const target = await resolveExternalExecutionTarget(context.workspaceRoot, input);
      // 无外部写目标时解析 canonical 工作目录，生成绑定完整命令身份的精确约束；
      // 旧 program: 宽约束仅在未配置 workspaceRoot 的边缘场景保留（该场景无法持久授权）。
      const cwd = target || !context.workspaceRoot ? undefined : await resolveFileTarget(context.workspaceRoot, input.cwd);
      return {
        toolName: "run_command",
        effect: target ? "external" : result.risk === "read_only" ? "none" : result.risk === "workspace_mutating" ? "workspace" : "external",
        destructive: result.risk === "destructive",
        operation: "command",
        resource: normalizeProgramName(input.program),
        risk: target ? "external_side_effect" : result.risk,
        stableConstraint: target
          ? computeExternalExecutionConstraint("run_command", target)
          : cwd
            ? computeWorkspaceCommandConstraint({ workspaceRoot: cwd.canonicalWorkspace, cwd: cwd.canonicalTarget, program: input.program, args: input.args })
            : `program:${normalizeProgramName(input.program)}`,
        ...(target ? { externalMutation: true, externalExecutionTarget: target } : {}),
        hardDenyReason: result.decision === "deny" ? result.reason : undefined,
        requiresApproval: result.decision !== "deny",
        approval: { reason: target ? "命令请求修改一个工作区外精确文件，需要明确用户授权" : result.reason, preview: { program: input.program, args: input.args, cwd: input.cwd, timeoutMs: input.timeoutMs, ...(target ? { externalWriteTarget: externalExecutionTargetLabel(target), operation: "write" } : {}) } },
        ...(cwd || target ? { commandCwd: cwd?.canonicalTarget ?? input.cwd } : {}),
      };
    },
    async execute(input, context) {
      const cwd = await resolveFileTarget(context.workspaceRoot, input.cwd);
      if (!cwd.exists) throw createToolError(TOOL_ERROR_CODES.PATH_OUTSIDE_WORKSPACE, "命令工作目录不存在");
      if (context.signal?.aborted) throw createToolError(TOOL_ERROR_CODES.EXECUTION_CANCELLED, "用户已取消工具调用");
      // Stage 3 fail-closed：没有已解析的沙箱范围（绑定缺失或能力不可执行）就不启动任何进程，
      // 防止绕过 ToolExecutor 的直接调用退化为裸 spawn。唯一例外：宿主可信配置的
      // danger-full-access——ToolExecutor 注入 sandboxExecutionOverride 后允许单次无隔离直接执行
      // （CR 20261016 R2：2.5 无沙箱降级直执已撤，沙箱不可用时 read-only 与 workspace-write 一律 fail-closed）。
      const sandbox = context.sandboxPolicy;
      if (!sandbox && context.sandboxExecutionOverride !== "direct") throw createToolError(SANDBOX_ERROR_CODES.UNAVAILABLE, "沙箱未就绪，无法提供已隔离执行，命令未启动");
      // Talk-Plan1022 S1：宿主执行范围（execution:"host"）由 ToolExecutor 在用户逐次批准后
      // 注入 sandboxExecutionOverride:"direct"，经下方无隔离直执分支运行；未批准时绕过
      // ToolExecutor 的直接调用没有 override 与 scope，仍保持 fail-closed。
      await claimExternalWriteCapability("run_command", input, context);
      // 平台可执行名解析先于沙箱包装完成（Windows npm/npx → .cmd），prepare 只消费解析后的 argv。
      const program = getPlatformExecutable(input.program);
      let prepared: SandboxPreparedCommand;
      if (sandbox && sandbox.execution !== "host") {
        // CR 20261016 R4：prepare（Adapter initialize/wrap，发生在目标 spawn 之前）失败时，
        // 仅"确定未启动"的可用性失败（UNAVAILABLE/NOT_PROVISIONED/RUNNER_FAILED）在
        // SANDBOX_START_MAX_ATTEMPTS 内重试并累积逐次脱敏诊断；POLICY_DENIED/SCOPE_CONFLICT/
        // CLEANUP_FAILED 与非端口错误立即失败不重试。耗尽后抛 SandboxPrepareExhaustedError，
        // 由 ToolExecutor 按 R2 fail-closed 语义 deny 终态化。
        const diagnostics: string[] = [];
        for (let attempt = 1; attempt <= SANDBOX_START_MAX_ATTEMPTS; attempt += 1) {
          try {
            prepared = await sandbox.port.prepare({
              commandId: sandbox.policy.externalWriteCapability?.executionId ?? randomUUID(),
              program,
              args: input.args,
              cwd: cwd.canonicalTarget,
              policy: sandbox.policy,
            });
            break;
          } catch (error) {
            if (!(error instanceof SandboxPortError) || !isSandboxAvailabilityFailureCode(error.code)) {
              if (error instanceof SandboxPortError) throw createToolError(error.code, error.message);
              throw error;
            }
            diagnostics.push(`第 ${attempt} 次包装失败：${error.message}`);
            if (attempt === SANDBOX_START_MAX_ATTEMPTS) throw new SandboxPrepareExhaustedError(diagnostics);
          }
        }
      } else {
        // danger-full-access 无隔离直接执行：跳过沙箱包装；enforcement unavailable 保证展示层不得宣称隔离。
        // R3：Windows npm/npx/pnpm 复用与沙箱路径同一受信解析（node.exe + CLI 脚本 + 结构化 argv），
        // .cmd 不交给 spawn(shell:false)（EINVAL 命令未启动）；受信 CLI 不可用时命令不启动（fail-closed）。
        try {
          const managed = resolveWindowsPackageManagerCommand(program, input.args);
          prepared = { executionId: randomUUID(), executable: managed?.executable ?? program, args: managed ? managed.args : input.args, env: {}, enforcement: "unavailable" };
        } catch (error) {
          if (error instanceof SandboxPortError) throw createToolError(error.code, error.message);
          throw error;
        }
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const child = spawn(prepared.executable, [...prepared.args], {
          cwd: cwd.canonicalTarget,
          detached: process.platform !== "win32",
          shell: false,
          windowsHide: true,
          env: { ...process.env, ...prepared.env },
        });
        // 所有终态（close、error、超时、取消）都必须释放沙箱执行资源；release 幂等不抛。
        let released = false;
        // 宿主执行范围没有沙箱 port，也不存在需要释放的沙箱执行资源。
        const sandboxPort = sandbox && sandbox.execution !== "host" ? sandbox.port : undefined;
        const releaseOnce = (): void => {
          if (released) return;
          released = true;
          if (sandboxPort) void sandboxPort.release(prepared.executionId);
        };
        const stdout = new BoundedOutputBuffer(outputLimit);
        const stderr = new BoundedOutputBuffer(outputLimit);
        let timedOut = false;
        let cancelled = false;
        const startedAt = Date.now();
        const timeout = setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child);
        }, input.timeoutMs);
        const onAbort = () => {
          cancelled = true;
          terminateProcessTree(child);
        };
        context.signal?.addEventListener("abort", onAbort, { once: true });
        // 每 1.5s 节流上报 stdout/stderr 尾部，供 CLI/Web 实时展示长时命令（如安装）的进展；
        // 沙箱包装后输出仍经同一 child 流，进度链路不断裂。
        let lastProgressAt = 0;
        function reportProgressIfDue(): void {
          const now = Date.now();
          if (now - lastProgressAt < 1_500) return;
          lastProgressAt = now;
          const tail = (stdout.toString() + stderr.toString()).slice(-160);
          context.onToolProgress?.(tail);
        }
        child.stdout?.on("data", (chunk: Buffer) => { stdout.append(chunk); reportProgressIfDue(); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr.append(chunk); reportProgressIfDue(); });
        child.on("error", (error) => {
          clearTimeout(timeout);
          releaseOnce();
          context.signal?.removeEventListener("abort", onAbort);
          reject(createToolError(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, getExecutionErrorMessage(error)));
        });
        child.on("close", (exitCode) => {
          clearTimeout(timeout);
          releaseOnce();
          context.signal?.removeEventListener("abort", onAbort);
          if (cancelled) return reject(createToolError(TOOL_ERROR_CODES.EXECUTION_CANCELLED, "用户已取消命令执行"));
          if (timedOut) return reject(createToolError(TOOL_ERROR_CODES.EXECUTION_TIMEOUT, "命令执行超时"));
          resolve({
            program: input.program,
            args: input.args,
            // 外部 canonical 身份仅供执行，通用结果使用不含宿主路径的安全标签。
            cwd: cwd.isExternal ? "[外部目录]" : cwd.relativePath,
            exitCode,
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            totalStdoutBytes: stdout.byteLength,
            totalStderrBytes: stderr.byteLength,
            durationMs: Date.now() - startedAt,
            timedOut: false,
            truncated: stdout.truncated || stderr.truncated,
            sandbox: { enforcement: prepared.enforcement, mode: sandbox?.policy.mode ?? context.sandbox?.mode },
          });
        });
      });
    },
    serializeOutput(output) { return output; },
  };
}
