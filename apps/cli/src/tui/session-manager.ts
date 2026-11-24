/** 单窗口轻量会话目录：普通历史只保留标题/UUID，显式打开后才创建完整视图与分页历史。 */
import { getCliSessionDisplayTitle } from "../session-title.js";
import { createInitialCliProjection } from "../event-projector.js";
import type { AgentEventEnvelope, AgentRuntime, Session, TurnExecutionView } from "@autopilot-agent/core";
import type { CliController, CliControllerResult } from "../controller.js";
import { createCliTuiStore } from "./store.js";
import type { CliTuiStore } from "./types.js";
import type { CliTuiDraftRef } from "./hooks/use-prompt-input.js";

/** 主子视图共用已保存交互文案，底层暂停状态保持原样。 */
export function getCliInteractionLabel(view?: TurnExecutionView): string | undefined {
  if (view?.interaction?.state !== "decided") return undefined;
  const decision = view.interaction.decision === "approved" ? "已批准" : "决定已保存";
  return `${decision}，${view.interaction.continuation?.state === "failed" ? "恢复失败" : "等待恢复"}`;
}

/** 已打开或有关联活动的目标；未打开的普通目录项没有Controller/Store。 */
export interface CliSessionEntry {
  sessionId: string;
  title: string;
  attachments: string[];
  controller: CliController;
  store: CliTuiStore;
  unread: boolean;
  hydrated: boolean;
  opened: boolean;
  parentSessionId?: string;
  historyCursor?: string;
  historyMore: boolean;
  historyLoading: boolean;
  summaryCursor?: string;
  summaryTurnId?: string;
  summaryStatus?: Session["status"];
  summaryKnown?: boolean;
  summaryReady?: boolean;
  summaryApproval?: AgentEventEnvelope;
  summaryRejectedId?: string;
  executionView?: TurnExecutionView;
  executionViewReadAt?: number;
  interactionNotice?: string;
  viewState: { draftRef: CliTuiDraftRef; initialStarted: boolean; lastSubmittedPrompt: { current: string | undefined } };
  pendingPrompts?: NonNullable<Session["presentation"]>["messages"];
}

/** 退出只陈述当前宿主确认的执行事实。 */
export interface CliSessionExitReport { stopped: string[]; waiting: string[]; recoverable: string[]; unconfirmed: string[] }
/** 普通目录只持有显示标题与内部路由身份。 */
export interface CliSessionDirectoryItem { sessionId: string; title: string }
/** 历史分页保留末尾游标，nextCursor仅表示还有旧页。 */
export interface CliSessionEventPage { items: AgentEventEnvelope[]; cursor?: string; nextCursor?: string }
/** 关联轻量状态由受信宿主绑定，普通独立会话不进入此列表。 */
export interface CliSessionRelation { threadId: string; parentThreadId: string | null; title?: string; status?: Session["status"]; activeTurnId?: string; executionView?: TurnExecutionView | null }

/** 创建Project级轻量目录，所有分页/异步结果固定写回原目标。 */
export function createCliSessionManager(options: {
  runtime: AgentRuntime;
  projectId: string;
  initialSession: Session;
  initialController: CliController;
  createController(sessionId: string): CliController;
  readRelations?(sessionId: string, signal?: AbortSignal): Promise<CliSessionRelation[]>;
  readSummary?(sessionId: string, signal?: AbortSignal): Promise<{ title?: string; status?: Session["status"]; activeTurnId?: string; currentTurnId?: string; executionView?: TurnExecutionView | null } | null>;
  readDirectoryPage?(input: { cursor?: string; limit: number }): Promise<{ items: Array<{ id: string; title?: string }>; nextCursor?: string }>;
  readEventPage?(sessionId: string, input: { cursor?: string; limit: number }): Promise<CliSessionEventPage>;
}) {
  const entries = new Map<string, CliSessionEntry>();
  const directory = new Map<string, CliSessionDirectoryItem>();
  const listeners = new Set<() => void>();
  let selectedId = options.initialSession.id;
  let directoryCursor: string | undefined;
  let directoryLoaded = false;
  let directoryLoading = false;
  let directoryRequest: Promise<void> | undefined;
  let refreshing = false;
  let refreshAbort: AbortController | undefined;
  let selectionGeneration = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** 发布实际目录/状态变化，后台事件不抢选中目标。 */
  function notify(): void { if (!stopped) for (const listener of listeners) listener(); }

  /** 将事件固定路由到该entry，未打开的关联目标只保存轻量安全状态。 */
  function bind(entry: CliSessionEntry): void {
    entry.controller.setEventListener(function receive(event, projection) {
      entry.store.acceptEvent(event, projection);
      if (event.type === "approval_required" || event.type === "todo_updated" || event.type === "status") { if (selectedId !== entry.sessionId) entry.unread = true; notify(); }
    });
    entry.controller.setQueuedInputListener?.(function queued(input) { entry.store.markQueuedInputStarted(input); });
  }

  /** 仅为已打开目标或真实关联摘要建立宿主对象，不为普通目录项创建对象。 */
  function attach(id: string, title: string | undefined, controller: CliController, opened: boolean): CliSessionEntry {
    const entry: CliSessionEntry = { sessionId: id, title: getCliSessionDisplayTitle(title, id), attachments: [], controller, store: createCliTuiStore(), unread: false, hydrated: false, opened, historyMore: true, historyLoading: false, viewState: { draftRef: {}, initialStarted: false, lastSubmittedPrompt: { current: undefined } } };
    let interaction = "";
    entry.store.subscribe(function interactionChanged() {
      const state = entry.store.getSnapshot();
      const current = JSON.stringify([state.liveTurnId, state.status, state.pendingApproval?.approvalId]);
      if (current !== interaction) { interaction = current; notify(); }
    });
    entries.set(id, entry); bind(entry); return entry;
  }
  const initial = attach(options.initialSession.id, options.initialSession.title, options.initialController, true);
  initial.pendingPrompts = options.initialSession.presentation?.messages.filter(function user(message) { return message.role === "user"; }) ?? [];
  directory.set(initial.sessionId, { sessionId: initial.sessionId, title: initial.title });

  /** 按需获取一页标题，不调用Session完整list/get、transcript或checkpoint。 */
  function loadDirectory(): Promise<void> {
    if (directoryRequest) return directoryRequest;
    if (stopped || directoryLoaded && !directoryCursor) return Promise.resolve();
    if (!options.readDirectoryPage) return Promise.reject(new Error("CLI_SESSION_DIRECTORY_UNAVAILABLE"));
    directoryLoading = true; notify();
    directoryRequest = options.readDirectoryPage({ cursor: directoryCursor, limit: 20 }).then(function loaded(page) {
      if (stopped) return;
      for (const item of page.items) directory.set(item.id, { sessionId: item.id, title: getCliSessionDisplayTitle(item.title, item.id) });
      directoryCursor = page.nextCursor; directoryLoaded = true;
    }).finally(function release() { directoryRequest = undefined; directoryLoading = false; notify(); });
    return directoryRequest;
  }

  /** 元数据已确认的新/未知/终态立即失效旧交互，不等待正文页追赶。 */
  function reconcileObservedIdentity(entry: CliSessionEntry, relation: Pick<CliSessionRelation, "activeTurnId" | "status">): void {
    const current = entry.controller.getProjection();
    const active = relation.status === "running" || relation.status === "waiting_approval" || relation.status === "waiting_user_input";
    const changedIdentity = !entry.summaryKnown || entry.summaryTurnId !== relation.activeTurnId;
    if (changedIdentity) { entry.summaryReady = false; entry.summaryApproval = undefined; }
    entry.summaryTurnId = relation.activeTurnId; entry.summaryStatus = relation.status; entry.summaryKnown = true;
    const invalid = changedIdentity || current.turnId !== relation.activeTurnId || !relation.activeTurnId || !active || current.pendingApproval && relation.status !== "waiting_approval";
    const status = relation.status ?? "idle";
    if (invalid && (changedIdentity || current.pendingApproval || current.turnId !== relation.activeTurnId || current.status !== status)) {
      entry.controller.invalidateObservedTurn?.({ turnId: relation.activeTurnId, status });
      const cleared = entry.controller.invalidateObservedTurn ? entry.controller.getProjection() : { ...createInitialCliProjection(), turnId: relation.activeTurnId, status };
      entry.store.syncProjection(cleared); notify();
    }
  }

  /** 当前交互只采用已追到尾的安全摘要；未完成追赶时旧卡不进入输入许可。 */
  function syncCurrentInteraction(entry: CliSessionEntry): void {
    if (!entry.summaryKnown || !entry.summaryTurnId || entry.controller.isExecuting?.()) return;
    let approval = entry.summaryReady && entry.summaryStatus === "waiting_approval" ? entry.summaryApproval : undefined;
    if (approval?.event.type === "approval_required") {
      const request = approval.event.result.approval;
      if (Number.isFinite(Date.parse(request.expiresAt)) && Date.parse(request.expiresAt) <= Date.now()) {
        if (entry.summaryRejectedId !== request.approvalId) entry.store.addNotice("审批已过期，请在目标会话通过原继续入口刷新");
        entry.summaryRejectedId = request.approvalId; approval = undefined;
      }
    }
    entry.controller.syncObservedInteraction?.({ turnId: entry.summaryTurnId, status: entry.summaryStatus ?? "idle", approval, requestId: entry.executionView?.interaction?.requestId });
    entry.store.syncProjection(entry.controller.getProjection());
  }

  /** 宿主统一安全投影直接提供当前请求；正文历史未追到尾也不阻挡审批。 */
  function applyExecutionView(entry: CliSessionEntry, view: TurnExecutionView): void {
    const previous = entry.executionView;
    if (previous?.turnId === view.turnId && view.lastSeq < previous.lastSeq) return;
    entry.executionView = view;
    entry.executionViewReadAt = Date.now();
    reconcileObservedIdentity(entry, { activeTurnId: view.turnId, status: view.status });
    entry.summaryApproval = view.interaction?.state === "pending" ? view.interaction.approval : undefined;
    entry.summaryReady = true;
    const diagnostic = view.interaction?.continuation?.failureDiagnostic;
    const notice = (view.continuation ?? view.interaction?.continuation)?.failureCode === "BOUNDARY_CHANGED" ? "原决定或答案已保存，执行结果未确认，请先核对原任务状态" : view.interaction?.state === "decided" ? `${view.waiting === "user_input" ? "答案" : view.interaction.decision === "approved" ? "批准决定" : "审批决定"}已保存，${view.interaction.continuation?.state === "failed" ? `恢复失败${diagnostic ? `（${diagnostic.category}/${diagnostic.code}，${diagnostic.stage}，已观察启动=${diagnostic.started}）` : ""}，请在目标会话通过 /resume 重试原请求` : "等待兼容宿主继续原任务"}` : view.interaction?.state === "expired" ? "审批已过期，请在目标会话继续刷新" : view.interaction?.state === "unconfirmed" ? "交互状态待确认，请稍后刷新" : view.warning === "summary_lag" ? "执行状态尚未同步，当前审批仍待处理" : view.execution === "lost" ? "执行已失联，结果未确认" : view.execution === "unconfirmed" ? "执行状态待确认，结果未确认" : undefined;
    if (notice && notice !== entry.interactionNotice) entry.store.addNotice(notice);
    if (view.waiting === "user_input" && view.interaction?.state === "pending" && view.interaction.question) {
      const questionNotice = JSON.stringify([view.turnId, view.interaction.question.requestId]);
      if (entry.interactionNotice !== questionNotice) {
        const first = view.interaction.question.questions[0];
        entry.store.addNotice([`等待回答 ${first.header}`, first.question, ...first.options.map(function option(item, n) { return `${n + 1}. ${item.label} — ${item.description}`; }), "在目标会话输入选项编号或自定义答案；/resume重新显示问题"].join("\n"));
      }
      entry.interactionNotice = questionNotice;
    } else entry.interactionNotice = notice;
    syncCurrentInteraction(entry);
  }

  /** 无论正文是否打开均独立分页追踪交互，最多100事件，不回放正文、不启动目标。 */
  async function refreshInteraction(entry: CliSessionEntry): Promise<void> {
    if (!options.readEventPage || !entry.summaryTurnId || entry.controller.isExecuting?.()) return;
    const turnId = entry.summaryTurnId; const status = entry.summaryStatus; const controller = entry.controller;
    if (status !== "running" && status !== "waiting_approval" && status !== "waiting_user_input") { entry.summaryApproval = undefined; entry.summaryReady = true; syncCurrentInteraction(entry); return; }
    const page = await options.readEventPage(entry.sessionId, { cursor: entry.summaryCursor, limit: 100 });
    if (stopped || entry.summaryTurnId !== turnId || entry.summaryStatus !== status || entry.controller !== controller || controller.isExecuting?.()) return;
    if (!entry.opened) entry.controller.observe?.(page.items.filter(function light(envelope) { return envelope.turnId === turnId && ["turn_started", "approval_required", "todo_updated", "turn_paused", "turn_completed", "turn_failed", "turn_interrupted", "question_required"].includes(envelope.event.type); }));
    for (const envelope of page.items) {
      if (envelope.turnId !== turnId) continue;
      if (envelope.event.type === "turn_started" || envelope.event.type === "turn_completed" || envelope.event.type === "turn_failed" || envelope.event.type === "turn_interrupted") entry.summaryApproval = undefined;
      if (envelope.event.type === "approval_required") entry.summaryApproval = envelope;
    }
    entry.summaryCursor = page.cursor ?? page.nextCursor ?? entry.summaryCursor;
    entry.summaryReady = !page.nextCursor;
    syncCurrentInteraction(entry);
  }

  /** 对精确目标读取最多100事件；未翻完旧历史时不会自动全量追赶。 */
  async function loadHistory(sessionId = selectedId): Promise<void> {
    const entry = entries.get(sessionId);
    if (!entry || !entry.opened || entry.historyLoading || stopped) return;
    if (!options.readEventPage) throw new Error("CLI_SESSION_HISTORY_UNAVAILABLE");
    entry.historyLoading = true;
    try {
      const page = await options.readEventPage(sessionId, { cursor: entry.historyCursor, limit: 100 });
      if (stopped || selectedId !== sessionId || entry.controller.isExecuting?.()) return;
      const through = page.nextCursor ? Date.parse(page.items[page.items.length - 1]?.timestamp ?? "") : Infinity;
      const prompts = (entry.pendingPrompts ?? []).filter(function visible(message) { return message.createdAt <= through; });
      entry.pendingPrompts = (entry.pendingPrompts ?? []).filter(function later(message) { return message.createdAt > through; });
      const history = [...prompts.map(function prompt(message) { return { at: message.createdAt, prompt: message.content, event: undefined as AgentEventEnvelope | undefined }; }), ...page.items.map(function event(envelope) { return { at: Date.parse(envelope.timestamp), prompt: undefined as string | undefined, event: envelope }; })].sort(function chronological(a, b) { return a.at - b.at; });
      for (const item of history) { if (item.event) entry.controller.observe?.([item.event]); else if (item.prompt) entry.store.recordPrompt(item.prompt); }
      if (entry.summaryKnown) { reconcileObservedIdentity(entry, { activeTurnId: entry.summaryTurnId, status: entry.summaryStatus }); syncCurrentInteraction(entry); }
      entry.historyCursor = page.cursor ?? page.nextCursor ?? entry.historyCursor;
      entry.historyMore = Boolean(page.nextCursor);
      entry.hydrated = true;
    } finally { entry.historyLoading = false; notify(); }
  }

  /** 只提取当前关联Turn的审批/阻塞/阶段/终态，不把回答或工具正文搬进隐藏状态。 */
  async function refresh(): Promise<void> {
    if (refreshing || stopped) return;
    refreshing = true;
    const abort = new AbortController(); refreshAbort = abort;
    try {
      const observedId = selectedId;
      const summary = await options.readSummary?.(observedId, abort.signal);
      if (abort.signal.aborted || stopped || selectedId !== observedId) return;
      const observed = entries.get(observedId);
      if (observed && summary) {
        if (summary.executionView && !observed.controller.isExecuting?.()) applyExecutionView(observed, summary.executionView);
        else {
          if (summary.status !== undefined && !observed.controller.isExecuting?.()) reconcileObservedIdentity(observed, { status: summary.status, activeTurnId: summary.currentTurnId ?? summary.activeTurnId });
          if (summary.status !== undefined) await refreshInteraction(observed);
        }
        const title = getCliSessionDisplayTitle(summary.title, observedId);
        if (observed.title !== title) { observed.title = title; directory.set(observedId, { sessionId: observedId, title }); notify(); }
      }
      const relations = await options.readRelations?.(observedId, abort.signal) ?? [];
      if (abort.signal.aborted || stopped || selectedId !== observedId) return;
      let changed = false;
      for (const relation of relations) {
        if (abort.signal.aborted || stopped || selectedId !== observedId) return;
        if (relation.threadId === observedId || relation.parentThreadId !== observedId) continue;
        const active = relation.status === "running" || relation.status === "waiting_approval" || relation.status === "waiting_user_input";
        let entry = entries.get(relation.threadId);
        if (!entry && !active) continue;
        if (!entry) { entry = attach(relation.threadId, relation.title, options.createController(relation.threadId), false); changed = true; }
        const title = getCliSessionDisplayTitle(relation.title, relation.threadId);
        if (entry.title !== title || entry.parentSessionId !== observedId) changed = true;
        entry.title = title; entry.parentSessionId = observedId;
        if (relation.executionView && !entry.controller.isExecuting?.()) applyExecutionView(entry, relation.executionView);
        else {
          if (!entry.controller.isExecuting?.()) reconcileObservedIdentity(entry, relation);
          if (active && relation.activeTurnId) await refreshInteraction(entry);
        }

      }
      if (abort.signal.aborted || stopped || selectedId !== observedId) return;
      const entry = entries.get(observedId)!;
      if (entry.opened && (!entry.hydrated || !entry.historyMore && entry.historyCursor) && !entry.controller.isExecuting?.()) await loadHistory(entry.sessionId);
      if (changed) notify();
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally { if (refreshAbort === abort) refreshAbort = undefined; refreshing = false; }
  }

  /** 原目标结果只写原Store，picker仍由前台App消费。 */
  function handleResult(entry: CliSessionEntry, result: CliControllerResult): void {
    entry.store.syncProjection(entry.controller.getProjection());
    if (result.kind === "error" && selectedId !== entry.sessionId) entry.unread = true;
    if (!result.skillOptions && !result.permissionOptions && !result.modelOptions && !result.effortOptions && !result.jobView && !result.contextView) {
      for (const line of result.lines) if (line.trim() && !line.startsWith("input queued:") && !line.startsWith("queued input started:")) entry.store.addNotice(line);
      if (!result.lines.length && result.message) entry.store.addNotice(result.message);
    }
    notify();
  }

  /** 选择只打开精确UUID的视图和首历史页，绝不调用resume/continue/start。 */
  async function select(sessionId: string): Promise<void> {
    refreshAbort?.abort();
    const generation = ++selectionGeneration;
    let entry = entries.get(sessionId);
    if (!entry) {
      if (!directory.has(sessionId)) return;
      const session = await options.runtime.sessions.get(sessionId);
      if (!session || session.productMode !== "work" || session.projectId !== options.projectId || stopped || generation !== selectionGeneration) return;
      entry = attach(session.id, session.title, options.createController(session.id), true);
      entry.pendingPrompts = session.presentation?.messages.filter(function user(message) { return message.role === "user"; }) ?? [];
    } else if (!entry.opened) {
      const session = await options.runtime.sessions.get(sessionId);
      if (!session || session.productMode !== "work" || session.projectId !== options.projectId || stopped || generation !== selectionGeneration) return;
      entry.opened = true; entry.hydrated = false;
      entry.pendingPrompts = session.presentation?.messages.filter(function user(message) { return message.role === "user"; }) ?? [];
      bind(entry);
    }
    selectedId = sessionId; entry.unread = false; notify();
    if (!entry.hydrated || !entry.historyMore && entry.historyCursor) await loadHistory(sessionId);
  }

  /** 停止本宿主轮询和正在执行的精确目标，等待审批原样保留。 */
  async function stop(): Promise<CliSessionExitReport> {
    stopped = true; refreshAbort?.abort(); if (timer) clearInterval(timer);
    for (const entry of entries.values()) entry.controller.beginShutdown?.();
    const report: CliSessionExitReport = { stopped: [], waiting: [], recoverable: [], unconfirmed: [] };
    for (const entry of entries.values()) {
      const view = entry.controller.getProjection();
      if (view.status === "waiting_approval" || view.status === "waiting_user_input") { report.waiting.push(entry.sessionId); continue; }
      if (entry.controller.isExecuting?.() && view.status === "running" && view.turnId) {
        const targetTurn = view.turnId;
        try { await entry.controller.dispatch({ type: "cancel_turn" }); const session = await options.runtime.sessions.get(entry.sessionId); if (session?.activeTurnId === targetTurn && session.status === "running") report.unconfirmed.push(entry.sessionId); else report.stopped.push(entry.sessionId); }
        catch { report.unconfirmed.push(entry.sessionId); }
      } else if (view.recoverable) report.recoverable.push(entry.sessionId);
      else if (view.status === "running") report.unconfirmed.push(entry.sessionId);
    }
    return report;
  }

  return {
    entries: function list() { return [...entries.values()]; },
    directory: function listDirectory() { return [...directory.values()]; },
    directoryState: function directoryState() { return { loading: directoryLoading, more: !directoryLoaded || Boolean(directoryCursor) }; },
    selected: function selected() { return entries.get(selectedId)!; },
    related: function related(sessionId = selectedId) { return [...entries.values()].filter(function child(entry) { return entry.sessionId !== sessionId && entry.parentSessionId === sessionId; }); },
    select, refresh, loadDirectory, loadHistory, handleResult, stop,
    subscribe: function subscribe(listener: () => void) { listeners.add(listener); return function unsubscribe() { listeners.delete(listener); }; },
    /** 首屏不等待历史；仅已打开/关联活动目标后续按游标有界观察。 */
    start: function start() {
      void loadHistory(initial.sessionId).catch(function failed() { initial.store.addNotice("历史暂不可用，可按Ctrl+L重试"); });
      void refresh().catch(function failed() { initial.store.addNotice("关联任务观察暂不可用"); });
      timer = setInterval(function observe() { void refresh().catch(function failed() { entries.get(selectedId)?.store.addNotice("关联任务观察暂不可用"); }); }, 1000); timer.unref?.();
    },
  };
}
/** TUI只依赖轻量目录接口，不接触底层存储。 */
export type CliSessionManager = ReturnType<typeof createCliSessionManager>;
