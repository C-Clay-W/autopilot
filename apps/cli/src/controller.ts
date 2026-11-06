/**
 * CLI Controller。
 *
 * Controller 是 Action 到 Core Runtime Public API 的唯一映射层；它不实现
 * Session/Turn 状态机，审批只从当前安全 projection 取得 approvalId，绝不
 * 生成 callId、toolName、normalizedInputHash 或冻结工具输入。
 */

import { createCliSessionTitle, getCliSessionDisplayTitle } from "./session-title.js";
import { recordTuiRuntimeErrorDiagnostic } from "./tui/performance-diagnostics.js";
import { classifyCliError } from "./error-diagnostics.js";
import { randomUUID } from "node:crypto";
import { AgentRuntimeError, normalizeWorkImage } from "@autopilot-agent/core";
import { createNodeSessionImageStore } from "@autopilot-agent/adapters";
import type {
  AgentEvent,
  AgentEventEnvelope,
  ApprovalDecision,
  ContextUsageView,
  ContinueTurnInput,
  ReasoningEffort,
  StartTurnInput,
  AgentMessage,
  SessionImageRef,
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

/** 将已受信存储的图片身份与用户正文组合为可恢复的消息。 */
function createImageMessage(content: string, images: SessionImageRef[]): AgentMessage {
  return { role: "user", content: [{ type: "text", text: content }, ...images.map(function toImage(image) { return { type: "image-ref" as const, id: image.id, sha256: image.sha256, width: image.width, height: image.height }; })] };
}

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
  /** 普通执行与现有 Runner 共享 owner 索引；不因前台选择转移 owner。 */
  registerExecution?(input: { threadId: string; turnId: string; cancel(): void }): { activate(): void; release(): void };
  /** 自动启动 queue Turn 前通知交互 TUI，避免等待 prompt 残留在底部。 */
  onQueuedInputStarted?: CliQueuedInputStartedListener;
  now?: () => Date;
}

/** CLI Controller 对外接口。 */
export interface CliController {
  dispatch(action: CliAction): Promise<CliControllerResult>;
  consume(events: AsyncIterable<AgentEvent>): Promise<CliControllerResult>;
  resume(expectedApproval?: { turnId: string; approvalId: string }): Promise<CliControllerResult>;
  /** 只读回放安全事件，不领取输入、执行lease或恢复Turn。 */
  observe?(events: readonly AgentEventEnvelope[]): void;
  /** 只读权威身份改变时失效旧交互与在途结果，不恢复或执行。 */
  invalidateObservedTurn?(input: { turnId?: string; status: CliTurnStatus }): void;
  /** 同步权威当前交互，不改变正文回放游标。 */
  syncObservedInteraction?(input: { turnId: string; status: CliTurnStatus; approval?: AgentEventEnvelope; requestId?: string }): void;
  isExecuting?(): boolean;
  beginShutdown?(): void;
  getProjection(): CliProjection;
  /** 读取当前 Session 默认或活动 Turn frozen 的脱敏状态栏视图。 */
  getStatusView?(input?: { signal?: AbortSignal }): Promise<CliStatusView>;
  setSession(sessionId: string): void;
  setEventListener(listener?: import("./types.js").CliEventListener): void;
  /** 绑定 queue Turn 启动通知；Plain 宿主不需要注册。 */
  setQueuedInputListener?(listener?: CliQueuedInputStartedListener): void;
}

/** 创建无 React 依赖的 Controller；Renderer 和 Runtime 均通过参数注入。 */
export function createCliController(options: CreateCliControllerOptions): CliController {
  const projector = createCliEventProjector({ sessionId: options.sessionId, now: options.now });
  let observationGeneration = 0;
  let eventListener = options.onEvent;
  let queuedInputListener = options.onQueuedInputStarted;
  let sessionId = options.sessionId;
  let turnId: string | undefined;
  let executing = 0;
  let stopping = false;
  let statusRevision = 0;
  let statusQuery: { sessionId?: string; turnId?: string; generation: number; revision: number; subscribers: Set<AbortSignal | undefined>; promise: Promise<CliStatusView> } | undefined;
  const automaticTitles = new Map<string, string>();
  const cancellationRequests = new Set<string>();
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

  /** 每Controller最多一个在途读取；各调用方独立取消，旧身份完成后才允许新身份查询。 */
  async function getStatusView(input: { signal?: AbortSignal } = {}): Promise<CliStatusView> {
    if (input.signal?.aborted || stopping) throw new DOMException("Status query no longer active", "AbortError");
    if (statusQuery && (statusQuery.sessionId !== sessionId || statusQuery.turnId !== turnId || statusQuery.generation !== observationGeneration || statusQuery.revision !== statusRevision)) {
      await statusQuery.promise.catch(function ignoreInvalidated() {});
      return getStatusView(input);
    }
    if (!statusQuery) {
      const query = { sessionId, turnId, generation: observationGeneration, revision: statusRevision, subscribers: new Set<AbortSignal | undefined>([input.signal]), promise: undefined as unknown as Promise<CliStatusView> };
      statusQuery = query;
      query.promise = readStatusView(query).finally(function releaseQuery() { if (statusQuery === query) statusQuery = undefined; });
    } else statusQuery.subscribers.add(input.signal);
    const query = statusQuery;
    const next = await query.promise;
    if (input.signal?.aborted || query.sessionId !== sessionId || query.turnId !== turnId || query.generation !== observationGeneration || query.revision !== statusRevision) throw new DOMException("Status query no longer active", "AbortError");
    return next;
  }

  /** 读取当前状态栏的脱敏配置；活动 Turn 优先使用 frozen 值。 */
  async function readStatusView(query: NonNullable<typeof statusQuery>): Promise<CliStatusView> {
    /** 在每个异步边界拦住已失效调用方；已开始的同步解析不能取消。 */
    function assertCurrent(): void {
      if (stopping || query.sessionId !== sessionId || query.turnId !== turnId || query.generation !== observationGeneration || query.revision !== statusRevision || ![...query.subscribers].some(function active(signal) { return !signal?.aborted; })) {
        throw new DOMException("Status query no longer active", "AbortError");
      }
    }
    assertCurrent();
    const targetSessionId = query.sessionId;
    const targetTurnId = query.turnId;
    const session = targetSessionId && options.runtime?.sessions ? (await options.runtime.sessions.get(targetSessionId)) ?? undefined : undefined;
    assertCurrent();
    const sessionConfig = session?.defaultRunConfig;
    const runtimeDefaults = options.getRuntimeStatusDefaults?.() ?? {};
    const currentProjection = projector.getProjection();
    const isActive = (currentProjection.status === "running" || currentProjection.status === "waiting_approval") && Boolean(targetSessionId && targetTurnId);
    const frozen = isActive && options.runtime && targetSessionId && targetTurnId
      ? await options.runtime.turns.getFrozenRunConfig({ sessionId: targetSessionId, turnId: targetTurnId })
      : undefined;
    assertCurrent();
    const hasSessionDefaults = Boolean(sessionConfig && Object.keys(sessionConfig).length > 0);
    const labels = getConfigLabels(frozen ?? { ...runtimeDefaults, ...sessionConfig });
    const sessionPermission = sessionConfig?.permissionMode ?? runtimeDefaults.permissionMode ?? "ask";
    const nextLabels = getConfigLabels({ ...runtimeDefaults, ...sessionConfig });
    const turns = options.runtime?.turns;
    // 新Runtime在同一checkpoint上生成两个投影；旧能力保持兼容，边界间仍检查取消。
    let contextUsage: CliStatusView["contextUsage"];
    let turnUsage: CliStatusView["turnUsage"];
    if (session && turns && typeof turns.getUsageSnapshot === "function") {
      const usage = await turns.getUsageSnapshot({ sessionId: session.id }).catch(function failClosed() { return { contextUsage: null, turnUsage: null }; });
      assertCurrent();
      contextUsage = usage.contextUsage;
      turnUsage = usage.turnUsage;
    } else if (session && turns) {
      contextUsage = typeof turns.getContextUsage === "function" ? await turns.getContextUsage({ sessionId: session.id }).catch(function failClosed() { return null; }) : undefined;
      assertCurrent();
      turnUsage = typeof turns.getTurnUsageSummary === "function" ? await turns.getTurnUsageSummary({ sessionId: session.id }).catch(function failClosed() { return null; }) : undefined;
      assertCurrent();
    }
    return {
      ...labels,
      workspaceRoot: options.workspaceRoot,
      source: frozen ? "turn_frozen" : hasSessionDefaults ? "session_default" : "runtime_default",
      nextPermissionMode: frozen && sessionPermission !== labels.permissionMode ? sessionPermission : undefined,
      nextModel: frozen && nextLabels.model !== labels.model ? nextLabels.model : undefined,
      nextEffort: frozen && nextLabels.effort !== labels.effort ? nextLabels.effort : undefined,
      contextUsage,
      turnUsage,
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
    statusRevision++;
    const statusView = await getStatusView();
    const isActive = statusView.source === "turn_frozen";
    const suffix = isActive ? "；当前 Turn 保持 frozen，下一个 Turn 生效" : "；下一个 Turn 生效";
    return result("ok", 0, [`permission: ${permissionLabel(mode)} (${mode})${suffix}`], { statusView });
  }

  let titleWarning: string | undefined;

  /** 首次交互立即存短输入兜底；仅更新本controller建立且尚未手工改名的自动标题。 */
  async function updateSessionTitle(targetSessionId: string, content: string, provisional: boolean): Promise<void> {
    const sessions = options.runtime?.sessions;
    if (!sessions?.get || !sessions.rename) return;
    const session = await sessions.get(targetSessionId);
    if (!session) return;
    const automatic = automaticTitles.get(targetSessionId);
    const empty = getCliSessionDisplayTitle(session.title, session.id) === "新对话" && (!session.title?.trim() || session.title === session.id);
    if (provisional ? !empty : !automatic || session.title !== automatic) return;
    const title = createCliSessionTitle(content);
    try { await sessions.rename(targetSessionId, title); }
    catch (error) {
      recordTuiRuntimeErrorDiagnostic(error);
      if (classifyCliError(error).code !== "STATE_STORAGE_UNAVAILABLE") throw error;
      const persisted = await sessions.get(targetSessionId);
      // 仅标题/更新时间允许变化，其余持久身份与执行事实必须逐字段保持一致。
      const before = { ...session, title: undefined, updatedAt: undefined };
      const after = persisted ? { ...persisted, title: undefined, updatedAt: undefined } : undefined;
      if (!persisted || persisted.id !== targetSessionId || persisted.productMode !== "work" || !persisted.projectId
        || !["idle", "completed", "failed"].includes(persisted.status) || persisted.activeTurnId
        || JSON.stringify(before) !== JSON.stringify(after)) throw error;
      titleWarning = "STATE_STORAGE_UNAVAILABLE：自动标题未保存，已核对原会话身份，任务继续；可稍后手动重命名";
      return;
    }
    if (provisional) automaticTitles.set(targetSessionId, title);
    else automaticTitles.delete(targetSessionId);
  }

  /** 消费一段 Core AgentEvent，统一补本地 seq、归约和渲染。 */
  async function consume(events: AsyncIterable<AgentEvent>): Promise<CliControllerResult> {
    const generation = observationGeneration;
    const lines: string[] = [];
    const targetSessionId = sessionId;
    await consumeStream(events, lines);
    if (generation !== observationGeneration) return result("error", 2, [], "CLI_TURN_IDENTITY_CHANGED");
    const completed = projector.getProjection();
    if (targetSessionId && sessionId === targetSessionId && completed.status === "completed" && completed.answer.trim()) await updateSessionTitle(targetSessionId, completed.answer, false);
    // Turn 到达终态后自动领取遗留 queue 输入启动新 Turn；对齐 Web start_next 的 claim→consume→start 语义。
    await drainQueuedInputs(lines).catch(function ignoreDrainFailure(error) {
      // 领取是 best-effort 增强；任何失败都不应把已完成的 Turn 翻转为错误退出码。
      lines.push(`queued input drain skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (titleWarning) { lines.push(titleWarning); titleWarning = undefined; }
    return result("ok", 0, lines);
  }

  /** 消费一个事件流并把渲染行追加到同一 lines；不改变调用方的结果语义。 */
  async function consumeStream(events: AsyncIterable<AgentEvent>, lines: string[]): Promise<void> {
    const generation = observationGeneration;
    let answerEventsSinceYield = 0;
    let owner: ReturnType<NonNullable<CreateCliControllerOptions["registerExecution"]>> | undefined;
    executing += 1;
    try {
    for await (const event of events) {
      if (generation !== observationGeneration) continue;
      turnId = event.turnId;
      if (event.type === "turn_started" && sessionId) cancellationRequests.delete(JSON.stringify([sessionId, turnId]));
      if (!owner && sessionId && options.registerExecution) {
        const ownedSession = sessionId;
        const ownedTurn = event.turnId;
        owner = options.registerExecution({ threadId: ownedSession, turnId: ownedTurn, cancel: async function cancelOwnedExecution() { await options.runtime?.turns.cancel({ sessionId: ownedSession, turnId: ownedTurn }); } });
        owner.activate();
      }
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
    } finally { executing -= 1; owner?.release(); }
  }

  /** Turn 终态后领取遗留排队输入并启动新 Turn；CLI 无 start_next 按钮，不领取则排队输入永久滞留。 */
  async function drainQueuedInputs(lines: string[]): Promise<void> {
    if (!sessionId || !options.runtime || stopping) return;
    const inbox = options.runtime.inbox;
    // 测试 double 或宿主未注入可用 inbox（缺 claimNext 能力）时跳过领取，不影响主流程。
    if (!inbox || typeof inbox.claimNext !== "function") return;
    for (let iteration = 0; iteration < CLI_MAX_AUTO_QUEUED_TURNS; iteration += 1) {
      if (!CLI_QUEUE_CLAIMABLE_STATUSES.has(projector.getProjection().status)) return;
      const claimed = await inbox.claimNext({ sessionId });
      if (!claimed) return;
      const queuedImages = claimed.attachments.length && options.workspaceRoot
        ? await Promise.all(claimed.attachments.map(async function resolveImage(attachment) { return (await createNodeSessionImageStore(options.workspaceRoot!).read({ sessionId: sessionId!, id: attachment.id })).image; }))
        : [];
      if (claimed.attachments.length && queuedImages.length !== claimed.attachments.length) throw new Error("会话图片不可用");
      if (claimed.attachments.some(function mismatched(attachment, index) { return attachment.sha256 && (queuedImages[index]?.sha256 !== attachment.sha256 || queuedImages[index]?.bytes !== attachment.bytes || queuedImages[index]?.width !== attachment.width || queuedImages[index]?.height !== attachment.height); })) throw new Error("会话图片校验失败");
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
          messages: queuedImages.length ? [createImageMessage(claimed.content, queuedImages)] : undefined,
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
  async function submitPrompt(content: string, delivery?: "steer" | "queue", images?: Extract<CliAction, { type: "submit_prompt" }>["images"]): Promise<CliControllerResult> {
    if (stopping) return result("error", 1, [], "CLI_HOST_STOPPING");
    const submittedTurnId = turnId;
    const submittedStatus = projector.getProjection().status;
    if (!sessionId) return result("error", 1, [], "CLI_SESSION_REQUIRED");
    if (!options.runtime) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    if ((images?.length ?? 0) > 10 || (images?.length && !options.workspaceRoot)) return result("error", 2, [], "CLI_IMAGE_INVALID");
    if (submittedStatus === "waiting_user_input") {
      if (images?.length) return result("error", 2, [], "结构化问题只接受选项编号或自定义文本");
      return answerQuestion(content, projector.getProjection().questionRequestId);
    }
    const normalized = await Promise.all((images ?? []).map(async function normalize(image) { const result = await normalizeWorkImage(image); return { name: image.name, mimeType: result.mimeType, bytes: result.bytes }; }));
    if (normalized.reduce(function total(size, image) { return size + image.bytes.byteLength; }, 0) > 20 * 1024 * 1024) return result("error", 2, [], "CLI_IMAGE_INVALID");
    const imageStore = options.workspaceRoot ? createNodeSessionImageStore(options.workspaceRoot) : undefined;
    const stored = [];
    for (const image of normalized) stored.push(await imageStore!.put({ sessionId, ...image }));
    const status = submittedStatus;
    if (stored.length === 0 && delivery === undefined && isCliContinuePrompt(content) && status !== "running") {
      const recoverable = await options.runtime.turns.getRecoverableState({ sessionId, turnId });
      if (recoverable?.recoverable) return resume();
    }
    if ((status === "running" || status === "waiting_approval") && submittedTurnId) {
      const input = await options.runtime.turns.steer({
        sessionId,
        turnId: submittedTurnId,
        content,
        attachments: stored,
        delivery: delivery ?? "steer",
        selectedSkills: toInboxSkillRefs(),
      });
      return result("ok", 0, [`input queued: ${input.inputId} (${input.delivery})`], { submittedInput: { inputId: input.inputId, delivery: input.delivery } });
    }
    if (delivery === "queue") return result("error", 2, [], "CLI_QUEUE_REQUIRES_ACTIVE_TURN");
    await updateSessionTitle(sessionId, content, true);
    const input: StartTurnInput = {
      sessionId,
      content,
      messages: stored.length ? [createImageMessage(content, stored)] : undefined,
      activeSkills: selectedSkills.length > 0 ? selectedSkills.map(function toActiveSkill(skill) {
        return { skillId: skill.skillId, contentHash: skill.contentHash };
      }) : undefined,
    };
    return consume(options.runtime.turns.start(input));
  }

  /** 当前目标内逐题收集历史问题答案，按精确requestId提交，原文只交给私有问题服务。 */
  let questionDraft: { turnId: string; requestId: string; answers: Array<{ id: string; selected: string[]; custom?: string }> } | undefined;

  /** 将受信问题的当前题目与原选项投影为终端提示，数字选择与自定义文本共用原Core校验。 */
  function questionLines(question: NonNullable<NonNullable<import("@autopilot-agent/core").TurnExecutionView["interaction"]>["question"]>, index = 0): string[] {
    const item = question.questions[index];
    return item ? [`等待回答（${index + 1}/${question.questions.length}） ${item.header}`, item.question, ...item.options.map(function option(option, n) { return `${n + 1}. ${option.label} — ${option.description}`; }), "输入选项编号，或直接输入自定义答案（纯数字补充用“其他 <内容>”）"] : [];
  }

  /** 已保存决定先交给受信宿主控制面；无协作组时沿原本机continue入口执行。 */
  async function continueSavedInteraction(input: { sessionId: string; turnId: string; approvalId?: string; requestId?: string }, approval?: ContinueTurnInput["approval"]): Promise<CliControllerResult> {
    const handoff = await options.runtime!.turns.requestInteractionContinuation?.(input);
    if (handoff?.queued) {
      const view = await options.runtime!.turns.getExecutionState({ sessionId: input.sessionId, turnId: input.turnId }).catch(function unavailable() { return null; });
      const host = view?.executionHost === "web-work-v1" ? "请保持或启动 Web 宿主" : view?.executionHost === "cli-work-v1" ? "请保持或启动 CLI 宿主" : "执行归属待确认";
      return result("ok", 0, [`${input.requestId ? "答案" : "审批决定"}已保存，等待兼容宿主继续原任务；${host}，/resume 可重试原请求`]);
    }
    return consume(options.runtime!.turns.continue({ sessionId: input.sessionId, turnId: input.turnId, requestId: input.requestId, approval }));
  }

  /** 只处理当前安全投影里的历史问题；迟到输入不能回答后续新请求。 */
  async function answerQuestion(content: string, expectedRequestId: string | undefined): Promise<CliControllerResult> {
    if (!sessionId || !options.runtime) return result("error", 1, [], "CLI_SESSION_REQUIRED");
    const targetSessionId = sessionId;
    const generation = observationGeneration;
    const view = await options.runtime.turns.getExecutionState({ sessionId: targetSessionId, turnId });
    if (!expectedRequestId || generation !== observationGeneration || view?.waiting !== "user_input" || !view.interaction?.question || view.interaction.requestId !== expectedRequestId) return result("error", 2, [], "当前问题已变化，请刷新后重新回答");
    const question = view.interaction.question;
    if (view.interaction.state === "decided") return isCliContinuePrompt(content) ? continueSavedInteraction({ sessionId: targetSessionId, turnId: view.turnId, requestId: question.requestId }) : result("ok", 0, ["答案已保存，请通过 /resume 继续原请求"]);
    if (view.interaction.state !== "pending") return result("error", 2, [], "问题状态待确认，请刷新后重试");
    if (questionDraft?.requestId !== question.requestId || questionDraft.turnId !== view.turnId) questionDraft = { turnId: view.turnId, requestId: question.requestId, answers: [] };
    const item = question.questions[questionDraft.answers.length];
    const text = content.trim();
    if (!item || !text) return result("error", 2, [], "请输入当前题目的选项编号或自定义文本");
    const custom = text.startsWith("其他 ") ? text.slice(3).trim() : undefined;
    if (custom === "") return result("error", 2, [], "请输入自定义答案内容");
    const number = custom === undefined && /^\d+$/u.test(text) ? Number(text) : undefined;
    if (number !== undefined && (number < 1 || number > item.options.length)) return result("error", 2, questionLines(question, questionDraft.answers.length), "选项编号超出范围");
    questionDraft.answers.push(number !== undefined ? { id: item.id, selected: [item.options[number - 1].label] } : { id: item.id, selected: [], custom: custom ?? text });
    if (questionDraft.answers.length < question.questions.length) return result("ok", 0, questionLines(question, questionDraft.answers.length));
    if (!options.runtime.questions) { questionDraft = undefined; return result("unavailable", 1, [], "当前宿主不支持提交历史问题答案"); }
    executing++;
    try {
      await options.runtime.questions.submit({ sessionId: targetSessionId, turnId: view.turnId, requestId: question.requestId, answers: questionDraft.answers });
      questionDraft = undefined;
      return await continueSavedInteraction({ sessionId: targetSessionId, turnId: view.turnId, requestId: question.requestId });
    } catch (error) {
      questionDraft = undefined;
      const current = await options.runtime.turns.getExecutionState({ sessionId: targetSessionId, turnId: view.turnId }).catch(function unavailable() { return null; });
      if (current?.interaction?.state === "decided") return result("error", 1, [], "答案已保存，继续失败，请通过 /resume 重试原请求");
      if (current?.interaction?.state === "pending" && current.interaction.question) return result("error", 2, questionLines(current.interaction.question), "答案尚未保存，请重新回答");
      throw error;
    } finally { executing--; }
  }

  /** 记录已提交的冻结审批身份，避免重复决定再次继续执行。 */
  const approvalRequests = new Set<string>();

  /** 冻结审批三元身份并防止重复提交；迟到界面不得批准下一请求。 */
  async function approve(decision: Extract<CliAction, { type: "approve" }>['decision'], expected?: Extract<CliAction, { type: "approve" }>['expected']): Promise<CliControllerResult> {
    // 提交决定与后续continue共同持有执行权，后台观察不能抢先失效本次审批。
    executing += 1;
    try {
      const generation = observationGeneration;
      const pending = projector.getProjection().pendingApproval;
      if (!sessionId || !turnId || !pending) return result("error", 2, [], "CLI_APPROVAL_NOT_AVAILABLE");
      if (!options.runtime) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
      if (pending.toolName === "run_command" && (decision === "allow_session" || decision === "allow_workspace") && !pending.allowedDecisions?.includes(decision)) {
        return result("error", 2, [], "CLI_COMMAND_APPROVAL_ALLOW_ONCE_ONLY");
      }
      const targetSessionId = sessionId;
      const targetTurnId = turnId;
      const identity = JSON.stringify([targetSessionId, targetTurnId, pending.approvalId]);
      if (expected && (expected.sessionId !== targetSessionId || expected.turnId !== targetTurnId || expected.approvalId !== pending.approvalId)) return result("error", 2, [], "CLI_APPROVAL_NOT_AVAILABLE");
      if (approvalRequests.has(identity)) return result("error", 2, [], "CLI_APPROVAL_NOT_AVAILABLE");
      if (pending.allowedDecisions && !pending.allowedDecisions.includes(decision)) return result("error", 2, [], "CLI_APPROVAL_NOT_AVAILABLE");
      approvalRequests.add(identity);
      projector.syncObservedInteraction({ turnId: targetTurnId, status: "waiting_approval" });
      const approvalInput = { sessionId: targetSessionId, turnId: targetTurnId, approvalId: pending.approvalId, decision };
      try {
        if (options.approvalSubmit) await options.approvalSubmit(approvalInput);
        else await options.runtime.approvals.submit(approvalInput);
      } catch (error) {
        approvalRequests.delete(identity);
        if (generation !== observationGeneration) return result("error", 2, [], "CLI_APPROVAL_NOT_AVAILABLE");
        const state = await options.runtime.turns.getRecoverableState({ sessionId: targetSessionId, turnId: targetTurnId });
        if (generation !== observationGeneration) return result("error", 2, [], "CLI_APPROVAL_NOT_AVAILABLE");
        if (state) projector.restore({ ...state, approval: state.approval?.approvalId === pending.approvalId ? undefined : state.approval });
        throw error;
      }
      if (generation !== observationGeneration) return result("error", 2, [], "CLI_APPROVAL_NOT_AVAILABLE");
      const continueInput: ContinueTurnInput = {
        sessionId: targetSessionId,
        turnId: targetTurnId,
        approval: { approvalId: pending.approvalId, decision: decision === "deny" ? "deny" : "allow" },
      };
      try {
        return await continueSavedInteraction({ sessionId: targetSessionId, turnId: targetTurnId, approvalId: pending.approvalId }, continueInput.approval);
      } catch (error) {
        const classification = classifyCliError(error);
        const state = await options.runtime.turns.getRecoverableState({ sessionId: targetSessionId, turnId: targetTurnId }).catch(function unavailable() { return null; });
        if (state && generation === observationGeneration) projector.restore(state);
        return result("error", 1, [], `审批决定已保存，恢复执行失败（CLI_APPROVAL_CONTINUE_FAILED/${classification.code}），请重试原决定继续`);
      }
    } finally { executing -= 1; }
  }

  /** 仅对提交瞬间精确活动Turn请求一次取消；终态/重复请求不输出误导notice。 */
  async function cancelTurn(): Promise<CliControllerResult> {
    if (!sessionId || !turnId) return result("error", 2, [], "CLI_ACTIVE_TURN_REQUIRED");
    if (!options.runtime) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
    const targetSessionId = sessionId;
    const targetTurnId = turnId;
    const identity = JSON.stringify([targetSessionId, targetTurnId]);
    if (!["running", "waiting_approval", "waiting_user_input"].includes(projector.getProjection().status) || cancellationRequests.has(identity)) return result("ok", 0);
    cancellationRequests.add(identity);
    try {
      const session = await options.runtime.sessions?.get?.(targetSessionId);
      if (session && (session.activeTurnId !== targetTurnId || !["running", "waiting_approval", "waiting_user_input"].includes(session.status))) return result("ok", 0);
      await options.runtime.turns.cancel({ sessionId: targetSessionId, turnId: targetTurnId });
      const state = await options.runtime.turns.getRecoverableState({ sessionId: targetSessionId, turnId: targetTurnId });
      if (state && sessionId === targetSessionId && turnId === targetTurnId) projector.restore(state);
      return result("ok", 0, state && ["completed", "failed"].includes(state.status) ? [] : ["turn cancellation requested"]);
    } catch (error) { cancellationRequests.delete(identity); throw error; }
  }

  /** 从 Core 脱敏恢复视图恢复当前投影，并继续同一个 turn。 */
  async function resume(expectedApproval?: { turnId: string; approvalId: string }): Promise<CliControllerResult> {
    if (executing > 0) return result("error", 2, [], "CLI_TURN_ALREADY_EXECUTING");
    // 恢复视图读取也属于本控制器执行，避免目录/迟到正文在首个事件前重置身份。
    executing += 1;
    try {
      const generation = observationGeneration;
      if (!sessionId) return result("error", 1, [], "CLI_SESSION_REQUIRED");
      if (!options.runtime) return result("error", 1, [], "CLI_RUNTIME_NOT_ATTACHED");
      const state = await options.runtime.turns.getRecoverableState({ sessionId, turnId });
      if (generation !== observationGeneration) return result("error", 2, [], "CLI_TURN_IDENTITY_CHANGED");
      if (!state) return result("error", 1, [], "CLI_RECOVERABLE_TURN_NOT_FOUND");
      if (expectedApproval && (state.turnId !== expectedApproval.turnId || state.approval?.approvalId !== expectedApproval.approvalId || state.interactionState !== "decided")) return result("error", 2, [], "CLI_APPROVAL_NOT_AVAILABLE");
      turnId = state.turnId;
      projector.restore(state);
      if (!state.recoverable) return result("error", 1, [], `CLI_TURN_NOT_RESUMABLE: ${state.status}`);
      if (state.status === "awaiting_approval" && state.approval) {
        // 旧宿主可能在决定落盘后退出；复用精确持久决定继续，不能再次提交同一审批。
        const decision = await options.runtime.approvals?.getDecision?.({ sessionId, turnId, approvalId: state.approval.approvalId });
        if (generation !== observationGeneration) return result("error", 2, [], "CLI_TURN_IDENTITY_CHANGED");
        if (decision) return await continueSavedInteraction({ sessionId, turnId, approvalId: state.approval.approvalId }, { approvalId: state.approval.approvalId, decision: decision.decision === "deny" ? "deny" : "allow" });
        return result("ok", 0, [
          `approval required: ${state.approval?.approvalId ?? "unknown"}${state.approval ? ` (${state.approval.toolName})` : ""}`,
        ]);
      }
      if (state.status === "awaiting_user_input") {
        const view = await options.runtime.turns.getExecutionState({ sessionId, turnId });
        if (!view?.interaction?.question) return result("error", 1, [], "问题身份或内容待确认，请刷新后重试");
        projector.syncObservedInteraction({ turnId, status: "waiting_user_input", requestId: view.interaction.question.requestId });
        if (view.interaction.state === "decided") return await continueSavedInteraction({ sessionId, turnId, requestId: view.interaction.question.requestId });
        return result("ok", 0, questionLines(view.interaction.question));
      }
      if (state.status === "interrupted_recoverable" || state.status === "limit_reached" || (state.status === "awaiting_approval" && !state.approval)) {
        return await consume(options.runtime.turns.continue({ sessionId, turnId }));
      }
      return result("error", 1, [], `CLI_TURN_NOT_RESUMABLE: ${state.status}`);
    } finally { executing -= 1; }
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
    statusRevision++;
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
    statusRevision++;
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
    if (action.type === "submit_prompt") return submitPrompt(action.content, action.delivery, action.images);
    if (action.type === "approve") return approve(action.decision, action.expected);
    if (action.type === "cancel_turn") return cancelTurn();
    if (action.type === "resume") return resume();
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
      return result("exit", 0, []);
    }
    return result("error", 2, [], "CLI_UNKNOWN_ACTION");
  }

  return {
    dispatch,
    consume,
    resume,
    /** 观察只更新当前固定 Session 的安全投影；不进入 consume 的自动队列执行路径。 */
    observe: function observe(events) {
      for (const envelope of events) {
        const previousCount = projector.getProjection().events.length;
        const projected = projector.observe(envelope);
        if (!projected.added) continue;
        turnId = envelope.turnId;
        for (const event of projected.projection.events.slice(previousCount)) eventListener?.(event, projected.projection);
      }
    },
    /** 清除旧Turn执行/审批身份，旧异步采样或审批返回后不得继续旧目标。 */
    invalidateObservedTurn: function invalidateObservedTurn(input) {
      observationGeneration++;
      turnId = input.turnId;
      projector.invalidateObservedTurn(input);
    },
    /** 审批代次改变即失效旧提交响应；只同步安全展示，不恢复执行。 */
    syncObservedInteraction: function syncObservedInteraction(input) {
      const before = JSON.stringify([projector.getProjection().pendingApproval?.approvalId, projector.getProjection().questionRequestId]);
      const event = input.approval?.event;
      const submitted = event?.type === "approval_required" && approvalRequests.has(JSON.stringify([sessionId, input.turnId, event.result.approval.approvalId]));
      const next = projector.syncObservedInteraction(submitted ? { ...input, approval: undefined } : input);
      if (before !== JSON.stringify([next.pendingApproval?.approvalId, next.questionRequestId])) observationGeneration++;
      turnId = input.turnId;
    },
    beginShutdown: function beginShutdown() { stopping = true; },
    isExecuting: function isExecuting() { return executing > 0; },
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
