/**
 * 工作区文件枚举 API：以 rg --files 枚举候选文件索引（供 CLI @文件提及等宿主能力复用）。
 * 复用内部 ripgrep 执行层与 glob_files 的排除规则，失败统一收敛为 AgentRuntimeError。
 */
import { stat } from "node:fs/promises";
import { AgentRuntimeError } from "../../runtime/protocol/error-code";
import { assertRipgrepSucceeded, normalizeSearchPath, runRipgrep } from "./file-search";
import { DEFAULT_EXCLUDES } from "./builtins/glob-files-tool";

/** listWorkspaceFiles 的输入契约。 */
export interface ListWorkspaceFilesInput {
  /** 工作区根的绝对路径；枚举范围不会超出该目录。 */
  workspaceRoot: string;
  /** 返回路径数量上限，默认 20000。 */
  maxFiles?: number;
  /** 取消信号；取消、超时与启动失败均收敛为 AgentRuntimeError。 */
  signal?: AbortSignal;
}

/** listWorkspaceFiles 的结果契约。 */
export interface ListWorkspaceFilesResult {
  /** 工作区相对路径（正斜杠、localeCompare 稳定排序）。 */
  files: string[];
  /** 结果不完整时为 true（ripgrep 输出截断或超过 maxFiles）。 */
  truncated: boolean;
}

const DEFAULT_MAX_FILES = 20000;
/** 20000 条路径按平均 400+ 字节预留的 stdout 上限，避免典型仓库误报截断。 */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** 枚举工作区文件并返回正斜杠相对路径的稳定排序列表。 */
export async function listWorkspaceFiles(input: ListWorkspaceFilesInput): Promise<ListWorkspaceFilesResult> {
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  if (!input.workspaceRoot || !Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new AgentRuntimeError("INVALID_INPUT", "workspaceRoot 不能为空且 maxFiles 必须为正整数");
  }
  let rootStats;
  try {
    rootStats = await stat(input.workspaceRoot);
  } catch (error) {
    throw new AgentRuntimeError("INVALID_INPUT", `工作区目录不存在: ${input.workspaceRoot}`, error);
  }
  if (!rootStats.isDirectory()) {
    throw new AgentRuntimeError("INVALID_INPUT", "workspaceRoot 必须是目录");
  }

  // rg --files 枚举文件名；--hidden 保留点文件（.gitignore/.env 等），排除规则与 glob_files 一致。
  const args = ["--files", "--hidden"];
  for (const exclusion of DEFAULT_EXCLUDES) args.push("--glob", exclusion);
  args.push("--", ".");

  try {
    const result = await runRipgrep(args, input.workspaceRoot, input.signal, { maxStdoutBytes: MAX_STDOUT_BYTES });
    assertRipgrepSucceeded(result);
    const files = result.stdout
      .split(/\r?\n/)
      .map(normalizeSearchPath)
      .filter(Boolean)
      .sort(function comparePaths(left, right) {
        return left.localeCompare(right);
      });
    return {
      files: files.slice(0, maxFiles),
      truncated: result.truncated || files.length > maxFiles,
    };
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error;
    throw new AgentRuntimeError("RUNTIME_ERROR", "枚举工作区文件失败", error);
  }
}
