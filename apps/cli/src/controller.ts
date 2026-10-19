/**
 * CLI Controller。
 *
 * Controller 是 Action 到 Core Runtime Public API 的唯一映射层；它不实现
 * Session/Turn 状态机，审批只从当前安全 projection 取得 approvalId，绝不
 * 生成 callId、toolName、normalizedInputHash 或冻结工具输入。
 */

import { randomUUID } from "node:crypto";
import { AgentRuntimeError } from "@autopilot-agent/core";
import type {
  AgentEvent,
  ApprovalDecision,
  ContextUsageView,
  ContinueTurnInput,
  ReasoningEffort,
  StartTurnInput,
} from "@autopilot-agent/core";
import { createCliEventProjector } from "./event-projector.js";
import { formatPlainContextReport } from "./context-report.js";
import type {
  CliAction,
  CliCommand,
  CliEffortOption,
  CliExitCode,
  CliEventListener,
  CliJobView,
  CliQueuedInputStarted,
  CliQueuedInputStartedListener,
  CliModelOption,
  CliPermissionMode,
  CliPermissionOption,
  CliProjection,
  CliRenderer,
  CliRuntimeStatusDefaults,
  CliSkillCatalogLister,
  CliSkillResolver,
  CliSkillSummary,
  CliStatusView,
  CliTurnStatus,
  CliRuntime,
} from "./types.js";

/** 让 Ink 在连续微任务事件之间获得一次绘制机会，避免回答结束后才整段出现。 */
const CLI_RENDER_YIELD_EVERY_ANSWER_EVENTS = 4;

/** 只有成功完成的 Turn 才自动领取 queue；失败、中断和达到上限都保留给用户处理。 */
const CLI_QUEUE_CLAIMABLE_STATUSES: ReadonlySet<CliTurnStatus> = new Set<CliTurnStatus>(["completed"]);

/** 单次 consume 后自动连续启动的排队 Turn 上限，防止病态积压无限循环。 */
const CLI_MAX_AUTO_QUEUED_TURNS = 8;

/** 与 Web Continue 入口保持一致的确定性继续词；模糊自然语言仍按普通 prompt 处理。 */
const CLI_CONTINUE_PROMPTS: ReadonlySet<string> = new Set(["继续", "继续执行", "继续任务"]);

function yieldToCliRenderer(): Promise<void> {
  return new Promise<void>(function resolveOnNextCheck(resolve): void {
    setImmediate(resolve);
  });
}

/** 判断输入是否是与 Web 相同的明确继续词，避免把新任务误接到旧 Turn。 */
function isCliContinuePrompt(content: string): boolean {
  return CLI_CONTINUE_PROMPTS.has(content.trim());
}

/** 为当前 Controller 注入的审批提交回调；四字段之外不允许宿主提供凭证。 */
export type CliApprovalSubmit = (input: {
  sessionId: string;
  turnId: string;
  approvalId: string;
  decision: "allow_once" | "allow_session" | "allow_workspace" | "deny";
}) => Promise<ApprovalDecision>;

/** Controller 输出结果；lines 由 Main 统一写入 stdout/stderr。 */
export interface CliControllerResult {
  kind: "ok" | "exit" | "error" | "unavailable";
  exitCode: CliExitCode;
  lines: string[];
  message?: string;
  skillOptions?: CliSkillSummary[];
  /** 交互 TTY 用于打开权限 picker；Plain 模式使用同一结果中的稳定 lines。 */
  permissionOptions?: CliPermissionOption[];
  /** 交互 TTY 用于打开模型 picker；Plain 模式使用同一结果中的稳定 lines。 */
  modelOptions?: CliModelOption[];
  /** 交互 TTY 用于打开推理强度 picker；Plain 模式使用同一结果中的稳定 lines。 */
  effortOptions?: CliEffortOption[];
  /** 当前 Session 的后台任务列表或详情；TUI 直接消费安全 DTO。 */
  jobView?: CliJobView;
  /** 状态栏使用的安全配置视图。 */
  statusView?: CliStatusView;
  /** /context 的专用安全报告；TUI 渲染为静态 transcript item，Plain/JSONL 消费 lines。 */
  contextView?: { usage: ContextUsageView | null; expanded: boolean };
  /** 运行中输入成功写入 durable inbox 后，供 TUI 标识等待中的引导或排队消息。 */
  submittedInput?: { inputId: string; delivery: "steer" | "queue" };
  projection: CliProjection;
}

/** 描述基础结果之外的可选输出，避免调用方使用 undefined 维护位置参数。 */
type CliControllerResultOptions = Omit<CliControllerResult, "kind" | "exitCode" | "lines" | "projection">;

/** 持久授权的安全展示行来源；canonical 私有身份已被 Core list 投影剔除。 */
type CliPermissionGrant = Awaited<ReturnType<CliRuntime["approvals"]["listPersistentGrants"]>>[number];

/** Controller 创建参数。 */
export interface CreateCliControllerOptions {
  runtime?: CliRuntime;
  renderer: CliRenderer;
  sessionId?: string;
  approvalSubmit?: CliApprovalSubmit;
  listSkills?: CliSkillCatalogLister;
  resolveSkill?: CliSkillResolver;
  /** Composition Root 传入的 canonical workspaceRoot，只用于安全状态栏展示。 */
  workspaceRoot?: string;
  /** 读取已热更新的安全 Runtime 默认值；仅用于 idle/Completed 状态栏，不参与 Turn 冻结。 */
  getRuntimeStatusDefaults?: () => CliRuntimeStatusDefaults;
  onEvent?: CliEventListener;
  /** 自动启动 queue Turn 前通知交互 TUI，避免等待 prompt 残留在底部。 */
  onQueuedInputStarted?: CliQueuedInputStartedListener;
  now?: () => Date;
}

/** CLI Controller 对外接口。 */
export interface CliController {
  dispatch(action: CliAction): Promise<CliControllerResult>;
  consume(events: AsyncIterable<AgentEvent>): Promise<CliControllerResult>;
  resume(): Promise<CliControllerResult>;
  getProjection(): CliProjection;
  /** 读取当前 Session 默认或活动 Turn frozen 的脱敏状态栏视图。 */
  getStatusView?(): Promise<CliStatusView>;
  setSession(sessionId: string): void;
  setEventListener(listener?: import("./types.js").CliEventListener): void;
  /** 绑定 queue Turn 启动通知；Plain 宿主不需要注册。 */
  setQueuedInputListener?(listener?: CliQueuedInputStartedListener): void;
}

/** 创建无 React 依赖的 Controller；Renderer 和 Runtime 均通过参数注入。 */
export function createCliController(options: CreateCliControllerOptions): CliController {
  const projector = createCliEventProjector({ sessionId: options.sessionId, now: options.now });
  let eventListener = options.onEvent;
  let queuedInputListener = options.onQueuedInputStarted;
  let sessionId = options.sessionId;
  let turnId: string | undefined;
  let pendingUndoTurnId: string | undefined;
  let selectedSkills: Array<{ skillId: string; contentHash: string; qualifiedName: string }> = [];

  /** 创建不写 IO 的基础结果。 */
  function result(
    kind: CliControllerResult["kind"],
    exitCode: CliExitCode,
    lines: string[] = [],
    optionsOrMessage: CliControllerResultOptions | string = {},
  ): CliControllerResult {
    const optional = typeof optionsOrMessage === "string" ? { message: optionsOrMessage } : optionsOrMessage;
    return { kind, exitCode, lines, ...optional, projection: projector.getProjection() };
  }

  /** 将 Core 权限模式转换为用户可读的稳定中文标签。 */
  function permissionLabel(mode: CliPermissionMode): string {
    if (mode === "auto_approve") return "为我审批";
    if (mode === "full_access") return "完全访问";
    return "询问";
  }

  /** 返回三态权限目录；选中项来自 Session 默认值而非活动 Turn 的可变状态。 */
  function createPermissionOptions(selectedMode: CliPermissionMode): CliPermissionOption[] {
    return [
      { mode: "ask", label: "询问", description: "查看和新建自动执行；编辑、覆写和每次命令执行询问。", selected: selectedMode === "ask" },
      { mode: "auto_approve", label: "为我审批", description: "文件工具沿用既有自动审批；命令仅自动执行只读，受信任工作区内的已识别变更命令可自动通过，未知或外部命令仍需审批。", selected: selectedMode === "auto_approve" },
      { mode: "full_access", label: "完全访问", description: "可执行需审批命令；仍拒绝破坏性命令，并遵守工作区路径、Trust 和参数校验。", selected: selectedMode === "full_access" },
    ];
  }

  /** 读取 Composition Root 的 settings-filtered 模型目录，缺失时不假造可切换模型。 */
  function getModelCapabilities(): NonNullable<CliRuntimeStatusDefaults["modelCapabilities"]> {
    return options.getRuntimeStatusDefaults?.().modelCapabilities ?? [];
  }

  /** 以 provider/modelId 查找当前允许切换的模型目录项。 */
  function findModelCapability(modelId: string, provider?: string) {
    return getModelCapabilities().find(function matchesModel(capability) {
      return capability.modelId === modelId && (provider === undefined || capability.provider === provider);
    });
  }

  /** 将模型与推理配置收窄为状态栏可展示的稳定字符串。 */
  function getConfigLabels(config: {
    modelRef?: { provider: string; modelId: string };
    reasoningProfile?: { effort: string };
    effectiveReasoning?: { effort: string; source: "requested" | "clamped" };
    permissionMode?: CliPermissionMode;
  }): Pick<CliStatusView, "model" | "effort" | "permissionMode"> {
    const effective = config.effectiveReasoning;
    return {
      model: config.modelRef ? `${config.modelRef.provider}/${config.modelRef.modelId}` : "runtime default",
      effort: effective
        ? effective.source === "clamped" ? `${effective.effort} (max clamped)` : effective.effort
        : config.reasoningProfile?.effort ?? "runtime default",
      permissionMode: config.permissionMode ?? "ask",
    };
  }

  /** 读取 Session 默认配置，并只保留权限 picker 所需的安全字段。 */
  async function getSession(): Promise<import("@autopilot-agent/core").Session | undefined> {
    if (!sessionId || !options.runtime?.sessions) return undefined;
    return (await options.runtime.sessions.get(sessionId)) ?? undefined;
  }

  /** 读取当前状态栏的脱敏配置；活动 Turn 优先使用 frozen 值。 */
  async function getStatusView(): Promise<CliStatusView> {
    const session = await getSession();
    const sessionConfig = session?.defaultRunConfig;
    const runtimeDefaults = options.getRuntimeStatusDefaults?.() ?? {};
    const currentProjection = projector.getProjection();
    const isActive = (currentProjection.status === "running" || currentProjection.status === "waiting_approval") && Boolean(sessionId && turnId);
    const frozen = isActive && options.runtime && sessionId && turnId
      ? await options.runtime.turns.getFrozenRunConfig({ sessionId, turnId })
      : undefined;
    const hasSessionDefaults = Boolean(sessionConfig && Object.keys(sessionConfig).length > 0);
    const labels = getConfigLabels(frozen ?? { ...runtimeDefaults, ...sessionConfig });
    const sessionPermission = sessionConfig?.permissionMode ?? runtimeDefaults.permissionMode ?? "ask";
    const nextLabels = getConfigLabels({ ...runtimeDefaults, ...sessionConfig });
    // 无 Runtime/Session 时省略字段；测试 double 缺 turns 或 getContextUsage 能力时同样跳过；查询失败 fail closed 为 null（unknown），不伪造 0%。
    const contextUsage = session && options.runtime?.turns && typeof options.runtime.turns.getContextUsage === "function"
      ? await options.runtime.turns.getContextUsage({ sessionId: session.id }).catch(function failClosed() { return null; })
      : undefined;
    return {
      ...labels,
      workspaceRoot: options.workspaceRoot,
      source: frozen ? "turn_frozen" : hasSessionDefaults ? "session_default" : "runtime_default",
      nextPermissionMode: frozen && sessionPermission !== labels.permissionMode ? sessionPermission : undefined,
      nextModel: frozen && nextLabels.model !== labels.model ? nextLabels.model : undefined,
      nextEffort: frozen && nextLabels.effort !== labels.effort ? nextLabels.effort : undefined,
      contextUsage,
    };
  }

  /** 返回权限 picker 的目录和当前状态栏视图；不读取 checkpoint 或审批凭证。 */
  async function openPermissions(): Promise<CliControllerResult> {
    const statusView = await getStatusView();
    const session = await getSession();
    const selectedMode = session?.defaultRunConfig?.permissionMode ?? statusView.permissionMode;
    const permissionOptions = createPermissionOptions(selectedMode);
    const lines = [
      "permission modes:",
      ...permissionOptions.map(function formatPermissionOption(option, index) {
        return `${index + 1}. ${option.mode} — ${option.label}：${option.description}`;
      }),
      "interactive: ↑↓ select · Enter save · Esc cancel; plain: /permissions <mode>",
    ];
    return result("ok", 0, lines, { permissionOptions, statusView });
  }

  /** 合并 Session 级与 Workspace 级持久授权为当前会话可见列表；按 scope+身份去重。 */
  async function listVisiblePermissionGrants(): Promise<CliPermissionGrant[]> {
    if (!options.runtime) return [];
    const grants = new Map<string, CliPermissionGrant>();
    const collect = function collectGrant(grant: CliPermissionGrant): void {
      grants.set(`${grant.scope}|${grant.toolName}|${grant.constraint}|${grant.workspaceRoot ?? ""}|${grant.sessionId ?? ""}`, grant);
    };
    if (sessionId) for (const grant of await options.runtime.approvals.listPersistentGrants({ sessionId })) collect(grant);
    if (options.workspaceRoot) for (const grant of await options.runtime.approvals.listPersistentGrants({ workspaceRoot: options.workspaceRoot })) collect(grant);
    return [...grants.values()];
  }

  /** 列出当前 Session/工作区可见的持久授权；只展示 Core 冻结的脱敏事实。 */
  async function listPermissionGrants(): Promise<CliControllerResult> {
    if (!options.runtime) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    const grants = await listVisiblePermissionGrants();
    if (grants.length === 0) return result("ok", 0, ["当前 Session/工作区没有可见的持久授权。"]);
    const lines = grants.map(function formatGrantLine(grant, index): string {
      const scope = grant.scope === "allow_workspace" ? "工作区" : "会话";
      const projection = grant.projection === "pending" ? " · 记住未同步（待重新批准）" : "";
      return `${index + 1}. [${scope}] ${grant.toolName} · ${grant.constraint}${projection}`;
    });
    lines.push("撤销：/permissions revoke <constraint>（constraint 请按列表原样复制）");
    return result("ok", 0, lines);
  }

  /** 按 toolName+constraint 精确撤销当前可见授权；Core 先删 grant 权威再删 local 投影规则。 */
  async function revokePermissionGrant(constraint: string): Promise<CliControllerResult> {
    if (!options.runtime) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    if (!sessionId || !options.workspaceRoot) return result("error", 2, [], "CLI_APPROVAL_NOT_AVAILABLE");
    const grants = await listVisiblePermissionGrants();
    const targets = grants.filter(function matchConstraint(grant) { return grant.constraint === constraint; });
    if (targets.length === 0) return result("error", 2, [], "CLI_PERMISSION_GRANT_NOT_FOUND");
    const lines: string[] = [];
    for (const grant of targets) {
      const outcome = await options.runtime.approvals.revokePersistentGrant({
        workspaceRoot: options.workspaceRoot,
        sessionId,
        toolName: grant.toolName,
        constraint,
      });
      if (!outcome.deleted) return result("error", 1, [], "CLI_PERMISSION_GRANT_REVOKE_FAILED");
      lines.push(`已撤销 [${grant.scope === "allow_workspace" ? "工作区" : "会话"}] ${grant.toolName} · ${grant.constraint}${outcome.ruleRemoved ? "，并已删除工作区记住规则" : ""}`);
    }
    lines.push("后续同范围操作将重新请求授权。");
    return result("ok", 0, lines);
  }

  /** 读-合并-写入 Session 默认权限，只改变 permissionMode 并保留其他配置字段。 */
  async function setPermissionMode(mode: CliPermissionMode): Promise<CliControllerResult> {
    if (!sessionId) return result("error", 2, [], "CLI_SESSION_REQUIRED");
    if (!options.runtime?.sessions) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    const session = await options.runtime.sessions.get(sessionId);
    if (!session) return result("error", 1, [], "SESSION_NOT_FOUND");
    await options.runtime.sessions.setDefaultRunConfig(sessionId, {
      ...(session.defaultRunConfig ?? {}),
      permissionMode: mode,
    });
    const statusView = await getStatusView();
    const isActive = statusView.source === "turn_frozen";
    const suffix = isActive ? "；当前 Turn 保持 frozen，下一个 Turn 生效" : "；下一个 Turn 生效";
    return result("ok", 0, [`permission: ${permissionLabel(mode)} (${mode})${suffix}`], { statusView });
  }

  /** 消费一段 Core AgentEvent，统一补本地 seq、归约和渲染。 */
  async function consume(events: AsyncIterable<AgentEvent>): Promise<CliControllerResult> {
    const lines: string[] = [];
    await consumeStream(events, lines);
    // Turn 到达终态后自动领取遗留 queue 输入启动新 Turn；对齐 Web start_next 的 claim→consume→start 语义。
    await drainQueuedInputs(lines).catch(function ignoreDrainFailure(error) {
      // 领取是 best-effort 增强；任何失败都不应把已完成的 Turn 翻转为错误退出码。
      lines.push(`queued input drain skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
    return result("ok", 0, lines);
  }

  /** 消费一个事件流并把渲染行追加到同一 lines；不改变调用方的结果语义。 */
  async function consumeStream(events: AsyncIterable<AgentEvent>, lines: string[]): Promise<void> {
    let answerEventsSinceYield = 0;
    for await (const event of events) {
      turnId = event.turnId;
      const previousCount = projector.getProjection().events.length;
      const projected = projector.project(event);
      if (projected.added) {
        const newEvents = projected.projection.events.slice(previousCount);
        for (const publicEvent of newEvents) {
          eventListener?.(publicEvent, projected.projection);
          const rendered = options.renderer.render(publicEvent);
          // context_usage 在 text 模式渲染为空：用量变化只刷新状态栏，不产生输出行。
          if (rendered) lines.push(rendered);
          if (eventListener) {
            if (publicEvent.type === "answer_delta") {
              answerEventsSinceYield += 1;
              if (answerEventsSinceYield < CLI_RENDER_YIELD_EVERY_ANSWER_EVENTS) continue;
              answerEventsSinceYield = 0;
            } else {
              answerEventsSinceYield = 0;
            }
            await yieldToCliRenderer();
          }
        }
      }
    }
  }

  /** Turn 终态后领取遗留排队输入并启动新 Turn；CLI 无 start_next 按钮，不领取则排队输入永久滞留。 */
  async function drainQueuedInputs(lines: string[]): Promise<void> {
    if (!sessionId || !options.runtime) return;
    const inbox = options.runtime.inbox;
    // 测试 double 或宿主未注入可用 inbox（缺 claimNext 能力）时跳过领取，不影响主流程。
    if (!inbox || typeof inbox.claimNext !== "function") return;
    for (let iteration = 0; iteration < CLI_MAX_AUTO_QUEUED_TURNS; iteration += 1) {
      if (!CLI_QUEUE_CLAIMABLE_STATUSES.has(projector.getProjection().status)) return;
      const claimed = await inbox.claimNext({ sessionId });
      if (!claimed) return;
      const nextTurnId = randomUUID();
      if (!(await inbox.consume({ sessionId, inputId: claimed.inputId, turnId: nextTurnId }))) continue;
      const startedInput: CliQueuedInputStarted = {
        inputId: claimed.inputId,
        turnId: nextTurnId,
        content: claimed.content,
        delivery: "queue",
      };
      queuedInputListener?.(startedInput);
      lines.push(`queued input started: ${claimed.inputId}`);
      const activeSkills = claimed.selectedSkills
        .filter(function hasIdentity(skill): boolean { return Boolean(skill.skillId && skill.contentHash); })
        .map(function toIdentity(skill) { return { skillId: skill.skillId, contentHash: skill.contentHash }; });
      try {
        await consumeStream(options.runtime.turns.start({
          sessionId,
          turnId: nextTurnId,
          content: claimed.content,
          activeSkills: activeSkills.length > 0 ? activeSkills : undefined,
          continuity: { source: "claimed_queue" },
        }), lines);
      } catch (error) {
        lines.push(`queued input failed: ${claimed.inputId} (${error instanceof Error ? error.message : String(error)})`);
        return;
      }
    }
  }

  /** 将已钉住 Skill 转为持续输入收件箱所需的安全身份引用。 */
  function toInboxSkillRefs() {
    return selectedSkills.map(function toInboxSkill(skill) {
      return {
        skillRef: skill.qualifiedName,
        skillId: skill.skillId,
        contentHash: skill.contentHash,
        pinned: true,
      };
    });
  }

  /** 启动新 turn，或将运行中的普通输入按 Web 同一语义投递为 steer/queue。 */
  async function submitPrompt(content: string, delivery?: "steer" | "queue"): Promise<CliControllerResult> {
    if (!sessionId) return result("error", 1, [], "CLI_SESSION_REQUIRED");
    if (!options.runtime) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    const status = projector.getProjection().status;
    if (delivery === undefined && isCliContinuePrompt(content) && status !== "running") {
      const recoverable = await options.runtime.turns.getRecoverableState({ sessionId, turnId });
      if (recoverable?.recoverable) return resume();
    }
    if ((status === "running" || status === "waiting_approval") && turnId) {
      const input = await options.runtime.turns.steer({
        sessionId,
        turnId,
        content,
        delivery: delivery ?? "steer",
        selectedSkills: toInboxSkillRefs(),
      });
      return result("ok", 0, [`input queued: ${input.inputId} (${input.delivery})`], { submittedInput: { inputId: input.inputId, delivery: input.delivery } });
    }
    if (delivery === "queue") return result("error", 2, [], "CLI_QUEUE_REQUIRES_ACTIVE_TURN");
    const input: StartTurnInput = {
      sessionId,
      content,
      activeSkills: selectedSkills.length > 0 ? selectedSkills.map(function toActiveSkill(skill) {
        return { skillId: skill.skillId, contentHash: skill.contentHash };
      }) : undefined,
    };
    return consume(options.runtime.turns.start(input));
  }

  /** 使用当前安全审批视图提交决定，并把 allow 类映射为 Core continue 的 allow。 */
  async function approve(decision: Extract<CliAction, { type: "approve" }>['decision']): Promise<CliControllerResult> {
    const pending = projector.getProjection().pendingApproval;
    if (!sessionId || !turnId || !pending) return result("error", 2, [], "CLI_APPROVAL_NOT_AVAILABLE");
    if (!options.runtime) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    if (pending.toolName === "run_command" && (decision === "allow_session" || decision === "allow_workspace") && !pending.allowedDecisions?.includes(decision)) {
      return result("error", 2, [], "CLI_COMMAND_APPROVAL_ALLOW_ONCE_ONLY");
    }
    const approvalInput = { sessionId, turnId, approvalId: pending.approvalId, decision };
    if (options.approvalSubmit) await options.approvalSubmit(approvalInput);
    else await options.runtime.approvals.submit(approvalInput);
    const continueInput: ContinueTurnInput = {
      sessionId,
      turnId,
      approval: { approvalId: pending.approvalId, decision: decision === "deny" ? "deny" : "allow" },
    };
    return consume(options.runtime.turns.continue(continueInput));
  }

  /** 取消当前 turn；取消细节由 Core Runtime 和 checkpoint 负责。 */
  async function cancelTurn(): Promise<CliControllerResult> {
    if (!sessionId || !turnId) return result("error", 2, [], "CLI_ACTIVE_TURN_REQUIRED");
    if (!options.runtime) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    await options.runtime.turns.cancel({ sessionId, turnId });
    const state = await options.runtime.turns.getRecoverableState({ sessionId, turnId });
    if (state) projector.restore(state);
    return result("ok", 0, ["turn cancellation requested"]);
  }

  /** 从 Core 脱敏恢复视图恢复当前投影，并继续同一个 turn。 */
  async function resume(): Promise<CliControllerResult> {
    if (!sessionId) return result("error", 1, [], "CLI_SESSION_REQUIRED");
    if (!options.runtime) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    const state = await options.runtime.turns.getRecoverableState({ sessionId, turnId });
    if (!state) return result("error", 1, [], "CLI_RECOVERABLE_TURN_NOT_FOUND");
    turnId = state.turnId;
    projector.restore(state);
    if (!state.recoverable) return result("error", 1, [], `CLI_TURN_NOT_RESUMABLE: ${state.status}`);
    if (state.status === "awaiting_approval") {
      return result("ok", 0, [
        `approval required: ${state.approval?.approvalId ?? "unknown"}${state.approval ? ` (${state.approval.toolName})` : ""}`,
      ]);
    }
    if (state.status === "awaiting_user_input") {
      return result("ok", 0, ["请在支持结构化回答的 Web 中处理"]);
    }
    if (state.status === "interrupted_recoverable" || state.status === "limit_reached") {
      return consume(options.runtime.turns.continue({ sessionId, turnId }));
    }
    return result("error", 1, [], `CLI_TURN_NOT_RESUMABLE: ${state.status}`);
  }

  /** 只读查询当前 Session 的上下文用量安全 DTO；未知输出固定为 unknown，exit 0。 */
  async function showContext(all: boolean): Promise<CliControllerResult> {
    if (!options.runtime) return result("unavailable", 1, [], "CAPABILITY_UNAVAILABLE: context_usage");
    if (!sessionId) return result("ok", 0, ["Context: unknown"], { contextView: { usage: null, expanded: all } });
    let usage: ContextUsageView | null;
    try {
      usage = await options.runtime.turns.getContextUsage({ sessionId });
    } catch {
      // 查询失败不伪造 0% 或猜测窗口，统一 fail closed 为 unknown。
      usage = null;
    }
    const lines = options.renderer.format === "jsonl"
      ? [JSON.stringify({ type: "context_usage_report", usage, expanded: all })]
      : formatPlainContextReport(usage, all);
    return result("ok", 0, lines, { contextView: { usage, expanded: all } });
  }

  /** 让 Core 从 durable checkpoint 读取完整消息并执行一次手动 compact。 */
  async function compact(): Promise<CliControllerResult> {
    if (!options.runtime) return result("unavailable", 1, [], "CAPABILITY_UNAVAILABLE: compact_input");
    if (!sessionId || !turnId) return result("error", 2, [], "CLI_ACTIVE_TURN_REQUIRED");
    try {
      const compacted = await options.runtime.turns.compact({
        sessionId,
        turnId,
        trigger: "manual",
      });
      if (compacted.outcome === "skipped") {
        return result("ok", 0, [`context compact skipped: no compactable history; projection unchanged (estimated ${compacted.preTokens} tokens)`]);
      }
      return result("ok", 0, [`context compacted: estimated ${compacted.preTokens} -> ${compacted.postTokens}`]);
    } catch (error) {
      // 活动 Turn 中 manual compact 被 Core 直接拒绝；必须显示明确拒绝而不是伪排队。
      if (error instanceof AgentRuntimeError && error.code === "TURN_ALREADY_RUNNING") {
        return result("error", 1, [], "TURN_ALREADY_RUNNING: 当前 Turn 仍在运行，请等待结束或中断后再压缩");
      }
      throw error;
    }
  }

  /** 仅由显式 slash action 调用 Core 的脱敏 Undo preview；模型 prompt 永远不会走此路径。 */
  async function previewUndo(): Promise<CliControllerResult> {
    if (!sessionId) return result("error", 2, [], "CLI_SESSION_REQUIRED");
    if (!options.runtime?.undo) return result("unavailable", 1, [], "CAPABILITY_UNAVAILABLE: undo");
    const preview = await options.runtime.undo.preview({ sessionId });
    pendingUndoTurnId = preview.status === "available" ? preview.turnId : undefined;
    if (preview.status !== "available") return result("error", 2, [], `UNDO_NOT_AVAILABLE: ${preview.reason ?? "UNKNOWN"}`);
    return result("ok", 0, [
      `undo preview: turn ${preview.turnId}`,
      ...preview.files.map(function formatFile(file) { return `- ${file.operation}: ${file.path}`; }),
      "输入 /undo confirm 执行；不会撤销命令、MCP、网络或数据库副作用。",
    ]);
  }

  /** 确认时重新由 Core 校验所有 SHA；preview 过期、外部修改或无 preview 都 fail closed。 */
  async function confirmUndo(): Promise<CliControllerResult> {
    if (!sessionId) return result("error", 2, [], "CLI_SESSION_REQUIRED");
    if (!pendingUndoTurnId || !options.runtime?.undo) return result("error", 2, [], "UNDO_CONFIRMATION_REQUIRED");
    const current = await options.runtime.undo.preview({ sessionId });
    if (current.status !== "available" || current.turnId !== pendingUndoTurnId) { pendingUndoTurnId = undefined; return result("error", 2, [], "UNDO_CONFLICT"); }
    const completed = await options.runtime.undo.execute({ sessionId, confirmed: true });
    pendingUndoTurnId = undefined;
    if (completed.status !== "completed") return result("error", 1, [], `UNDO_FAILED: ${completed.conflicts.join(",") || "compensation required"}`);
    return result("ok", 0, [`undo completed: ${completed.restoredPaths.join(", ")}`]);
  }

  /** 返回 settings/capability 允许的模型目录，并标记 Session 下一 Turn 默认值。 */
  async function openModelPicker(): Promise<CliControllerResult> {
    const session = await getSession();
    const statusView = await getStatusView();
    const selected = session?.defaultRunConfig?.modelRef ?? options.getRuntimeStatusDefaults?.().modelRef;
    const modelOptions = getModelCapabilities().map(function toModelOption(capability) {
      return { provider: capability.provider, modelId: capability.modelId, selected: selected?.provider === capability.provider && selected.modelId === capability.modelId };
    });
    if (modelOptions.length === 0) return result("unavailable", 1, [], "CAPABILITY_UNAVAILABLE: model_catalog");
    return result("ok", 0, [
      "models:",
      ...modelOptions.map(function formatModel(option, index) { return `${index + 1}. ${option.provider}/${option.modelId}${option.selected ? " (selected)" : ""}`; }),
      "interactive: ↑↓ select · Enter save · Esc cancel; plain: /model <model>",
    ], { statusView, modelOptions });
  }

  /** 校验模型与既有 CC effort 请求的组合后，写入仅供下一 Turn 冻结的 Session 默认模型。 */
  async function setModel(modelId: string, provider?: string): Promise<CliControllerResult> {
    if (!sessionId) return result("error", 2, [], "CLI_SESSION_REQUIRED");
    if (!options.runtime?.sessions) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    const capability = findModelCapability(modelId, provider);
    if (!capability) return result("error", 2, [], "MODEL_NOT_SUPPORTED");
    const session = await options.runtime.sessions.get(sessionId);
    if (!session) return result("error", 1, [], "SESSION_NOT_FOUND");
    const currentEffort = session.defaultRunConfig?.reasoningProfile?.effort;
    if (currentEffort && !capability.requestableEfforts.includes(currentEffort)) return result("error", 2, [], "REASONING_EFFORT_NOT_SUPPORTED");
    await options.runtime.sessions.setDefaultRunConfig(sessionId, {
      ...(session.defaultRunConfig ?? {}),
      modelRef: { provider: capability.provider, modelId: capability.modelId },
    });
    const statusView = await getStatusView();
    const suffix = statusView.source === "turn_frozen" ? "；当前 Turn 保持 frozen，下一个 Turn 生效" : "；下一个 Turn 生效";
    return result("ok", 0, [`model: ${capability.provider}/${capability.modelId}${suffix}`], { statusView });
  }

  /** 返回当前模型可明确请求的 CC effort 目录；端点不支持时由其返回明确错误。 */
  async function openEffortPicker(): Promise<CliControllerResult> {
    const session = await getSession();
    const statusView = await getStatusView();
    const modelRef = session?.defaultRunConfig?.modelRef ?? options.getRuntimeStatusDefaults?.().modelRef;
    const capability = modelRef ? findModelCapability(modelRef.modelId, modelRef.provider) : undefined;
    if (!capability) return result("unavailable", 1, [], "CAPABILITY_UNAVAILABLE: effort_catalog");
    const selectedEffort = session?.defaultRunConfig?.reasoningProfile?.effort ?? options.getRuntimeStatusDefaults?.().reasoningProfile?.effort;
    const effortOptions = capability.requestableEfforts.map(function toEffortOption(effort) {
      return { effort, selected: effort === selectedEffort };
    });
    return result("ok", 0, [
      `efforts for ${capability.provider}/${capability.modelId}:`,
      ...effortOptions.map(function formatEffort(option, index) { return `${index + 1}. ${option.effort}${option.selected ? " (selected)" : ""}`; }),
      "interactive: ↑↓ select · Enter save · Esc cancel; plain: /effort <effort>",
    ], { statusView, effortOptions });
  }

  /** 只接受当前 settings 目录允许的 effort，并写入下一 Turn 的 Session 默认配置。 */
  async function setEffort(effort: string): Promise<CliControllerResult> {
    if (!sessionId) return result("error", 2, [], "CLI_SESSION_REQUIRED");
    if (!options.runtime?.sessions) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    const session = await options.runtime.sessions.get(sessionId);
    if (!session) return result("error", 1, [], "SESSION_NOT_FOUND");
    const modelRef = session.defaultRunConfig?.modelRef ?? options.getRuntimeStatusDefaults?.().modelRef;
    const capability = modelRef ? findModelCapability(modelRef.modelId, modelRef.provider) : undefined;
    if (!capability || !capability.requestableEfforts.includes(effort)) return result("error", 2, [], "REASONING_EFFORT_NOT_SUPPORTED");
    await options.runtime.sessions.setDefaultRunConfig(sessionId, {
      ...(session.defaultRunConfig ?? {}),
      reasoningProfile: { effort: effort as ReasoningEffort },
    });
    const statusView = await getStatusView();
    const suffix = statusView.source === "turn_frozen" ? "；当前 Turn 保持 frozen，下一个 Turn 生效" : "；下一个 Turn 生效";
    return result("ok", 0, [`effort: ${effort}${suffix}`], { statusView });
  }

  /** 通过 Core Public API 读取当前 turn 的脱敏冻结配置。 */
  async function getFrozenRunConfig() {
    if (!options.runtime) return undefined;
    if (!sessionId || !turnId) return undefined;
    return options.runtime.turns.getFrozenRunConfig({ sessionId, turnId });
  }

  /** 通过 Composition Root 校验 canonical Skill 并只保存身份/hash。 */
  async function selectSkill(skill: string): Promise<CliControllerResult> {
    if (!options.resolveSkill) return result("unavailable", 1, [], "CAPABILITY_UNAVAILABLE: skill_selector");
    try {
      const resolved = await options.resolveSkill(skill);
      selectedSkills = [...selectedSkills.filter(function keepSkill(item) { return item.skillId !== resolved.skillId; }), { ...resolved, qualifiedName: skill }];
      return result("ok", 0, [`skill selected: ${skill}`]);
    } catch {
      return result("error", 1, [], "CLI_SKILL_NOT_FOUND");
    }
  }

  /** 切换一个 canonical Skill 的上下文钉住状态，并把最新安全列表返回给 TUI。 */
  async function toggleSkill(skill: string): Promise<CliControllerResult> {
    if (!options.resolveSkill || !options.listSkills) return result("unavailable", 1, [], "CAPABILITY_UNAVAILABLE: skill_selector");
    try {
      const resolved = await options.resolveSkill(skill);
      const isSelected = selectedSkills.some(function isSameSkill(item) { return item.skillId === resolved.skillId; });
      selectedSkills = isSelected
        ? selectedSkills.filter(function removeSkill(item) { return item.skillId !== resolved.skillId; })
        : [...selectedSkills, { ...resolved, qualifiedName: skill }];
      const skills = await options.listSkills();
      const skillOptions = skills.map(function markSelected(entry) {
        return { ...entry, selected: selectedSkills.some(function isSelectedEntry(item) { return item.qualifiedName === entry.qualifiedName; }) };
      });
      return result("ok", 0, [isSelected ? `skill disabled: ${skill}` : `skill enabled: ${skill}`], { skillOptions });
    } catch {
      return result("error", 1, [], "CLI_SKILL_NOT_FOUND");
    }
  }

  /** 展示可选择的 Skill 安全摘要，避免要求用户记忆 canonical 名称。 */
  async function listSkills(): Promise<CliControllerResult> {
    if (!options.listSkills) return result("unavailable", 1, [], "CAPABILITY_UNAVAILABLE: skill_catalog");
    try {
      const skills = (await options.listSkills()).map(function markSelected(entry) {
        return { ...entry, selected: selectedSkills.some(function isSelectedEntry(item) { return item.qualifiedName === entry.qualifiedName; }) };
      });
      if (skills.length === 0) return result("ok", 0, ["no skills available"], { skillOptions: skills });
      return result("ok", 0, [
        "available skills:",
        ...skills.map(function formatSkill(skill, index) {
          const description = skill.description.trim() ? ` — ${skill.description.trim()}` : "";
          return `${index + 1}. ${skill.displayName} (${skill.qualifiedName})${description}`;
        }),
        "use /skill <canonical name> to select one",
      ], { skillOptions: skills });
    } catch {
      return result("error", 1, [], "CLI_SKILL_CATALOG_UNAVAILABLE");
    }
  }

  /** 返回绑定当前 Work Session 的 Job 服务；跨 Session/Workspace 校验继续由 Core 执行。 */
  function getSessionJobs() {
    if (!sessionId) throw new AgentRuntimeError("SESSION_NOT_FOUND", "CLI Session 不存在");
    if (!options.runtime || !options.workspaceRoot) throw new AgentRuntimeError("WORKSPACE_REQUIRED", "CLI 工作区不可用");
    return options.runtime.jobs.forSession({ workspaceId: options.workspaceRoot, sessionId });
  }

  /** 将 Job 管理错误收口为稳定 CLI 结果，不向 TUI 暴露底层异常。 */
  function jobError(error: unknown): CliControllerResult {
    const message = error instanceof AgentRuntimeError ? error.code : "CLI_RUNTIME_ERROR";
    return result("error", 1, [], message);
  }

  /** 列出当前 Session 的安全 Job 摘要；该操作可与活动 Turn 并发。 */
  async function listJobs(): Promise<CliControllerResult> {
    try {
      const list = await getSessionJobs().list({ limit: 100 });
      return result("ok", 0, [JSON.stringify(list)], { jobView: { mode: "list", list } });
    } catch (error) { return jobError(error); }
  }

  /** 读取当前 Session 的安全 Job 详情，不读取日志正文。 */
  async function showJob(jobId: string): Promise<CliControllerResult> {
    try {
      const read = await getSessionJobs().read({ jobId, waitMs: 0 });
      return result("ok", 0, [JSON.stringify({ job: read.job })], { jobView: { mode: "detail", job: read.job } });
    } catch (error) { return jobError(error); }
  }

  /** 读取当前 Session 的有限安全双流日志；不会等待或停止 Job。 */
  async function readJobOutput(jobId: string): Promise<CliControllerResult> {
    try {
      const read = await getSessionJobs().read({ jobId, waitMs: 0 });
      return result("ok", 0, [JSON.stringify(read)], { jobView: { mode: "detail", job: read.job, output: read.output } });
    } catch (error) { return jobError(error); }
  }

  /** 根据用户明确给出的 Job ID 停止当前 Runtime 拥有的任务，并返回真实状态。 */
  async function stopJob(jobId: string): Promise<CliControllerResult> {
    try {
      const job = await getSessionJobs().stop({ jobId, source: "host" });
      return result("ok", 0, [JSON.stringify({ job })], { jobView: { mode: "detail", job } });
    } catch (error) { return jobError(error); }
  }

  /** 处理宿主 Action；未进入对应 Runtime Step 的能力返回明确 unavailable。 */
  async function dispatch(action: CliAction): Promise<CliControllerResult> {
    if (action.type === "submit_prompt") return submitPrompt(action.content, action.delivery);
    if (action.type === "approve") return approve(action.decision);
    if (action.type === "cancel_turn") return cancelTurn();
    if (action.type === "compact") return compact();
    if (action.type === "show_context") return showContext(action.all);
    if (action.type === "undo_preview") return previewUndo();
    if (action.type === "undo_confirm") return confirmUndo();
    if (action.type === "select_skill") return selectSkill(action.skill);
    if (action.type === "toggle_skill") return toggleSkill(action.skill);
    if (action.type === "list_skills") return listSkills();
    if (action.type === "open_permissions") return openPermissions();
    if (action.type === "set_permission_mode") return setPermissionMode(action.mode);
    if (action.type === "list_permission_grants") return listPermissionGrants();
    if (action.type === "revoke_permission_grant") return revokePermissionGrant(action.constraint);
    if (action.type === "open_model_picker") return openModelPicker();
    if (action.type === "set_model") return setModel(action.modelId, action.provider);
    if (action.type === "open_effort_picker") return openEffortPicker();
    if (action.type === "set_effort") return setEffort(action.effort);
    if (action.type === "list_jobs") return listJobs();
    if (action.type === "show_job") return showJob(action.jobId);
    if (action.type === "read_job_output") return readJobOutput(action.jobId);
    if (action.type === "stop_job") return stopJob(action.jobId);
    if (action.type === "exit") {
      if (projector.getProjection().status === "running" || projector.getProjection().status === "waiting_approval") {
        await cancelTurn();
      }
      return result("exit", 0, []);
    }
    return result("error", 2, [], "CLI_UNKNOWN_ACTION");
  }

  return {
    dispatch,
    consume,
    resume,
    getProjection: function getProjection() { return projector.getProjection(); },
    getStatusView,
    setSession: function setSession(nextSessionId: string) {
      sessionId = nextSessionId;
      projector.setSessionId(nextSessionId);
    },
    setEventListener: function setEventListener(listener) {
      eventListener = listener;
    },
    setQueuedInputListener: function setQueuedInputListener(listener) {
      queuedInputListener = listener;
    },
  };
}

/** 将 argv 命令转换为 Step 5.2 可执行范围内的 Controller Action。 */
export function commandToAction(command: CliCommand): CliAction | undefined {
  if (command.type === "chat" && command.prompt) return { type: "submit_prompt", content: command.prompt };
  return undefined;
}
