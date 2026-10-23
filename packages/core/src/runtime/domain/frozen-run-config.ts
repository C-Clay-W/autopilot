/**
 * runtime/domain/frozen-run-config.ts — Turn 冻结的运行配置
 *
 * Turn 开始时由 resolveRunConfig(projectDefault, sessionDefault, turnOverride) 计算并冻结。
 * 整个 turn 生命周期不可变；continue 时强制读取此快照，忽略 ContinueTurnInput.runConfig 覆盖。
 * 只保存引用（ModelRef / CredentialRef），不保存真实 Key 或 sampler 实例。
 */

import type { ToolPermissionMode } from "../../internal/tools/types";
import type { ModelRef } from "./model-ref";
import type { ReasoningProfile } from "./reasoning-profile";
import type { CredentialRef } from "./index";
import type { CompactPolicy } from "../protocol/run-config";
import type { DatabaseSearchPolicy, RagSourcePolicy } from "../../internal/database-search";
import type { RerankPolicy } from "../../internal/lib/rerank";
import type { SandboxMode } from "./sandbox-policy";

/**
 * 冻结的运行配置；写入 TurnStore 后整个 turn 生命周期不可变。
 * 所有字段在冻结时已解析为最终值，不再有"缺省"语义。
 */
export interface FrozenRunConfig {
  /** 由 Core 新 Turn 签发的 Work 上下文边界版本；旧记录缺失时仅允许查看历史。 */
  workContextVersion?: 1;
  /** Session 派生的工具上限；旧 Work Turn 可缺省，Chat 缺省必须拒绝恢复。 */
  capabilityCeiling?: import("./product-mode").CapabilityCeiling;
  /** 当前 Turn 的附件引用上限，继续运行不能引入新附件。 */
  chatAttachmentGrants?: readonly import("../protocol/chat-capability").ChatAttachmentGrant[];
  /** 当前 Turn 冻结的 Work 预览能力开关；旧记录缺失按 false，仅受信 Host 计算，override 不可开启。 */
  workPreviewEnabled?: boolean;

  /** 模型引用；冻结时已解析，可能为 undefined（表示使用 Runtime 默认 sampler）。 */
  modelRef?: ModelRef;
  /** 推理强度配置；冻结时已解析。 */
  reasoningProfile?: ReasoningProfile;
  /** 凭据引用；真实 Key 由 CredentialStore 在 executeTurn 内解析，不持久化。 */
  credentialRef?: CredentialRef;
  /** 工具权限模式；冻结时已解析。 */
  permissionMode?: ToolPermissionMode;
  /** 每个执行段的采样/工具循环轮数；未配置表示关闭。 */
  maxSteps?: number;
  /** 单个安全可重试工具调用的最大重试次数；新 Turn 冻结时已由统一限制层解析，旧记录可缺省兼容。 */
  maxToolRetries?: number;
  /** 当前 Turn 的累计运行时长安全上限；continue 时沿用冻结值。 */
  maxDurationMs?: number;
  /** 当前 Turn 的显式累计 Provider token 安全上限；缺省表示关闭。 */
  maxTotalTokens?: number;
  /** 区分新预算语义与旧冻结配置；缺省值表示需要在恢复边界迁移。 */
  safetyBudgetVersion?: 2;
  /** 工作区根目录；冻结时已 canonical 化。 */
  workspaceRoot?: string;
  /** Runtime bootstrap 已确认工作区可信；继续运行时沿用该冻结结论。 */
  workspaceTrusted?: boolean;
  /** 本次 Turn 的上下文压缩策略；continue 时不可被覆盖。 */
  compactPolicy?: CompactPolicy;
  /** 当前 Turn 冻结的数据库工具注册策略；旧 Turn 缺省视为关闭。 */
  databaseSearchPolicy?: DatabaseSearchPolicy;
  /** 当前 Turn 冻结的可信文档来源；continue/replay 不重新解析。 */
  ragSourcePolicy?: RagSourcePolicy;
  /** 当前 Turn 冻结的专用 Rerank 非敏感配置；不保存 API Key。 */
  rerankPolicy?: RerankPolicy;
  /**
   * 当前 Turn 冻结的 OS 沙箱模式（Talk-Plan0917 Stage 1）；与 permissionMode 正交，
   * 仅可信宿主可设置 danger-full-access。旧记录缺省时在恢复边界按 fail-safe 范式
   * 迁移为 read-only（无沙箱历史的记录不可继承宽能力）。
   */
  sandboxMode?: SandboxMode;
  /** 宿主显式验证的受控临时目录；仅 runtimeDefault 可冻结，恢复/Continue 不可变更。 */
  sandboxTempRoot?: string;
  /** 冻结 policy 的安全摘要（mode/workspaceRoot/tempRoot 的 SHA-256）；不保存敏感路径明细。 */
  sandboxPolicyDigest?: string;
  /** 沙箱冻结语义版本；缺省表示需要在恢复边界迁移。 */
  sandboxPolicyVersion?: 1;
  /**
   * Talk-Plan1022 R2：本次 Turn 的有效进程执行方式。新 Turn 由受信宿主的 SandboxPort
   * 静态声明冻结，整个 Turn 生命周期不可变；恢复时必须与当前 Port 一致，否则拒绝继续
   * （旧沙箱 Turn/checkpoint 不得静默转成宿主执行）。缺省表示升级前的沙箱时代记录。
   */
  processExecution?: "sandbox" | "host";
}
