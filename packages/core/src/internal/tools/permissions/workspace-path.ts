/**
 * 工作区路径守卫：将用户相对路径解析为已校验的真实工作区内部路径，阻止穿越和链接逃逸。
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";

export interface WorkspacePath {
  absolutePath: string;
  relativePath: string;
  exists: boolean;
}

/** 以 Windows 不区分大小写规则比较路径，避免 root-evil 前缀绕过；供内部围栏与外部目标预检共用。 */
export function isInsideRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 拒绝 UNC、设备、绝对路径和 NUL 等不能作为工作区相对路径的输入。 */
function validateRelativeInput(inputPath: string): void {
  if (!inputPath || inputPath.includes("\0")) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "路径不能为空且不能包含 NUL 字符");
  }
  if (/^(\\\\|\/\/|\\\\\?\\|\\\\\.\\)/.test(inputPath) || path.isAbsolute(inputPath) || path.win32.isAbsolute(inputPath)) {
    throw createToolError(TOOL_ERROR_CODES.PATH_OUTSIDE_WORKSPACE, "仅允许工作区内相对路径");
  }
}

/** 查找目标或最近存在父目录的 realpath，用于识别 symlink/junction 指向工作区外；外部目标预检共用同一还原算法。 */
export async function findExistingRealpath(targetPath: string): Promise<{ realPath: string; exists: boolean }> {
  let current = targetPath;
  let exists = true;
  while (true) {
    try {
      return { realPath: await realpath(current), exists };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
      exists = false;
    }
  }
}

/** 校验相对路径并返回可安全传给文件系统的绝对路径与对外相对路径。 */
export async function resolveWorkspacePath(workspaceRoot: string | undefined, inputPath: string): Promise<WorkspacePath> {
  if (!workspaceRoot) {
    throw createToolError(TOOL_ERROR_CODES.WORKSPACE_NOT_CONFIGURED, "文件和命令工具需要显式配置 workspaceRoot");
  }
  validateRelativeInput(inputPath);
  const rootPath = await realpath(path.resolve(workspaceRoot));
  const targetPath = path.resolve(rootPath, inputPath);
  if (!isInsideRoot(rootPath, targetPath)) {
    throw createToolError(TOOL_ERROR_CODES.PATH_TRAVERSAL, "路径不能逃离工作区");
  }
  const resolved = await findExistingRealpath(targetPath);
  if (!isInsideRoot(rootPath, resolved.realPath)) {
    throw createToolError(TOOL_ERROR_CODES.PATH_UNSAFE_LINK, "路径或父目录链接指向工作区外");
  }
  return { absolutePath: targetPath, relativePath: path.relative(rootPath, targetPath) || ".", exists: resolved.exists };
}

/** 校验目标为普通文件，目录、符号链接和设备文件均不可作为文本读写目标。 */
export async function assertRegularFile(targetPath: string): Promise<void> {
  const stats = await lstat(targetPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ, "仅允许读取或写入普通文件");
  }
}

/** 校验搜索起点为真实目录，拒绝符号链接、junction 和其他特殊文件。 */
export async function assertDirectory(targetPath: string): Promise<void> {
  const stats = await lstat(targetPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ, "文件发现起点必须是工作区内真实目录");
  }
}

/** 校验内容搜索起点为真实普通文件或目录，拒绝链接和设备文件。 */
export async function assertSearchTarget(targetPath: string): Promise<void> {
  const stats = await lstat(targetPath);
  if ((!stats.isFile() && !stats.isDirectory()) || stats.isSymbolicLink()) {
    throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ, "内容搜索起点必须是工作区内真实文件或目录");
  }
}
