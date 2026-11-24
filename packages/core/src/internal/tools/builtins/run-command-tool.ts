/**
 * run_command 工具：以 shell:false 执行结构化 argv，并实施命令策略、超时、取消和输出截断。
 *
 * Talk-Plan0917 Stage 3：策略放行后必须经 SandboxPort.prepare 生成沙箱包装 argv 再 spawn。
 * 唯一无隔离例外是宿主可信配置的 danger-full-access：ToolExecutor 注入
 * sandboxExecutionOverride 后跳过包装直接执行（结果 enforcement=unavailable，展示层不得宣称隔离）。
 * 绑定缺失或沙箱不可用时按权限模式 fail-closed（SANDBOX_UNAVAILABLE），不转普通审批。
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { computeWorkspaceCommandConstraint, decideCommandPermission, normalizeProgramName } from "../permissions/command-policy";
import { resolveFileTarget } from "../permissions/path-access-policy";
import { isInsideRoot, resolveWorkspacePath } from "../permissions/workspace-path";
import { assertFileMutationAllowed } from "../permissions/mutation-policy";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { AgentToolDefinition } from "../types";
import { BoundedOutputBuffer, getPlatformExecutable, isSandboxAvailabilityFailureCode, resolveWindowsPackageManagerCommand, SANDBOX_START_MAX_ATTEMPTS, SandboxPrepareExhaustedError, terminateManagedProcessTree } from "../process-utils";
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

/** 溢出落盘目标：仅在输出首次超过内存上限时创建文件，普通命令不产生临时文件。 */
interface CommandSpillTarget {
  workspaceRoot: string;
  directory: string;
  absolutePath: string;
  relativePath: string;
  fd: number | undefined;
  failed: boolean;
  identity?: { dev: number; ino: number };
}

/** 将路径片段限制为工作区临时文件名可用的安全字符，防止 callId/turnId 携带分隔符或相对路径。 */
function toSafePathSegment(value: string, fallback: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return sanitized.length > 0 ? sanitized : fallback;
}

/** 构造工作区 `.autopilot/tmp/<turn>/<call>.<stream>.log` 落盘目标；路径只使用安全片段与工作区相对形式。 */
function createSpillTarget(workspaceRoot: string, turnId: string, callId: string, stream: "stdout" | "stderr"): CommandSpillTarget {
  const turnSegment = toSafePathSegment(turnId, "turn");
  const suffix = createHash("sha256").update(callId).digest("hex").slice(0, 16);
  const fileName = `${toSafePathSegment(callId, "call")}-${suffix}.${stream}.log`;
  const directory = path.join(workspaceRoot, ".autopilot", "tmp", turnSegment);
  return {
    workspaceRoot,
    directory,
    absolutePath: path.join(directory, fileName),
    relativePath: `.autopilot/tmp/${turnSegment}/${fileName}`,
    fd: undefined,
    failed: false,
  };
}

/** 首次溢出前复用工作区路径守卫检查最近祖先，独占创建失败时安全降级。 */
async function openSpillTarget(target: CommandSpillTarget, initial: Buffer): Promise<boolean> {
  if (target.failed || target.fd !== undefined) return target.fd !== undefined;
  try {
    await resolveWorkspacePath(target.workspaceRoot, target.relativePath);
    mkdirSync(target.directory, { recursive: true, mode: 0o700 });
    await resolveWorkspacePath(target.workspaceRoot, target.relativePath);
    target.fd = openSync(target.absolutePath, "wx", 0o600);
    const identity = fstatSync(target.fd);
    target.identity = { dev: identity.dev, ino: identity.ino };
    writeSync(target.fd, initial);
    return true;
  } catch {
    discardSpillTarget(target);
    return false;
  }
}

/** 仅在路径仍处于工作区且文件身份属于本次独占创建时清理半成品。 */
function discardSpillTarget(target: CommandSpillTarget | undefined): void {
  if (!target) return;
  const owned = target.fd !== undefined && target.identity;
  if (target.fd !== undefined) {
    try { closeSync(target.fd); } catch { /* 文件已关闭或不可关闭，忽略 */ }
    target.fd = undefined;
  }
  if (owned && target.identity) {
    try {
      const root = realpathSync(target.workspaceRoot);
      const directory = realpathSync(target.directory);
      const current = lstatSync(target.absolutePath);
      if (isInsideRoot(root, directory) && current.isFile() && current.dev === target.identity.dev && current.ino === target.identity.ino) unlinkSync(target.absolutePath);
    } catch { /* 路径或身份无法确认时不删除 */ }
  }
  target.failed = true;
}

/** 继续向已打开的落盘文件追加分片；写入失败即丢弃文件并停止落盘。 */
function appendSpillChunk(target: CommandSpillTarget, chunk: Buffer): void {
  if (target.fd === undefined) return;
  try {
    writeSync(target.fd, chunk);
  } catch {
    discardSpillTarget(target);
  }
}

/** 首次超限时把内存中已有的全部输出与当前分片落盘，之后分片继续追加。 */
async function spillOutputChunk(buffer: BoundedOutputBuffer, target: CommandSpillTarget | undefined, chunk: Buffer): Promise<void> {
  if (!target) return;
  if (target.fd !== undefined) { appendSpillChunk(target, chunk); return; }
  if (target.failed || buffer.byteLength + chunk.length <= outputLimit) return;
  // 此刻 buffer 尚未截断，toBuffer 可按原始顺序重建全部已接收字节，先落盘再追加当前分片。
  if (await openSpillTarget(target, buffer.toBuffer())) appendSpillChunk(target, chunk);
}

/** 关闭落盘文件；仅成功落盘时返回工作区相对路径供模型用 read_file 回读。 */
function finishSpillTarget(target: CommandSpillTarget | undefined): string | undefined {
  if (!target || target.fd === undefined) return undefined;
  try { closeSync(target.fd); } catch { /* 忽略关闭失败，不影响命令结果 */ }
  target.fd = undefined;
  return target.failed ? undefined : target.relativePath;
}

/** 创建结构化前台命令工具，不支持 Shell 解释、多命令或交互式输入。 */
export function createRunCommandTool(): AgentToolDefinition<z.infer<typeof runCommandSchema>, Record<string, unknown>> {
  return {
    name: "run_command",
    description: "在工作区内以 program + args 执行单个前台命令；不使用 Shell，不支持管道或交互式输入。需要常驻 Web/预览服务时使用 start_background_job；前台超时且副作用未知时先核对 Job/进程/端口，不得盲重试或换命令重复启动。用户明确要求执行某个命令时必须使用本工具，不得改用功能等价的内置工具绕过审批。",
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
        risk: result.risk === "destructive" ? "destructive" : target ? "external_side_effect" : result.risk,
        stableConstraint: target
          ? computeExternalExecutionConstraint("run_command", target)
          : cwd
            ? computeWorkspaceCommandConstraint({ workspaceRoot: cwd.canonicalWorkspace, cwd: cwd.canonicalTarget, program: input.program, args: input.args })
            : `program:${normalizeProgramName(input.program)}`,
        ...(target ? { externalMutation: true, externalExecutionTarget: target } : {}),
        hardDenyReason: result.decision === "deny" ? result.reason : undefined,
        requiresApproval: result.decision !== "deny",
        requireSingleApproval: result.requireSingleApproval ?? (target && result.risk === "unknown" && context.permissionMode !== "ask" ? true : undefined),
        approval: { reason: target ? "命令请求修改一个工作区外精确文件，需要明确用户授权" : result.reason, preview: { program: input.program, args: input.args, cwd: input.cwd, timeoutMs: input.timeoutMs, ...(target ? { externalWriteTarget: externalExecutionTargetLabel(target), operation: "write" } : {}) } },
        ...(cwd || target ? { commandCwd: cwd?.canonicalTarget ?? input.cwd } : {}),
      };
    },
    /** 准备受信执行域，并在真实 close 与已发起的停止检查收敛后释放资源。 */
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
      return new Promise<Record<string, unknown>>(function executeCommand(resolve, reject) {
        const child = spawn(prepared.executable, [...prepared.args], {
          cwd: cwd.canonicalTarget,
          detached: process.platform !== "win32",
          shell: false,
          windowsHide: true,
          env: { ...process.env, ...prepared.env },
        });
        // 只有真实 close 后才释放资源；停止请求失败不提前结算或释放执行归属。
        let released = false;
        // 宿主执行范围没有沙箱 port，也不存在需要释放的沙箱执行资源。
        const sandboxPort = sandbox && sandbox.execution !== "host" ? sandbox.port : undefined;
        /** close 收尾只释放一次沙箱资源，宿主执行范围无需释放。 */
        function releaseOnce(): void {
          if (released) return;
          released = true;
          if (sandboxPort) void sandboxPort.release(prepared.executionId);
        }
        const stdout = new BoundedOutputBuffer(outputLimit);
        const stderr = new BoundedOutputBuffer(outputLimit);
        // 溢出落盘按 turn → call 分目录，文件名与目录段均为安全片段；工作区不可用时静默跳过。
        const spillTurnId = context.fileMutations?.turnId || context.executionSessionId || "turn";
        const spillCallId = context.toolCallId ?? "call";
        let spillAllowed = true;
        try {
          assertFileMutationAllowed(context);
          if (sandbox?.policy.mode === "read-only") spillAllowed = false;
        } catch { spillAllowed = false; }
        const stdoutSpill = spillAllowed ? createSpillTarget(cwd.canonicalWorkspace, spillTurnId, spillCallId, "stdout") : undefined;
        const stderrSpill = spillAllowed ? createSpillTarget(cwd.canonicalWorkspace, spillTurnId, spillCallId, "stderr") : undefined;
        let stopReason: "timeout" | "cancelled" | undefined;
        let stopping: Promise<void> | undefined;
        let executionError: Error | undefined;
        let closed = false;
        const startedAt = Date.now();
        const timeout = setTimeout(function onTimeout() { requestStop("timeout"); }, input.timeoutMs);
        /** 首个中止固定原因并复用停止请求；失败只暴露安全事实，仍等待真实 close。 */
        function requestStop(reason: "timeout" | "cancelled"): void {
          if (closed || stopping) return;
          stopReason = reason;
          clearTimeout(timeout);
          stopping = terminateManagedProcessTree(child).catch(function unconfirmedStop() {
            context.onToolProgress?.("停止未确认，仍等待执行结束");
          });
        }
        /** Runtime 取消与工具 timeout 使用同一受管停止请求。 */
        function onAbort(): void { requestStop("cancelled"); }
        context.signal?.addEventListener("abort", onAbort, { once: true });
        if (context.signal?.aborted) onAbort();
        // 每 1.5s 节流上报 stdout/stderr 尾部，供 CLI/Web 实时展示长时命令（如安装）的进展；
        // 沙箱包装后输出仍经同一 child 流，进度链路不断裂。
        let lastProgressAt = 0;
        /** 节流上报有界输出尾部，保持原有长时命令进度。 */
        function reportProgressIfDue(): void {
          const now = Date.now();
          if (now - lastProgressAt < 1_500) return;
          lastProgressAt = now;
          const tail = (stdout.toString() + stderr.toString()).slice(-160);
          context.onToolProgress?.(tail);
        }
        // 暂停各流直到守卫检查完成，避免异步检查期间无限积累输出。
        let stdoutPending = Promise.resolve();
        let stderrPending = Promise.resolve();
        child.stdout?.on("data", function onStdout(chunk: Buffer) {
          child.stdout?.pause();
          stdoutPending = spillOutputChunk(stdout, stdoutSpill, chunk).then(function finishChunk() { stdout.append(chunk); reportProgressIfDue(); child.stdout?.resume(); });
        });
        child.stderr?.on("data", function onStderr(chunk: Buffer) {
          child.stderr?.pause();
          stderrPending = spillOutputChunk(stderr, stderrSpill, chunk).then(function finishChunk() { stderr.append(chunk); reportProgressIfDue(); child.stderr?.resume(); });
        });
        // Node 的 spawn/error 后仍有 close；不把可能来自执行期的 error 当作进程已结束。
        child.on("error", function onError(error) {
          executionError ??= error;
        });
        /** close 与停止确认共同收尾，避免 error/abort/close 竞态提前释放或重复结算。 */
        child.once("close", async function onClose(exitCode) {
          closed = true;
          clearTimeout(timeout);
          context.signal?.removeEventListener("abort", onAbort);
          await Promise.all([stdoutPending, stderrPending, stopping]);
          releaseOnce();
          // 取消与超时终态不向模型返回可回读路径，落盘文件一并丢弃，避免残留无主日志。
          if (stopReason) {
            discardSpillTarget(stdoutSpill);
            discardSpillTarget(stderrSpill);
            return reject(createToolError(stopReason === "cancelled" ? TOOL_ERROR_CODES.EXECUTION_CANCELLED : TOOL_ERROR_CODES.EXECUTION_TIMEOUT, stopReason === "cancelled" ? "用户已取消命令执行" : "命令执行超时"));
          }
          if (executionError) {
            discardSpillTarget(stdoutSpill);
            discardSpillTarget(stderrSpill);
            return reject(createToolError(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, getExecutionErrorMessage(executionError)));
          }
          const stdoutSpilledPath = finishSpillTarget(stdoutSpill);
          const stderrSpilledPath = finishSpillTarget(stderrSpill);
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
            // 截断后的完整输出可在工作区临时目录回读；提示控制在一行，避免额外放大结果字节。
            ...(stdoutSpilledPath || stderrSpilledPath ? {
              spilledOutput: {
                ...(stdoutSpilledPath ? { stdout: stdoutSpilledPath } : {}),
                ...(stderrSpilledPath ? { stderr: stderrSpilledPath } : {}),
              },
              spillHint: "完整输出已写入上述工作区相对路径；用 read_file 配合 offset/limit 分段读取即可，无需重跑命令。",
            } : {}),
            ...(!spillAllowed && (stdout.truncated || stderr.truncated) ? { spillHint: "只读模式未保存完整输出，截断内容无法回读。" } : {}),
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
