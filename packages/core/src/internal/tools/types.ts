/**
 * P4 工具层的共享协议：统一描述工具定义、权限结果、执行终态与审计事件。
 */
import type { ZodType } from "zod";
import type { VisionAnalyzer } from "../../runtime/provider/vision-analyzer";
import type { FileMutationStore, SandboxPort } from "../../runtime/ports";
import type { SandboxMode, SandboxPolicy } from "../../runtime/domain/sandbox-policy";
import type { UserQuestionRequest } from "../../runtime/domain";
import type { ExternalExecutionAuthorization, ExternalExecutionTarget } from "../../runtime/domain/external-execution";

/** Runtime 绑定真实 ApprovalService 的私有桥接；工具输入不接受该端口。 */
export interface ExternalExecutionAuthority {
  freeze(input: { approval: ToolApprovalRequest; input: unknown }): Promise<void>;
  authorize(input: { toolName: string; input: unknown; callId: string; inputHash: string; constraint: string; approval?: { approvalId: string; decision: ToolApprovalDecision } }): Promise<ExternalExecutionAuthorization | null>;
}

/** Kernel 注入的冻结沙箱绑定：平台 Port + 宿主冻结的 policy 输入；由 ToolExecutor 解析为执行范围。 */
export interface SandboxExecutionBinding {
  port: SandboxPort;
  /** 来自 FrozenRunConfig 的宿主冻结模式；旧记录缺省时按 fail-safe 范式取 read-only。 */
  mode: SandboxMode;
  /** 宿主显式验证的受控临时目录；缺省不继承环境 TEMP/TMP。 */
  tempRoot?: string;
}

/** ToolExecutor 解析 capability 后传给进程类工具的执行范围；缺失即无法提供已隔离执行。 */
export interface SandboxExecutionScope {
  port: SandboxPort;
  policy: SandboxPolicy;
}

export type ToolPermissionDecision = "allow" | "approval_required" | "deny";
export type ToolApprovalDecision = "allow_once" | "allow_session" | "allow_workspace" | "deny";
export type ToolPermissionMode = "ask" | "auto_approve" | "full_access";
/** 工具静态声明的最保守副作用范围；dynamic 表示必须由运行时输入重新判定。 */
export type ToolEffect = "none" | "workspace" | "external" | "dynamic";
/** 命令副作用分级；只允许策略已知的低风险类别进入自动审批。 */
export type CommandRisk = "read_only" | "workspace_mutating" | "external_side_effect" | "unknown" | "destructive";
/** 工具审批风险；保留既有写入/命令值，命令工具使用 CommandRisk。 */
export type ToolRisk = "write" | "command" | CommandRisk;
export type ToolSideEffectState = "not_started" | "completed" | "unknown";

export interface ToolError {
  code: string;
  message: string;
}

export interface ToolInterruptionState {
  phase: "before_execution" | "executing" | "after_execution";
  normalizedInputHash: string;
  sideEffectState: ToolSideEffectState;
  safeToRetry: boolean;
  reason: string;
}

export interface ToolExecutionMeta {
  durationMs: number;
  inputHash: string;
  outputBytes?: number;
  truncated?: boolean;
  exitCode?: number | null;
}

/**
 * 工具专用展示明细：由 Core 从成功结果的受控 serialized output 生成的可判别只读事实。
 *
 * 三层有界语义必须分开理解，任何一层都不得把不完整结果伪装成完整结果：
 * 1. `executionTruncated` 表示工具执行阶段已丢弃结果（ripgrep 输出上限或工具输出预算）；正常分页仍保留可证明的 `total*`，不算执行截断；
 * 2. `displayTruncated` 仅在 Core display 预算裁剪本明细时出现，不能与工具执行截断混淆；
 * 3. `shown*` 是本明细实际携带的条目数；Web 的局部折叠只作用于这些已存在的条目，不属于本类型的语义。
 *
 * `total*` 只在 Core 能证明完整总数时出现，禁止由 `shown*`、数组长度或 `executionTruncated` 推断。
 * 本类型只承载元数据：不含文件正文、匹配文本、内容哈希或绝对路径。
 */
export type ToolDisplayDetail =
  | {
      kind: "read_file";
      /** 工作区相对路径，已统一为正斜杠。 */
      path: string;
      startLine: number;
      /** 实际读到的末行；未读到任何行时为 null，不生成 endLine < startLine 的误导范围。 */
      endLine: number | null;
      totalLines: number;
      returnedLines: number;
      /** 本次读取未覆盖到文件末尾；不等同于失败。 */
      truncated: boolean;
    }
  | {
      kind: "glob_files";
      paths: string[];
      shownCount: number;
      totalCount?: number;
      executionTruncated: boolean;
      /** Core display 预算已裁剪路径；缺席代表未裁剪或旧 transcript。 */
      displayTruncated?: true;
    }
  | {
      kind: "grep_content";
      /** 按相对路径分组的命中行；context 行不计为命中，也不携带任何匹配文本。 */
      files: Array<{
        path: string;
        /** 命中行数，恒等于 lineNumbers.length；与 count 模式的 submatch 次数不是同一语义。 */
        matchedLineCount: number;
        /** 升序且已去重的命中行号；同一行多次命中只计一次。 */
        lineNumbers: number[];
      }>;
      shownMatchedLineCount: number;
      totalMatchedLineCount?: number;
      executionTruncated: boolean;
      /** Core display 预算已裁剪文件组或单文件行号；缺席代表未裁剪或旧 transcript。 */
      displayTruncated?: true;
    }
  | {
      kind: "grep_paths";
      paths: string[];
      shownCount: number;
      totalCount?: number;
      executionTruncated: boolean;
      /** Core display 预算已裁剪路径；缺席代表未裁剪或旧 transcript。 */
      displayTruncated?: true;
    }
  | {
      kind: "grep_counts";
      /** count 模式的每文件 submatch 次数；与 grep_content 的 matchedLineCount 不是同一语义。 */
      files: Array<{ path: string; count: number }>;
      shownFileCount: number;
      totalFileCount?: number;
      executionTruncated: boolean;
      /** Core display 预算已裁剪文件计数条目；缺席代表未裁剪或旧 transcript。 */
      displayTruncated?: true;
    }
  | {
      kind: "web_search";
      /** 经过 Core 归一化并实际返回给 Agent 的公开来源数量。 */
      sourceCount: number;
      /** Provider 或 Core 输出预算是否裁剪了结果。 */
      truncated: boolean;
    }
  | {
      kind: "web_fetch";
      /** 最终 URL 的小写域名；不包含路径、query、fragment 或 userinfo。 */
      host: string;
      /** 经 Core 裁剪的响应内容类型，不包含正文。 */
      contentType: string;
      /** Adapter 或 Core 是否裁剪了响应。 */
      truncated: boolean;
    };

/** 后台 Job 工具的安全展示事实；programLabel 仅为脱敏 executable basename，不包含参数、路径、PID、owner 或输出正文。 */
export interface ToolJobDisplayFacts {
  action: "start" | "list" | "read" | "stop";
  jobId?: string;
  programLabel?: string;
  observedStatus?: import("../../runtime/domain").JobStatus;
  observedCount?: number;
  hasMore?: boolean;
  waitOutcome?: import("../../runtime/domain").JobReadView["waitOutcome"];
}

/** 供 Presentation 消费的安全工具展示事实；不包含原始 input、output 或 Provider 输出。 */
export interface ToolDisplayFacts {
  titleKey: string;
  target?: string;
  summary?: string;
  metrics?: Record<string, string | number | boolean>;
  /** 工具专用明细；只有已实现 projector 的成功结果才会携带，旧事件缺失时按通用事实回退。 */
  detail?: ToolDisplayDetail;
  /** 后台 Job 的专用引用事实；只由 ToolExecutor 从受控工具结果生成。 */
  job?: ToolJobDisplayFacts;
  diff?: {
    text?: string;
    files?: number;
    added?: number;
    removed?: number;
    truncated?: boolean;
  };
  /** 进程类工具的实际执行方式：sandboxed=OS 沙箱内、unisolated=宿主直接执行（danger-full-access）、unavailable=沙箱不可用未启动；展示层不得把 unisolated/unavailable 宣称隔离。 */
  executionMode?: "sandboxed" | "unisolated" | "unavailable";
  /** 沙箱不可用类拒绝的结构化脱敏诊断；由 ToolExecutor 从本地 status 探测生成，Web/CLI 各出口共用。 */
  diagnostics?: string[];
}

/** 供审批 UI 消费的冻结安全视图；决定范围只能由 PolicyEngine 生成。 */
export interface ApprovalDisplayFacts {
  operation: string;
  effect: "none" | "workspace" | "external";
  destructive: boolean;
  resource?: string;
  risk?: string;
  actionPreview?: string;
  /** 命令审批的可识别工作目录：本地 facts 提供 canonical 目录（未绑定 workspaceRoot 时为输入原文），用户据此审查实际执行位置。 */
  cwd?: string;
  /** 命令声明外部效果但未声明精确目标（如解释器 -e 脚本）：修改范围无法精确限定，展示层据此给出未知范围提示，不得宣称"仅覆盖精确目标"。 */
  unknownScope?: boolean;
  allowedDecisions: ToolApprovalDecision[];
}

export interface ToolApprovalRequest {
  approvalId: string;
  callId: string;
  toolName: string;
  normalizedInputHash: string;
  /** 持久授权使用的稳定约束；旧 checkpoint 可能没有该字段。 */
  constraint?: string;
  reason: string;
  risk: ToolRisk;
  preview: Record<string, unknown>;
  expiresAt: string;
  /** PolicyEngine 在生成审批时冻结的可提交范围。 */
  allowedDecisions?: ToolApprovalDecision[];
  /** 任务文件集合审批：冻结的文件与操作清单；批准后由 ApprovalService 保存为 Turn 级集合授权。 */
  taskFileSet?: import("../../runtime/domain/approval").TaskFileTarget[];
  /** 新建审批附带的安全展示事实；旧 checkpoint 可能尚未包含该字段。 */
  display?: ApprovalDisplayFacts;
}

export interface ToolExecutionRequest {
  callId: string;
  toolName: string;
  input: unknown;
  approval?: {
    approvalId: string;
    decision: ToolApprovalDecision;
  };
}

export type ToolExecutionResult =
  | { status: "success"; callId: string; toolName: string; output: unknown; meta: ToolExecutionMeta; display?: ToolDisplayFacts }
  | { status: "question_required"; callId: string; toolName: string; request: UserQuestionRequest; meta: ToolExecutionMeta; display?: ToolDisplayFacts }
  | { status: "approval_required"; callId: string; toolName: string; approval: ToolApprovalRequest; display?: ToolDisplayFacts }
  | { status: "denied"; callId: string; toolName: string; error: ToolError; display?: ToolDisplayFacts }
  | { status: "error"; callId: string; toolName: string; error: ToolError; meta?: ToolExecutionMeta; display?: ToolDisplayFacts }
  | { status: "cancelled" | "timeout"; callId: string; toolName: string; error: ToolError; meta: ToolExecutionMeta; interruption: ToolInterruptionState; display?: ToolDisplayFacts };

export interface ToolPermissionResult {
  decision: ToolPermissionDecision;
  reason: string;
  risk?: ToolRisk;
  /** allow_session/allow_workspace 的稳定匹配键，不绑定本次完整工具输入。 */
  constraint?: string;
  preview?: Record<string, unknown>;
}

/** Schema 校验后由本地工具代码生成的执行事实；模型、metadata 与 MCP 描述均不能直接提供这些字段。 */
export interface ToolActionFacts {
  toolName: string;
  effect: Exclude<ToolEffect, "dynamic">;
  destructive: boolean;
  operation: string;
  resource?: string;
  risk?: CommandRisk;
  /** 本地 Runtime 已确定的进程隔离事实，用于审批展示，不由模型或 MCP schema 提供。 */
  executionIsolation?: "sandboxed" | "unisolated";
  stableConstraint?: string;
  /** 已完成的本地硬门禁拒绝原因，例如破坏性命令。 */
  hardDenyReason?: string;
  /** 本次操作本身必须先获得批准，例如写入或外部调用。 */
  requiresApproval?: boolean;
  /** Stage 1（Talk-Plan1013）：目标在 canonical workspace 外且为修改操作；任何权限模式都不得自动放行，只能由精确授权或逐次审批放行。 */
  externalMutation?: boolean;
  /** 外部目标的 canonical 身份；执行层复查与授权约束绑定此身份，不由模型输入提供。 */
  externalTarget?: { canonicalTarget: string; canonicalWorkspace: string };
  /** Stage5 R5（Talk-Plan1013）：外部目标当前限制判定；deny=硬拒绝，ask=逐次询问，allow=放行；由共享入口在 facts 阶段解析。 */
  externalRestriction?: "allow" | "ask" | "deny";
  /** 私有精确命令写目标；生成公开 display 时仅使用安全标签。 */
  externalExecutionTarget?: ExternalExecutionTarget;
  /** 仅由本地代码生成的脱敏审批卡内容。 */
  approval?: { reason: string; preview?: Record<string, unknown> };
  /** 任务文件集合审批：本地 facts 冻结的声明清单，随审批请求一起持久化。 */
  taskFileSet?: import("../../runtime/domain/approval").TaskFileTarget[];
  /** 命令审批的可识别工作目录：优先 canonical 目录，本地代码冻结，不由模型额外声明。 */
  commandCwd?: string;
}

/** PolicyEngine 的唯一决策结果；审批范围随冻结审批一起持久化，ApprovalService 不再重算策略。 */
export interface ToolPolicyResult {
  decision: ToolPermissionDecision;
  reason: string;
  risk?: ToolRisk;
  constraint?: string;
  preview?: Record<string, unknown>;
  allowedApprovalDecisions?: ToolApprovalDecision[];
  /** deny 终态的稳定错误码（如 SANDBOX_*）；缺席时由 ToolExecutor 使用既有兜底码。 */
  errorCode?: string;
}

export interface ToolEvent {
  type: "tool_validation_failed" | "tool_approval_required" | "tool_denied" | "tool_start" | "tool_result" | "tool_error" | "tool_cancelled" | "tool_auto_approved";
  callId: string;
  toolName: string;
  timestamp: string;
  inputHash?: string;
  durationMs?: number;
  status?: ToolExecutionResult["status"];
  outputBytes?: number;
  truncated?: boolean;
  exitCode?: number | null;
  errorCode?: string;
}

export interface ToolExecutionContext {
  /** 仅RuntimePorts/Native宿主注入，不接受任何工具参数或持久配置覆盖。 */
  hostMutationProtection?: import("../../runtime/ports/host-mutation-protection").HostMutationProtection;
  /** Runtime私有Session归属，用于外部能力认领，不接受工具参数。 */
  executionSessionId?: string;
  externalExecutionAuthority?: ExternalExecutionAuthority;
  /** 仅由 ToolExecutor 在宿主可信配置 danger-full-access 的单次直执（或未来复用降级审批的消费边界）注入；绕过 ToolExecutor 的调用没有该标志，工具保持 fail-closed。 */
  sandboxExecutionOverride?: "direct";
  /** Session 派生的产品上限，与 Skill 和审批权限无关。 */
  capabilityCeiling?: import("../../runtime/domain/product-mode").CapabilityCeiling;
  workspaceRoot?: string;
  permissionMode: ToolPermissionMode;
  /** 宿主在 Runtime bootstrap 后注入；未显式可信时不得自动执行工作区变更命令。 */
  workspaceTrusted?: boolean;
  signal?: AbortSignal;
  /** ToolExecutor 在实际调用时注入，mutation WAL 不接受模型伪造的 call ID。 */
  toolCallId?: string;
  /** 仅由 Fetch 重定向的进程内绑定注入，模型输入不能重置跳数。 */
  webFetchRedirectsRemaining?: number;
  /** Runtime 已绑定的私有 mutation store；缺失时兼容旧的非 durable Agent API。 */
  fileMutations?: { store: FileMutationStore; sessionId: string; turnId: string };
  onToolEvent?: (event: ToolEvent) => void;
  /** 工具执行期间的节流进度上报；由 ToolExecutor 从 ExecutionOptions.onProgress 注入。 */
  onToolProgress?: (chunk: string) => void;
  /** @deprecated 仅保留旧扩展的类型兼容；Core 不再注入，内置工具不读取。 */
  agentFlow?: {
    search(query: string, topK?: number, tableName?: string): Promise<unknown[]>;
    searchAcrossTables?(query: string, topK?: number, tableName?: string): Promise<unknown>;
    prepareRagSearch?(query: string, topK?: number, tableName?: string, focusedPdfFileName?: string, focusedResourceId?: string, signal?: AbortSignal): Promise<unknown>;
    readVisualEvidence?(visualEvidenceRef: string, signal?: AbortSignal): Promise<{ dataUrl: string; mimeType: string }>;
  };
  /** 当前 Runtime 中 read_file 的可信快照，供 edit_file 做 stale read 校验。 */
  fileReadStates?: Map<string, { sha256: string; mtimeMs: number;
    /** 模型已观察的行范围；edit_file 只允许修改已观察区间内的内容 */
    observedRanges: Array<{ startLine: number; endLine: number }>;
  }>;
  /** @deprecated 旧 RAG 聚焦字段；Core 不再注入或读取。 */
  focusedPdfFileName?: string;
  /** @deprecated 旧 RAG 聚焦字段；Core 不再注入或读取。 */
  focusedResourceId?: string;
  /** Session Runtime 注入的已持久化授权命中；Core 不直接读写 session 文件。 */
  resolvePersistentGrant?: (request: { toolName: string; inputHash: string; input: unknown; constraint?: string; risk?: ToolRisk }) => Promise<boolean>;
  /** Session Runtime 注入的冻结审批校验；用于跨请求恢复。 */
  validateApproval?: (request: { approvalId: string; decision: ToolApprovalDecision; callId: string; toolName: string; inputHash: string; constraint?: string }) => Promise<boolean>;
  /** Talk-Plan1013 Stage5 R5：Session Runtime 注入的当前外部限制判定；唯一来源为 ApprovalService + projector 快照。 */
  resolveExternalRestriction?: (request: { workspaceRoot: string; toolName: string; constraint: string }) => Promise<"allow" | "ask" | "deny">;
  /**
   * Talk-Plan1013 Stage5 R3：文件修改授权绑定；仅由 ToolExecutor 在本次执行已过外部修改 gate
   * （审批已消费或 grant 命中）时从 facts 注入，工具输入与模型不可构造。write_file/edit_file
   * 在目标锁内比较当前 canonical 目标与操作和本绑定，失配即停止。
   */
  fileMutationAuthorization?: {
    canonicalTarget: string;
    canonicalWorkspace: string;
    operation: string;
    constraint: string;
  };
  /** Turn 应用层按已冻结视觉路由注入；缺省时视觉工具不会注册。 */
  visionAnalyzer?: VisionAnalyzer;
  /** 当前已激活 Skill 的能力交集；未设置表示没有 Skill 额外收窄。 */
  allowedTools?: string[];
  /** 当前 Turn 冻结的沙箱绑定（Talk-Plan0917 Stage 3）；由 Kernel 注入，run_command 的策略判定与执行隔离经此完成。 */
  sandbox?: SandboxExecutionBinding;
  /** ToolExecutor 解析沙箱能力后的执行范围；仅在已确认可沙箱执行时注入给进程类工具。 */
  sandboxPolicy?: SandboxExecutionScope;
}

/** 工具调度元数据；只声明并发、重试和超时边界，绝不作为权限放行凭证。 */
export interface ToolMetadata {
  effect: ToolEffect;
  destructive: boolean;
  concurrency: {
    max: number;
    resourceKey?: string | ((input: unknown) => string);
  };
  retry: {
    safe: boolean;
    maxRetries?: number;
  };
  timeout?: {
    defaultMs?: number;
    maxMs?: number;
  };
}

export interface AgentToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  metadata: ToolMetadata;
  /** 可选的引用授权校验；必须在执行事件和 handler 之前完成。 */
  validateInput?(input: TInput, context: ToolExecutionContext): Promise<void>;
  /** 当前授权状态决定目录可见性；不能仅靠此钩子替代执行校验。 */
  isAvailable?(): boolean;
  /** 在 Schema 校验后生成可信 ActionFacts；不得信任模型输入中的风险字段。 */
  createActionFacts(input: TInput, context: ToolExecutionContext): ToolActionFacts | Promise<ToolActionFacts>;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
  serializeOutput(output: TOutput): unknown;
  /** 交互型工具可将可信执行结果转换为非 success 终态；普通工具不实现该钩子。 */
  createExecutionResult?(input: TInput, output: TOutput, context: {
    callId: string;
    toolName: string;
    inputHash: string;
    meta: ToolExecutionMeta;
  }): ToolExecutionResult;
}

export interface ToolModelDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolExecutionOptions {
  signal?: AbortSignal;
  /** Scheduler 已按工具 metadata 解析的单次执行超时；不覆盖 Runtime 的 AbortSignal。 */
  timeoutMs?: number;
  /** 工具执行期间的节流进度回调；仅长时工具（如 run_command）实现节流上报。 */
  onProgress?: (callId: string, chunk: string) => void;
}
