/**
 * internal/tools/permissions/mutation-policy.ts — 文件工具的 mutation 名义层沙箱检查（Talk-Plan0917 Stage 5）
 *
 * write_file/edit_file 按已确认的选项 A 直接修改真实工作区，不进入 OS 进程沙箱，也不伪装成
 * 子进程隔离；本模块把 Turn 冻结的 sandboxMode（ToolExecutionContext.sandbox.mode，Kernel 自
 * FrozenRunConfig 注入，旧记录缺省 fail-safe read-only）接入文件工具判定链：read-only 一律
 * FS_SANDBOX_DENIED；workspace-write 与 danger-full-access 均维持既有工作区围栏（锁内
 * canonicalize-then-contain、审批、WAL、Undo 不回退），danger-full-access 不放宽工具 schema。
 * 缺沙箱绑定的旧上下文不虚构 read-only，沿用既有围栏；tempRoot 只属于进程沙箱策略，
 * 不构成文件工具的写白名单旁路。
 */
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { ToolExecutionContext } from "../types";
import path from "node:path";
import { resolveFileTarget } from "./path-access-policy";
import type { ResolvedFileTarget } from "./path-access-policy";
import type { HostMutationProtection } from "../../../runtime/ports/host-mutation-protection";
import { normalizeComparablePath } from "../../../runtime/domain/external-permissions";

/** 精确文件/目录比较共享一条规则；Windows忽略大小写，父路径替换也不能覆盖保护域。 */
function protectedPathsOverlap(target: string, protectedPath: string, scope: "file" | "directory"): boolean {
  const pathApi = /^[a-z]:[\\/]/iu.test(target) || /^[a-z]:[\\/]/iu.test(protectedPath) ? path.win32 : path.posix;
  /** 规范分隔符、盘符与大小写，避免root-evil裸前缀和Windows别名。 */
  function normalize(value: string): string {
    const normalized = pathApi.resolve(value);
    return pathApi === path.win32 ? normalized.toLowerCase() : normalized;
  }
  const candidate = normalize(target);
  const authority = normalize(protectedPath);
  /** 逐级目录边界比较，不用裸字符串startsWith来扩大或漏判路径。 */
  function contained(root: string, child: string): boolean {
    const relative = pathApi.relative(root, child);
    return relative === "" || (!pathApi.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`));
  }
  return candidate === authority || contained(candidate, authority) || (scope === "directory" && contained(authority, candidate));
}

/** 对原请求绝对身份和realpath/最近存在祖先身份复查受信保护域，失败只给安全错误。 */
export async function assertHostMutationTargetAllowed(context: { workspaceRoot?: string; hostMutationProtection?: HostMutationProtection }, inputPath: string): Promise<void> {
  const protection = context.hostMutationProtection;
  if (!protection) return;
  const target = await resolveFileTarget(context.workspaceRoot, inputPath);
  try {
    const rules = await protection.getProtectedTargets(target.canonicalWorkspace);
    for (const rule of rules) {
      if (!rule.path || !path.isAbsolute(rule.path) || (rule.scope !== "file" && rule.scope !== "directory")) throw new Error("保护域无效");
      const authority = await resolveFileTarget(target.canonicalWorkspace, rule.path);
      for (const candidate of [target.absolutePath, target.canonicalTarget]) {
        if ([authority.absolutePath, authority.canonicalTarget].some(function overlaps(protectedPath) { return protectedPathsOverlap(candidate, protectedPath, rule.scope); })) throw new Error("保护域命中");
      }
    }
  } catch {
    throw createToolError(TOOL_ERROR_CODES.FS_SANDBOX_DENIED, "宿主授权状态或权限配置受到保护，文件修改被拒绝");
  }
}

/** 在执行锁内、真实 mutation 前检查 Turn 冻结的沙箱模式；read-only 拒绝且不产生任何磁盘变化。 */
export function assertFileMutationAllowed(context: ToolExecutionContext): void {
  if (context.sandbox?.mode === "read-only") {
    throw createToolError(TOOL_ERROR_CODES.FS_SANDBOX_DENIED, "当前 Turn 冻结的沙箱模式为 read-only，文件修改被拒绝");
  }
}

/**
 * Talk-Plan1013 Stage5 R3：执行层复查——目标锁内比较当前 canonical 目标/操作与 ToolExecutor
 * 注入的批准绑定（唯一审批链产生，模型与工具输入不可构造）。等待目标锁期间父链接被替换到
 * 其他目录、或工作区内目标在 facts 后改指外部时，当前 canonical 身份与绑定失配即停止，
 * 零磁盘变化；策略 allow 不豁免本复查（Plan 7.4/16.3）。错误码取 APPROVAL_MISMATCH：语义是
 * 授权绑定不覆盖当前调用（与 consumeApproval 约束失配同类），而非可重试的文件 stale。
 */
export function assertFileMutationAuthorized(
  context: Pick<ToolExecutionContext, "fileMutationAuthorization">,
  target: Pick<ResolvedFileTarget, "isExternal" | "canonicalTarget" | "canonicalWorkspace">,
  operation: string,
): void {
  const binding = context.fileMutationAuthorization;
  if (!binding) {
    // 无绑定：facts 阶段为工作区内目标；锁内解析为外部即未授权转移，拒绝。
    if (target.isExternal) throw createToolError(TOOL_ERROR_CODES.APPROVAL_MISMATCH, "目标在授权后转移到工作区外，未授权的修改已停止");
    return;
  }
  if (!target.isExternal
    || normalizeComparablePath(target.canonicalTarget) !== normalizeComparablePath(binding.canonicalTarget)
    || normalizeComparablePath(target.canonicalWorkspace) !== normalizeComparablePath(binding.canonicalWorkspace)
    || operation !== binding.operation) {
    throw createToolError(TOOL_ERROR_CODES.APPROVAL_MISMATCH, "文件修改授权目标或操作已改变，本次执行已停止");
  }
}
