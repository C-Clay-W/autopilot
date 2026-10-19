/** Node 文件锁回归测试：Windows 锁句柄竞争不能作为持久化 Session 的致命 EPERM。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "./file-utils";

const temporaryDirectories: string[] = [];

/** 清理每个测试创建的独立状态目录。 */
afterEach(function removeTemporaryDirectories() {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("withFileLock", function fileLockSuite() {
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
