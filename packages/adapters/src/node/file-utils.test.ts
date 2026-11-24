/** Node 文件锁回归测试：Windows 锁句柄竞争不能作为持久化 Session 的致命 EPERM。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFileOperationDiagnostic, withAsyncFileLock, withFileLock } from "./file-utils";

const temporaryDirectories: string[] = [];

/** 清理每个测试创建的独立状态目录。 */
afterEach(function removeTemporaryDirectories() {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("withFileLock", function fileLockSuite() {
  it.each([withFileLock, withAsyncFileLock])("释放重试不删除替换 owner 的锁", async function keepsReplacementOwner(locked) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-file-lock-owner-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "checkpoint.jsonl");
    const lockPath = target + ".lock";
    const unlink = fs.promises.unlink;
    let attempts = 0;
    vi.spyOn(fs.promises, "unlink").mockImplementation(async function replaceOwner(file) {
      if (String(file) === lockPath) {
        attempts++;
        fs.writeFileSync(lockPath, JSON.stringify({ ownerId: "replacement", pid: process.pid, createdAt: Date.now() }));
        throw Object.assign(new Error("handle contention"), { code: "EPERM" });
      }
      return unlink(file);
    });
    await locked(target, function done() {});
    expect(attempts).toBe(1);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).ownerId).toBe("replacement");
  });

  it("无法释放锁时保留错误诊断，不静默成功", async function reportsCleanupFailure() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-file-lock-error-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "checkpoint.jsonl");
    const error = Object.assign(new Error("storage unavailable"), { code: "EIO" });
    vi.spyOn(fs.promises, "unlink").mockRejectedValueOnce(error);
    await expect(withFileLock(target, function done() {})).rejects.toBe(error);
    expect(getFileOperationDiagnostic(error)).toMatchObject({ phase: "cleanup", cleanupFailed: true, osCode: "EIO" });
  });

  it.each(["sync", "async"] as const)("%s 释放锁遇到短暂 EPERM 后不能遗留活进程锁", async function retriesRelease(mode) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-file-lock-release-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "checkpoint.jsonl");
    const lockPath = target + ".lock";
    const unlink = fs.unlinkSync;
    const unlinkAsync = fs.promises.unlink;
    let denied = false;
    // 模拟 Windows 读取锁元数据时的短暂句柄竞争，不改真实会话。
    function refuseOnce(file: fs.PathLike): void {
      if (String(file) === lockPath && !denied) { denied = true; throw Object.assign(new Error("handle contention"), { code: "EPERM" }); }
    }
    vi.spyOn(fs, "unlinkSync").mockImplementation(function remove(file) { refuseOnce(file); return unlink(file); });
    vi.spyOn(fs.promises, "unlink").mockImplementation(async function remove(file) { refuseOnce(file); return unlinkAsync(file); });
    const locked = mode === "sync" ? withFileLock : withAsyncFileLock;
    await expect(locked(target, function write() { fs.writeFileSync(target, "completed"); })).resolves.toBeUndefined();
    expect(denied).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    await expect(locked(target, function read() { return fs.readFileSync(target, "utf8"); })).resolves.toBe("completed");
  });

  it("立即回收已退出进程留下的锁，不等待 30 秒超时", async function reclaimsExitedProcessLockOwner() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-file-lock-"));
    temporaryDirectories.push(directory);
    const targetPath = path.join(directory, "session.json");
    const lockPath = `${targetPath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ ownerId: "stopped-process", pid: 99_999_999, createdAt: Date.now() }), "utf8");

    await expect(withFileLock(targetPath, function writeRecoveredSession() {
      fs.writeFileSync(targetPath, "saved", "utf8");
    })).resolves.toBeUndefined();

    expect(fs.readFileSync(targetPath, "utf8")).toBe("saved");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("Windows 锁刚释放后首次返回 EPERM 时继续竞争并完成写入", async function retriesWindowsLockContention() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-file-lock-"));
    temporaryDirectories.push(directory);
    const targetPath = path.join(directory, "session.json");
    const lockPath = `${targetPath}.lock`;
    const error = Object.assign(new Error("Windows handle contention"), { code: "EPERM" });
    vi.spyOn(fs, "openSync").mockImplementationOnce(function throwWindowsLockContention() { throw error; });

    await expect(withFileLock(targetPath, function writeSession() {
      fs.writeFileSync(targetPath, "saved", "utf8");
    })).resolves.toBeUndefined();

    expect(fs.readFileSync(targetPath, "utf8")).toBe("saved");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
