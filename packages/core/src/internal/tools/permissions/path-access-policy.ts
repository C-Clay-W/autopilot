/**
 * internal/tools/permissions/path-access-policy.ts — 文件目标预检与外部目标身份（Talk-Plan1013 Stage 1）
 *
 * 本模块是文件工具共享的目标预检入口：在既有 workspace-path 内部围栏之外，允许合法本机
 * 绝对路径与相对解析后的外部目标进入文件工具链。读取/搜索外部目标免新增路径审批（读取例外）；
 * 修改外部目标由工具在 ActionFacts 标记 externalMutation，交由 PolicyEngine 的全模式外部修改
 * gate 与执行层复查强制授权。目标身份以 realpath（或最近存在祖先还原）的 canonical 形式表示，
 * 拒绝裸 `../` 充当持久 authority；决策仍归 PolicyEngine，本模块不产生任何放行。
 */
import path from "node:path";
import { realpath } from "node:fs/promises";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import { isInsideRoot } from "./workspace-path";
import type { ToolExecutionContext } from "../types";

/** 文件工具共享的目标解析结果；修改操作据此标记外部 mutation 与 canonical 身份。 */
export interface ResolvedFileTarget {
  /** realpath 还原前的解析绝对路径；实际读写在此路径上进行。 */
  absolutePath: string;
  /** 发起 workspace 的 canonical 根。 */
  canonicalWorkspace: string;
  /** 目标或最近存在祖先还原后的 canonical 路径；授权与 read state 绑定此身份。 */
  canonicalTarget: string;
  /** canonical 目标是否在 canonical workspace 外。 */
  isExternal: boolean;
  /** 目标当前是否存在。 */
  exists: boolean;
  /** 工作区内相对路径（仅内部目标存在）；统一正斜杠由调用方按需转换。 */
  relativePath?: string;
}

/** 校验目标输入的基本安全形态：空/NUL、UNC 与设备命名空间、ADS 和盘符相对路径一律拒绝。 */
function validateTargetInput(inputPath: string): void {
  if (!inputPath || inputPath.includes("\0")) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "路径不能为空且不能包含 NUL 字符");
  }
  if (/^(\\\\|\/\/)/.test(inputPath)) {
    throw createToolError(TOOL_ERROR_CODES.PATH_OUTSIDE_WORKSPACE, "不支持 UNC 或网络路径目标");
  }
  if (/^(\\\\\?\\|\\\\\.\\)/i.test(inputPath)) {
    throw createToolError(TOOL_ERROR_CODES.PATH_OUTSIDE_WORKSPACE, "不支持设备命名空间路径目标");
  }
  // 盘符之后的第二个冒号即 NTFS 备用数据流（ADS），无法安全约束，直接拒绝。
  if (/^[a-zA-Z]:[\\/]/.test(inputPath)) {
    if (/:/.test(inputPath.slice(2))) {
      throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "路径包含备用数据流（ADS）语法，已拒绝");
    }
    return;
  }
  if (/^[a-zA-Z]:/.test(inputPath)) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "不支持盘符相对路径，请使用工作区相对路径或绝对路径");
  }
}

/** 还原目标 canonical 身份：存在目标用自身 realpath；未存在目标用最近存在祖先 realpath 接回未存在剩余段（Plan 7.2）。 */
async function resolveCanonicalTarget(absolutePath: string): Promise<{ canonicalTarget: string; exists: boolean }> {
  let current = absolutePath;
  for (;;) {
    try {
      const real = await realpath(current);
      return current === absolutePath
        ? { canonicalTarget: real, exists: true }
        : { canonicalTarget: path.join(real, path.relative(current, absolutePath)), exists: false };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/** 解析文件工具目标：工作区内相对路径与合法本机绝对路径均可，返回 canonical 身份与内外判定。 */
export async function resolveFileTarget(workspaceRoot: string | undefined, inputPath: string): Promise<ResolvedFileTarget> {
  if (!workspaceRoot) {
    throw createToolError(TOOL_ERROR_CODES.WORKSPACE_NOT_CONFIGURED, "文件和命令工具需要显式配置 workspaceRoot");
  }
  validateTargetInput(inputPath);
  // workspace 根必须真实存在：沿用既有严格 realpath 语义，不存在时异常交由 toToolError 收敛。
  const canonicalWorkspace = await realpath(path.resolve(workspaceRoot));
  const absolutePath = path.resolve(canonicalWorkspace, inputPath);
  // 未存在目标通过最近存在祖先还原 canonical 身份；链接指向由 realpath 统一判定。
  const resolved = await resolveCanonicalTarget(absolutePath);
  const isExternal = !isInsideRoot(canonicalWorkspace, resolved.canonicalTarget);
  return {
    absolutePath,
    canonicalWorkspace,
    canonicalTarget: resolved.canonicalTarget,
    isExternal,
    exists: resolved.exists,
    ...(isExternal ? {} : { relativePath: path.relative(canonicalWorkspace, resolved.canonicalTarget) || "." }),
  };
}

/** 生成 read state 键：内部目标用工作区相对路径，外部目标用 ext: 前缀的 canonical 身份，避免裸 `../` 充当 authority。 */
export function getReadStateKey(target: Pick<ResolvedFileTarget, "isExternal" | "canonicalTarget" | "relativePath">): string {
  return target.isExternal ? `ext:${target.canonicalTarget}` : target.relativePath ?? ".";
}

/** 构造外部修改的稳定授权约束；grant 与审批绑定同一 canonical 身份。 */
export function buildExternalConstraint(canonicalTarget: string): string {
  return `ext-file:${canonicalTarget}`;
}

/**
 * Talk-Plan1013 Stage5 R5：经 ToolExecutionContext 的唯一共享入口查询外部目标当前限制判定
 * （allow/ask/deny）。规则来源只有 ApprovalService + projector 快照；入口缺失或目标在
 * 工作区内时按 allow 处理，不新建第二套规则读取逻辑。
 */
export async function resolveExternalTargetRestriction(
  context: Pick<ToolExecutionContext, "resolveExternalRestriction">,
  target: ResolvedFileTarget,
  toolName: string,
): Promise<"allow" | "ask" | "deny"> {
  if (!target.isExternal || !context.resolveExternalRestriction) return "allow";
  return context.resolveExternalRestriction({ workspaceRoot: target.canonicalWorkspace, toolName, constraint: buildExternalConstraint(target.canonicalTarget) });
}
