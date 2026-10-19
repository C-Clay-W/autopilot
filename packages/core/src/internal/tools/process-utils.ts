/**
 * 受管子进程公共底座：固定内存输出缓冲和跨平台进程树终止。
 *
 * 仅服务于 Runtime 自己启动的非 shell 子进程，不能用于执行未经过 ToolExecutor 的命令。
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SANDBOX_ERROR_CODES } from "../../runtime/domain/sandbox-policy";
import { SandboxPortError } from "../../runtime/ports";

/** 受管进程树停止失败分类，供 JobService 映射稳定错误码。 */
export class ProcessTreeTerminationError extends Error {
  /** 创建只暴露稳定分类的内部错误。 */
  constructor(public readonly code: "FAILED" | "TIMEOUT") {
    super(code === "TIMEOUT" ? "受管进程树停止超时" : "受管进程树停止失败");
    this.name = "ProcessTreeTerminationError";
  }
}

/** 沙箱启动链总尝试上限（首次 + 最多 2 次重试）；status 探测与 prepare 包装均不启动目标命令，重试安全。 */
export const SANDBOX_START_MAX_ATTEMPTS = 3;

/** 仅这些 code 表示"目标命令确定未启动"的沙箱可用性失败，可安全重试；其余（POLICY_DENIED/SCOPE_CONFLICT/CLEANUP_FAILED）禁止重试。 */
const SANDBOX_AVAILABILITY_FAILURE_CODES: ReadonlySet<string> = new Set([
  SANDBOX_ERROR_CODES.UNAVAILABLE,
  SANDBOX_ERROR_CODES.NOT_PROVISIONED,
  SANDBOX_ERROR_CODES.RUNNER_FAILED,
]);

/** 判断 SandboxPortError.code 是否属于可重试的沙箱可用性失败。 */
export function isSandboxAvailabilityFailureCode(code: string): boolean {
  return SANDBOX_AVAILABILITY_FAILURE_CODES.has(code);
}

/** 沙箱 prepare 重试耗尽的结构化标记：目标命令未启动，Executor 据此按 fail-closed deny 终态化。 */
export class SandboxPrepareExhaustedError extends Error {
  readonly code: string;
  readonly diagnostics: readonly string[];

  constructor(diagnostics: readonly string[]) {
    super(`沙箱包装连续 ${SANDBOX_START_MAX_ATTEMPTS} 次尝试均失败，目标命令未启动`);
    this.name = "SandboxPrepareExhaustedError";
    this.code = SANDBOX_ERROR_CODES.UNAVAILABLE;
    this.diagnostics = [...diagnostics];
  }
}

/** 在固定字节预算内保留流输出头尾，避免高输出进程无限占用内存。 */
export class BoundedOutputBuffer {
  private readonly head: Buffer;
  private readonly tail: Buffer;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private headBytes = 0;
  private tailBytes = 0;
  private tailOffset = 0;
  private totalBytes = 0;

  /** 按总预算构造头尾缓冲；预算至少为两个字节。 */
  constructor(private readonly outputLimit = 30_000) {
    this.headLimit = Math.floor(outputLimit / 2);
    this.tailLimit = outputLimit - this.headLimit;
    this.head = Buffer.alloc(this.headLimit);
    this.tail = Buffer.alloc(this.tailLimit);
  }

  /** 接收单个流分片，并将其写入固定大小的头尾缓冲区。 */
  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.headBytes < this.headLimit) {
      const headLength = Math.min(this.headLimit - this.headBytes, chunk.length);
      chunk.copy(this.head, this.headBytes, 0, headLength);
      this.headBytes += headLength;
    }
    if (chunk.length >= this.tailLimit) {
      chunk.copy(this.tail, 0, chunk.length - this.tailLimit);
      this.tailBytes = this.tailLimit;
      this.tailOffset = 0;
      return;
    }
    const firstLength = Math.min(this.tailLimit - this.tailOffset, chunk.length);
    chunk.copy(this.tail, this.tailOffset, 0, firstLength);
    const remainingLength = chunk.length - firstLength;
    if (remainingLength > 0) chunk.copy(this.tail, 0, firstLength);
    this.tailOffset = (this.tailOffset + chunk.length) % this.tailLimit;
    this.tailBytes = Math.min(this.tailLimit, this.tailBytes + chunk.length);
  }

  /** 返回输出是否超过完整保留上限。 */
  get truncated(): boolean { return this.totalBytes > this.outputLimit; }
  /** 返回原始输出总字节数。 */
  get byteLength(): number { return this.totalBytes; }
  /** 返回当前仍可按原始字节 cursor 读取的最早位置。 */
  get retainedStartCursor(): number { return this.truncated ? this.totalBytes - this.tailBytes : 0; }
  /** 返回受限 UTF-8 输出。 */
  toString(): string {
    if (!this.truncated) {
      const tail = this.readTail();
      return Buffer.concat([this.head.subarray(0, Math.max(0, this.totalBytes - tail.length)), tail]).toString("utf8");
    }
    return `${this.head.toString("utf8", 0, this.headBytes)}\n…[输出已截断]…\n${this.readTail().toString("utf8")}`;
  }

  /** 返回指定 cursor 之后仍保留的输出；cursor 早于窗口时由 truncated 明确表示缺口。 */
  readSince(cursor = 0): { output: string; startCursor: number; truncated: boolean } {
    const requestedCursor = Math.max(0, Math.min(cursor, this.totalBytes));
    if (!this.truncated) {
      return { output: this.readFullBuffer().subarray(requestedCursor).toString("utf8"), startCursor: requestedCursor, truncated: false };
    }
    const startCursor = this.retainedStartCursor;
    const offset = Math.max(0, requestedCursor - startCursor);
    return { output: this.readTail().subarray(offset).toString("utf8"), startCursor, truncated: requestedCursor < startCursor };
  }

  /** 按时间顺序读取环形尾部缓冲区。 */
  private readTail(): Buffer {
    if (this.tailBytes < this.tailLimit) return this.tail.subarray(0, this.tailBytes);
    return Buffer.concat([this.tail.subarray(this.tailOffset), this.tail.subarray(0, this.tailOffset)]);
  }

  /** 在未截断时按原始顺序重建完整字节序列。 */
  private readFullBuffer(): Buffer {
    const tail = this.readTail();
    return Buffer.concat([this.head.subarray(0, Math.max(0, this.totalBytes - tail.length)), tail]);
  }
}

/** 按平台终止进程及其派生树，避免 Job/命令取消遗留子进程。 */
export function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

/** 在限定时间内等待目标子进程 close；监听器和 timer 都会在完成后清理。 */
function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(function wait(resolve) {
    const timer = setTimeout(function onTimeout() {
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    /** 收到真实 close 后结束等待。 */
    function onClose(): void {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("close", onClose);
  });
}

/** 等待 Windows taskkill 自身结束，非零退出不能当作已停止。 */
function runWindowsTaskkill(pid: number, timeoutMs: number): Promise<void> {
  return new Promise(function run(resolve, reject) {
    let taskkill: ChildProcess;
    try {
      taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true });
    } catch {
      reject(new ProcessTreeTerminationError("FAILED"));
      return;
    }
    const timer = setTimeout(function timedOut() {
      taskkill.kill();
      reject(new ProcessTreeTerminationError("TIMEOUT"));
    }, timeoutMs);
    taskkill.once("error", function onError() { clearTimeout(timer); reject(new ProcessTreeTerminationError("FAILED")); });
    taskkill.once("close", function onClose(exitCode) {
      clearTimeout(timer);
      if (exitCode === 0) resolve();
      else reject(new ProcessTreeTerminationError("FAILED"));
    });
  });
}

/**
 * 有界停止当前 Runtime 拥有的执行域；POSIX 要求原 detached 进程组消失并观察根退出。
 * Windows 此通用函数只确认 taskkill/包装退出；沙箱 Job 另需私有容器空能力。
 */
export async function terminateManagedProcessTree(child: ChildProcess, options: { graceMs?: number; timeoutMs?: number } = {}): Promise<void> {
  if (!child.pid) return;
  const graceMs = options.graceMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const startedAt = Date.now();
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await runWindowsTaskkill(child.pid, timeoutMs);
    const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
    if (!await waitForChildClose(child, remaining)) throw new ProcessTreeTerminationError("TIMEOUT");
    return;
  }
  const groupId = child.pid;
  /** 只检测当前受管组，ESRCH 表示组消失；权限/其他错误不能当作组为空。 */
  function groupExists(): boolean {
    try { process.kill(-groupId, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw new ProcessTreeTerminationError("FAILED");
    }
  }
  /** 只向既有受管组发信号；组在竞态中消失是终态，不退回只杀父进程。 */
  function signalGroup(signal: NodeJS.Signals): void {
    if (!groupExists()) return;
    try { process.kill(-groupId, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new ProcessTreeTerminationError("FAILED");
    }
  }
  /** 有界等待原进程组消失，根进程退出不提前放行同组子孙。 */
  async function waitForGroupExit(until: number): Promise<boolean> {
    while (groupExists()) {
      if (Date.now() >= until) return false;
      await new Promise<void>(function pause(resolve) { setTimeout(resolve, 20); });
    }
    return true;
  }
  signalGroup("SIGTERM");
  if (!await waitForGroupExit(startedAt + Math.min(graceMs, timeoutMs))) {
    signalGroup("SIGKILL");
    if (!await waitForGroupExit(startedAt + timeoutMs)) throw new ProcessTreeTerminationError("TIMEOUT");
  }
  const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
  if (!await waitForChildClose(child, remaining)) throw new ProcessTreeTerminationError("TIMEOUT");
}

/** 为 Windows 下 npm/npx 选择可执行 .cmd，策略仍使用原逻辑名称。 */
export function getPlatformExecutable(program: string): string {
  return process.platform === "win32" && /^(npm|npx)$/i.test(program) ? `${program}.cmd` : program;
}

/**
 * Windows 下将 npm/npx/pnpm 解析为可信 node.exe + 对应 CLI 脚本 + 结构化 argv，不执行任何
 * cmd shim（.cmd 交给 spawn(shell:false) 会得到 EINVAL，命令未启动）。沙箱包装路径与
 * danger-full-access 直接执行共用本实现；非 Windows 平台或非包管理器返回 null，由调用方按
 * 原生程序执行。受信 CLI 不可用时抛 SandboxPortError（SANDBOX_UNAVAILABLE），调用方必须
 * fail-closed，不得回退 shell 拼接。
 */
export function resolveWindowsPackageManagerCommand(program: string, args: readonly string[]): { executable: string; args: string[] } | null {
  if (process.platform !== "win32" || !/^(npm|npx|pnpm)(\.cmd)?$/i.test(program)) return null;
  const manager = program.replace(/\.cmd$/i, "").toLowerCase() as "npm" | "npx" | "pnpm";
  const relative = manager === "pnpm" ? "node_modules\\pnpm\\bin\\pnpm.mjs" : `node_modules\\npm\\bin\\${manager}-cli.js`;
  const programFiles = process.env.ProgramFiles;
  const systemProgramFiles = programFiles && /^[a-z]:\\Program Files$/i.test(programFiles) ? programFiles : "C:\\Program Files";
  const systemRoot = path.win32.join(systemProgramFiles, "nodejs");
  const execRoot = path.win32.dirname(process.execPath);
  const roots = [execRoot, systemRoot];
  let lastError: unknown;
  for (const candidateRoot of roots) {
    try {
      const root = fs.realpathSync.native(candidateRoot);
      // Program Files 兜底根不能经 junction/symlink 转入用户可写目录。运行时自身 Node
      // 安装根与 process.execPath 同级信任、不做该比较——nvm-windows 的
      // Program Files\nodejs 本身是指向用户目录的 junction，按字面比较会误杀合法安装。
      if (candidateRoot !== execRoot && path.win32.normalize(root).toLowerCase() !== path.win32.normalize(candidateRoot).toLowerCase()) continue;
      const expected = path.win32.join(root, relative);
      const cli = fs.realpathSync.native(expected);
      if (path.win32.normalize(cli).toLowerCase() !== path.win32.normalize(expected).toLowerCase()) continue;
      if (!fs.statSync(cli).isFile()) continue;
      return { executable: process.execPath, args: [cli, ...args] };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && typeof lastError === "object" && "code" in lastError && (lastError as { code?: unknown }).code !== "ENOENT") throw lastError;
  throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "受信包管理器 CLI 不可用");
}

/** 解析受管 Job 的实际 executable/argv；Windows npm/npx 只使用当前 Node 安装旁的固定 CLI。 */
export function resolveManagedCommand(program: string, args: readonly string[]): { executable: string; args: string[] } {
  if (process.platform !== "win32" || !/^(npm|npx)$/i.test(program)) return { executable: program, args: [...args] };
  const cliName = program.toLowerCase() === "npx" ? "npx-cli.js" : "npm-cli.js";
  const nodeRoot = fs.realpathSync.native(path.dirname(process.execPath));
  const candidate = path.join(nodeRoot, "node_modules", "npm", "bin", cliName);
  let cliPath: string;
  try { cliPath = fs.realpathSync.native(candidate); }
  catch { throw new Error("受信 npm CLI 不可用"); }
  const relative = path.relative(nodeRoot, cliPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("受信 npm CLI 不可用");
  return { executable: process.execPath, args: [cliPath, ...args] };
}
