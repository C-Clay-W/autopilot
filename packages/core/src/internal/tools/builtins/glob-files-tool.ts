/**
 * glob_files 工具：在工作区硬边界内按 glob 模式发现文件，返回稳定分页的相对路径。
 */
import { z } from "zod";
import { assertDirectory } from "../permissions/workspace-path";
import { resolveFileTarget, resolveExternalTargetRestriction } from "../permissions/path-access-policy";
import { assertRipgrepSucceeded, normalizeSearchPath, runRipgrep } from "../file-search";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { AgentToolDefinition } from "../types";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
export const DEFAULT_EXCLUDES = [
  "!**/.git/**",
  "!**/.svn/**",
  "!**/.hg/**",
  "!**/node_modules/**",
  "!**/.next/**",
  "!**/dist/**",
  "!**/coverage/**",
] as const;

const globFilesSchema = z.object({
  pattern: z.string().min(1).max(512),
  path: z.string().min(1).default("."),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.number().int().min(0).default(0),
}).strict();

/** 构造 glob_files 的 ripgrep argv，始终尊重 gitignore 并排除高噪声目录。 */
function buildGlobArguments(pattern: string, targetPath: string): string[] {
  const args = ["--files", "--hidden", "--glob", pattern];
  for (const exclusion of DEFAULT_EXCLUDES) args.push("--glob", exclusion);
  args.push("--", targetPath);
  return args;
}

/** 创建只读文件名发现工具定义。 */
export function createGlobFilesTool(): AgentToolDefinition<z.infer<typeof globFilesSchema>, Record<string, unknown>> {
  return {
    name: "glob_files",
    description: "按文件名或相对路径 glob 模式发现工作区文件。路径未知时先用本工具，不要用 run_command 执行 pwd、dir、find、rg 或临时探测脚本。返回稳定排序的工作区相对路径；结果截断时缩小 path 或 pattern 后继续。",
    inputSchema: globFilesSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 1, resourceKey: "workspace:file-discovery" }, retry: { safe: false } },
    async createActionFacts(input, context) {
      // Talk-Plan1013 Stage5 R5：外部搜索目标先查当前 Read 限制——deny 硬拒绝，ask 逐次确认；allow 与工作区内目标维持免新增路径审批。
      const target = await resolveFileTarget(context.workspaceRoot, input.path);
      const restriction = await resolveExternalTargetRestriction(context, target, "glob_files");
      return {
        toolName: "glob_files",
        effect: "none",
        destructive: false,
        operation: "discover",
        risk: "read_only",
        ...(target.isExternal ? {
          externalTarget: { canonicalTarget: target.canonicalTarget, canonicalWorkspace: target.canonicalWorkspace },
          externalRestriction: restriction,
        } : {}),
        ...(restriction === "deny" ? { hardDenyReason: "搜索该工作区外目录已被显式规则拒绝" } : {}),
        ...(restriction === "ask" ? { requiresApproval: true, approval: { reason: "搜索该工作区外目录需要逐次确认" } } : {}),
      };
    },
    async execute(input, context) {
      // Talk-Plan1013 Stage 1：纯搜索免新增外部路径审批；外部目标以 canonical 绝对路径交给 ripgrep。
      const workspace = await resolveFileTarget(context.workspaceRoot, ".");
      const target = await resolveFileTarget(context.workspaceRoot, input.path);
      if (!target.exists) {
        throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ, `目录不存在: ${input.path}`);
      }
      await assertDirectory(target.absolutePath);
      const result = await runRipgrep(
        buildGlobArguments(input.pattern, target.isExternal ? target.canonicalTarget : target.relativePath!),
        workspace.absolutePath,
        context.signal,
      );
      assertRipgrepSucceeded(result);
      const files = result.stdout
        .split(/\r?\n/)
        .map(normalizeSearchPath)
        .filter(Boolean)
        .sort(function comparePaths(left, right) {
          return left.localeCompare(right);
        });
      const selected = files.slice(input.offset, input.offset + input.limit);
      return {
        files: selected,
        returned: selected.length,
        offset: input.offset,
        truncated: result.truncated || files.length > input.offset + input.limit,
        // ripgrep 输出未被截断时整份路径列表才完整，此时的总数才可证明；否则一律省略，不得由分页推断。
        ...(result.truncated ? {} : { total: files.length }),
      };
    },
    serializeOutput(output) { return output; },
  };
}
