/**
 * node/settings/user-config-directory.ts — 首次业务命令的用户配置目录保障。
 *
 * 仅在 Node Adapter 中通过当前运行用户 Home 创建并校验 ~/.autopilot；不创建 settings
 * 或 durable state，且拒绝配置根链接，避免配置逃逸到 Home 之外。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 用户配置目录创建可能返回的稳定、脱敏错误码。 */
export type UserConfigDirectoryErrorCode =
  | "AUTOPILOT_HOME_UNRESOLVED"
  | "AUTOPILOT_CONFIG_ROOT_NOT_DIRECTORY"
  | "AUTOPILOT_CONFIG_ROOT_UNSAFE_LINK"
  | "AUTOPILOT_CONFIG_ROOT_UNAVAILABLE";

/** 用户配置目录的稳定错误；message 不包含 Home 或配置根路径。 */
export class UserConfigDirectoryError extends Error {
  constructor(public readonly code: UserConfigDirectoryErrorCode) {
    super(code);
    this.name = "UserConfigDirectoryError";
  }
}

/** 测试可注入临时 Home；生产调用始终由 os.homedir() 解析当前用户 Home。 */
export interface EnsureUserConfigDirectoryOptions {
  homeDirectory?: string;
}

/** 将当前运行用户 Home 解析为可安全使用的绝对路径。 */
function resolveUserHome(homeDirectory: string | undefined): string {
  let candidate = homeDirectory;
  if (candidate === undefined) {
    try {
      candidate = os.homedir();
    } catch {
      throw new UserConfigDirectoryError("AUTOPILOT_HOME_UNRESOLVED");
    }
  }
  if (!candidate || !path.isAbsolute(candidate)) throw new UserConfigDirectoryError("AUTOPILOT_HOME_UNRESOLVED");
  return path.resolve(candidate);
}

/** 读取目录项的 lstat；缺失项保留给 mkdir，其余读取异常统一收敛为不可用。 */
function readEntry(entryPath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new UserConfigDirectoryError("AUTOPILOT_CONFIG_ROOT_UNAVAILABLE");
  }
}

/** 判断 canonical 配置根仍位于 canonical Home 内，防止链接或重解析点逃逸。 */
function isWithinHome(homeDirectory: string, configDirectory: string): boolean {
  const relative = path.relative(homeDirectory, configDirectory);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 校验配置根是非链接的真实目录，并确认 canonical 位置没有离开 Home。 */
function assertSafeConfigDirectory(homeDirectory: string, configDirectory: string): void {
  const entry = readEntry(configDirectory);
  if (!entry) throw new UserConfigDirectoryError("AUTOPILOT_CONFIG_ROOT_UNAVAILABLE");
  if (entry.isSymbolicLink()) throw new UserConfigDirectoryError("AUTOPILOT_CONFIG_ROOT_UNSAFE_LINK");
  if (!entry.isDirectory()) throw new UserConfigDirectoryError("AUTOPILOT_CONFIG_ROOT_NOT_DIRECTORY");
  try {
    const canonicalHome = fs.realpathSync.native(homeDirectory);
    const canonicalConfigDirectory = fs.realpathSync.native(configDirectory);
    if (!isWithinHome(canonicalHome, canonicalConfigDirectory)) {
      throw new UserConfigDirectoryError("AUTOPILOT_CONFIG_ROOT_UNSAFE_LINK");
    }
  } catch (error) {
    if (error instanceof UserConfigDirectoryError) throw error;
    throw new UserConfigDirectoryError("AUTOPILOT_CONFIG_ROOT_UNAVAILABLE");
  }
}

/**
 * 创建或复用 ~/.autopilot，并在创建前后验证它不是链接或同名普通文件。
 *
 * 递归 mkdir 本身可处理多个进程同时首次启动；此函数不修改既有目录权限或内容。
 */
export function ensureUserConfigDirectory(options: EnsureUserConfigDirectoryOptions = {}): string {
  const homeDirectory = resolveUserHome(options.homeDirectory);
  const configDirectory = path.join(homeDirectory, ".autopilot");
  const existing = readEntry(configDirectory);
  if (existing) assertSafeConfigDirectory(homeDirectory, configDirectory);
  else {
    try {
      fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    } catch {
      throw new UserConfigDirectoryError("AUTOPILOT_CONFIG_ROOT_UNAVAILABLE");
    }
    assertSafeConfigDirectory(homeDirectory, configDirectory);
  }
  return configDirectory;
}
