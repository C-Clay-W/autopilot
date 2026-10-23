/**
 * PolicyEngine：工具执行前唯一的强制策略入口，合并硬门禁、Skill、审批、grant、Trust 与权限模式。
 */
import { isTaskFileSetDeclarationConstraint } from "../../runtime/domain/approval";
import { SANDBOX_ERROR_CODES } from "../../runtime/domain/sandbox-policy";
import { isWorkspaceCommandConstraint } from "./permissions/command-policy";
import { TOOL_ERROR_CODES } from "./tool-error";
import type { ToolActionFacts, ToolApprovalDecision, ToolExecutionContext, ToolMetadata, ToolPolicyResult } from "./types";

/** PolicyEngine 的输入只接受 Runtime 注入的上下文、Registry metadata 与工具本地生成的事实。 */
export interface PolicyEvaluationInput {
  context: ToolExecutionContext;
  metadata: ToolMetadata;
  facts: ToolActionFacts;
  grantMatched: boolean;
  /**
   * 受沙箱约束的进程类调用（Stage 3 起由 ToolExecutor 对 run_command/Job/MCP 注入）才提供；
   * available=false 时无论审批模式、grant 或只读事实都 fail-closed（G3/G7）。
   * 未注入表示该调用不经过沙箱判定，行为与本字段引入前完全一致。
   */
  sandbox?: { available: boolean };
  /**
   * Talk-Plan1022 S1：Windows 宿主执行事实——受信宿主已停用进程沙箱，进程调用经用户
   * 逐次审批后在宿主直接执行（无 OS 隔离）。由 ToolExecutor 探测到宿主执行 port 后注入；
   * 任何 grant、full_access、auto_approve 或 Trust 自动放行都不代替此次确认，
   * 仅 hard deny、Skill 白名单与显式外部 deny 仍然先于本分支拒绝。
   */
  hostExecution?: boolean;
}

/** 唯一策略决策器；顺序固定为 hard deny、Skill、操作审批、grant、Trust/模式自动放行、请求审批。 */
export class PolicyEngine {
  /**
   * 判断持久授权是否可参与本次决策。
   * ask 模式 run_command 曾一刀切禁止持久授权；现在允许"记住此命令"，
   * 但仅接受绑定 canonical 工作目录、平台、平台解析后的程序身份与完整 argv 的精确约束
   * （当前 cmd:v2；cmd:v1 已停止签发，只做历史类型识别）；
   * 旧 program: 宽约束一律不命中（同程序不同参数、不同 cwd 必须重新判断）。
   */
  canUsePersistentGrant(context: ToolExecutionContext, facts: ToolActionFacts): boolean {
    if (facts.requiresApproval !== true || facts.toolName === "stop_background_job") return false;
    // 集合声明（工作区与外部）必须逐次审批：旧集合 grant 不能静默放行后续的新清单声明（增量要用户明确确认）。
    if (isTaskFileSetDeclarationConstraint(facts.stableConstraint)) return false;
    if (context.permissionMode === "ask" && facts.toolName === "run_command") return isWorkspaceCommandConstraint(facts.stableConstraint);
    return true;
  }

  /** 对一个已校验的工具调用作出唯一执行决定。 */
  evaluate(input: PolicyEvaluationInput): ToolPolicyResult {
    // —— Talk-Plan0927 `--codex` unrestricted 旁路唯一插入点（预留，未实现）——
    // 既有冻结约定（Talk-Plan0917 组合矩阵）：进程级 unrestricted 仅旁路审批层
    // （hard deny/Skill/审批/grant/模式全放行），插入位置在 hard deny 判定之前；
    // 不得隐式获得 danger-full-access，不得关闭 OS 沙箱与执行层 cwd/文件路径边界。
    // 落地前必须双 Plan 联合评审，并保持双方零回归门禁。
    const { context, facts, grantMatched, metadata } = input;
    const risk = facts.risk ?? (facts.effect === "none" ? "read_only" : facts.effect === "workspace" ? "workspace_mutating" : "external_side_effect");
    const base = {
      risk,
      constraint: facts.stableConstraint,
      preview: facts.approval?.preview,
    };
    if ((metadata.effect === "none" && facts.effect !== "none") || (metadata.destructive && !facts.destructive)) {
      return { decision: "deny", reason: "工具本地 ActionFacts 与 Registry metadata 的安全边界不一致", ...base };
    }
    if (facts.hardDenyReason) return { decision: "deny", reason: facts.hardDenyReason, ...base };
    // 备注：Skill 白名单不放在 ToolExecutor 单独判断，而是并入唯一的策略入口，使所有拒绝理由共用同一条 deny 通路（同一事件、错误码与 display），
    // 避免在 Executor 里散出第二种拒绝机制；Kernel 已按 Skill 收窄模型可见工具，这里是执行期的二次强制，防止绕过定义列表直接发起调用。
    // 本判定排在 hardDenyReason 之后、grant/full_access 之前，因此 Skill 白名单是比 full_access 更硬的边界，full_access 也不能执行未授权工具。
    if (context.allowedTools && !context.allowedTools.includes(facts.toolName)) {
      return { decision: "deny", reason: `当前激活 Skill 不允许使用工具 ${facts.toolName}`, ...base };
    }
    // 沙箱 fail-closed：先于只读放行、grant、full_access 与 auto_approve —— 任何审批
    // 范围、持久授权或只读事实都不能补齐缺失的沙箱边界（组合矩阵 C6：unavailable × 任意
    // permissionMode 一律 SANDBOX_UNAVAILABLE，目标命令不启动，无审批兜底）。
    if (input.sandbox && input.sandbox.available !== true) {
      return { decision: "deny", reason: "沙箱不可用，无法提供已隔离执行，操作被拒绝", errorCode: SANDBOX_ERROR_CODES.UNAVAILABLE, ...base };
    }
    // Talk-Plan1022 S1：显式外部 deny 从 externalMutation gate 提前为统一前置判定——宿主执行
    // 确认与只读自动放行都不得越过它；非宿主模式行为不变（该分支原判定结果一致）。
    if (facts.externalMutation === true && facts.externalRestriction === "deny") {
      return { decision: "deny", reason: "该工作区外文件修改已被显式规则拒绝", errorCode: TOOL_ERROR_CODES.COMMAND_FORBIDDEN, ...base };
    }
    // Talk-Plan1022 S1：Windows 宿主执行逐次确认，先于只读自动放行、grant、full_access、
    // auto_approve 与 Trust；allowedDecisions 收窄为单次允许/拒绝。审批卡按工具说明
    // 无隔离事实（run_command 批准后真实执行；start_background_job 通道未接通，批准不启动）。
    if (input.hostExecution === true) {
      return {
        decision: "approval_required",
        reason: facts.toolName === "start_background_job"
          ? "Windows 宿主执行：后台命令将在当前用户权限下直接运行，未启用沙箱隔离，需要逐次确认"
          : "Windows 宿主执行：命令将在当前用户权限下直接运行，未启用沙箱隔离，需要逐次确认",
        ...base,
        allowedApprovalDecisions: ["allow_once", "deny"],
      };
    }
    if (!facts.requiresApproval) return { decision: "allow", reason: facts.approval?.reason ?? "本地策略确认该操作为只读", ...base };
    // Talk-Plan1013 Stage5 R5：外部读取 ask 逐次询问——先于 grant 与任何权限模式分支，
    // allowedDecisions 收窄为单次允许/拒绝，不写任何持久规则，full_access 也不能跳过。
    if (facts.externalRestriction === "ask") {
      return {
        decision: "approval_required",
        reason: facts.approval?.reason ?? "该外部目标的读取需要逐次确认",
        ...base,
        allowedApprovalDecisions: ["allow_once", "deny"],
      };
    }
    // Talk-Plan1013 Stage 1：全模式外部修改 gate（Plan 16.3）。externalMutation 由文件工具的本地
    // ActionFacts 依据 canonical 目标判定，任何权限模式（full_access/auto_approve/可信宽模式）都
    // 不能越过它：只有 Runtime 校验过的精确外部持久授权或本次冻结审批可以放行，mode 本身不构成授权。
    // Stage5 R5：deny 为硬拒绝（先于 grant 与模式放行）；ask 已在上方收窄为逐次询问（即便有 grant）；
    // grant boolean 不再兼任 deny，三态判定来自共享权限事实入口。
    if (facts.externalMutation === true) {
      if (!grantMatched) {
        return {
          decision: "approval_required",
          reason: facts.approval?.reason ?? "工作区外文件修改需要明确用户授权",
          ...base,
          allowedApprovalDecisions: ["allow_once", "allow_session", "allow_workspace", "deny"],
        };
      }
    }
    if (grantMatched) return { decision: "allow", reason: "命中 Runtime 持久授权", ...base };
    if (context.permissionMode === "full_access") return { decision: "allow", reason: "full_access 已授予本次非硬拒绝操作", ...base };
    if (context.permissionMode === "auto_approve" && this.allowsAutoApprove(risk, context.workspaceTrusted === true)) {
      return { decision: "allow", reason: "auto_approve 与工作区信任允许本次操作", ...base };
    }
    // G4（Talk-Plan0917 Stage 3）：仅当调用已确认可在沙箱内隔离执行时（sandbox facts 由
    // ToolExecutor 对进程类调用注入），auto_approve + Trust 才对外部副作用/未知风险自动放行；
    // 裸跑下这些风险从不自动放行，不可安全包装时仍走审批或 fail-closed。
    if (input.sandbox?.available === true && context.permissionMode === "auto_approve" && context.workspaceTrusted === true) {
      return { decision: "allow", reason: "auto_approve：本次调用已确认在沙箱内隔离执行，自动放行", ...base };
    }
    return {
      decision: "approval_required",
      reason: facts.approval?.reason ?? "本次操作需要用户审批",
      ...base,
      // ask 模式普通命令提供"记住此命令"（工作区级精确授权，不含 allow_session）；
      // 任务文件集合审批（工作区与外部）只提供一次性批准/拒绝（集合授权为 Turn 级，由 submit 分支保存）；
      // stop_background_job 与非精确约束的 ask 命令仍保持仅单次/拒绝。
      allowedApprovalDecisions: facts.toolName === "stop_background_job" || isTaskFileSetDeclarationConstraint(facts.stableConstraint)
        ? ["allow_once", "deny"]
        : facts.toolName === "run_command" && context.permissionMode === "ask"
          ? isWorkspaceCommandConstraint(facts.stableConstraint)
            ? ["allow_once", "allow_workspace", "deny"]
            : ["allow_once", "deny"]
          : ["allow_once", "allow_session", "allow_workspace", "deny"],
    };
  }

  /** 仅保留 Stage 1/4 已冻结的 auto_approve 风险矩阵。 */
  private allowsAutoApprove(risk: ToolPolicyResult["risk"], workspaceTrusted: boolean): boolean {
    return risk === "read_only" || ((risk === "write" || risk === "workspace_mutating") && workspaceTrusted);
  }
}
