/**
 * Node durable Adapter 文件工具：提供进程内串行锁、原子替换、JSONL 读取和安全文件键。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

/** 内部文件阶段诊断只记录封闭阶段与OS码，原始异常不进入公开DTO。 */
export interface FileOperationDiagnostic {
  phase: "lock" | "temporary_write" | "rename" | "cleanup";
  osCode?: string;
  lockWaitMs?: number;
  attempts?: number;
  elapsedMs?: number;
  cleanupFailed?: boolean;
}
const fileDiagnostics = new WeakMap<object, FileOperationDiagnostic>();
/** 取得内部诊断副本，不读取异常正文、路径或stack。 */
export function getFileOperationDiagnostic(error: unknown): FileOperationDiagnostic | undefined {
  return error && typeof error === "object" ? fileDiagnostics.get(error) : undefined;
}
/** 只接受已知OS错误码；任意自定义code不得进入日志。 */
function rememberFileFailure(error: unknown, diagnostic: FileOperationDiagnostic): void {
  if (!error || typeof error !== "object") return;
  const code = (error as NodeJS.ErrnoException).code;
  const osCode = ["EACCES", "EPERM", "ENOENT", "EEXIST", "ENOSPC", "EIO", "EMFILE", "ENFILE", "EBUSY", "EROFS", "ENOTDIR", "ETIMEDOUT"].includes(code ?? "") ? code : undefined;
  fileDiagnostics.set(error, { ...diagnostic, ...(osCode ? { osCode } : {}) });
}

const fileLocks = new Map<string, Promise<void>>();
const PROCESS_LOCK_RETRY_MS = 10;
const PROCESS_LOCK_TIMEOUT_MS = 30_000;
const PROCESS_LOCK_STALE_MS = 60_000;

interface ProcessLockMetadata {
  ownerId: string;
  pid: number;
  createdAt: number;
}

interface ProcessLockHandle {
  lockPath: string;
  ownerId: string;
  descriptor: number;
}

interface AsyncProcessLockHandle {
  lockPath: string;
  ownerId: string;
  descriptor: FileHandle;
}

/** JSONL 恢复时发现的脱敏损坏记录位置；绝不包含原始记录正文。 */
export interface JsonlCorruptionDiagnostic {
  code: "DURABLE_JSONL_CORRUPTED";
  line: number;
  reason: "INVALID_JSON";
}

/** 等待短暂的跨进程锁竞争，不阻塞 Node 事件循环。 */
function waitForProcessLock(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROCESS_LOCK_RETRY_MS));
}

/** 判断锁文件是否已超过短临界区允许的 stale 时间。 */
function isStaleProcessLock(lockPath: string): boolean {
  try {
    const metadata = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<ProcessLockMetadata>;
    const createdAt = typeof metadata.createdAt === "number" ? metadata.createdAt : fs.statSync(lockPath).mtimeMs;
    return Date.now() - createdAt > PROCESS_LOCK_STALE_MS;
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > PROCESS_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

/** 异步判断锁文件是否已超过短临界区允许的 stale 时间。 */
async function isStaleProcessLockAsync(lockPath: string): Promise<boolean> {
  try {
    const metadata = JSON.parse(await fsp.readFile(lockPath, "utf8")) as Partial<ProcessLockMetadata>;
    const createdAt = typeof metadata.createdAt === "number" ? metadata.createdAt : (await fsp.stat(lockPath)).mtimeMs;
    return Date.now() - createdAt > PROCESS_LOCK_STALE_MS;
  } catch {
    try {
      return Date.now() - (await fsp.stat(lockPath)).mtimeMs > PROCESS_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

/** 检查锁文件记录的 owner 进程是否已经退出，避免重启后的遗留锁占满超时窗口。 */
function hasExitedProcessLockOwner(lockPath: string): boolean {
  try {
    const metadata = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<ProcessLockMetadata>;
    if (!Number.isInteger(metadata.pid) || (metadata.pid as number) <= 0) return false;
    try {
      process.kill(metadata.pid as number, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    // 锁刚创建时可能尚未写完 metadata，继续依赖常规 stale 判定避免抢占有效临界区。
    return false;
  }
}

/** 异步检查锁文件记录的 owner 进程是否已经退出。 */
async function hasExitedProcessLockOwnerAsync(lockPath: string): Promise<boolean> {
  try {
    const metadata = JSON.parse(await fsp.readFile(lockPath, "utf8")) as Partial<ProcessLockMetadata>;
    if (!Number.isInteger(metadata.pid) || (metadata.pid as number) <= 0) return false;
    try {
      process.kill(metadata.pid as number, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

/** Windows 句柄竞争可能在锁刚删除后仍返回 EPERM/EACCES；统一按短暂竞争重试。 */
function isProcessLockContention(code: string | undefined): boolean {
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}

/** 使用 wx 原子创建锁文件，跨 Node 进程保护同一文件的读改写临界区。 */
async function acquireProcessLock(filePath: string, requireExitedOwner = false): Promise<ProcessLockHandle> {
  ensureParentDirectory(filePath);
  const lockPath = `${filePath}.lock`;
  const ownerId = randomUUID();
  const startedAt = Date.now();
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      const metadata: ProcessLockMetadata = { ownerId, pid: process.pid, createdAt: Date.now() };
      fs.writeFileSync(descriptor, JSON.stringify(metadata), "utf8");
      return { lockPath, ownerId, descriptor };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!isProcessLockContention(code)) throw error;
      if (hasExitedProcessLockOwner(lockPath) || (!requireExitedOwner && isStaleProcessLock(lockPath))) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // 另一个进程可能已完成释放或正在替换锁；下一轮重新竞争。
        }
        continue;
      }
      if (Date.now() - startedAt >= PROCESS_LOCK_TIMEOUT_MS) {
        throw new Error(`跨进程文件锁等待超时：${filePath}`);
      }
      await waitForProcessLock();
    }
  }
}

/** 短暂句柄竞争时重试释放，每次重核 owner；失败不能被当成已经释放。 */
async function removeOwnedProcessLock(lockPath: string, ownerId: string): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      const metadata = JSON.parse(await fsp.readFile(lockPath, "utf8")) as Partial<ProcessLockMetadata>;
      if (metadata.ownerId !== ownerId) return;
      await fsp.unlink(lockPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if ((code === "EPERM" || code === "EACCES" || code === "EBUSY") && Date.now() - startedAt < PROCESS_LOCK_TIMEOUT_MS) {
        await waitForProcessLock();
        continue;
      }
      rememberFileFailure(error, { phase: "cleanup", cleanupFailed: true });
      throw error;
    }
  }
}

/** 关闭并按 owner 校验后删除跨进程锁文件，完成前不释放进程内队列。 */
async function releaseProcessLock(handle: ProcessLockHandle): Promise<void> {
  try {
    fs.closeSync(handle.descriptor);
  } finally {
    await removeOwnedProcessLock(handle.lockPath, handle.ownerId);
  }
}

/** 将同一文件的读改写操作串行化，兼顾同进程队列与跨进程原子锁。 */
export async function withFileLock<T>(filePath: string, operation: () => T | Promise<T>, options?: { requireExitedOwner?: boolean }): Promise<T> {
  const key = path.resolve(filePath);
  const previous = fileLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => next);
  fileLocks.set(key, queued);
  try {
    await previous;
    const startedAt = Date.now();
    let handle: ProcessLockHandle;
    try { handle = await acquireProcessLock(key, options?.requireExitedOwner); }
    catch (error) { rememberFileFailure(error, { phase: "lock", lockWaitMs: Date.now() - startedAt }); throw error; }
    try {
      return await operation();
    } finally {
      await releaseProcessLock(handle);
    }
  } finally {
    release();
    if (fileLocks.get(key) === queued) fileLocks.delete(key);
  }
}

const asyncFileLocks = new Map<string, Promise<void>>();

/** 使用异步 wx 原子创建锁文件，跨 Node 进程保护 Transcript 的读尾部与追加临界区。 */
async function acquireAsyncProcessLock(filePath: string): Promise<AsyncProcessLockHandle> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const ownerId = randomUUID();
  const startedAt = Date.now();
  while (true) {
    try {
      const descriptor = await fsp.open(lockPath, "wx");
      const metadata: ProcessLockMetadata = { ownerId, pid: process.pid, createdAt: Date.now() };
      await descriptor.writeFile(JSON.stringify(metadata), "utf8");
      return { lockPath, ownerId, descriptor };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!isProcessLockContention(code)) throw error;
      if (await hasExitedProcessLockOwnerAsync(lockPath) || await isStaleProcessLockAsync(lockPath)) {
        try {
          await fsp.unlink(lockPath);
        } catch {
          // 另一个进程可能已完成释放或正在替换锁；下一轮重新竞争。
        }
        continue;
      }
      if (Date.now() - startedAt >= PROCESS_LOCK_TIMEOUT_MS) {
        throw new Error(`跨进程文件锁等待超时：${filePath}`);
      }
      await waitForProcessLock();
    }
  }
}

/** 关闭并按 owner 校验后异步删除跨进程锁文件。 */
async function releaseAsyncProcessLock(handle: AsyncProcessLockHandle): Promise<void> {
  try {
    await handle.descriptor.close();
  } finally {
    await removeOwnedProcessLock(handle.lockPath, handle.ownerId);
  }
}

/** 将同一文件的异步读改写操作串行化，供 Transcript 专用热路径使用。 */
export async function withAsyncFileLock<T>(filePath: string, operation: () => T | Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = asyncFileLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => next);
  asyncFileLocks.set(key, queued);
  try {
    await previous;
    const handle = await acquireAsyncProcessLock(key);
    try {
      return await operation();
    } finally {
      await releaseAsyncProcessLock(handle);
    }
  } finally {
    release();
    if (asyncFileLocks.get(key) === queued) asyncFileLocks.delete(key);
  }
}

/** 确保目标文件的父目录存在。 */
export function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** 通过同目录临时文件和 rename 原子替换目标文件，失败时保留原文件。 */
export function atomicReplace(filePath: string, content: string): void {
  ensureParentDirectory(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let phase: FileOperationDiagnostic["phase"] = "temporary_write";
  let failure: unknown;
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    phase = "rename";
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    failure = error;
    rememberFileFailure(error, { phase });
    throw error;
  } finally {
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); }
    catch (error) {
      if (failure) rememberFileFailure(failure, { ...getFileOperationDiagnostic(failure)!, cleanupFailed: true });
      else { rememberFileFailure(error, { phase: "cleanup" }); throw error; }
    }
  }
}

/** Session 保存遇 Windows 共享冲突时，在原锁内复用同一临时文件，最多五次、退避共 300ms。 */
export async function replaceSessionFile(filePath: string, content: string): Promise<void> {
  if (process.platform !== "win32") return atomicReplace(filePath, content);
  ensureParentDirectory(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const delays = [20, 40, 80, 160];
  let attempts = 0;
  const started = performance.now();
  try {
    await fsp.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    for (;;) {
      attempts++;
      try { await fsp.rename(temporaryPath, filePath); return; }
      catch (error) {
        const delay = delays[attempts - 1];
        if (!delay || !["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise(function backoff(resolve) { setTimeout(resolve, delay); });
      }
    }
  } catch (error) {
    let cleanupFailed = false;
    try { await fsp.rm(temporaryPath, { force: true }); } catch { cleanupFailed = true; }
    rememberFileFailure(error, { phase: attempts ? "rename" : "temporary_write", attempts, elapsedMs: Math.round(performance.now() - started), cleanupFailed });
    throw error;
  }
}

/** 安全拼接 Store 文件名，拒绝路径分隔符和状态根外的路径逃逸。 */
export function safeFilePath(directory: string, key: string, extension: string): string {
  if (!key || key.includes("/") || key.includes("\\") || key === "." || key === "..") {
    throw new Error("持久化 ID 不能包含路径分隔符");
  }
  const canonicalDirectory = path.resolve(directory);
  const candidate = path.resolve(canonicalDirectory, `${key}${extension}`);
  const relative = path.relative(canonicalDirectory, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("持久化路径越出状态根");
  }
  return candidate;
}

/** 读取 JSON 文件；不存在或损坏时返回 null。 */
export function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 读取 JSONL 文件并跳过损坏行，同时返回脱敏诊断与原始有效行供兼容去重使用。 */
export function readJsonLines<T>(filePath: string): { values: T[]; lines: string[]; diagnostics: JsonlCorruptionDiagnostic[] } {
  if (!fs.existsSync(filePath)) return { values: [], lines: [], diagnostics: [] };
  const sourceLines = fs.readFileSync(filePath, "utf8").split("\n");
  const values: T[] = [];
  const validLines: string[] = [];
  const diagnostics: JsonlCorruptionDiagnostic[] = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    if (!line) continue;
    try {
      values.push(JSON.parse(line) as T);
      validLines.push(line);
    } catch {
      // 损坏行不能阻塞其他持久化记录的恢复。
      diagnostics.push({ code: "DURABLE_JSONL_CORRUPTED", line: index + 1, reason: "INVALID_JSON" });
    }
  }
  if (diagnostics.length > 0) {
    console.warn(`[DURABLE_JSONL_CORRUPTED] file=${path.basename(filePath)} records=${diagnostics.length} lines=${diagnostics.map((item) => item.line).join(",")}`);
  }
  return { values, lines: validLines, diagnostics };
}

/** 以 JSONL 追加一条记录；调用方应在 withFileLock 内执行。 */
export function appendJsonLine(filePath: string, serialized: string): void {
  ensureParentDirectory(filePath);
  fs.appendFileSync(filePath, `${serialized}\n`, "utf8");
}

/** 追加 JSONL 记录并按完整序列化内容幂等去重。 */
export async function appendUniqueJsonLine(filePath: string, serialized: string): Promise<void> {
  await withFileLock(filePath, () => {
    const existing = readJsonLines<unknown>(filePath).lines;
    if (existing.includes(serialized)) return;
    appendJsonLine(filePath, serialized);
  });
}
