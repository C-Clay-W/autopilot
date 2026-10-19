/**
 * 文件搜索执行层：使用项目固定的 ripgrep 二进制，以无 Shell argv 提供超时、取消和输出上限。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { createToolError, TOOL_ERROR_CODES } from "./tool-error";

export interface RipgrepExecutionOptions {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface RipgrepExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;

/** 从模块自身位置解析 @vscode/ripgrep 的固定平台二进制，宿主 cwd 与安装方式不影响命中。 */
export function resolveRipgrepExecutable(): string {
  // 基准是本模块（bundle 后为 dist 产物自身位置），而非 process.cwd()：
  // CLI 全局安装或从用户项目目录启动时，cwd 下无法解析到 core 的依赖；
  // CJS 产物中 import.meta 为空，沿用 database-snapshot 的 __filename 回退模式。
  const modulePath = import.meta.url || (typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json"));
  const moduleRequire = createRequire(modulePath);
  const packageEntry = moduleRequire.resolve("@vscode/ripgrep");
  const packageRequire = createRequire(packageEntry);
  const arch = process.env.npm_config_arch || process.arch;
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const platformPackage = `@vscode/ripgrep-${process.platform}-${arch}`;
  try {
    return packageRequire.resolve(`${platformPackage}/bin/${binaryName}`);
  } catch {
    throw createToolError(
      TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED,
      `缺少当前平台的 ripgrep 运行包: ${platformPackage}`,
    );
  }
}

/** 在字节上限内追加输出，超过上限时保留完整前缀并标记截断。 */
function appendBoundedChunk(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number,
): { bytes: number; truncated: boolean } {
  const remaining = Math.max(0, maxBytes - currentBytes);
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return {
    bytes: currentBytes + Math.min(chunk.length, remaining),
    truncated: chunk.length > remaining,
  };
}

/** 执行一次 ripgrep；取消、超时和启动失败均转换为稳定工具错误。 */
export async function runRipgrep(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  options: RipgrepExecutionOptions = {},
): Promise<RipgrepExecutionResult> {
  if (signal?.aborted) {
    throw createToolError(TOOL_ERROR_CODES.EXECUTION_CANCELLED, "用户已取消文件搜索");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const executable = resolveRipgrepExecutable();

  return await new Promise<RipgrepExecutionResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let cancelled = false;
    let timedOut = false;
    let spawnError: Error | undefined;

    /** 终止仍在运行的 ripgrep 子进程。 */
    function stopChild(): void {
      if (!child.killed) child.kill();
    }

    /** 响应 Agent AbortSignal，并交由 ToolExecutor 生成 cancelled 终态。 */
    function handleAbort(): void {
      cancelled = true;
      stopChild();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutMs);
    signal?.addEventListener("abort", handleAbort, { once: true });

    child.stdout?.on("data", (value: Buffer) => {
      const appended = appendBoundedChunk(stdoutChunks, value, stdoutBytes, maxStdoutBytes);
      stdoutBytes = appended.bytes;
      if (appended.truncated) {
        stdoutTruncated = true;
        stopChild();
      }
    });
    child.stderr?.on("data", (value: Buffer) => {
      const appended = appendBoundedChunk(stderrChunks, value, stderrBytes, maxStderrBytes);
      stderrBytes = appended.bytes;
    });
    child.on("error", (error: Error) => {
      spawnError = error;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      if (cancelled) {
        reject(createToolError(TOOL_ERROR_CODES.EXECUTION_CANCELLED, "用户已取消文件搜索"));
        return;
      }
      if (timedOut) {
        reject(createToolError(TOOL_ERROR_CODES.EXECUTION_TIMEOUT, `文件搜索超过 ${timeoutMs}ms`));
        return;
      }
      if (spawnError) {
        reject(createToolError(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, `无法启动 ripgrep: ${spawnError.message}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        truncated: stdoutTruncated,
      });
    });
  });
}

/** 将 ripgrep 返回路径统一转换为工作区相对的正斜杠形式。 */
export function normalizeSearchPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 将 ripgrep 非零终态转换为对模型可行动的稳定错误。 */
export function assertRipgrepSucceeded(result: RipgrepExecutionResult): void {
  if (result.exitCode === 0 || result.exitCode === 1 || result.truncated) return;
  const message = result.stderr.trim().slice(0, 500) || "ripgrep 搜索失败";
  if (/regex parse error|error parsing regex|unclosed group|repetition operator/i.test(message)) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, `搜索正则无效: ${message}`);
  }
  throw createToolError(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, message);
}
