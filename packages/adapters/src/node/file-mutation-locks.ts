/** 同一 OS 用户的文件目标锁域：独立于 workspace/stateRoot 与 HOME/TEMP 环境覆盖。 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { withFileLock } from "./file-utils";

/** 由 OS 用户身份确定共同锁目录，不接受模型或各 workspace 的配置。 */
export function getNodeFileMutationLockRoot(): string {
  return path.join(os.userInfo().homedir, ".autopilot", "file-mutation-locks");
}

/** 对 canonical 目标去重排序取锁，避免多文件 Undo 与工具互相抢占或死锁。 */
export async function withNodeFileMutationLocks<T>(canonicalTargets: readonly string[], operation: () => Promise<T>): Promise<T> {
  const ids = [...new Set(canonicalTargets.map(function targetId(target) {
    if (!path.isAbsolute(target)) throw new Error("文件目标锁必须绑定 canonical 绝对路径");
    const normalized = path.normalize(target);
    return createHash("sha256").update(process.platform === "win32" ? normalized.toLowerCase() : normalized).digest("hex");
  }))].sort();
  /** 所有调用均按相同顺序取锁，锁取得后覆盖完整校验/WAL/提交/补偿临界区。 */
  async function lockNext(index: number): Promise<T> {
    if (index === ids.length) return operation();
    return withFileLock(path.join(getNodeFileMutationLockRoot(), ids[index]! + ".target"), function acquireNext() { return lockNext(index + 1); }, { requireExitedOwner: true });
  }
  return lockNext(0);
}
