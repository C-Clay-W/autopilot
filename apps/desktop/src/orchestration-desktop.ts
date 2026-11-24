/** Desktop 产品装配：固定工作区绑定，运行独立于窗口/视图，全部派工继续经过 S5/H3。 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createNodeTrustPolicy } from "@autopilot-agent/adapters";
import type { AgentEventEnvelope } from "@autopilot-agent/core";
import type { ApPermissionMode, DesktopWorkspace } from "./workspace";
import { ManagedRuntimeHost } from "./managed-runtime-host";
import { ManagedFactsHost, type ManagedFactsLedger } from "./managed-facts-host";
import type { ManagedLeaseActivity, ManagedRuntimeReceipt } from "./managed-runtime-service";
import { checkoutEvidence } from "./orchestration-recovery";
import { confirmedAssignmentSession, controllerCancelReceipt, controllerControl, controllerReceipt, OrchestrationStore, saveControllerOperation, type ExecutionReference } from "./orchestration-store";
import { OrchestrationService, orchestrationId, type CheckoutHolder } from "./orchestration-service";
import { OrchestrationHost } from "./orchestration-host";
import { canonicalCheckout, continuationAction } from "./orchestration-admission";
import { readManagedRecord, writeManagedRecord } from "./managed-runtime-store";
import type { OrchestrationView, OrchestrationPreferences, OrchestrationUiCommand, OrchestrationInspection } from "./orchestration-contract";

import { executionSettled, hasRecoveryWork, recoverySummary } from "./recovery-dialogue";
import { intentBasis, settleDirectResponses, rebaseControllerCorrections, isTerminalInputTurn } from "./orchestration-intents";
import type { OrchestrationPromptAttachments, OrchestrationQueuedPrompt, OrchestrationRun, OrchestrationTerminalFileMentions } from "./orchestration-store";
import { canCancelTurn, isManagedApprovalDecision, type ApprovalContinuation } from "./orchestration-contract";
import { legacyApprovalContinuation } from "./orchestration-approval";
import { projectInteractions, currentInspection, interactionKey } from "./orchestration-interactions";
import type { ManagedCloseTarget, ManagedExecutorTarget, ManagedTerminalFrame } from "./managed-terminal-host";
import { currentApproval, receiptStatus, approvalContinuationStatus, pendingMessage, turnStatus } from "./orchestration-presentation";
import type { OrchestrationBrowser } from "./orchestration-browser";
import { ExecutorHandoffComplete, saveExecutorInput, saveRelayAnswer } from "./orchestration-relay";
import { finishResult, saveFinish } from "./orchestration-finish";
import { recordViewCloseProgress, viewCloseActivity } from "./orchestration-view-close";
import { parseOrchestrationTemplate } from "../../cli/src/orchestration-templates";
import { orchestrationSkillRef } from "./orchestration-skill";

const ORCHESTRATION_TERMINAL_HELP = [
  "编排主控帮助",
  "",
  "任务与派工",
  "直接输入需求  提交目标或追加需求",
  "/queue <需求>  等当前 Turn 成功后处理排队输入",
  "/pause  暂停新派工",
  "/dispatch  恢复自动派工",
  "/finish run [原因]  为整个 Run 有序收尾",
  "/finish step <步骤ID> [原因]  为指定步骤有序收尾",
  "/batch approve  确认待处理的扩员批次",
  "/batch deny  拒绝待处理的扩员批次",
  "",
  "主控操作",
  "/status  查看主控状态、待处理事项和审批 ID",
  "/allow <审批ID>  保存一次性批准",
  "/deny <审批ID>  保存拒绝决定",
  "/answer <回答JSON>  保存问题回答",
  "/resume  继续可恢复的原主控 Turn",
  "/cancel  请求停止当前主控 Turn",
  "Esc  在聊天输入区请求停止当前主控 Turn",
  "",
  "执行者操作",
  "/agent <委派ID> status  查看 Turn、审批 ID 和安全预览",
  "/agent <委派ID> approve <审批ID>  保存一次性批准",
  "/agent <委派ID> deny <审批ID>  保存拒绝决定",
  "/agent <委派ID> answer <回答JSON>  保存问题回答",
  "/agent <委派ID> resume  继续可恢复的原执行者 Turn",
  "/agent <委派ID> cancel  请求停止当前执行者 Turn",
  "",
  "手动保存审批或回答后，用对应的 resume 命令继续原 Turn。",
  "回答 JSON 包含 questionId 与 answers。每项回答含 id、selected，可附 custom。",
  "",
  "历史执行恢复",
  "/recover  核查原 Run 的执行",
  "/reconnect  连接已核查的原执行",
  "/reconnect accept  确认目录变化并连接原执行",
].join("\n");

interface DesktopSettings { schema: 1; modes: OrchestrationView["modes"]; preferences: OrchestrationPreferences }
interface InspectionRead { basis: string; checkedAt: number; pending: boolean; result: Promise<OrchestrationInspection | undefined>; value?: OrchestrationInspection }
interface RuntimeEntry { channel: ManagedRuntimeHost; facts: ManagedFactsHost; service: OrchestrationService; observed: Map<string, InspectionRead>; decided: Set<string> }
type DecisionCommand = Extract<OrchestrationUiCommand, { type: "control" | "controller" }>;

/** 图形交互只能要求宿主续接当次提交的原审批或原问题。 */
function interactionContinuation(command: DecisionCommand) {
  if (command.continueAfterApproval === undefined && command.continueAfterAnswer === undefined) return;
  const approval = command.continueAfterApproval !== undefined;
  const id = approval ? command.approvalId : command.questionId;
  if (!command.runId || typeof id !== "string" || !/^[\w-]{1,128}$/u.test(id) || command.jobId !== undefined) throw new Error("DESKTOP_IPC_DENIED");
  if (approval ? command.continueAfterApproval !== true || command.continueAfterAnswer !== undefined || command.operation !== "approval" || !isManagedApprovalDecision(command.decision) || command.questionId !== undefined || command.answers !== undefined
    : command.continueAfterAnswer !== true || command.operation !== "answer" || command.approvalId !== undefined || command.decision !== undefined || !Array.isArray(command.answers)) throw new Error("DESKTOP_IPC_DENIED");
  const operation = approval ? "approval" as const : "answer" as const;
  const identity = approval ? { approvalId: id } : { questionId: id };
  const target = { operation, requestId: command.requestId, ...identity, ...(approval ? { decision: command.decision } : { answers: command.answers }) };
  const resume = { operation: "resume" as const, requestId: orchestrationId(command.requestId, approval ? "resume-after-approval" : "resume-after-answer"), ...identity };
  return { id, target, resume, changed: approval ? "ORCHESTRATION_APPROVAL_CHANGED" : "ORCHESTRATION_QUESTION_CHANGED", unconfirmed: approval ? "ORCHESTRATION_APPROVAL_NOT_CONFIRMED" : "ORCHESTRATION_ANSWER_NOT_CONFIRMED", resumePending: approval ? "ORCHESTRATION_APPROVAL_SAVED_RESUME_PENDING" : "ORCHESTRATION_ANSWER_SAVED_RESUME_PENDING" };
}

/** 当前检查中必须仍呈现原交互 ID；Worker 续接时核对同一个 ID。 */
function matchesInteraction(inspection: OrchestrationInspection, identity: { approvalId?: string; questionId?: string }, state: "pending" | "decided"): boolean {
  const interaction = inspection.interaction;
  return interaction?.state === state && (identity.approvalId ? interaction.approval?.approvalId === identity.approvalId : interaction.question?.requestId === identity.questionId);
}
/** 只有同会话、同 Turn 的未确认请求阻止再发停止。 */
function pendingControllerCancel(run: OrchestrationRun, sessionId: string, turnId?: string) {
  const receipt = controllerCancelReceipt(run);
  return receipt?.state === "unconfirmed" && receipt.sessionId === sessionId && receipt.turnId === turnId ? receipt : undefined;
}
/** 只显示可从当前封批操作精确归属到唯一主控决定的拆分理由。 */
function batchReason(run: OrchestrationRun, batch: NonNullable<OrchestrationRun["batches"]>[number]): string | undefined {
  const seals = run.records.filter(function seal(record) { return record.action === "seal"; });
  if (run.batches?.at(-1) !== batch) return;
  const seal = batch.sealRequestId ? seals.find(function original(r) { return r.requestId === batch.sealRequestId; }) : seals.length === run.batches.length ? seals.at(-1) : undefined;
  const reasons = (run.pending ?? []).flatMap(function reasons(intent) {
    return [intent.decision, ...(intent.decisionHistory ?? [])].flatMap(function match(decision) {
      return decision?.actions.some(function action(entry, index) { return entry.kind === "relation" && entry.action.type === "seal" && orchestrationId(intent.id, String(index)) === seal?.requestId; }) ? [decision.reason] : [];
    });
  });
  return reasons.length === 1 ? reasons[0].trim().slice(0, 2000) || undefined : undefined;
}
/** 恢复入口只投影最近一次关闭接续记录的时间与 Run 版本。 */
function latestViewClose(run: OrchestrationRun) {
  for (let index = run.records.length - 1; index >= 0; index--) {
    const record = run.records[index];
    if (record.viewClose) return { at: record.at, revision: record.viewClose.revision };
  }
}

/** 一个 canonical Checkout 一个 Runtime，所有 Run 共用应用关系账本。 */
export class OrchestrationDesktop {
  readonly store: OrchestrationStore;
  private removing = new Set<string>();
  private terminalSessionIds = new Map<string, string>();
  private checkoutNotices = new Map<string, string>();
  private runtimes = new Map<string, RuntimeEntry>();
  private recoveries = new Map<string, { token: string; ready: boolean; changed: boolean; checks: string[]; revision: number; fingerprint?: string }>();
  private inspections = new Map<string, OrchestrationInspection>();
  private hosts = new Map<string, OrchestrationHost>();
  private closed = false;
  private recoveryOperations = new Map<string, Promise<void>>();
  private checkedResumes = new Set<string>();
  private serial = new Map<string, Promise<unknown>>();
  private cancelling = new Set<string>();
  private connections = new Map<string, Promise<void>>();
  private controllerStarts = new Map<string, Promise<void>>();
  private runtimeStarts = new Map<string, Promise<RuntimeEntry>>();
  private listeners = new Set<(sessionId?: string) => void>();
  constructor(private root: string, private workspaces: () => DesktopWorkspace[], private launch: (channel: ManagedRuntimeHost, checkout: string, stateRoot: string) => Promise<void>, private appVersion: string, private defaultApPermission: () => ApPermissionMode = function defaultPermission() { return "ask"; }, private browser?: OrchestrationBrowser) { this.store = new OrchestrationStore(join(root, "relations")); }

  /** 窗口只收到刷新提示，所有安全投影仍由固定快照 IPC 返回。 */
  subscribe(listener: (sessionId?: string) => void): () => void {
    this.listeners.add(listener);
    const listeners = this.listeners;
    return function unsubscribe() { listeners.delete(listener); };
  }

  /** 关键事实和决定确认后提示窗口刷新。 */
  private changed(sessionId?: string): void { for (const listener of this.listeners) listener(sessionId); }

  /** 只撤下精确匹配的已决请求，后续交互仍依赖可信事实。 */
  private decisionConfirmed(entry: RuntimeEntry, ref: ExecutionReference, turnId: string | undefined, operation: string, id: string | undefined, requestId: string, receipt?: ManagedRuntimeReceipt): boolean {
    if (!turnId || !id || !receipt || receipt.state !== "confirmed" || receipt.code || receipt.requestId !== requestId || receipt.operation !== operation || receipt.sessionId !== ref.sessionId || receipt.turnId !== turnId) return false;
    entry.observed.delete(ref.sessionId);
    entry.decided.add(interactionKey(ref, turnId, operation === "approval" ? "approval" : "question", id));
    this.changed(ref.sessionId);
    return true;
  }

  /** 同一会话的 CLI 回放与实时读取显示同一笔持久审批/恢复状态。 */
  private approvalNotice(run: OrchestrationRun, sessionId: string, inspection?: OrchestrationInspection, assignmentId?: string): string | undefined {
    const legacy = legacyApprovalContinuation(run, inspection, assignmentId);
    const item = currentApproval(run.approvalContinuations, sessionId, inspection) ?? legacy;
    return item ? approvalContinuationStatus(item) : undefined;
  }

  /** 浏览器身份沿实时编排工作区名称与固定 ID 装配，隐藏在受管 Host 内。 */
  private createHost(entry: RuntimeEntry, runId: string, workspaceId: string): OrchestrationHost {
    const desktop = this;
    return new OrchestrationHost(entry.service, entry.channel, entry.facts, runId, this.browser, function label(id) {
      return desktop.workspaces().find(function current(w) { return w.id === id && w.mode === "orchestration"; })?.name;
    }, workspaceId, async function recover(id) { await desktop.recoverApproval(workspaceId, id, "resume", runId); });
  }

  /** 当前导航显式定位 Run；旧账本兼容定位最后一个历史，不修改历史内容。 */
  private async currentRun(workspaceId: string) {
    const ledger = await this.store.read();
    return ledger.runs.find(function current(run) { return run.workspaceId === workspaceId && run.id === ledger.currentRunIds?.[workspaceId]; }) ?? ledger.runs.filter(function same(run) { return run.workspaceId === workspaceId; }).at(-1);
  }

  /** 终端代次由主进程读取所选 Run，渲染层只能声明期望目标供核对。 */
  async selectedTerminalRunId(workspaceId: string): Promise<string | undefined> {
    return (await this.currentRun(workspaceId))?.id;
  }

  /** 只有已核对创建的 AP Session 能获得独立终端能力。 */
  async executorTerminalTarget(workspaceId: string, runId: string, assignmentId: string): Promise<ManagedExecutorTarget> {
    const run = await this.currentRun(workspaceId);
    const item = run?.assignments.find(function same(a) { return a.id === assignmentId; });
    const sessionId = item && confirmedAssignmentSession(item);
    if (!this.workspaceAvailable(workspaceId) || run?.id !== runId || run.navigationRemoved || run.controller.executor !== "ap" || !sessionId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    return { runId, assignmentId, sessionId };
  }

  /** 关闭视图前核对整批目标和真实活动，等待进度回执期间保留原 Run 与终端输入。 */
  async prepareViewsClose(workspaceId: string, runId: string, views: ManagedCloseTarget[], remaining: () => boolean, isCurrent: () => boolean, confirm: () => Promise<boolean>, lastRecorded?: () => void): Promise<false | "inactive" | "active"> {
    const desktop = this;
    /** 同一组 Run 下的真实 Worker 活动，不从 renderer 声明的状态推断结束。 */
    async function inspect() {
      const run = await desktop.currentRun(workspaceId);
      if (!isCurrent() || !run || run.id !== runId || run.navigationRemoved || !desktop.workspaceAvailable(workspaceId)) throw new Error("ORCHESTRATION_RUN_MISMATCH");
      const entry = desktop.runtimes.get(run.checkout);
      if (!entry?.channel.isConnected() || !run.controller.execution) throw new Error("ORCHESTRATION_VIEW_CLOSE_UNKNOWN");
      const targets = await Promise.all(views.map(async function status({ id, sessionId }) {
        const assignment = id === "controller" ? undefined : run.assignments.find(function own(item) { return item.id === id; });
        const ref = id === "controller" ? run.controller.execution : assignment?.execution;
        if (!ref || (sessionId && sessionId !== ref.sessionId) || ref.hostId !== entry.channel.identity.hostId || ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation) throw new Error("ORCHESTRATION_VIEW_CLOSE_UNKNOWN");
        const activity = await entry.channel.command({ operation: "lease_activity", requestId: randomUUID(), sessionId: ref.sessionId }).catch(function unavailable() { throw new Error("ORCHESTRATION_VIEW_CLOSE_UNKNOWN"); }) as ManagedLeaseActivity;
        // 主控引用来自 Session 创建。执行者仍须与其已登记的 Turn 精确匹配。
        if (activity?.sessionId !== ref.sessionId || (assignment && activity.turnId !== ref.turnId)) throw new Error("ORCHESTRATION_VIEW_CLOSE_UNKNOWN");
        const state = viewCloseActivity(activity);
        if (!activity.turnId && (activity.execution === "active" || state === "waiting")) throw new Error("ORCHESTRATION_VIEW_CLOSE_UNKNOWN");
        return { assignment, ref, activity, state };
      }));
      if (!isCurrent()) throw new Error("ORCHESTRATION_VIEW_CLOSE_STALE");
      if (targets.some(function unknown(t) { return t.state === "unknown"; })) throw new Error("ORCHESTRATION_VIEW_CLOSE_UNKNOWN");
      if (!remaining() && targets.some(function active(t) { return t.state !== "inactive"; })) throw new Error("ORCHESTRATION_LAST_ACTIVE_TERMINAL");
      return { run, entry, targets };
    }
    const before = await inspect();
    const active = before.targets.some(function busy(target) { return target.state !== "inactive"; });
    if (active && !await confirm()) return false;
    const current = await inspect();
    for (const [index, target] of current.targets.entries()) {
      if (JSON.stringify(target.ref) !== JSON.stringify(before.targets[index].ref) || target.activity.turnId !== before.targets[index].activity.turnId) throw new Error("ORCHESTRATION_VIEW_CLOSE_STALE");
      if (target.state === "inactive") continue;
      if (before.targets[index].state === "inactive") throw new Error("ORCHESTRATION_VIEW_CLOSE_STALE");
      if (!target.assignment) continue;
      if (target.state === "waiting" || target.activity.execution !== "active" || !target.ref.turnId) throw new Error("ORCHESTRATION_VIEW_CLOSE_REPORT_WAITING");
      await recordViewCloseProgress(current.entry.service, current.entry.channel, current.run, target.assignment, views[index].viewId, isCurrent);
    }
    const final = await inspect();
    if (final.targets.some(function changed(target, index) { return JSON.stringify(target.ref) !== JSON.stringify(current.targets[index].ref) || target.activity.turnId !== current.targets[index].activity.turnId || target.state !== "inactive" && current.targets[index].state === "inactive"; })) throw new Error("ORCHESTRATION_VIEW_CLOSE_STALE");
    if (final.targets.some(function busy(target) { return target.state !== "inactive"; })) return "active";
    if (!remaining()) {
      const viewClose = { revision: final.run.revision, targets: final.targets.map(function identify({ assignment, activity }) {
        return { id: assignment?.id ?? "controller", sessionId: activity.sessionId, turnId: activity.turnId, status: activity.status, result: activity.result };
      }) };
      const digest = orchestrationId(JSON.stringify(viewClose));
      const requestId = orchestrationId("last-view-close", runId, ...views.map(function view(item) { return item.viewId; }).sort(), digest);
      const recorded = await this.store.update(function checkpoint(ledger) {
        const run = ledger.runs.find(function exact(item) { return item.id === runId && item.workspaceId === workspaceId; });
        if (!isCurrent() || !run || run.navigationRemoved || run.revision !== viewClose.revision) return "stale";
        if (remaining()) return "remaining";
        if (!run.records.some(function original(record) { return record.requestId === requestId; })) run.records.push({ requestId, digest, action: "human_last_view_close", at: new Date().toISOString(), viewClose });
        return "saved";
      }).catch(function failed() { throw new Error("ORCHESTRATION_VIEW_CLOSE_RECORD_FAILED"); });
      if (recorded === "stale") throw new Error("ORCHESTRATION_VIEW_CLOSE_STALE");
      if (recorded === "saved") {
        const verified = await inspect();
        if (verified.run.revision !== viewClose.revision || verified.targets.some(function changed(target, index) { return target.state !== "inactive" || target.activity.turnId !== final.targets[index].activity.turnId || JSON.stringify(target.ref) !== JSON.stringify(final.targets[index].ref); })) throw new Error("ORCHESTRATION_VIEW_CLOSE_STALE");
        lastRecorded?.();
      }
    }
    return "inactive";
  }

  /** 命令在原会话登记收尾；源文本原样入账，已保存请求从同一终端查询。 */
  private async finishFromTerminal(run: OrchestrationRun, entry: RuntimeEntry, frame: ManagedTerminalFrame, ref: ExecutionReference, isCurrent: () => boolean, assignment?: OrchestrationRun["assignments"][number]): Promise<string> {
    const text = frame.text?.trim() ?? "";
    const parts = text.split(/\s+/u);
    if (!frame.requestId || parts[0] !== "/finish") throw new Error("ORCHESTRATION_INVALID_COMMAND");
    const stepId = parts[1] === "step" ? parts[2] : parts[1] === "run" ? undefined : assignment?.stepId;
    if (parts[1] !== "run" && !stepId) return "用法：/finish run [原因] 或 /finish step <步骤ID> [原因]。";
    await saveFinish(entry.service, run.id, { requestId: frame.requestId, text: frame.text!, source: ref, assignmentId: assignment?.id, stepId }, isCurrent);
    this.changed(ref.sessionId);
    void this.hosts.get(run.id)?.drive().catch(function pending() { /* 已持久收尾范围，等原 Host 对账。 */ });
    return "收尾已登记。原终端会显示汇总及未完成项；审批和停止仍按原 Turn 处理。";
  }

  /** 按绑定会话读取精确事件与交互；恢复、审批和取消沿既有控制门。 */
  private async executorTerminalRequest(workspaceId: string, target: ManagedExecutorTarget, frame: ManagedTerminalFrame, isCurrent: () => boolean): Promise<unknown> {
    await this.executorTerminalTarget(workspaceId, target.runId, target.assignmentId);
    await this.connectControl(target.runId);
    const run = await this.currentRun(workspaceId);
    const entry = run && this.runtimes.get(run.checkout);
    const item = run?.assignments.find(function same(a) { return a.id === target.assignmentId; });
    const ref = item?.execution;
    if (!isCurrent() || !this.workspaceAvailable(workspaceId) || !run || run.id !== target.runId || run.navigationRemoved || !entry || !item || !ref
      || ref.sessionId !== target.sessionId || ref.hostId !== entry.channel.identity.hostId || ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    const requestId = frame.requestId ?? randomUUID();
    const executionToken = orchestrationId(JSON.stringify(ref));
    if (frame.operation === "read") {
      const inspection = await entry.channel.command({ operation: "inspect", requestId, sessionId: ref.sessionId }, true) as OrchestrationInspection;
      const page = await entry.channel.command({ operation: "transcript", requestId: randomUUID(), sessionId: ref.sessionId, cursor: frame.cursor }, true) as { items: AgentEventEnvelope[]; cursor?: string; nextCursor?: string };
      const startTurn = orchestrationId(ref.hostId, ref.sessionId, item.startRequestId);
      const started = !frame.cursor && (item.submission === "start" && (item.state === "active" || item.state === "released" || item.retiredForRepair)
        || page.items.some(function initial(e) { return e.sessionId === ref.sessionId && e.turnId === startTurn; }));
      const task = started ? { id: item.startRequestId, content: item.content } : undefined;
      const approval = inspection.interaction?.approval;
      const pendingApproval = approval?.display && item.state === "active" && ref.turnId && inspection.turnId === ref.turnId && inspection.interaction?.state === "pending"
        && !entry.decided.has(interactionKey(ref, ref.turnId, "approval", approval.approvalId)) ? { turnId: ref.turnId, approval } : undefined;
      // 首次附着尚未核清原启动时不推进游标，等确证后把 TASK 和首批事件一起交给终端。
      return { runId: run.id, sessionId: ref.sessionId, workspaceRoot: run.checkout, status: "AP 执行者" + this.finishNotice(run, ref.sessionId), task, cancelToken: executionToken, inspection, pendingApproval, approvalStatus: this.approvalNotice(run, ref.sessionId, inspection, item.id), page: frame.cursor || started ? page : undefined };
    }
    if (frame.operation === "cli" && !frame.action) return entry.channel.command({ operation: "cli", requestId, sessionId: ref.sessionId }, true);
    if (frame.executionToken !== executionToken || !frame.requestId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    if (frame.operation === "cli" && frame.action?.type === "approve") {
      const { decision, expected } = frame.action;
      if (!ref.turnId || expected?.sessionId !== ref.sessionId || expected.turnId !== ref.turnId || !isManagedApprovalDecision(decision)) throw new Error("DESKTOP_IPC_DENIED");
      try {
        await this.command({ type: "control", workspaceId, runId: run.id, revision: run.revision, assignmentId: item.id, executionToken, requestId: frame.requestId, operation: "approval", approvalId: expected.approvalId, decision, continueAfterApproval: true }, isCurrent);
        const saved = (await this.currentRun(workspaceId))?.approvalContinuations?.find(function same(record) { return record.sessionId === ref.sessionId && record.turnId === ref.turnId && record.approvalId === expected.approvalId; });
        return { kind: "ok", exitCode: 0, lines: [saved ? approvalContinuationStatus(saved) : "审批决定已保存，恢复结果待核查。"] };
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "ORCHESTRATION_APPROVAL_SAVED_RESUME_PENDING") return { kind: "ok", exitCode: 0, lines: ["审批决定已保存，继续结果待核查。"] };
        return { kind: "error", exitCode: 1, lines: [code === "ORCHESTRATION_APPROVAL_CHANGED" || code === "ORCHESTRATION_RUN_MISMATCH" || code === "MANAGED_TERMINAL_STALE" ? "审批或会话已变化，本次决定未提交。" : "审批提交未确认，请核查原决定。"] };
      }
    }
    if (frame.operation === "input" && /^\/approval\s+(status|resume)$/u.test(frame.text?.trim() ?? "")) return this.approvalFromTerminal(run, ref.sessionId, item.id, frame.text!.trim().endsWith("resume") ? "resume" : "query");
    if (frame.operation === "input" && /^\/finish(?:\s|$)/u.test(frame.text?.trimStart() ?? "")) return this.finishFromTerminal(run, entry, frame, ref, isCurrent, item);
    if (frame.operation === "cli" && frame.action?.type === "submit_prompt" && frame.action.delivery !== "queue") {
      if (frame.questionId) return { kind: "error", exitCode: 1, lines: ["请在此会话的问答控件提交原问题的回答。"] };
      const result = await entry.channel.command({ operation: "cli", requestId, sessionId: ref.sessionId, action: frame.action }, true) as import("@autopilot-agent/cli/dist/controller.js").CliControllerResult;
      if (!result.preparedPrompt) return result;
      try { await saveExecutorInput(entry.service, run.id, item.id, ref, requestId, result.preparedPrompt, isCurrent); }
      catch (error) {
        if (error instanceof ExecutorHandoffComplete) return { kind: "error", exitCode: 1, lines: ["此执行者已完成交接，请在 AP 主控中提交新的需求"] };
        throw error;
      }
      this.changed(ref.sessionId);
      void this.hosts.get(run.id)?.drive(true).catch(function pending() { /* 输入原文已保存，等待原 Host 核查。 */ });
      return { ...result, preparedPrompt: undefined, lines: [...result.lines, "原文已保存并同步给主控。"], hostRecordedPrompt: result.preparedPrompt.content };
    }
    const operation = frame.operation === "cancel" && frame.turnId === ref.turnId ? "cancel" : frame.operation === "input" && frame.text === "/resume" ? "resume" : undefined;
    if (!operation) throw new Error("ORCHESTRATION_CONTROL_DENIED");
    if (operation === "resume") {
      const inspection = await entry.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: ref.sessionId }, true) as OrchestrationInspection;
      if (inspection.interaction?.state === "decided" && inspection.interaction.approval) return this.approvalFromTerminal(run, ref.sessionId, item.id, "resume");
    }
    await this.command({ type: "control", workspaceId, runId: run.id, revision: run.revision, assignmentId: item.id, executionToken, requestId, operation });
    return operation === "cancel" ? { message: "已请求停止原执行者 Turn，请核查原回执。" } : "已请求恢复原执行者 Turn，请核查原回执。";
  }

  /** 原入口在断线重开后仍从同一个范围记录读取最终回执。 */
  private finishNotice(run: OrchestrationRun, sessionId: string): string {
    return (run.finishes ?? []).filter(function source(f) { return f.source.sessionId === sessionId; }).map(function notice(f) {
      if (f.stop) {
        const controls = [...(f.controllerStops ?? []).map(function status(c) { return "主控 · " + receiptStatus(c); }),
          ...run.assignments.flatMap(function target(a) { return (a.controls ?? []).filter(function stop(c) { return c.operation === "cancel" || c.operation === "stop_job"; }).map(function status(c) { return a.id + " · " + receiptStatus({ ...c.receipt, operation: c.operation }); }); })];
        return "\n" + [f.receipt ? "整次编排停止已确认。" : "已停止新派工，正在核查原 Turn 和后台任务。", ...controls].join("\n");
      }
      const summary = f.receipt?.results.map(function result(r) {
        const item = run.assignments.find(function same(a) { return a.id === r.assignmentId; });
        return [r.assignmentId, item?.results.find(function same(x) { return x.id === r.resultId; })?.summary, ...r.unresolved].filter(Boolean).join(" · ");
      }).join("\n");
      return "\n" + (f.stepId ? "步骤 " + f.stepId : "整个 Run") + (f.receipt ? "收尾回执已保存" + (summary ? "\n" + summary : "") : "收尾中，等待在途报告与资源核查。");
    }).join("");
  }

  /** 只连接控制通道；核对原 Session/Turn 后换代，不恢复旧执行、不释放目录占用。 */
  private connectControl(runId: string): Promise<void> {
    const pending = this.connections.get(runId); if (pending) return pending;
    const desktop = this;
    const next = this.openControl(runId).finally(function done() { desktop.connections.delete(runId); });
    this.connections.set(runId, next); return next;
  }

  /** 导航生命周期按工作区身份核对；连接阶段可以失效，不等待终端反调命令。 */
  private workspaceAvailable(workspaceId: string): boolean {
    return !this.removing.has(workspaceId) && !this.store.navigationRemoved(workspaceId) && this.workspaces().some(function same(workspace) { return workspace.id === workspaceId; });
  }

  /** 控制重连不要求目录摘要或所有 Job 停止；执行恢复仍走独立核查。 */
  private async openControl(runId: string): Promise<void> {
    const run = (await this.store.read()).runs.find(function same(r) { return r.id === runId; });
    if (!run || run.navigationRemoved || !this.workspaceAvailable(run.workspaceId)) return;
    const starting = this.controllerStarts.get(run.workspaceId);
    if (starting) {
      await starting;
      return this.openControl(runId);
    }
    if (this.hosts.has(runId) && this.runtimes.get(run.checkout)?.facts.status().ledger?.connection.state === "connected") return;
    if (!run.controller.execution) {
      const trust = await createNodeTrustPolicy({ stateRoot: join(this.root, "runtimes", orchestrationId(run.checkout)) }).getTrustStatus(run.checkout);
      if (trust.status !== "trusted") throw new Error("ORCHESTRATION_TRUST_REQUIRED");
    }
    this.hosts.get(runId)?.close(); this.hosts.delete(runId);
    const entry = await this.runtime(run.checkout);
    if (!this.workspaceAvailable(run.workspaceId)) return;
    if (!run.controller.execution) {
      await this.initializeController(entry, run);
      return;
    }
    const desktop = this;
    const refs = [run.controller.execution, ...run.assignments.map(function ref(a) { return a.execution; })];
    let settled = !!run.controller.execution;
    let controllerInspection: OrchestrationInspection | undefined;
    for (const ref of refs) {
      if (!ref) { settled = false; continue; }
      try {
        const inspection = await entry.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: ref.sessionId }, true) as OrchestrationInspection;
        if (!this.workspaceAvailable(run.workspaceId)) return;
        if (ref.turnId && ref.turnId !== inspection.turnId) { settled = false; continue; }
        settled &&= executionSettled(inspection);
        if (ref.sessionId === run.controller.execution?.sessionId) controllerInspection = inspection;
        await this.store.update(function rebind(ledger) {
          const current = ledger.runs.find(function same(r) { return r.id === runId; })!;
          if (current.navigationRemoved || !desktop.workspaceAvailable(current.workspaceId)) return;
          const target = [current.controller.execution, ...current.assignments.map(function ref(a) { return a.execution; })].find(function same(r) { return r?.sessionId === ref.sessionId; });
          if (target) { target.owner = entry.channel.identity.owner; target.generation = entry.channel.identity.generation; }
        });
        if (!this.workspaceAvailable(run.workspaceId)) return;
        try { await entry.facts.register(ref.sessionId); } catch { /* H2失败不改变已核对的控制身份。 */ }
      } catch (error) { settled = false; console.info("[orchestration-control]", error instanceof Error && /^[A-Z][A-Z_]{1,80}$/.test(error.message) ? error.message : "ORCHESTRATION_CONTROL_UNCONFIRMED"); /* 未核清身份保留原占用。 */ }
    }
    // 重开补核已发送输入的原回执，不能仅因业务未验收而锁住已答复的对话。
    for (const intent of run.pending ?? []) if (intent.kind === "prompt" && intent.state === "pending" && intent.wake && !intent.decision) {
      try {
        const receipt = await entry.channel.command({ operation: "query", requestId: randomUUID(), targetRequestId: intent.wake.requestId }) as ManagedRuntimeReceipt;
        await this.store.update(function receiptSaved(ledger) { const current = ledger.runs.find(function same(r) { return r.id === runId; })!; const target = current.pending?.find(function same(i) { return i.id === intent.id; }); if (target?.wake) target.wake.receipt = receipt; });
      } catch { settled = false; }
    }
    await entry.service.reconcileControllerCheckout(runId);
    if (!this.workspaceAvailable(run.workspaceId)) return;
    const available = await this.store.update(function suspend(ledger) {
      const current = ledger.runs.find(function same(r) { return r.id === runId; })!;
      if (current.navigationRemoved || !desktop.workspaceAvailable(current.workspaceId)) return false;
      if (controllerInspection?.turnId) settleDirectResponses(current, current.controller.execution!.sessionId, { ...controllerInspection, turnId: controllerInspection.turnId, result: controllerInspection.status }, controllerInspection.activeJobs);
      const previouslyBlocked = current.controlOnly;
      current.controlOnly = !settled || hasRecoveryWork(current, ledger.leases?.some(function owned(l) { return l.runId === current.id; }) === true);
      if (current.controlOnly) current.paused = true;
      else if (previouslyBlocked) current.paused = false;
      current.revision++; rebaseControllerCorrections(current, current.revision - 1); return true;
    });
    if (!available || !this.workspaceAvailable(run.workspaceId)) return;
    const host = this.createHost(entry, runId, run.workspaceId);
    // 先登记，删除可撤销正在打开的 Host 订阅。
    this.hosts.set(runId, host);
    try { await host.open(); for (const item of run.approvalContinuations ?? []) this.checkFailedResume(run, item); }
    catch (error) { host.close(); if (this.hosts.get(runId) === host) this.hosts.delete(runId); throw error; }
  }

  /** 所有 Run 按工作区归属匹配在线 Worker 活动表，只复核命中的当前 Turn。 */
  async hasWorkingTurn(workspaceId: string): Promise<boolean> {
    const { runs } = await this.store.read();
    const sessions = new Map<RuntimeEntry, Set<string>>();
    for (const run of runs) {
      if (run.workspaceId !== workspaceId || run.navigationRemoved) continue;
      const entry = this.runtimes.get(run.checkout);
      if (!entry?.channel.isConnected() || entry.channel.identity.hostId !== run.hostId) continue;
      const owned = sessions.get(entry) ?? new Set<string>();
      sessions.set(entry, owned);
      const refs = [run.controller.execution, run.recoveryDialogue?.execution, ...(run.recoveryDialogue?.previousExecutions ?? []),
        ...run.assignments.flatMap(function refs(a) { return [a.execution, ...(a.previousExecutions ?? [])]; })];
      for (const ref of refs) if (ref?.hostId === run.hostId) owned.add(ref.sessionId);
    }
    const workers = await Promise.all(Array.from(sessions, async function inspect([entry, owned]) {
      if (!owned.size) return false;
      const active = await entry.channel.command({ operation: "active_turns", requestId: randomUUID() }).catch(function offline() { return undefined; });
      if (!Array.isArray(active)) return false;
      const working = await Promise.all(active.filter(function belongs(id) { return owned.has(id); }).map(async function confirm(sessionId: string) {
        const result = await entry.channel.command({ operation: "active_turns", requestId: randomUUID(), sessionId }).catch(function unknown() { return undefined; });
        return Array.isArray(result) && result.includes(sessionId);
      }));
      return working.includes(true);
    }));
    return workers.includes(true);
  }

  /** 提交导航删除后立即撤销编排入口，终端清理独立完成。 */
  async removeWorkspace(workspaceId: string, stopTerminals: () => Promise<void>): Promise<void> {
    this.removing.add(workspaceId);
    try { await this.store.removeNavigation(workspaceId); }
    catch (error) { this.removing.delete(workspaceId); throw error; }
    this.removing.delete(workspaceId);
    this.terminalSessionIds.delete(workspaceId);
    for (const [id, host] of this.hosts) if (host.desktopWorkspaceId === workspaceId) {
      host.close(); this.hosts.delete(id); this.checkoutNotices.delete(id); this.recoveries.delete(id);
    }
    void stopTerminals().catch(function failed() { console.warn("已删除工作区的终端收尾未确认。"); });
  }

  /** 存活 Worker 退出需明确确认，保留全部账本及 Checkout 占用。 */
  hasRuntime(): boolean { return this.runtimes.size > 0; }

  /** 偏好兼容新增，未知版本拒绝而不清空。 */
  private async settings(): Promise<DesktopSettings> {
    const value = await readManagedRecord<DesktopSettings>(join(this.root, "settings.json"), { schema: 1, modes: {}, preferences: { responsibility: "local", repairLimit: 2, automaticDispatch: true } });
    if (value.schema !== 1 || !value.modes || !value.preferences) throw new Error("ORCHESTRATION_SETTINGS_INVALID");
    return value;
  }

  /** 只查询原操作，不重发；异步结果必须仍属于同一请求和目标才能提交。 */
  private async reconcileController(runId: string): Promise<void> {
    const run = (await this.store.read()).runs.find(function same(r) { return r.id === runId; });
    if (!run) return;
    const latest = controllerControl(run), entry = this.runtimes.get(run.checkout), ref = run.controller.execution;
    if (!entry || !ref || entry.facts.status().ledger?.connection.state !== "connected" || ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation) return;
    const cancel = controllerCancelReceipt(run);
    const detached = cancel?.state === "unconfirmed" && cancel.requestId !== latest?.requestId
      ? { requestId: cancel.requestId, operation: cancel.operation, sessionId: cancel.sessionId, turnId: cancel.turnId } : undefined;
    for (const control of [latest, detached]) {
      if (!control || ref.sessionId !== control.sessionId) continue;
      const previous = control === latest ? controllerReceipt(control, run.controller.receipt) : cancel;
      if (previous?.state === "confirmed" || previous?.state === "rejected") continue;
      try {
        const receipt = controllerReceipt(control, await entry.channel.command({ operation: "query", requestId: randomUUID(), targetRequestId: control.requestId }, true) as ManagedRuntimeReceipt)!;
        await this.store.update(function reconcile(ledger) {
          const current = ledger.runs.find(function same(r) { return r.id === runId; });
          if (!current || current.controller.execution?.sessionId !== ref.sessionId || current.controller.execution.owner !== ref.owner || current.controller.execution.generation !== ref.generation) return;
          if (pendingControllerCancel(current, control.sessionId, control.turnId)?.requestId === control.requestId) current.controller.cancelReceipt = receipt;
          const currentControl = controllerControl(current);
          const currentReceipt = controllerReceipt(currentControl, current.controller.receipt);
          if (JSON.stringify(currentControl) !== JSON.stringify(control) || currentReceipt?.state === "confirmed" || currentReceipt?.state === "rejected") return;
          current.controller.control = control; current.controller.receipt = receipt;
        });
      } catch { /* 断连或未知结果保留原请求；下一次状态读取继续核查。 */ }
    }
  }

  /** 详情查询以已提交事实为基线，共享同一在途读并拒绝迟到的返回。 */
  private inspectionRead(entry: RuntimeEntry, ref: ExecutionReference, verify: boolean, requested: boolean): Promise<OrchestrationInspection | undefined> | undefined {
    const facts = entry.facts.projection()?.sessions[ref.sessionId];
    if (ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation || ref.hostId !== entry.channel.identity.hostId || facts?.reconciliation !== "consistent" || entry.facts.failedSessions().has(ref.sessionId)) return;
    const basis = JSON.stringify(facts.snapshot?.execution);
    const existing = entry.observed.get(ref.sessionId);
    if (!requested) return existing?.basis === basis ? Promise.resolve(existing?.value) : undefined;
    if (existing && existing.basis === basis && (existing.pending || !verify || Date.now() - existing.checkedAt < 5000)) return existing.result;
    const read: InspectionRead = { basis, checkedAt: Date.now(), pending: true, result: entry.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: ref.sessionId }, true).then(function observed(value) {
      if (entry.observed.get(ref.sessionId) !== read || !entry.channel.isConnected() || JSON.stringify(entry.facts.projection()?.sessions[ref.sessionId]?.snapshot?.execution) !== basis) return;
      read.value = value as OrchestrationInspection;
      return read.value;
    }).catch(function unavailable() { return undefined; }).finally(function settled() { read.pending = false; }) };
    entry.observed.set(ref.sessionId, read);
    return read.result;
  }

  /** 事件触发轻量投影，低频对账只核查待处理、未知或仍可能有活动的已关联 Session。 */
  async snapshot(reconcile = true, sessionIds?: readonly string[]): Promise<OrchestrationView> {
    const [settings, initialLedger] = await Promise.all([this.settings(), this.store.read()]);
    let ledger = initialLedger;
    const desktop = this;
    const checks = new Map<RuntimeEntry, Set<string>>();
    const requested = sessionIds && new Set(sessionIds);
    const controllerChecks: Promise<void>[] = [];
    const currentRunIds = new Map(ledger.runs.map(function current(run) { return [run.workspaceId, ledger.currentRunIds?.[run.workspaceId] ?? run.id]; }));
    for (const run of ledger.runs) {
      const entry = this.runtimes.get(run.checkout);
      const facts = entry?.facts.projection();
      if (!entry?.channel.isConnected() || facts?.connection.state !== "connected" || run.navigationRemoved || !this.hosts.has(run.id)) continue;
      const isCurrent = currentRunIds.get(run.workspaceId) === run.id;
      const verifyIds = checks.get(entry) ?? new Set<string>();
      for (const ref of [run.controller.execution, ...run.assignments.filter(function live(a) { return !["cancelled", "released"].includes(a.state); }).map(function target(a) { return a.execution; })]) {
        if (!ref || ref.owner !== facts.connection.owner || ref.generation !== facts.connection.generation) continue;
        const session = facts.sessions[ref.sessionId];
        if (!session) continue;
        const execution = session.snapshot?.execution;
        if (execution?.interaction?.state === "pending" || execution?.interaction?.state === "unconfirmed" || execution?.execution === "active" || isCurrent && (session.reconciliation !== "consistent" || entry.facts.failedSessions().has(ref.sessionId))) verifyIds.add(ref.sessionId);
      }
      if (verifyIds.size) checks.set(entry, verifyIds);
      const receipt = controllerReceipt(controllerControl(run), run.controller.receipt);
      if (reconcile && (receipt && !["confirmed", "rejected"].includes(receipt.state) || controllerCancelReceipt(run)?.state === "unconfirmed")) controllerChecks.push(this.reconcileController(run.id));
    }
    if (reconcile) {
      await Promise.allSettled([...controllerChecks, ...Array.from(checks, function refresh([entry, sessions]) { return entry.facts.refresh([...sessions]); })]);
      if (controllerChecks.length) ledger = await this.store.read();
    }
    const liveInspections = new Map<string, OrchestrationInspection>();
    const reads: Promise<void>[] = [];
    for (const run of ledger.runs) {
      const entry = this.runtimes.get(run.checkout);
      if (!entry?.channel.isConnected() || run.navigationRemoved || !this.hosts.has(run.id)) continue;
      const current = currentRunIds.get(run.workspaceId) === run.id;
      for (const ref of [run.controller.execution, ...run.assignments.filter(function live(a) { return !["cancelled", "released"].includes(a.state); }).map(function target(a) { return a.execution; })]) {
        if (!ref || !current && !checks.get(entry)?.has(ref.sessionId)) continue;
        const observed = this.inspectionRead(entry, ref, reconcile && current, !requested || requested.has(ref.sessionId));
        if (observed) reads.push(observed.then(function collect(inspection) { if (inspection) liveInspections.set(orchestrationId(JSON.stringify(ref)), inspection); }));
      }
    }
    const persistedFacts = new Map<string, ManagedFactsLedger | undefined>();
    const checkouts = new Set(ledger.runs.filter(function archived(run) { return !run.navigationRemoved && !desktop.runtimes.has(run.checkout); }).map(function root(run) { return run.checkout; }));
    await Promise.all([...reads, ...Array.from(checkouts, async function archived(checkout) {
      persistedFacts.set(checkout, await readManagedRecord<ManagedFactsLedger | undefined>(join(desktop.root, "runtimes", orchestrationId(checkout), "facts.json"), undefined));
    })]);
    return { modes: settings.modes, preferences: settings.preferences, runs: ledger.runs.filter(function visible(run) { return !run.navigationRemoved; }).map(function project(run) {
      const entry = desktop.runtimes.get(run.checkout);
      const connected = entry?.channel.isConnected() && entry.facts.projection()?.connection.state === "connected" && desktop.hosts.has(run.id);
      const factLedger = entry?.facts.projection() ?? persistedFacts.get(run.checkout);
      const sessions = factLedger?.sessions;
      const interactions = run.acceptance === "accepted" ? [] : projectInteractions(!!connected, factLedger, [{ execution: run.controller.execution }, ...run.assignments.filter(function active(a) { return !["cancelled", "released"].includes(a.state); }).map(function target(a) { return { assignmentId: a.id, execution: a.execution }; })], entry?.decided, entry?.facts.failedSessions()).filter(function undecided(i) { return !run.approvalContinuations?.some(function saved(item) { return i.kind === "approval" && item.sessionId === i.sessionId && item.turnId === i.turnId && item.approvalId === i.requestId && item.approval.state === "confirmed" && !item.approval.code; }); });
      const controllerFacts = sessions?.[run.controller.execution?.sessionId ?? ""];
      const observed = run.controller.execution ? liveInspections.get(orchestrationId(JSON.stringify(run.controller.execution))) : undefined;
      const trusted = !!connected && !!controllerFacts && !entry?.facts.failedSessions().has(controllerFacts.sessionId) && controllerFacts.reconciliation === "consistent" && run.controller.execution?.owner === entry?.channel.identity.owner && run.controller.execution?.generation === entry?.channel.identity.generation && !!observed && observed.turnId === controllerFacts.snapshot?.execution?.turnId && (!run.controller.execution?.turnId || run.controller.execution.turnId === observed.turnId);
      const controllerInspection = trusted ? currentInspection(observed, interactions, undefined, run.approvalContinuations?.filter(function own(i) { return i.sessionId === run.controller.execution?.sessionId; })) : undefined;
      const approvalContinuations = [...(run.approvalContinuations ?? [])];
      for (const legacy of [legacyApprovalContinuation(run, controllerInspection), ...run.assignments.map(function legacy(a) {
        return connected ? legacyApprovalContinuation(run, liveInspections.get(a.execution ? orchestrationId(JSON.stringify(a.execution)) : ""), a.id) : undefined;
      })]) if (legacy && !approvalContinuations.some(function same(item) { return item.id === legacy.id; })) approvalContinuations.push(legacy);

      const control = controllerControl(run);
      const receipt = controllerReceipt(control, run.controller.receipt);
      const cancel = controllerCancelReceipt(run);
      const waitingForGoal = trusted && !run.goal.trim() && !run.steps.length && !run.assignments.length && !run.prompts.length && controllerFacts?.reconciliation === "consistent" && !!controllerFacts.snapshot && !controllerFacts.snapshot.execution;
      return { id: run.id, workspaceId: run.workspaceId, revision: run.revision, goal: run.goal, controllerId: run.controller.execution?.sessionId, connected: !!connected, paused: run.paused, accepted: run.acceptance === "accepted", current: currentRunIds.get(run.workspaceId) === run.id, needsRecovery: !!run.controlOnly,
        controllerReceipt: receipt ? { ...control, requestId: receipt.requestId, sessionId: receipt.sessionId, turnId: receipt.turnId, state: receipt.state, code: receipt.code } : undefined,
        controllerCancelReceipt: cancel ? { requestId: cancel.requestId, operation: cancel.operation, sessionId: cancel.sessionId, turnId: cancel.turnId, state: cancel.state, code: cancel.code } : undefined,
        controllerToken: run.controller.execution ? orchestrationId(JSON.stringify(run.controller.execution), sessions?.[run.controller.execution.sessionId]?.snapshot?.execution?.turnId ?? "idle") : undefined,
        interactions,
        controllerInspection,
        approvalContinuations,
        waitingForGoal,
        controllerCanCancel: trusted && canCancelTurn(controllerInspection),
        recovery: desktop.recoveries.get(run.id), recoverySummary: run.controlOnly ? recoverySummary(run) : undefined, lastViewClose: latestViewClose(run),
        checkoutLabel: run.checkout, controllerStatus: controllerInspection?.status ?? "unknown", controllerExecution: controllerInspection?.execution ?? "unconfirmed", controllerJobs: controllerInspection ? controllerInspection.activeJobs ? "active" : "inactive" : "unknown",
        handoffs: run.handoffs?.map(function handoff(h) { return { requestId: h.requestId, assignmentId: h.assignmentId, fromAssignmentId: h.fromAssignmentId, scope: h.scope, received: !!h.received }; }),
        finishes: run.finishes?.map(function finish(f) { return { requestId: f.requestId, text: f.text, assignmentId: f.assignmentId, stepId: f.stepId, stop: f.stop, completed: !!f.receipt, controllerStops: f.controllerStops?.map(function status(c) { return { requestId: c.requestId, operation: c.operation, state: c.state, code: c.code }; }),
          targets: f.targets.map(function target(t) {
            const item = run.assignments.find(function same(a) { return a.id === t.assignmentId; });
            const final = f.receipt?.results.find(function same(r) { return r.assignmentId === t.assignmentId; });
            const result = final ? item?.results.find(function same(r) { return r.id === final.resultId; }) : item && finishResult(item);
            const notice = item?.controls?.find(function same(c) { return c.requestId === t.noticeId; })?.receipt;
            return { assignmentId: t.assignmentId, state: item?.state ?? "unknown", report: result?.summary, checks: result?.checks ?? [], unresolved: final?.unresolved ?? result?.unresolved ?? [],
              notice: notice?.state === "confirmed" && (notice.operation === "start" || notice.inputStatus === "consumed") ? "consumed" : notice?.state, accepted: final?.accepted ?? false };
          }) }; }),
        steps: run.steps.map(function step(s) { return { id: s.id, goal: s.goal, dependencies: s.dependencies, deliverables: s.deliverables, accepted: s.verdict?.accepted === true, repairs: s.repairs }; }),
        assignments: run.assignments.map(function assignment(a) {
          const facts = sessions?.[a.execution?.sessionId ?? ""];
          const inspection = liveInspections.get(a.execution ? orchestrationId(JSON.stringify(a.execution)) : "");
          const trustedFacts = !!connected && !!facts && !entry?.facts.failedSessions().has(facts.sessionId) && facts.reconciliation === "consistent" && a.execution?.owner === entry?.channel.identity.owner && a.execution?.generation === entry?.channel.identity.generation;
          const current = trustedFacts && !!inspection && inspection.turnId === a.execution?.turnId && inspection.turnId === facts.snapshot?.execution?.turnId;
          const controls = a.controls ?? [];
          const start = controls.findIndex(function segment(c) { return c.operation === "start" && c.requestId === a.execution?.requestId; });
          return { id: a.id, stepId: a.stepId, content: a.content, state: a.state, takeover: a.takeover,
            canCancel: current && canCancelTurn(inspection),
            native: trustedFacts && a.execution?.turnId === facts.snapshot?.execution?.turnId && !["unconfirmed", "lost"].includes(facts.snapshot?.execution?.execution ?? "unconfirmed") ? facts.snapshot?.execution?.status ?? "unknown" : "unknown", source: connected ? "Core / H2" : "Host 最后可信记录",
            sessionId: a.execution?.sessionId, terminalSessionId: confirmedAssignmentSession(a),
            directInputs: a.directInputs?.map(function input(i) { return { requestId: i.requestId, text: run.prompts[i.promptVersion - 1]?.text ?? "", state: i.state, impact: i.impact, result: i.result, decision: i.decision, delivery: i.delivery?.receipt?.state, questionId: i.question?.requestId }; }),
            executionToken: a.execution ? orchestrationId(JSON.stringify(a.execution)) : undefined,
            occupied: ledger.leases?.some(function owns(l) { return l.runId === run.id && l.assignmentId === a.id; }) === true,
            local: { phase: a.local.phase, source: a.local.source, handoff: a.local.handoff, obligations: a.local.obligations, skills: a.local.skills.map(function skill(s) { return s.name + (s.version ? " @ " + s.version : " · 版本未知"); }), cooperation: a.local.cooperation },
            results: a.results.map(function result(r) { return { id: r.id, summary: r.summary, outcome: r.outcome, checks: r.checks, unresolved: r.unresolved, evidence: r.evidence }; }),
            controls: controls.map(function control(c) { return { requestId: c.requestId, operation: c.operation, state: c.receipt.state, code: c.receipt.code }; }),
            pendingResume: controls.slice(start + 1).some(function pending(c) { return c.operation === "resume" && c.receipt.state === "unconfirmed" && (!c.receipt.turnId || c.receipt.turnId === a.execution?.turnId); }),
            inspection: current ? currentInspection(inspection, interactions, a.id, approvalContinuations.filter(function own(i) { return i.sessionId === a.execution?.sessionId; })) : undefined,
            activity: Object.values(facts?.facts ?? {}).filter(function same(f) { return f.turnId === a.execution?.turnId; }).slice(-40).map(function event(f) { return { id: f.eventId, type: f.eventType, source: f.source, at: f.timestamp }; }),
          };
        }),
        pending: (run.acceptance === "accepted" || run.finishes?.some(function whole(f) { return !f.stepId; }) ? [] : run.pending ?? []).filter(function pending(i) { return i.state === "pending"; }).map(function pending(i) { const interrupted = i.kind === "prompt" && controllerInspection?.execution === "inactive" && controllerInspection.status === "interrupted"; return { id: i.id, assignmentId: i.assignmentId, source: i.source, reason: i.attention === "input_too_large" ? i.attention : i.decision?.error ?? (interrupted ? !i.wake ? "input_waiting_recovery" : (i.wake.turnId ?? i.wake.receipt?.turnId) === controllerInspection.turnId ? "controller_interrupted" : "wake_unconfirmed" : i.attention ?? i.kind) }; }),
        batches: (run.batches ?? []).filter(function current(b) { return b.planVersion === run.planVersion; }).map(function batch(b) {
          const tasks = b.assignmentIds.flatMap(function task(id) {
            const assignment = run.assignments.find(function same(a) { return a.id === id; });
            const step = run.steps.find(function same(s) { return s.id === assignment?.stepId; });
            return assignment && step ? [{ id, content: assignment.content, stepId: step.id, stepGoal: step.goal, scope: step.scope, purpose: assignment.purpose, checkout: assignment.checkout, access: assignment.access, dependencies: step.dependencies, deliverables: step.deliverables }] : [];
          });
          return { planVersion: b.planVersion, digest: b.digest, state: b.state, assignmentIds: b.assignmentIds, maxConcurrent: run.policy.maxConcurrent, reason: b.state === "pending" ? batchReason(run, b) : undefined, tasks };
        }),
      };
    }) };
  }

  /** 固定白名单与串行接纳；Renderer 不得提交 actor、目录、Worker 或 Runtime 参数。 */
  command(value: unknown, isCurrent = function current() { return true; }): Promise<void> {
    const desktop = this;
    const queueKey = ["preferences", "mode"].includes((value as { type?: string })?.type ?? "") ? "settings" : (value as { workspaceId?: string })?.workspaceId ?? "settings";
    const next = (this.serial.get(queueKey) ?? Promise.resolve()).then(async function execute() {
      if (!isCurrent()) throw new Error("MANAGED_TERMINAL_STALE");
      if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 40000) throw new Error("DESKTOP_IPC_DENIED");
      const command = value as OrchestrationUiCommand;
      if (command.type === "preferences") {
        const p = command.value;
        if (Object.keys(command).some(function extra(k) { return !["type", "value"].includes(k); }) || !p || Object.keys(p).some(function extra(k) { return !["responsibility", "repairLimit", "automaticDispatch", "executorLayout"].includes(k); }) || !["local", "controller"].includes(p.responsibility) || !Number.isSafeInteger(p.repairLimit) || p.repairLimit < 0 || p.repairLimit > 20 || typeof p.automaticDispatch !== "boolean" || p.executorLayout !== undefined && !["tab", "split"].includes(p.executorLayout)) throw new Error("DESKTOP_IPC_DENIED");
        const settings = await desktop.settings(); settings.preferences = structuredClone(p); await writeManagedRecord(join(desktop.root, "settings.json"), settings); return;
      }
      const keys = command.type === "approvalRecovery" ? ["type", "workspaceId", "runId", "id", "action"] : command.type === "selectRun" ? ["type", "workspaceId", "runId"] : command.type === "newTask" ? ["type", "workspaceId"] : command.type === "mode" ? ["type", "workspaceId", "mode"] : command.type === "enter" ? ["type", "workspaceId", "goal", "trust"] : command.type === "batch" ? ["type", "workspaceId", "revision", "planVersion", "digest", "approve"]
        : command.type === "pause" ? ["type", "workspaceId", "revision", "paused"]
        : command.type === "prompt" ? ["type", "workspaceId", "revision", "requestId", "text", "scope", "targetId"]
        : ["inspect", "takeover", "cancelPlanned", "cancelUnstarted", "abandonStopped", "query"].includes(command.type) ? ["type", "workspaceId", "revision", "assignmentId", "executionToken"]
        : command.type === "control" ? ["type", "workspaceId", "revision", "assignmentId", "executionToken", "requestId", "operation", "approvalId", "decision", "continueAfterApproval", "continueAfterAnswer", "questionId", "answers", "jobId"]
        : command.type === "checkRecovery" ? ["type", "workspaceId"]
        : command.type === "reconnect" ? ["type", "workspaceId", "token", "acceptCheckout"]
        : command.type === "controller" ? ["type", "workspaceId", "executionToken", "requestId", "operation", "approvalId", "decision", "continueAfterApproval", "continueAfterAnswer", "questionId", "answers", "jobId"] : [];
      if (keys.length && !keys.includes("runId")) keys.push("runId");
      if (!keys.length || Object.keys(command).some(function extra(k) { return !keys.includes(k); })) throw new Error("DESKTOP_IPC_DENIED");
      const workspace = desktop.workspaces().find(function target(w) { return w.id === command.workspaceId; });
      if (!workspace || desktop.removing.has(workspace.id) || desktop.store.navigationRemoved(workspace.id)) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
      if (command.type !== "selectRun" && command.runId && (await desktop.currentRun(workspace.id))?.id !== command.runId) throw new Error("ORCHESTRATION_RUN_MISMATCH");
      if (command.type === "selectRun") {
        await desktop.store.update(function select(ledger) {
          if (!ledger.runs.some(function owns(r) { return r.workspaceId === workspace.id && r.id === command.runId; })) throw new Error("ORCHESTRATION_RUN_MISSING");
          (ledger.currentRunIds ??= {})[workspace.id] = command.runId;
        }); return;
      }
      if (command.type === "newTask") { if (workspace.mode !== "orchestration") throw new Error("ORCHESTRATION_MODE_MISMATCH"); await desktop.openController(workspace, "", false, true); return; }
      if (command.type === "checkRecovery" || command.type === "reconnect") { await desktop.recover(workspace, command); return; }
      if (!["mode", "enter"].includes(command.type)) { const current = await desktop.currentRun(workspace.id); if (current) await desktop.connectControl(current.id); }
      if (command.type === "approvalRecovery") {
        if (!command.runId || typeof command.id !== "string" || !/^[\w-]{1,128}$/u.test(command.id) || !["query", "resume"].includes(command.action)) throw new Error("DESKTOP_IPC_DENIED");
        await desktop.recoverApproval(workspace.id, command.id, command.action); return;
      }
      if ((command.type === "control" || command.type === "controller") && command.continueAfterApproval !== undefined) {
        interactionContinuation(command);
        await desktop.submitApproval(workspace.id, command); return;
      }
      if (command.type === "controller") { await desktop.controller(workspace.id, command); return; }
      if (!["mode", "enter", "batch"].includes(command.type)) {
        if (!Number.isSafeInteger((command as { revision: number }).revision)) throw new Error("DESKTOP_IPC_DENIED");
        const run = await desktop.currentRun(workspace.id);
        const entry = run && desktop.runtimes.get(run.checkout); const host = run && desktop.hosts.get(run.id);
        if (!run || !entry || !host) throw new Error("ORCHESTRATION_RECOVERY_REQUIRED");
        const human = entry.service.bind(run!.id, { kind: "human" });
        if (command.type === "pause") {
          if (typeof command.paused !== "boolean") throw new Error("DESKTOP_IPC_DENIED");
          await human.pause(command.revision, command.paused);
        } else if (command.type === "prompt") {
          if (typeof command.requestId !== "string" || !/^[\w-]{1,128}$/.test(command.requestId) || typeof command.text !== "string" || !command.text.trim() || command.text.length > 16000) throw new Error("DESKTOP_IPC_DENIED");
          await host.prompt({ requestId: command.requestId, expectedRevision: command.revision, action: { type: "prompt", text: command.text, scope: command.scope, targetId: command.targetId } });
        } else if (command.type === "control" || command.type === "inspect" || command.type === "takeover" || command.type === "cancelPlanned" || command.type === "cancelUnstarted" || command.type === "abandonStopped" || command.type === "query") {
          const item = run.assignments.find(function target(a) { return a.id === command.assignmentId; });
          if (!item || (item.execution ? orchestrationId(JSON.stringify(item.execution)) : undefined) !== command.executionToken) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
          if (command.type === "cancelPlanned") await human.command({ requestId: orchestrationId(run.id, item.id, "cancelPlanned"), expectedRevision: command.revision, action: { type: "cancelPlanned", assignmentId: item.id } });
          else if (command.type === "abandonStopped") await human.abandonStopped(item.id, command.revision);
          else if (command.type === "cancelUnstarted") await human.cancelUnstarted(item.id, command.revision);
          else if (command.type === "takeover") await human.takeover(command.revision, item.id);
          else if (command.type === "query") { await human.query(item.id); for (const control of item.controls ?? []) if (control.receipt.state === "unconfirmed") await human.query(item.id, control.requestId); }
          else if (command.type === "inspect") {
            if (!item.execution) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
            const inspection = await entry.channel.command({ operation: "inspect", requestId: orchestrationId(item.id, "inspect"), sessionId: item.execution.sessionId }, true) as OrchestrationInspection;
            if (inspection.turnId !== item.execution.turnId && !(item.state === "submitted" && !inspection.turnId)) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
            desktop.inspections.set(command.executionToken!, inspection);
            const saved = await readManagedRecord<Record<string, OrchestrationInspection>>(join(desktop.root, "inspections.json"), {});
            saved[command.executionToken!] = inspection; await writeManagedRecord(join(desktop.root, "inspections.json"), saved);
          } else if (command.type === "control") {
            if (!item.execution || !["cancel", "resume", "approval", "answer", "stop_job"].includes(command.operation) || typeof command.requestId !== "string" || !/^[\w-]{1,128}$/.test(command.requestId)) throw new Error("DESKTOP_IPC_DENIED");
            const continuation = interactionContinuation(command);
            if (continuation) {
              await desktop.continueAssignmentInteraction(run, entry, command, continuation);
              return;
            }
            const prior = item.controls?.find(function same(c) { return c.requestId === command.requestId; });
            const updated = prior ? await human.query(item.id, command.requestId)
              : await human.control({ assignmentId: item.id, expectedRevision: command.revision, execution: item.execution, command: { operation: command.operation, requestId: command.requestId, approvalId: command.approvalId, decision: command.decision, questionId: command.questionId, answers: command.answers, jobId: command.jobId } });
            desktop.inspections.delete(command.executionToken);
            const saved = await readManagedRecord<Record<string, OrchestrationInspection>>(join(desktop.root, "inspections.json"), {});
            delete saved[command.executionToken];
            // 决定确认后重新核对原 Turn，保留独立恢复入口，不沿用已失效的审批卡。
            const receipt = updated.assignments.find(function target(a) { return a.id === item.id; })?.controls?.find(function target(c) { return c.requestId === command.requestId; })?.receipt;
            if (["approval", "answer"].includes(command.operation) && desktop.decisionConfirmed(entry, item.execution, item.execution.turnId, command.operation, command.operation === "approval" ? command.approvalId : command.questionId, command.requestId, receipt)) {
              const inspection = await entry.channel.command({ operation: "inspect", requestId: orchestrationId(command.requestId, "inspect"), sessionId: item.execution.sessionId }, true) as OrchestrationInspection;
              if (inspection.turnId !== item.execution.turnId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
              desktop.inspections.set(command.executionToken, inspection); saved[command.executionToken] = inspection;
            }
            await writeManagedRecord(join(desktop.root, "inspections.json"), saved);
          }
        }
        if (command.type !== "inspect") await host.drive(); else if (command.executionToken) {
          const inspected = run.assignments.find(function same(item) { return item.id === command.assignmentId; })?.execution;
          if (inspected) { entry.observed.delete(inspected.sessionId); await entry.facts.refresh([inspected.sessionId]); }
        }
        return;
      }
      if (command.type === "batch") {
        if (!Number.isSafeInteger(command.revision) || !Number.isSafeInteger(command.planVersion) || typeof command.digest !== "string" || typeof command.approve !== "boolean") throw new Error("DESKTOP_IPC_DENIED");
        const run = await desktop.currentRun(workspace.id);
        const entry = run && desktop.runtimes.get(run.checkout);
        if (!entry || !desktop.hosts.has(run!.id)) throw new Error("ORCHESTRATION_RECOVERY_REQUIRED");
        await entry.service.bind(run!.id, { kind: "human" }).command({ requestId: orchestrationId(run!.id, String(command.planVersion), command.digest, String(command.approve)), expectedRevision: command.revision, action: { type: "batchDecision", planVersion: command.planVersion, digest: command.digest, approve: command.approve } });
        desktop.changed();
        await desktop.hosts.get(run!.id)!.drive(); return;
      }
      if (command.type === "mode") {
        if (!["parallel", "orchestration"].includes(command.mode) || (workspace.mode ?? "parallel") !== command.mode) throw new Error("DESKTOP_IPC_DENIED");
        const settings = await desktop.settings(); settings.modes[workspace.id] = command.mode;
        await writeManagedRecord(join(desktop.root, "settings.json"), settings); return;
      }
      if (workspace.mode !== "orchestration") throw new Error("ORCHESTRATION_MODE_MISMATCH");
      if (command.type !== "enter") throw new Error("DESKTOP_IPC_DENIED");
      if (typeof command.goal !== "string" || !command.goal.trim() || command.goal.length > 16000 || typeof command.trust !== "boolean") throw new Error("DESKTOP_IPC_DENIED");
      const existing = await desktop.currentRun(workspace.id);
      if (existing) return; // 进入旧 Run 只展示概览，恢复必须走单独入口。
      await desktop.openController(workspace, command.goal, command.trust);
    });
    this.serial.set(queueKey, next.catch(function keepQueue() {})); return next;
  }

  /** 原决定和恢复反馈各自持久化，通知不依赖恢复链完成。 */
  private async saveApproval(runId: string, item: ApprovalContinuation): Promise<void> {
    await this.store.update(function save(ledger) {
      const run = ledger.runs.find(function same(run) { return run.id === runId; });
      if (!run) throw new Error("ORCHESTRATION_RUN_MISSING");
      const records = run.approvalContinuations ??= [];
      const index = records.findIndex(function same(record) { return record.id === item.id; });
      if (index < 0) records.push(structuredClone(item)); else records[index] = structuredClone(item);
      const reason = item.reconciliation?.stopped;
      if (reason && !run.finishes?.some(function stopped(f) { return f.stop; })) {
        const id = orchestrationId(run.id, "approval-recovery", item.id);
        const pending = run.pending ??= [];
        if (!pending.some(function notified(i) { return i.id === id; })) pending.push({ id, kind: "host", source: "host", assignmentId: item.assignmentId,
          detail: approvalContinuationStatus(item) + " 请查询 approvalRecovery 后协调原任务。", basis: intentBasis(run, item.assignmentId), promptVersion: run.prompts.at(-1)?.version ?? 0,
          policyVersion: run.policy.settingsVersion, state: "pending", at: new Date().toISOString() });
      }
    });
    this.changed(item.sessionId);
    if (item.reconciliation?.stopped) void this.hosts.get(runId)?.drive(false, item.sessionId).catch(function offline() { /* 重连重新收集同一事项。 */ });
  }

  /** 两入口按 Session/Turn/审批 ID 合并同一决定，保存确认后即返回并排队恢复。 */
  private async submitApproval(workspaceId: string, command: DecisionCommand): Promise<void> {
    if (typeof command.requestId !== "string" || !/^[\w-]{1,128}$/u.test(command.requestId) || command.type === "control" && !Number.isSafeInteger(command.revision)) throw new Error("DESKTOP_IPC_DENIED");
    const run = await this.currentRun(workspaceId);
    const entry = run && this.runtimes.get(run.checkout);
    const assignmentId = command.type === "control" ? command.assignmentId : undefined;
    const assignment = run?.assignments.find(function same(a) { return a.id === assignmentId; });
    const ref = assignmentId ? assignment?.execution : run?.controller.execution;
    if (!run || !entry || !ref || !entry.channel.isConnected() || entry.facts.projection()?.connection.state !== "connected" || run.navigationRemoved || !this.workspaceAvailable(workspaceId) || ref.hostId !== entry.channel.identity.hostId || ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation) throw new Error("ORCHESTRATION_RECOVERY_REQUIRED");
    const inspection = await entry.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: ref.sessionId }, true) as OrchestrationInspection;
    const token = assignmentId ? orchestrationId(JSON.stringify(ref)) : orchestrationId(JSON.stringify(ref), inspection.turnId ?? "idle");
    if (command.executionToken !== token || !inspection.turnId || assignmentId && ref.turnId !== inspection.turnId || assignment && ["released", "cancelled"].includes(assignment.state)) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    const id = orchestrationId(run.id, ref.sessionId, inspection.turnId, command.approvalId!);
    const prior = run.approvalContinuations?.find(function same(item) { return item.id === id; });
    if (prior && prior.decision !== command.decision) throw new Error("ORCHESTRATION_REQUEST_CONFLICT");
    const item: ApprovalContinuation = prior ?? { id, assignmentId, sessionId: ref.sessionId, turnId: inspection.turnId, approvalId: command.approvalId!, decision: command.decision, requestId: command.requestId, autoResume: true, origin: { hostId: ref.hostId, owner: ref.owner, generation: ref.generation }, pauseSeq: inspection.lastSeq, dispatchPauseId: run.records.filter(function pause(r) { return r.action === "pause:true"; }).at(-1)?.requestId,
      approval: { requestId: command.requestId, operation: "approval", sessionId: ref.sessionId, turnId: inspection.turnId, state: "unconfirmed" } };
    if (!prior) {
      if (!matchesInteraction(inspection, command, "pending") || !(inspection.interaction?.approval?.allowedDecisions ?? inspection.interaction?.approval?.display?.allowedDecisions ?? ["allow_once", "deny"]).includes(command.decision!)) throw new Error("ORCHESTRATION_APPROVAL_CHANGED");
      await this.saveApproval(run.id, item);
      this.checkFailedResume(run, item);
      if (assignmentId) {
        const current = (await this.currentRun(workspaceId))!;
        const updated = await entry.service.bind(run.id, { kind: "human" }).control({ assignmentId, expectedRevision: current.revision, execution: ref,
          command: { operation: "approval", requestId: item.requestId, approvalId: item.approvalId, decision: item.decision } });
        item.approval = { ...item.approval, ...updated.assignments.find(function same(a) { return a.id === assignmentId; })!.controls!.find(function same(c) { return c.requestId === item.requestId; })!.receipt };
      } else item.approval = (await this.controller(workspaceId, { ...command, type: "controller", continueAfterApproval: undefined }, true))!;
      await this.saveApproval(run.id, item);
    } else if (item.approval.state !== "confirmed" || item.approval.code) {
      await this.recoverApproval(workspaceId, item.id, "query");
      const saved = (await this.currentRun(workspaceId))?.approvalContinuations?.find(function same(record) { return record.id === item.id; });
      if (saved) Object.assign(item, saved);
    }
    if (!this.decisionConfirmed(entry, ref, item.turnId, "approval", item.approvalId, item.requestId, item.approval)) { this.checkFailedResume(run, item); throw new Error("ORCHESTRATION_APPROVAL_NOT_CONFIRMED"); }
    this.checkFailedResume(run, item);
  }

  /** 冷启动复用主进程已读取的关系索引，只连接仍有审批事项的 Run。 */
  restoreApprovalWork(runs: OrchestrationRun[]): void {
    for (const run of runs) if (!run.navigationRemoved && this.workspaceAvailable(run.workspaceId)) {
      for (const item of run.approvalContinuations ?? []) this.checkFailedResume(run, item);
    }
  }

  /** 宿主按原审批串行核查，首次立即处理，其余最多三轮，每轮相隔两秒。 */
  private checkFailedResume(run: OrchestrationRun, item: ApprovalContinuation, attempted = 0): void {
    if (attempted >= 4 || this.closed || !item.autoResume || item.reconciliation?.stopped ||
      item.resume && !item.resume.code && ["started", "confirmed"].includes(item.resume.state) || this.checkedResumes.has(item.id)) return;
    this.checkedResumes.add(item.id);
    const desktop = this;
    const timer = setTimeout(function enqueue() {
      const task = (desktop.serial.get(run.workspaceId) ?? Promise.resolve()).then(async function reconcile() {
        const latest = (await desktop.store.read()).runs.find(function same(r) { return r.id === run.id; });
        const target = latest?.approvalContinuations?.find(function same(i) { return i.id === item.id; });
        if (desktop.closed || !latest || latest.navigationRemoved || !target || target.reconciliation?.stopped || !desktop.workspaceAvailable(run.workspaceId)) return;
        if (latest.finishes?.some(function stopping(f) { return f.stop; })) {
          (target.reconciliation ??= { checks: 0 }).stopped = "主控已停止整个编排";
          await desktop.saveApproval(run.id, target); return;
        }
        if (target.resume && !target.resume.code && ["started", "confirmed"].includes(target.resume.state)) return;
        const budget = target.reconciliation ??= { checks: 0 };
        try {
          if (budget.checks >= 4) throw new Error("核查次数已用完，原任务仍待确认");
          budget.checks = Math.max(budget.checks, attempted) + 1;
          attempted = budget.checks;
          await desktop.saveApproval(run.id, target);
          if (!desktop.runtimes.get(latest.checkout)?.channel.isConnected()) await desktop.connectControl(run.id);
          await desktop.recoverApproval(run.workspaceId, item.id, "automatic", run.id);
          if (attempted === 4) {
            const final = (await desktop.store.read()).runs.find(function same(r) { return r.id === run.id; })?.approvalContinuations?.find(function same(i) { return i.id === item.id; });
            if (final && !final.reconciliation?.stopped && (!final.resume || final.resume.code || !["started", "confirmed"].includes(final.resume.state))) throw new Error("ORCHESTRATION_CONTINUE_PENDING");
          }
        } catch (error) {
          const updated = (await desktop.store.read()).runs.find(function same(r) { return r.id === run.id; })?.approvalContinuations?.find(function same(i) { return i.id === item.id; });
          if (!updated) return;
          const state = updated.reconciliation ??= budget;
          if (Math.max(state.checks, attempted) >= 4 || error instanceof Error && ["ORCHESTRATION_EXECUTION_MISMATCH", "ORCHESTRATION_APPROVAL_BASIS_UNKNOWN"].includes(error.message)) {
            if (error instanceof Error && error.message === "ORCHESTRATION_EXECUTION_MISMATCH" && updated.resume) updated.resume.retryable = false;
            state.stopped = error instanceof Error && error.message === "ORCHESTRATION_EXECUTION_MISMATCH" ? "原执行身份已变化" : error instanceof Error && error.message === "ORCHESTRATION_APPROVAL_BASIS_UNKNOWN" ? "历史记录缺少原执行代次或暂停序号" : state.reason ?? (updated.resume && updated.resume.phase !== "check_resume" ? "恢复已发出，原请求回执未确认" : "原执行者未能确认恢复条件");
            await desktop.saveApproval(run.id, updated);
          }
        }
      });
      desktop.serial.set(run.workspaceId, task.catch(function keepQueue() {}));
      void task.finally(async function next() {
        desktop.checkedResumes.delete(item.id);
        const latest = (await desktop.store.read()).runs.find(function same(r) { return r.id === run.id; });
        const target = latest?.approvalContinuations?.find(function same(i) { return i.id === item.id; });
        if (latest && target && !latest.navigationRemoved && desktop.workspaceAvailable(run.workspaceId)) desktop.checkFailedResume(latest, target, attempted);
      }).catch(function unavailable() { /* 重连从持久预算继续。 */ });
    }, attempted || item.reconciliation?.checks ? 2000 : 0);
    timer.unref?.();
  }

  /** 核查原回执后仅续接精确已决暂停点；未知不重新批准、不重放恢复。 */
  private async recoverApproval(workspaceId: string, id: string, action: "query" | "resume" | "automatic", runId?: string): Promise<void> {
    const prior = this.recoveryOperations.get(id) ?? Promise.resolve();
    const desktop = this;
    const task = prior.catch(function previous() {}).then(function next() { return desktop.performRecovery(workspaceId, id, action, runId); });
    this.recoveryOperations.set(id, task);
    try { await task; } finally { if (this.recoveryOperations.get(id) === task) this.recoveryOperations.delete(id); }
  }

  /** 同一审批的自动与主控入口共用串行回执事务。 */
  private async performRecovery(workspaceId: string, id: string, action: "query" | "resume" | "automatic", runId?: string): Promise<void> {
    const run = runId ? (await this.store.read()).runs.find(function same(r) { return r.id === runId && r.workspaceId === workspaceId; }) : await this.currentRun(workspaceId);
    const entry = run && this.runtimes.get(run.checkout);
    if (!run || !entry || !entry.channel.isConnected() || run.navigationRemoved || !this.workspaceAvailable(workspaceId)) throw new Error("ORCHESTRATION_RECOVERY_REQUIRED");
    let item = run.approvalContinuations?.find(function same(record) { return record.id === id; });
    if (!item) {
      for (const target of [{ assignmentId: undefined, ref: run.controller.execution }, ...run.assignments.map(function target(a) { return { assignmentId: a.id, ref: a.execution }; })]) {
        if (!target.ref) continue;
        const inspection = await entry.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: target.ref.sessionId }, true) as OrchestrationInspection;
        const legacy = legacyApprovalContinuation(run, inspection, target.assignmentId);
        if (legacy?.id === id) { item = legacy; await this.saveApproval(run.id, item); break; }
      }
    }
    if (!item) throw new Error("ORCHESTRATION_APPROVAL_CHANGED");
    if (action !== "query" && run.finishes?.some(function stopping(f) { return f.stop; })) throw new Error("ORCHESTRATION_FINISHING");
    const assignment = run.assignments.find(function same(a) { return a.id === item!.assignmentId; });
    const ref = item.assignmentId ? assignment?.execution : run.controller.execution;
    if (!ref || ref.sessionId !== item.sessionId || item.assignmentId && ref.turnId !== item.turnId || ref.hostId !== entry.channel.identity.hostId || ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation || assignment && ["released", "cancelled"].includes(assignment.state)) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    const originChanged = item.origin && (item.origin.owner !== ref.owner || item.origin.generation !== ref.generation || item.origin.hostId !== ref.hostId);
    if (originChanged && item.resume) {
      // 换代只对账，原 Worker 已保存的精确成功回执仍可结束恢复事项。
      const receipt = await entry.channel.command({ operation: "query", requestId: randomUUID(), targetRequestId: item.resume.requestId, approvalId: item.approvalId }, true) as ManagedRuntimeReceipt;
      if (receipt.operation === "resume" && receipt.requestId === item.resume.requestId && receipt.sessionId === item.sessionId && receipt.turnId === item.turnId && !receipt.code && ["started", "confirmed"].includes(receipt.state)) {
        item.resume = receipt; await this.saveApproval(run.id, item); return;
      }
    }
    if (originChanged) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    if (action === "automatic" && (!item.origin || item.pauseSeq === undefined)) throw new Error("ORCHESTRATION_APPROVAL_BASIS_UNKNOWN");
    const record = item, approvalRunId = run.id;
    const desktop = this;
    /** 核查与实际续接都要求原暂停、空闲执行和无活动 Job。 */
    async function pausedHere(): Promise<boolean> {
      const inspection = await entry!.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: record.sessionId }, true) as OrchestrationInspection;
      const activity = await entry!.channel.command({ operation: "lease_activity", requestId: randomUUID(), sessionId: record.sessionId }, true) as ManagedLeaseActivity;
      const latest = (await desktop.store.read()).runs.find(function current(r) { return r.id === approvalRunId; });
      const cancel = latest && controllerCancelReceipt(latest);
      const pause = latest?.records.filter(function pause(r) { return r.action === "pause:true"; }).at(-1);
      const stopped = action === "automatic" && (!latest || pause && pause.requestId !== record.dispatchPauseId || latest.controlOnly || latest.navigationRemoved || latest.finishes?.some(function stop(f) { return f.stop; })
        || desktop.cancelling.has(orchestrationId(approvalRunId, record.sessionId, record.turnId)) || (!record.assignmentId && cancel?.turnId === record.turnId && !cancel.code)
        || !!latest.assignments.find(function same(a) { return a.id === record.assignmentId; })?.controls?.some(function cancelled(c) { return c.operation === "cancel" && c.receipt.turnId === record.turnId && !c.receipt.code; }));
      const samePause = !stopped && (record.pauseSeq === undefined || inspection.lastSeq === record.pauseSeq) && inspection.turnId === record.turnId &&
        matchesInteraction(inspection, record, "decided") && (!record.decision || inspection.interaction?.approval?.decision === record.decision);
      const idle = inspection.execution === "inactive" && inspection.recoverable && inspection.activeJobs === false && activity.sessionId === record.sessionId &&
        activity.turnId === record.turnId && activity.execution === "inactive" && activity.activeJobs === false && activity.activeTurn === false;
      if (record.reconciliation) record.reconciliation.reason = !samePause ? "原审批暂停点已变化" : inspection.activeJobs || activity.activeJobs ? "原会话仍有活动的后台任务" : !idle ? "原执行尚未确认空闲" : undefined;
      return samePause && idle;
    }
    /** 只接受 Worker 对原请求和目标的完整回执。 */
    let missingAtWorker = false;
    async function query(receipt: ManagedRuntimeReceipt) {
      const value = await entry!.channel.command({ operation: "query", requestId: randomUUID(), targetRequestId: receipt.requestId, approvalId: record.approvalId }, true) as ManagedRuntimeReceipt;
      // Host 已知尚未投递的预检失败，只有 Worker 也确认没有该请求才可重新预检。
      if (receipt.phase === "check_resume" && value.code === "MANAGED_REQUEST_UNKNOWN" && value.requestId === receipt.requestId) { missingAtWorker = true; return { ...receipt, state: "unconfirmed" as const, retryable: await pausedHere() }; }
      if (value.requestId !== receipt.requestId || value.sessionId !== record.sessionId || value.turnId !== record.turnId || value.operation !== receipt.operation) return { ...receipt, state: "unconfirmed" as const, retryable: false };
      return value;
    }
    if (item.approval.state !== "confirmed" || item.approval.code) item.approval = await query(item.approval);
    // 上轮读预检抛错或宿主退出且未写入 submitted，仍须 Worker 明确无原请求才可补发。
    if (!item.resume && action === "automatic" && (item.reconciliation?.checks ?? 0) > 1 && item.approval.state === "confirmed" && !item.approval.code) {
      item.resume = { requestId: orchestrationId(item.requestId, "resume-after-approval"), operation: "resume", sessionId: item.sessionId, turnId: item.turnId,
        state: "unconfirmed", phase: "check_resume", code: "ORCHESTRATION_CONTINUE_PENDING" };
      await this.saveApproval(run.id, item);
    }
    if (item.resume) item.resume = await query(item.resume);
    else if (action === "query") item.ready = await pausedHere();
    await this.saveApproval(run.id, item);
    const confirmed = this.decisionConfirmed(entry, ref, item.turnId, "approval", item.approvalId, item.requestId, item.approval);
    if (action === "query") return;
    if (!confirmed) throw new Error("ORCHESTRATION_APPROVAL_NOT_CONFIRMED");
    if (item.resume && !item.resume.code && ["started", "confirmed"].includes(item.resume.state)) return;
    if (item.resume && item.resume.retryable !== true) throw new Error("ORCHESTRATION_CONTINUE_PENDING");
    if (action === "automatic" && item.resume && (!missingAtWorker || item.resume.phase !== "check_resume" || item.reconciliation?.retried || item.resume.requestId !== orchestrationId(item.requestId, "resume-after-approval"))) {
      item.reconciliation!.stopped = item.resume.retryable ? "原启动失败，等待主控核实并继续" : "原请求的投递结果仍待确认";
      await this.saveApproval(run.id, item); return;
    }
    if (!await pausedHere()) {
      if (!item.resume) {
        item.resume = { requestId: orchestrationId(item.requestId, "resume-after-approval"), operation: "resume", sessionId: item.sessionId, turnId: item.turnId, state: "unconfirmed", phase: "check_resume", code: "ORCHESTRATION_CONTINUE_PENDING" };
        await this.saveApproval(run.id, item);
      }
      throw new Error("ORCHESTRATION_CONTINUE_PENDING");
    }
    if (action === "automatic" && item.resume) item.reconciliation!.retried = true;
    const previous = item.resume;
    const retry = previous && previous.phase !== "check_resume";
    if (action === "resume" && item.reconciliation) delete item.reconciliation.stopped;
    if (retry) item.attempt = (item.attempt ?? 0) + 1;
    const requestId = retry ? orchestrationId(item.requestId, "resume-after-approval", String(item.attempt)) : orchestrationId(item.requestId, "resume-after-approval");
    item.resume = { requestId, operation: "resume", sessionId: item.sessionId, turnId: item.turnId, state: "submitted" };
    await this.saveApproval(run.id, item);
    const resume = { operation: "resume" as const, requestId, approvalId: item.approvalId, ...(retry ? { retryOf: previous!.requestId } : {}) };
    try {
      if (item.assignmentId) {
        const current = (await this.store.read()).runs.find(function same(r) { return r.id === run.id; })!;
        const updated = await entry.service.bind(run.id, { kind: "human" }).control({ assignmentId: item.assignmentId, expectedRevision: current.revision, execution: ref, command: resume });
        item.resume = { ...item.resume, ...updated.assignments.find(function same(a) { return a.id === record.assignmentId; })!.controls!.find(function same(c) { return c.requestId === requestId; })!.receipt };
      } else {
        item.resume = await entry.service.resumeController(run.id, ref.sessionId, item.turnId, async function resumeController() {
          if (action === "automatic" && !await pausedHere()) throw new Error("ORCHESTRATION_CONTINUE_PENDING");
          return await entry!.channel.command({ ...resume, sessionId: ref.sessionId, turnId: record.turnId }, true) as ManagedRuntimeReceipt;
        });
      }
      if (!item.resume || item.resume.requestId !== requestId || item.resume.sessionId !== item.sessionId || item.resume.turnId !== item.turnId || item.resume.operation !== "resume") {
        item.resume = { requestId, operation: "resume", sessionId: item.sessionId, turnId: item.turnId, state: "unconfirmed" };
      }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z_]{1,80}$/u.test(error.message) ? error.message : "ORCHESTRATION_CONTINUE_PENDING";
      item.resume = { ...item.resume!, state: "unconfirmed", code, ...(["ORCHESTRATION_CHECKOUT_BUSY", "ORCHESTRATION_HANDOFF_INCOMPLETE", "ORCHESTRATION_EXECUTION_RECOVERY_REQUIRED"].includes(code) ? { phase: "check_resume" as const } : {}) };
    }
    await this.saveApproval(run.id, item);
    if (action !== "automatic") this.checkFailedResume(run, item);
    entry.observed.delete(ref.sessionId);
    void entry.facts.refresh([ref.sessionId]).finally(function changed() { desktop.changed(ref.sessionId); }).catch(function unknown() { /* 原回执可单独核查。 */ });
  }

  /** 受管 CLI 仅定位自身会话的原审批；核查与恢复不创建新决定。 */
  private async approvalFromTerminal(run: OrchestrationRun, sessionId: string, assignmentId: string | undefined, action: "query" | "resume"): Promise<string> {
    const entry = this.runtimes.get(run.checkout)!;
    const inspection = await entry.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId }, true) as OrchestrationInspection;
    const item = currentApproval(run.approvalContinuations, sessionId, inspection) ?? legacyApprovalContinuation(run, inspection, assignmentId);
    if (!item) return "此会话没有可核查的原审批恢复记录。";
    await this.command({ type: "approvalRecovery", workspaceId: run.workspaceId, runId: run.id, id: item.id, action });
    const current = await this.currentRun(run.workspaceId);
    const saved = current?.approvalContinuations?.find(function same(record) { return record.id === item.id; }) ?? item;
    return approvalContinuationStatus(saved) + (saved.resume ? "\n恢复技术详情 " + JSON.stringify({ phase: saved.resume.phase, code: saved.resume.code, diagnostic: saved.resume.diagnostic }) : "");
  }

  /** GUI 用本次审批或回答的原回执续跑；重复提交核查同一操作，仍经过原目录准入。 */
  private async continueAssignmentInteraction(run: OrchestrationRun, entry: RuntimeEntry, command: Extract<DecisionCommand, { type: "control" }>, continuation: NonNullable<ReturnType<typeof interactionContinuation>>): Promise<void> {
    const desktop = this;
    const human = entry.service.bind(run.id, { kind: "human" });
    const { target, resume } = continuation;
    /** 每次控制前从原工作区重新读取关系和代次，不接受历史或活动状态未知的目标。 */
    async function exact() {
      const current = await desktop.currentRun(run.workspaceId);
      const item = current?.assignments.find(function same(a) { return a.id === command.assignmentId; });
      const ref = item?.execution;
      if (current?.id !== run.id || current.navigationRemoved || !desktop.workspaceAvailable(run.workspaceId) || desktop.runtimes.get(run.checkout) !== entry || !entry.channel.isConnected() || entry.facts.projection()?.connection.state !== "connected") throw new Error("ORCHESTRATION_RECOVERY_REQUIRED");
      if (!item || !ref?.turnId || ["cancelled", "released"].includes(item.state) || command.executionToken !== orchestrationId(JSON.stringify(ref)) || ref.hostId !== entry.channel.identity.hostId || ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      return { item, ref, revision: current.revision };
    }
    /** 核对 Worker 的原 Turn 和交互阶段，换目标后不发送控制。 */
    async function inspect(ref: ExecutionReference, state: "pending" | "decided") {
      const inspection = await entry.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: ref.sessionId }, true) as OrchestrationInspection;
      if (inspection.turnId !== ref.turnId || !matchesInteraction(inspection, resume, state)) throw new Error(continuation.changed);
      return inspection;
    }
    const initial = await exact();
    const prior = initial.item.controls?.find(function same(c) { return c.requestId === command.requestId; });
    const digest = orchestrationId(JSON.stringify(target), JSON.stringify({ kind: "human" }));
    if (prior && (prior.operation !== target.operation || prior.digest !== digest)) throw new Error("ORCHESTRATION_REQUEST_CONFLICT");
    let receipt = prior?.receipt;
    if (!prior) {
      await inspect(initial.ref, "pending");
      const current = await exact();
      const updated = await human.control({ assignmentId: command.assignmentId, expectedRevision: current.revision, execution: current.ref, command: target });
      receipt = updated.assignments.find(function same(a) { return a.id === command.assignmentId; })?.controls?.find(function same(c) { return c.requestId === command.requestId; })?.receipt;
    } else if (receipt?.state === "unconfirmed") {
      const updated = await human.query(command.assignmentId, command.requestId);
      receipt = updated.assignments.find(function same(a) { return a.id === command.assignmentId; })?.controls?.find(function same(c) { return c.requestId === command.requestId; })?.receipt;
    }
    if (!this.decisionConfirmed(entry, initial.ref, initial.ref.turnId, target.operation, continuation.id, target.requestId, receipt)) throw new Error(continuation.unconfirmed);
    try {
      const decided = await exact();
      const previous = decided.item.controls?.find(function same(c) { return c.requestId === resume.requestId; });
      if (previous && (previous.operation !== "resume" || previous.digest !== orchestrationId(JSON.stringify(resume), JSON.stringify({ kind: "human" })))) throw new Error("ORCHESTRATION_REQUEST_CONFLICT");
      let resumed = previous?.receipt;
      if (previous?.receipt.state === "unconfirmed") {
        const updated = await human.query(command.assignmentId, resume.requestId);
        resumed = updated.assignments.find(function same(a) { return a.id === command.assignmentId; })?.controls?.find(function same(c) { return c.requestId === resume.requestId; })?.receipt;
      } else if (!previous) {
        const inspection = await inspect(decided.ref, "decided");
        if (inspection.execution !== "inactive" || !inspection.recoverable || inspection.activeJobs || decided.item.controls?.some(function stopping(c) { return c.operation === "cancel" && c.receipt.state === "unconfirmed"; })) throw new Error("ORCHESTRATION_CONTINUE_PENDING");
        const current = await exact();
        const updated = await human.control({ assignmentId: command.assignmentId, expectedRevision: current.revision, execution: current.ref, command: resume });
        resumed = updated.assignments.find(function same(a) { return a.id === command.assignmentId; })?.controls?.find(function same(c) { return c.requestId === resume.requestId; })?.receipt;
      }
      if (!resumed || resumed.code || !["started", "confirmed"].includes(resumed.state) || resumed.sessionId !== initial.ref.sessionId || resumed.turnId !== initial.ref.turnId || resumed.operation !== "resume" || resumed.requestId !== resume.requestId) throw new Error("ORCHESTRATION_CONTINUE_PENDING");
    } catch { throw new Error(continuation.resumePending); }
    finally {
      entry.observed.delete(initial.ref.sessionId);
      void entry.facts.refresh([initial.ref.sessionId]).finally(function project() { desktop.changed(initial.ref.sessionId); }).catch(function unavailable() { /* 核查失败显示未知。 */ });
    }
  }

  /** 在新 Run 对轮询可见前登记初始化；并发首进共享结果，显式新任务依次创建。 */
  private openController(workspace: DesktopWorkspace, goal: string, grantTrust = false, newTask = false, requestId?: string): Promise<void> {
    const pending = this.controllerStarts.get(workspace.id);
    if (pending && !newTask) return pending;
    const desktop = this;
    const next = (pending?.catch(function previousFailed() {}) ?? Promise.resolve()).then(function start() {
      return desktop.startController(workspace, goal, grantTrust, newTask, requestId);
    }).finally(function done() {
      if (desktop.controllerStarts.get(workspace.id) === next) desktop.controllerStarts.delete(workspace.id);
    });
    this.controllerStarts.set(workspace.id, next);
    return next;
  }

  /** 首次受信工作区只建立固定主控；没有用户目标时不产生 Prompt 或启动模型。 */
  private async startController(workspace: DesktopWorkspace, goal: string, grantTrust: boolean, newTask: boolean, requestId?: string): Promise<void> {
    const checkout = await canonicalCheckout(workspace.directory);
    const stateRoot = join(this.root, "runtimes", orchestrationId(checkout));
    const trust = createNodeTrustPolicy({ stateRoot });
    if ((await trust.getTrustStatus(checkout)).status !== "trusted") {
      if (!grantTrust) throw new Error("ORCHESTRATION_TRUST_REQUIRED");
      await trust.grantTrust(checkout);
    }
    const entry = await this.runtime(checkout);
    const settings = await this.settings();
    if (!this.workspaceAvailable(workspace.id)) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
    const run = await entry.service.open(workspace.id, checkout, goal, { ...settings.preferences, settingsVersion: "1", permissionVersion: "core-default", permissionMode: newTask ? this.defaultApPermission() : workspace.apPermission ?? this.defaultApPermission(), maxConcurrent: 4, versions: { app: this.appVersion, core: "0.4.0", protocol: "1", schema: "1" } }, !goal.trim(), newTask, requestId);
    if (run.controller.execution && this.hosts.has(run.id)) return;
    const host = await this.initializeController(entry, run);
    await host.drive();
  }

  /** 首次启动和未绑定 Session 的重试沿用原 Run 和固定创建请求。 */
  private async initializeController(entry: RuntimeEntry, run: OrchestrationRun): Promise<OrchestrationHost> {
    if (!run.checkoutFingerprint) {
      const { fingerprint } = await checkoutEvidence(run.checkout);
      await this.store.update(function baseline(ledger) { ledger.runs.find(function same(r) { return r.id === run.id; })!.checkoutFingerprint = fingerprint; });
    }
    await entry.service.bind(run.id, { kind: "human" }).initialize();
    if (!this.workspaceAvailable(run.workspaceId)) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
    const host = this.createHost(entry, run.id, run.workspaceId);
    this.hosts.set(run.id, host);
    try {
      await host.open();
      if (!this.workspaceAvailable(run.workspaceId)) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
    } catch (error) {
      host.close();
      if (this.hosts.get(run.id) === host) this.hosts.delete(run.id);
      throw error;
    }
    return host;
  }

  /** 私有启动集中复用；持久 owner 锁未核清时 Worker 不会握手，不能抢占旧进程。 */
  private runtime(checkout: string): Promise<RuntimeEntry> {
    const pending = this.runtimeStarts.get(checkout); if (pending) return pending;
    const desktop = this;
    const next = this.startRuntime(checkout).finally(function done() { desktop.runtimeStarts.delete(checkout); });
    this.runtimeStarts.set(checkout, next); return next;
  }

  /** 同目录并发打开共享一次启动，其他目录不排队等待。 */
  private async startRuntime(checkout: string): Promise<RuntimeEntry> {
    const previous = this.runtimes.get(checkout);
    if (previous?.channel.isConnected()) return previous;
    if (previous) { previous.facts.close(); for (const run of (await this.store.read()).runs.filter(function same(r) { return r.checkout === checkout; })) { this.hosts.get(run.id)?.close(); this.hosts.delete(run.id); } }
    const stateRoot = join(this.root, "runtimes", orchestrationId(checkout));
    const channel = new ManagedRuntimeHost(orchestrationId(this.root, checkout));
    try {
      await this.launch(channel, checkout, stateRoot);
      const facts = new ManagedFactsHost(channel, join(stateRoot, "facts.json")); await facts.open();
      const desktop = this;
      const entry: RuntimeEntry = { channel, facts, observed: new Map(), decided: new Set(), service: new OrchestrationService(this.store, channel, checkout, facts, function notify(runId, holders, acquired) {
        desktop.recordCheckoutNotice(runId, holders, acquired);
      }) };
      this.runtimes.set(checkout, entry);
      facts.subscribe(function changed(sessionId) {
        if (desktop.runtimes.get(checkout) !== entry) return;
        if (!sessionId) entry.observed.clear();
        desktop.changed(sessionId);
      });
      return entry;
    } catch (error) { channel.stop(); throw new Error(error instanceof Error && /^[A-Z][A-Z_]{1,80}$/.test(error.message) ? error.message : "ORCHESTRATION_START_FAILED"); }
  }

  /** 只将工作区、执行身份和可处理状态投影给发起请求的终端。 */
  private recordCheckoutNotice(runId: string, holders: CheckoutHolder[], acquired: boolean): void {
    const workspaces = this.workspaces();
    const lines = holders.map(function describe(holder) {
      const name = workspaces.find(function same(workspace) { return workspace.id === holder.workspaceId; })?.name?.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
      const workspace = name ? name + "（" + holder.workspaceId + "）" : holder.workspaceId ?? "未知工作区";
      const role = holder.assignmentId ? "委派 " + holder.assignmentId : "主控";
      const ref = holder.execution;
      const activity = holder.activity;
      const identity = `${workspace} · Run ${holder.runId} · ${role} · Session ${ref?.sessionId ?? "未知"} · Turn ${ref?.turnId ?? "未知"}`;
      if (acquired) {
        const cause = holder.available === "waiting" ? "等待人工处理，已让出目录；可回原会话继续处理"
          : holder.available === "failed" ? "Turn 已失败且无活动 Job，已回收租约" : "Turn 已结束且无活动 Job，已回收租约";
        return identity + " · " + cause;
      }
      const move = activity?.turnId && activity.turnId !== ref?.turnId ? ` · 当前会话 Turn ${activity.turnId}` : "";
      const status = holder.resuming ? "正在请求继续" : holder.disconnected ? "当前连接无法核查" : activity?.execution === "lost" ? "执行进程已失联" : activity?.activeTurn && activity.execution !== "active"
        ? "Worker 执行或收尾中" : activity && (activity.turnId || !ref?.turnId) ? turnStatus(activity.status, activity.execution) : "状态待核查";
      const action = activity?.activeJobs ? "后台 Job 仍活动，请在该工作区任务进度查看或停止 Job。"
        : activity?.execution === "active" || activity?.activeTurn || holder.resuming ? "可等待执行结束，或从该工作区任务进度停止对应 Turn。"
        : activity?.waiting ? "请在原会话核查审批或问题，处理后再试。"
        : "请打开对应工作区和 Run 的任务进度核查；失联时先重新连接。";
      return `${identity}${move} · ${status} · ${action}`;
    });
    this.checkoutNotices.set(runId, [acquired ? "已取得目录，可继续执行。" : "目录仍有占用。", ...lines].join("\n"));
  }

  /** 显式核查只拉起只读 Runtime；继续前再次核查全部原身份与目录，不自动恢复 Turn。 */
  private async recover(workspace: DesktopWorkspace, command: Extract<OrchestrationUiCommand, { type: "checkRecovery" | "reconnect" }>): Promise<void> {
    const run = await this.currentRun(workspace.id);
    if (!run || await canonicalCheckout(workspace.directory) !== run.checkout) throw new Error("ORCHESTRATION_CHECKOUT_MISMATCH");
    if (!run.controlOnly && this.hosts.has(run.id) && this.runtimes.get(run.checkout)?.facts.status().ledger?.connection.state === "connected") throw new Error("ORCHESTRATION_ALREADY_CONNECTED");
    const entry = await this.runtime(run.checkout);
    const { fingerprint, reason } = await checkoutEvidence(run.checkout);
    const refs = [run.controller.execution, ...run.assignments.filter(function active(a) { return a.execution && a.state !== "cancelled"; }).map(function ref(a) { return a.execution; })];
    const compatible = ["0.3.0", "0.4.0"].includes(run.policy.versions.core) && run.policy.versions.protocol === "1" && run.policy.versions.schema === "1";
    let ready = !!fingerprint && !!run.controller.execution && compatible;
    const checks = ["Runtime 独占 owner 锁已获取；不代表旧 Job 已停止",
      compatible ? "Core / H1 / schema 兼容" : "版本不兼容，无法重新连接",
      run.controller.execution ? "原主控身份已保存" : "缺少原主控身份，无法重新连接",
      fingerprint ? "目录内容摘要已计算" : `目录内容摘要失败：${reason}；勾选确认不能跳过此检查`];
    for (const ref of refs) {
      if (!ref) { ready = false; continue; }
      try {
        const inspection = await entry.channel.command({ operation: "inspect", requestId: orchestrationId(ref.sessionId, "recovery"), sessionId: ref.sessionId }, true) as OrchestrationInspection;
        const unstarted = !inspection.turnId && run.assignments.some(function pending(a) { return a.execution?.sessionId === ref.sessionId && a.state === "submitted"; });
        const sameTurn = !ref.turnId || inspection.turnId === ref.turnId || unstarted;
        const safe = sameTurn && !inspection.activeJobs && ["inactive", "lost"].includes(inspection.execution) && inspection.threadPolicy === "disabled";
        ready &&= safe;
        checks.push(`${ref.sessionId.slice(0, 8)}：${inspection.status} / ${inspection.execution}；checkpoint ${inspection.checkpoint ? "存在" : "无"}；Job ${inspection.activeJobs ? "待核查，不放行" : "无活动"}；交互 ${inspection.interaction?.state ?? "无"}；Thread 禁用；${safe ? "可重新连接" : "保留占用待处理"}`);
        await entry.facts.register(ref.sessionId);
      } catch { ready = false; checks.push(`${ref.sessionId.slice(0, 8)}：身份 / Session / Thread 策略未核清`); }
    }
    const token = orchestrationId(run.id, String(run.revision), entry.channel.identity.generation, fingerprint ?? "unknown", JSON.stringify(checks));
    const result = { token, ready, changed: fingerprint !== run.checkoutFingerprint || !run.checkoutFingerprint, checks, revision: run.revision, fingerprint };
    if (command.type === "checkRecovery") { this.recoveries.set(run.id, result); return; }
    if (typeof command.token !== "string" || typeof command.acceptCheckout !== "boolean" || command.token !== this.recoveries.get(run.id)?.token || command.token !== token || !ready || result.changed && !command.acceptCheckout) { this.recoveries.set(run.id, result); throw new Error("ORCHESTRATION_RECOVERY_RECHECK_REQUIRED"); }
    const identity = entry.channel.identity;
    await this.store.update(function rebind(ledger) {
      const current = ledger.runs.find(function same(r) { return r.id === run!.id; })!;
      if (current.revision !== run.revision) throw new Error("ORCHESTRATION_STALE_REVISION");
      // 同 Session / Turn / 原请求身份不变，仅受信核查后更换进程代次；不释放任何租约。
      for (const ref of [current.controller.execution, ...current.assignments.map(function ref(a) { return a.execution; })]) if (ref) { ref.owner = identity.owner; ref.generation = identity.generation; }
      if (result.changed) {
        current.acceptance = "pending"; for (const step of current.steps) step.verdict = undefined;
        current.prompts.push({ version: current.prompts.length + 1, text: "用户已确认按本次恢复核查的目录内容重新连接。旧验收仅作历史证据，必须重新评估当前内容，不得沿用旧版本通过结论。", scope: "run", targetId: current.id, at: new Date().toISOString() });
        current.planVersion++;
      }
      current.controlOnly = false; current.checkoutFingerprint = fingerprint; current.paused = true; current.revision++; rebaseControllerCorrections(current, current.revision - 1);
      current.records.push({ requestId: token, digest: token, action: "human_reconnect_checked", at: new Date().toISOString() });
    });
    this.hosts.get(run.id)?.close();
    if (!this.workspaceAvailable(workspace.id)) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
    const host = this.createHost(entry, run.id, run.workspaceId); this.hosts.set(run.id, host);
    try { await host.open(); for (const item of run.approvalContinuations ?? []) this.checkFailedResume(run, item); } catch (error) { host.close(); if (this.hosts.get(run.id) === host) this.hosts.delete(run.id); throw error; }
    this.recoveries.delete(run.id);
  }

  /** 主控人类操作同样绑定当前 Turn；原命令账本负责幂等，不给模型审批权限。 */
  private async controller(workspaceId: string, command: Extract<OrchestrationUiCommand, { type: "controller" }>, decisionOnly = false): Promise<ManagedRuntimeReceipt | undefined> {
    const run = await this.currentRun(workspaceId);
    const ref = run?.controller.execution; const entry = run && this.runtimes.get(run.checkout);
    if (!run || !ref || !entry || !this.hosts.has(run!.id) || ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation) throw new Error("ORCHESTRATION_RECOVERY_REQUIRED");
    if (!["inspect", "query", "cancel", "resume", "approval", "answer", "stop_job"].includes(command.operation) || typeof command.requestId !== "string" || !/^[\w-]{1,128}$/.test(command.requestId)) throw new Error("DESKTOP_IPC_DENIED");
    const continuation = interactionContinuation(command);
    if (command.runId && command.runId !== run.id) throw new Error("ORCHESTRATION_RUN_MISMATCH");
    const guardedResume = command.operation === "resume" && !!(command.approvalId || command.questionId);
    if ((continuation || guardedResume) && (run.navigationRemoved || !this.workspaceAvailable(workspaceId) || entry.facts.status().ledger?.connection.state !== "connected")) throw new Error("ORCHESTRATION_RECOVERY_REQUIRED");
    const inspection = await entry.channel.command({ operation: "inspect", requestId: orchestrationId(ref.sessionId, "inspect"), sessionId: ref.sessionId }, true) as OrchestrationInspection;
    if (command.executionToken !== orchestrationId(JSON.stringify(ref), inspection.turnId ?? "idle")) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    if (continuation && !matchesInteraction(inspection, continuation.resume, "pending")) throw new Error(continuation.changed);
    if (command.operation === "resume" && run.controlOnly && !isTerminalInputTurn(run, inspection.turnId)) throw new Error("ORCHESTRATION_EXECUTION_RECOVERY_REQUIRED");
    if (guardedResume && (!inspection.turnId || inspection.execution !== "inactive" || !matchesInteraction(inspection, command, "decided") || this.cancelling.has(orchestrationId(run.id, ref.sessionId, inspection.turnId)) || pendingControllerCancel(run, ref.sessionId, inspection.turnId))) throw new Error("ORCHESTRATION_CONTINUE_PENDING");
    if (command.operation === "query") {
      await this.reconcileController(run.id);
      return;
    }
    const saved = await readManagedRecord<Record<string, OrchestrationInspection>>(join(this.root, "inspections.json"), {});
    let result: ManagedRuntimeReceipt | undefined;
    if (command.operation === "inspect") { this.inspections.set("controller:" + run.id, inspection); saved["controller:" + run.id] = inspection; entry.observed.delete(ref.sessionId); }
    else {
      const control = { requestId: command.requestId, operation: command.operation, sessionId: ref.sessionId, turnId: inspection.turnId, jobId: command.jobId };
      const ended = command.operation === "cancel" && !canCancelTurn(inspection) && inspection.execution === "inactive";
      if (!ended && (!inspection.turnId || command.operation === "resume" && (!inspection.recoverable || inspection.activeJobs))) throw new Error("ORCHESTRATION_CONTINUE_PENDING");
      const cancelKey = command.operation === "cancel" && control.turnId ? orchestrationId(run.id, ref.sessionId, control.turnId) : undefined;
      if (cancelKey && this.cancelling.has(cancelKey)) return;
      if (cancelKey) this.cancelling.add(cancelKey);
      const desktop = this;
      let alreadyPending = false;
      /** 先保存精确意图，再向 Worker 发送原请求。 */
      async function sendControl(): Promise<ManagedRuntimeReceipt> {
        const pending: ManagedRuntimeReceipt = { ...control, operation: command.operation, ...(ended ? { state: "confirmed", code: "MANAGED_NO_ACTIVE_TURN" } : { state: "unconfirmed" }) };
        const prior = await desktop.store.update(function save(ledger) {
          const current = ledger.runs.find(function same(r) { return r.id === run!.id; })!;
          const prior = command.operation === "cancel" ? pendingControllerCancel(current, control.sessionId, control.turnId) : undefined;
          if (prior) return prior;
          saveControllerOperation(current, control, pending);
        });
        if (prior) { alreadyPending = true; await desktop.reconcileController(run!.id); return prior; }
        if (ended) return pending;
        try { return await entry!.channel.command({ operation: command.operation, requestId: command.requestId, sessionId: ref!.sessionId, turnId: inspection.turnId, approvalId: command.approvalId, decision: command.decision, questionId: command.questionId, answers: command.answers, jobId: command.jobId }, true) as ManagedRuntimeReceipt; }
        catch { return pending; }
      }
      let receipt: ManagedRuntimeReceipt;
      try {
        receipt = controllerReceipt(control, command.operation === "resume" ? await entry.service.resumeController(run.id, ref.sessionId, inspection.turnId!, sendControl) : await sendControl())!;
        if (alreadyPending || ended) { await entry.facts.refresh([ref.sessionId]); return; }
        await this.store.update(function audit(ledger) {
          const current = ledger.runs.find(function same(r) { return r.id === run.id; })!;
          if (current.controller.execution?.sessionId !== ref.sessionId || current.controller.execution.owner !== ref.owner || current.controller.execution.generation !== ref.generation) return;
          const cancel = command.operation === "cancel" ? controllerCancelReceipt(current) : undefined;
          const settled = cancel?.requestId === control.requestId && cancel.state !== "unconfirmed" ? cancel : receipt;
          if (cancel?.requestId === control.requestId) current.controller.cancelReceipt = settled;
          if (JSON.stringify(current.controller.control) !== JSON.stringify(control)) return;
          current.controller.receipt = settled;
          saveRelayAnswer(current, settled, ref, command.questionId);
          current.records.push({ requestId: command.requestId, digest: orchestrationId(JSON.stringify(settled)), action: "human_controller_" + command.operation, at: new Date().toISOString() });
        });
        result = receipt;
      } finally { if (cancelKey) this.cancelling.delete(cancelKey); }
      // 两阶段审批确认后立即反馈，后续 inspect/恢复的存储故障不能重新变成“审批提交中”。
      if (decisionOnly) { entry.observed.delete(ref.sessionId); return result; }
      this.inspections.delete("controller:" + run.id); delete saved["controller:" + run.id];
      const decided = ["approval", "answer"].includes(command.operation) && this.decisionConfirmed(entry, ref, inspection.turnId, command.operation, command.operation === "approval" ? command.approvalId : command.questionId, command.requestId, receipt);
      if (!continuation && decided) {
        const current = await entry.channel.command({ operation: "inspect", requestId: orchestrationId(command.requestId, "inspect"), sessionId: ref.sessionId }, true) as OrchestrationInspection;
        if (current.turnId !== inspection.turnId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
        this.inspections.set("controller:" + run.id, current); saved["controller:" + run.id] = current;
      }
    }
    await writeManagedRecord(join(this.root, "inspections.json"), saved);
    if (continuation) {
      if (!result || result.state !== "confirmed" || result.code) throw new Error(continuation.unconfirmed);
      let resumed: ManagedRuntimeReceipt | undefined;
      try {
        // 在同一工作区串行命令中复用原交互、Turn、Job 和目录的恢复校验。
        resumed = await this.controller(workspaceId, { type: "controller", workspaceId, runId: run.id, executionToken: command.executionToken, ...continuation.resume });
      } catch {
        throw new Error(continuation.resumePending);
      }
      if (!resumed || resumed.code || !["started", "confirmed"].includes(resumed.state)) throw new Error(continuation.resumePending);
      return resumed;
    }
    entry.observed.delete(ref.sessionId);
    await entry.facts.refresh([ref.sessionId]);
    return result;
  }

  /** 先交给 Worker 持久接纳，再记录原回执，不等恢复、轮询或工作区队列。 */
  private async cancelFromTerminal(workspaceId: string, frame: ManagedTerminalFrame, isCurrent: () => boolean): Promise<{ message: string; error?: boolean }> {
    const { requestId, turnId, executionToken } = frame;
    if (typeof requestId !== "string" || typeof turnId !== "string" || typeof executionToken !== "string" || !/^[\w-]{1,128}$/u.test(requestId) || !/^[\w-]{1,128}$/u.test(turnId)) throw new Error("DESKTOP_IPC_DENIED");
    const run = await this.currentRun(workspaceId);
    const ref = run?.controller.execution;
    const entry = run && this.runtimes.get(run.checkout);
    if (!isCurrent() || !run || !ref || !entry || !this.workspaceAvailable(workspaceId) || run.navigationRemoved || !this.hosts.has(run.id)
      || executionToken !== orchestrationId(run.id, JSON.stringify(ref)) || ref.hostId !== entry.channel.identity.hostId || ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation) {
      return { message: "主控连接已变化，原停止请求未发送。", error: true };
    }
    const control = { requestId, operation: "cancel" as const, sessionId: ref.sessionId, turnId };
    const cancelKey = orchestrationId(run.id, ref.sessionId, turnId);
    if (this.cancelling.has(cancelKey)) return { message: "原停止请求状态待确认，等待原 Turn 的终态。" };
    if (run.records.some(function duplicate(r) { return r.requestId === requestId && r.action === "human_controller_cancel"; })) return { message: "原停止请求已登记，请查看该 Turn 的回执。" };
    if (pendingControllerCancel(run, ref.sessionId, turnId)) {
      await this.reconcileController(run.id);
      return { message: "已核查原停止请求，按原 Turn 的状态确认结果。" };
    }
    this.cancelling.add(cancelKey);
    const previous = JSON.stringify(controllerControl(run));
    const previousCancel = controllerCancelReceipt(run)?.requestId;
    let receipt: ManagedRuntimeReceipt = { ...control, state: "unconfirmed" };
    try {
      try { receipt = controllerReceipt(control, await entry.channel.command(control, true) as ManagedRuntimeReceipt)!; }
      catch { /* 传输未知只按原请求核查。 */ }
      await this.store.update(function audit(ledger) {
        const current = ledger.runs.find(function same(candidate) { return candidate.id === run.id; });
        if (!current || current.navigationRemoved || JSON.stringify(current.controller.execution) !== JSON.stringify(ref)
          || current.records.some(function duplicate(record) { return record.requestId === requestId; })) return;
        if (controllerCancelReceipt(current)?.requestId === previousCancel) current.controller.cancelReceipt = receipt;
        if (JSON.stringify(controllerControl(current)) === previous) {
          current.controller.control = control;
          current.controller.receipt = receipt;
        }
        current.records.push({ requestId, digest: orchestrationId(JSON.stringify(receipt)), action: "human_controller_cancel", at: new Date().toISOString() });
      });
    } finally { this.cancelling.delete(cancelKey); }
    if (receipt.code) return { message: receipt.code === "MANAGED_TURN_MISMATCH" ? "所见 Turn 已变化，请刷新后再停止当前 Turn。" : "停止请求已发出，原 Turn 的停止回执待核查。", error: true };
    return { message: receipt.state === "confirmed" ? "该 Turn 已结束。" : "停止请求状态待确认，等待原 Turn 的终态。" };
  }

  /** 受管 CLI 的固定主控入口；Session 身份从 Run 解析，禁止客户端自选目标或运行时。 */
  async terminalRequest(workspaceId: string, frame: ManagedTerminalFrame, expectedRunId?: string, target?: ManagedExecutorTarget, isCurrent = function current() { return true; }): Promise<unknown> {
    if (this.removing.has(workspaceId) || this.store.navigationRemoved(workspaceId)) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
    const workspace = this.workspaces().find(function same(w) { return w.id === workspaceId && w.mode === "orchestration"; });
    if (!workspace) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
    if (target) return this.executorTerminalRequest(workspaceId, target, frame, isCurrent);
    if (frame.operation === "cancel") return this.cancelFromTerminal(workspaceId, frame, isCurrent);
    let selected = await this.currentRun(workspaceId);
    if (expectedRunId && expectedRunId !== selected?.id) throw new Error("ORCHESTRATION_RUN_MISMATCH");
    if (!this.workspaceAvailable(workspaceId) || selected?.navigationRemoved) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
    if (selected) {
      const runId = selected.id;
      await this.connectControl(runId);
      selected = await this.currentRun(workspaceId);
      if (selected?.id !== runId && (expectedRunId || frame.operation !== "read")) throw new Error("ORCHESTRATION_RUN_MISMATCH");
    }
    const run = selected;
    if (!isCurrent()) throw new Error("MANAGED_TERMINAL_STALE");
    if (!this.workspaceAvailable(workspaceId) || run?.navigationRemoved) throw new Error("ORCHESTRATION_WORKSPACE_MISSING");
    if (run && run.controller.executor !== "ap") throw new Error("ORCHESTRATION_EXECUTOR_UNSUPPORTED");
    const entry = run && this.runtimes.get(run.checkout);
    if (frame.operation === "read") {
      if (!run) {
        const checkout = await canonicalCheckout(workspace.directory);
        const trust = await createNodeTrustPolicy({ stateRoot: join(this.root, "runtimes", orchestrationId(checkout)) }).getTrustStatus(checkout);
        if (trust.status === "trusted") {
          await this.openController(workspace, "");
          return await this.terminalRequest(workspaceId, frame);
        }
        return { status: "直接输入任务目标，主控会自动协调执行；之后可随时追加需求。", trustRequired: true, workspaceRoot: checkout };
      }
      if (!entry || !this.hosts.has(run!.id)) return { sessionId: run.controller.execution?.sessionId, status: "原主控暂未连接。请重新连接终端；历史和未处理输入会保留。" };
      const ref = run.controller.execution;
      if (!ref || ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      const inspection = await entry.channel.command({ operation: "inspect", requestId: orchestrationId("cli-inspect", ref.sessionId), sessionId: ref.sessionId }, true) as OrchestrationInspection;
      if (expectedRunId && (await this.currentRun(workspaceId))?.id !== expectedRunId) throw new Error("ORCHESTRATION_RUN_MISMATCH");
      const host = this.hosts.get(run.id)!;
      // 终态与 Worker 驱动退出可能错开；只读轮询只补驱动已保存且未发送的本会话输入。
      if (inspection.execution === "inactive" && !inspection.activeJobs && !["waiting_approval", "waiting_user_input"].includes(inspection.status)
        && run.pending?.some(function waiting(i) {
          const prompt = run.prompts[i.promptVersion - 1];
          return i.kind === "prompt" && i.state === "pending" && i.attention !== "input_too_large" && !i.wake && prompt?.terminalInput && (!prompt.queue || inspection.status === "completed");
        })) void host.drive().catch(function failed() {});
      const batch = run.batches?.find(function pending(b) { return b.planVersion === run.planVersion && b.state === "pending"; });
      const sessions = entry.facts.status().ledger?.sessions;
      const waiting = run.assignments.filter(function waiting(a) { return a.execution && sessions?.[a.execution.sessionId]?.snapshot?.execution?.interaction?.state === "pending"; }).map(function waiting(a) { return `执行者 ${a.id} 需要你处理，输入 /agent ${a.id} status 查看审批或问题。`; }).join("\n");
      const batchNotice = batch ? `\n扩员计划等待确认：${batch.assignmentIds.map(function task(id) { const a = run.assignments.find(function same(a) { return a.id === id; }); const step = run.steps.find(function same(s) { return s.id === a?.stepId; }); return `${id}：${step?.goal}；任务 ${a?.content}；目录 ${run.checkout}；依赖 ${step?.dependencies.join("、") || "无"}；交付 ${step?.deliverables.join("、")}`; }).join("\n")}\n输入 /batch approve 确认完整批次，或 /batch deny 取消。` : "";
      const cursor = this.terminalSessionIds.get(workspaceId) === ref.sessionId ? frame.cursor : undefined;
      this.terminalSessionIds.set(workspaceId, ref.sessionId);
      const queued = (run.pending ?? []).flatMap(function entries(i) {
        const queue = i.kind === "prompt" ? run.prompts[i.promptVersion - 1]?.queue : undefined;
        if (!queue) return [];
        const wake = i.wake, receipt = wake?.receipt;
        const turnId = wake?.operation === "start" && receipt?.requestId === wake.requestId && receipt?.sessionId === ref.sessionId
          && receipt?.operation === "start" && receipt.turnId === wake.turnId && !receipt.code && ["started", "confirmed"].includes(receipt.state) ? receipt.turnId : undefined;
        return [{ inputId: queue.inputId, turnId, rejected: i.attention === "input_too_large" }];
      });
      const queueStarts = queued.flatMap(function started(i) { return i.turnId ? [{ inputId: i.inputId, turnId: i.turnId }] : []; }).slice(-40);
      const queueRejections = queued.filter(function rejected(i) { return i.rejected; }).slice(-40).map(function rejection(i) { return { inputId: i.inputId, message: pendingMessage("input_too_large") }; });
      const pendingQueueCount = queued.filter(function waiting(i) { return !i.turnId && !i.rejected; }).length;
      return { runId: run.id, sessionId: ref.sessionId, workspaceRoot: run.checkout, queueStarts, queueRejections, cancelToken: orchestrationId(run.id, JSON.stringify(ref)), checkoutNotice: this.checkoutNotices.get(run.id), receiptNotice: this.finishNotice(run, ref.sessionId).trimStart() || undefined, approvalStatus: this.approvalNotice(run, ref.sessionId, inspection), pendingApproval: inspection.interaction?.state === "pending" && inspection.interaction.approval && !entry.decided.has(interactionKey(ref, inspection.turnId!, "approval", inspection.interaction.approval.approvalId)) ? { turnId: inspection.turnId, approval: inspection.interaction.approval } : undefined, inspection, status: `AP 主控 · ${run.finishes?.some(function stopped(f) { return f.stop; }) ? "已停止新派工" : run.controlOnly ? "旧编排执行待核查，可在本会话继续输入；/recover 查看核查结果" : !run.goal.trim() && !run.prompts.length && !inspection.turnId && !run.assignments.length ? "等待目标；主控 Turn 尚未开始" : run.paused ? "派工暂停（可继续追加需求）；/dispatch 恢复派工" : "自动协调中；可随时追加需求"}${pendingQueueCount ? " · 排队 " + pendingQueueCount + " 条" : ""}${batchNotice}${waiting ? "\n" + waiting : ""}`, page: await entry.channel.command({ operation: "transcript", requestId: orchestrationId("transcript", frame.cursor ?? "start"), sessionId: ref.sessionId, cursor }, true) };
    }
    if (frame.operation === "cli") {
      if (!run || !entry || !this.hosts.has(run!.id) || !run.controller.execution) throw new Error("ORCHESTRATION_RECOVERY_REQUIRED");
      const ref = run.controller.execution;
      if (ref.owner !== entry.channel.identity.owner || ref.generation !== entry.channel.identity.generation) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      if (frame.executionToken && frame.executionToken !== orchestrationId(run.id, JSON.stringify(ref))) return { kind: "error", exitCode: 1, lines: ["主控会话已切换，本次输入未提交。请从输入历史取回。"] };
      if (frame.action?.type === "approve") {
        const { expected, decision } = frame.action;
        const inspection = await entry.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: ref.sessionId }, true) as OrchestrationInspection;
        if (!expected || expected.sessionId !== ref.sessionId || expected.turnId !== inspection.turnId || !isManagedApprovalDecision(decision)) throw new Error("ORCHESTRATION_APPROVAL_CHANGED");
        await this.command({ type: "controller", workspaceId, runId: run.id, executionToken: orchestrationId(JSON.stringify(ref), inspection.turnId!), requestId: frame.requestId, operation: "approval", approvalId: expected.approvalId, decision, continueAfterApproval: true }, isCurrent);
        const saved = (await this.currentRun(workspaceId))?.approvalContinuations?.find(function same(record) { return record.sessionId === ref.sessionId && record.turnId === expected.turnId && record.approvalId === expected.approvalId; });
        return { kind: "ok", exitCode: 0, lines: [saved ? approvalContinuationStatus(saved) : "审批决定已保存，恢复结果待核查。"] };
      }
      if (frame.action?.type === "submit_prompt" && frame.action.delivery === "queue") {
        const version = run.records.find(function same(record) { return record.requestId === frame.requestId; })?.promptVersion;
        const existing = version && run.prompts[version - 1];
        if (existing) {
          if (!existing.queue || existing.text !== frame.action.content) throw new Error("ORCHESTRATION_REQUEST_CONFLICT");
          if (run.pending?.some(function rejected(i) { return i.kind === "prompt" && i.promptVersion === version && i.attention === "input_too_large"; })) return { kind: "error", exitCode: 2, lines: [pendingMessage("input_too_large")] };
          return { kind: "ok", exitCode: 0, lines: [], submittedInput: { inputId: existing.queue.inputId, delivery: "queue" } };
        }
      }
      const result = await entry.channel.command({ operation: "cli", requestId: frame.requestId ?? randomUUID(), sessionId: ref.sessionId, action: frame.action, questionId: frame.questionId }, true) as import("@autopilot-agent/cli/dist/controller.js").CliControllerResult & { queuedAfterTurnId?: string };
      if (result.continuationRequested) {
        try { await this.terminalRequest(workspaceId, { operation: "input", text: "/resume", requestId: frame.requestId, executionToken: orchestrationId(run.id, JSON.stringify(ref)) }); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "ORCHESTRATION_CHECKOUT_BUSY") throw error;
          return { ...result, continuationRequested: undefined, lines: [...result.lines, "决定已保存，等目录可用后用 /resume 继续原 Turn。"] };
        }
        return { ...result, continuationRequested: undefined };
      }
      if (result.preparedPrompt) {
        const prompt = result.preparedPrompt;
        if (prompt.delivery === "queue") {
          if (!frame.requestId || !result.queuedAfterTurnId) throw new Error("CLI_QUEUE_REQUIRES_ACTIVE_TURN");
          const queue = { inputId: frame.requestId, afterTurnId: result.queuedAfterTurnId };
          const response = await this.submitTerminalPrompt(workspaceId, run.id, frame.requestId, prompt, queue, isCurrent);
          if (response.rejected) return { kind: "error", exitCode: 2, lines: [response.message] };
          return { kind: "ok", exitCode: 0, lines: result.lines, submittedInput: { inputId: queue.inputId, delivery: "queue" } };
        }
        const response = await this.submitTerminalPrompt(workspaceId, run.id, frame.requestId, prompt, undefined, isCurrent);
        if (response.rejected) return { kind: "error", exitCode: 2, lines: [response.message] };
        return { ...result, preparedPrompt: undefined, lines: [...result.lines, response.message], hostRecordedPrompt: prompt.content };
      }
      return result;
    }
    const text = frame.text?.trim(); if (!text || !frame.requestId) throw new Error("DESKTOP_IPC_DENIED");
    if (frame.executionToken && (!run?.controller.execution || frame.executionToken !== orchestrationId(run.id, JSON.stringify(run.controller.execution)))) return "主控会话已切换，本次输入未提交。请从输入历史取回。";
    if (run?.controller.execution && /^\/approval\s+(status|resume)$/u.test(text)) return this.approvalFromTerminal(run, run.controller.execution.sessionId, undefined, text.endsWith("resume") ? "resume" : "query");
    if (run?.controller.execution && entry && /^\/finish(?:\s|$)/u.test(text)) {
      const ref = run.controller.execution;
      const inspection = await entry.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: ref.sessionId }, true) as OrchestrationInspection;
      return this.finishFromTerminal(run, entry, frame, { ...ref, turnId: inspection.turnId }, isCurrent);
    }
    if (text.startsWith("/recovery-answer ")) return "旧恢复选择已停用。可直接在本会话输入、用 /recover 核查执行，或手动开始新任务。";
    if (text === "/trust") {
      const checkout = await canonicalCheckout(workspace.directory);
      await createNodeTrustPolicy({ stateRoot: join(this.root, "runtimes", orchestrationId(checkout)) }).grantTrust(checkout);
      await this.openController(workspace, "");
      return "已信任此工作区。请输入交给持久主控的目标。";
    }
    if (text === "/agent" || text === "/help") return ORCHESTRATION_TERMINAL_HELP;
    if (run && text === "/recover") {
      const legacy = run.recoveryDialogue;
      const saved = legacy && !legacy.resolved
        ? [...legacy.pending.filter(function pending(p) { return !p.delivered; }).map(function text(p) { return p.content; }),
           ...(legacy.lastAnswer && !legacy.pending.some(function same(p) { return p.requestId === legacy.lastAnswer!.requestId; }) ? [legacy.lastAnswer.content] : [])]
        : [];
      if (run.controlOnly) await this.command({ type: "checkRecovery", workspaceId, runId: run.id });
      const check = this.recoveries.get(run.id);
      const lastViewClose = latestViewClose(run);
      const continuation = lastViewClose ? [`最近一次终端接续记录（Run 版本 ${lastViewClose.revision}，${lastViewClose.at}）。请在原 Run 详情查看步骤、结果、未完成项和审批。`] : [];
      return [...continuation, check ? check.ready ? "旧执行已核查。输入 " + (check.changed ? "/reconnect accept 确认目录变化并连接。" : "/reconnect 连接原执行。") : "旧执行仍待核查，请在进度中查看审批、Job 或连接状态。" : "可以直接在此会话输入。需要继续原 Turn 时使用 /resume。", ...(check?.checks ?? []), ...(saved.length ? ["旧版恢复问题保留的输入，可从下方取回：", ...saved] : [])].join("\n");
    }
    if (run && (text === "/reconnect" || text === "/reconnect accept")) {
      const recovery = this.recoveries.get(run!.id); if (!recovery) return "请先输入 /recover 核查原任务。";
      await this.command({ type: "reconnect", workspaceId, runId: run.id, token: recovery.token, acceptCheckout: text === "/reconnect accept" });
      return "已连接原主控，派工保持暂停。可追加需求；输入 /dispatch 恢复自动协调。";
    }
    if (run && (text === "/pause" || text === "/dispatch" || text === "/resume")) {
      if (!entry || !this.hosts.has(run!.id)) throw new Error("ORCHESTRATION_RECOVERY_REQUIRED");
      if (text === "/pause") { await this.command({ type: "pause", workspaceId, runId: run!.id, revision: run.revision, paused: true }); return "新派工已暂停；现有执行继续，仍可追加需求。Esc 可停止当前主控Turn。"; }
      if (text === "/dispatch") {
        if (run.controlOnly) return "旧派工仍待核查；请 /recover 核查后 /reconnect。";
        if (run.paused) await this.command({ type: "pause", workspaceId, runId: run.id, revision: run.revision, paused: false });
        return "已恢复自动协调。继续原 Turn 使用 /resume。";
      }
      const current = (await this.snapshot()).runs.find(function same(r) { return r.id === run.id; })!;
      if (current.controllerToken && entry) {
        const inspection = await entry.channel.command({ operation: "inspect", requestId: orchestrationId(frame.requestId, "inspect"), sessionId: run.controller.execution!.sessionId }, true) as OrchestrationInspection;
        if (inspection.interaction?.state === "decided" && inspection.interaction.approval) return this.approvalFromTerminal(run, run.controller.execution!.sessionId, undefined, "resume");
        if (run.controlOnly && !isTerminalInputTurn(run, inspection.turnId)) return "旧执行尚未恢复；请 /recover 核查后 /reconnect。";
        if (!inspection.recoverable) return "当前没有可恢复的原 Turn；未启动任何执行。";
        if (inspection.recoverable) await this.command({ type: "controller", workspaceId, runId: run!.id, executionToken: current.controllerToken, requestId: frame.requestId, operation: "resume" });
      }
      const resumeReceipt = (await this.store.read()).runs.find(function same(r) { return r.id === run.id; })?.controller.receipt;
      if (resumeReceipt?.requestId === frame.requestId) return `恢复回执：${resumeReceipt.state}；started 仅表示原 Turn 已启动，不代表完成。${run.paused ? "新派工仍暂停。" : ""}`;
      return "没有取得原 Turn 的恢复回执。请查看当前执行状态。";
    }
    if (run && /^\/batch (approve|deny)$/u.test(text)) {
      const batch = run.batches?.find(function pending(b) { return b.planVersion === run.planVersion && b.state === "pending"; });
      const requestId = frame.requestId, approve = text.endsWith("approve");
      // 先冻结这次人工输入所见清单；包括当时无待批清单的结果，重放不能改投新一版。
      const claim = await this.store.update(function bindInput(ledger) {
        const current = ledger.runs.find(function same(r) { return r.id === run.id; });
        if (!isCurrent() || !current || current.navigationRemoved || ledger.currentRunIds?.[workspaceId] && ledger.currentRunIds[workspaceId] !== run.id) throw new Error("MANAGED_TERMINAL_STALE");
        let record = current.records.find(function original(r) { return r.requestId === requestId; });
        const digest = orchestrationId(run.id, text);
        if (record && (record.action !== "terminal_batch" || record.digest !== digest)) throw new Error("ORCHESTRATION_REQUEST_CONFLICT");
        if (!record) {
          record = { requestId, digest, action: "terminal_batch", text, at: new Date().toISOString(), batchTarget: batch && { planVersion: batch.planVersion, digest: batch.digest } };
          current.records.push(record);
        }
        const target = record.batchTarget;
        const decisionId = target && orchestrationId(run.id, String(target.planVersion), target.digest, String(approve));
        return { target, revision: current.revision, decided: !!decisionId && current.records.some(function saved(r) { return r.action === "batchDecision" && r.requestId === decisionId; }) };
      });
      if (!claim.target) return "当前没有等待确认的扩员批次。";
      if (!claim.decided) await this.command({ type: "batch", workspaceId, runId: run.id, revision: claim.revision, ...claim.target, approve }, isCurrent);
      return "批次决定已保存，主控会自动继续处理。";
    }
    if (text === "/batch") return "使用 /batch approve 确认扩员批次，或 /batch deny 拒绝。";
    if (run && text.startsWith("/agent ")) {
      const [, assignmentId, action, ...parts] = text.split(" ");
      const assignment = run.assignments.find(function same(a) { return a.id === assignmentId; });
      if (!assignment?.execution) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      const executionToken = orchestrationId(JSON.stringify(assignment.execution));
      if (action === "status") {
        await this.command({ type: "inspect", workspaceId, runId: run!.id, revision: run.revision, assignmentId, executionToken });
        const inspection = this.inspections.get(executionToken)!;
        const display = inspection.interaction?.approval?.display;
        const details = [display?.operation ? `操作：${display.operation}` : "", display?.resource ? `影响：${display.resource}` : "", display?.risk ? `风险：${display.risk}` : "", display ? JSON.stringify(display, null, 2) : "", display?.hostExecution ? "此操作在宿主执行，未启用 OS 沙箱隔离。" : ""].filter(Boolean);
        return [`${assignmentId}：${inspection.status} · Session ${assignment.execution.sessionId} · Turn ${inspection.turnId ?? "无"} · 交互 ${inspection.interaction?.state ?? "无"}`, inspection.interaction?.approval ? `审批ID ${inspection.interaction.approval.approvalId}：${inspection.interaction.approval.toolName} · ${inspection.interaction.approval.reason}` : "", ...details, inspection.interaction?.question ? `问题 ${inspection.interaction.question.requestId}：` + inspection.interaction.question.questions.map(function question(q) { return `${q.id} ${q.question} ${q.options.map(function option(o) { return o.label; }).join(" / ")}`; }).join("\n") : ""].filter(Boolean).join("\n");
      }
      const operation = action === "approve" || action === "deny" ? "approval" : action === "answer" ? "answer" : action === "resume" ? "resume" : action === "cancel" ? "cancel" : undefined;
      if (!operation) return "执行者操作支持 status、approve/deny <审批ID>、answer <JSON>、resume、cancel。";
      if (operation === "resume") {
        const inspection = await entry!.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: assignment.execution.sessionId }, true) as OrchestrationInspection;
        if (inspection.interaction?.state === "decided" && inspection.interaction.approval) return this.approvalFromTerminal(run, assignment.execution.sessionId, assignmentId, "resume");
      }
      const answer = operation === "answer" ? JSON.parse(parts.join(" ")) : undefined;
      await this.command({ type: "control", workspaceId, runId: run!.id, revision: run.revision, assignmentId, executionToken, requestId: frame.requestId, operation, ...(operation === "approval" ? { continueAfterApproval: true, approvalId: parts[0], decision: action === "approve" ? "allow_once" : "deny" } : {}), ...(answer ? { questionId: answer.questionId, answers: answer.answers } : {}) });
      if (operation === "approval") {
        const saved = (await this.store.read()).runs.find(function same(r) { return r.id === run.id; })?.approvalContinuations?.find(function exact(i) { return i.assignmentId === assignmentId && i.sessionId === assignment.execution!.sessionId && i.turnId === assignment.execution!.turnId && i.approvalId === parts[0]; });
        return saved ? approvalContinuationStatus(saved) : "宿主正在核查原审批决定。";
      }
      const updated = (await this.store.read()).runs.find(function same(r) { return r.id === run.id; })?.assignments.find(function same(a) { return a.id === assignmentId; });
      const receipt = updated?.controls?.find(function same(c) { return c.requestId === frame.requestId; })?.receipt;
      if (receipt?.state === "unconfirmed" || !receipt) return "执行者操作回执待核查；请先核查原回执，不重复批准或恢复。";
      return operation === "answer" ? "回答已保存；尚未恢复执行。使用同一委派的 resume 独立继续原 Turn。" : `执行者操作回执：${receipt.state}；started 仅表示已启动，不代表完成。`;
    }
    if (!run) { if (text.startsWith("/")) throw new Error("ORCHESTRATION_INPUT_REQUIRED"); await this.command({ type: "enter", workspaceId, goal: text, trust: false }); return "目标已提交到持久主控。"; }
    if (text.startsWith("/")) {
      const view = (await this.snapshot()).runs.find(function same(r) { return r.id === run.id; })!;
      if (!view.controllerToken) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      const [name, ...args] = text.split(" ");
      const operation = name === "/status" ? "inspect" : name === "/allow" || name === "/deny" ? "approval" : name === "/answer" ? "answer" : name === "/resume" ? "resume" : name === "/cancel" ? "cancel" : undefined;
      if (!operation) return "此受管命令不可用。直接输入需求，或 /help 查看当前支持的操作。";
      const answer = operation === "answer" ? JSON.parse(args.join(" ")) : {};
      await this.command({ type: "controller", workspaceId, runId: run!.id, executionToken: view.controllerToken, requestId: frame.requestId, operation, ...(operation === "approval" ? { continueAfterApproval: true, approvalId: args[0], decision: name === "/allow" ? "allow_once" : "deny" } : {}), ...(operation === "answer" ? { questionId: answer.questionId, answers: answer.answers } : {}) });
      if (operation === "approval") {
        const saved = (await this.store.read()).runs.find(function same(r) { return r.id === run.id; })?.approvalContinuations?.find(function exact(i) { return !i.assignmentId && i.sessionId === run.controller.execution?.sessionId && i.turnId === view.controllerInspection?.turnId && i.approvalId === args[0]; });
        return saved ? approvalContinuationStatus(saved) : "宿主正在核查原审批决定。";
      }
      if (operation === "answer") {
        const receipt = (await this.store.read()).runs.find(function same(r) { return r.id === run.id; })?.controller.receipt;
        if (receipt?.state !== "confirmed") throw new Error("ORCHESTRATION_DECISION_UNCONFIRMED");
      }
      if (operation === "inspect") {
        const inspection = this.inspections.get("controller:" + run.id);
        const question = inspection?.interaction?.question;
        return [`主控：${inspection?.status ?? "待确认"}；${run.paused ? "新派工暂停" : "自动协调"}`, `进度：${run.steps.filter(function accepted(step) { return step.verdict?.accepted; }).length}/${run.steps.length} 个步骤已验收，${run.assignments.length} 个委派`, inspection?.interaction?.approval ? `审批 ${inspection.interaction.state} · ID ${inspection.interaction.approval.approvalId}：${inspection.interaction.approval.toolName} · ${inspection.interaction.approval.reason}\n${JSON.stringify(inspection.interaction.approval.display ?? {}, null, 2)}` : "", question ? question.questions.map(function item(q) { return `${q.header}：${q.question}`; }).join("\n") : "", ...(run.pending ?? []).filter(function pending(i) { return i.state === "pending"; }).map(function pending(i) { return `待处理：${i.assignmentId ?? "主控"} · ${i.attention ?? i.detail ?? i.kind}`; }), "执行者人类操作：/agent <委派ID> status 查看，approve/deny <审批ID>、answer <JSON>、resume、cancel。"].filter(Boolean).join("\n");
      }
      const receipt = (await this.store.read()).runs.find(function same(r) { return r.id === run.id; })?.controller.receipt;
      if (receipt?.code === "MANAGED_NO_ACTIVE_TURN") return "当前没有可停止的 Turn；如仍有后台 Job，请单独查看并停止。";
      return receipt?.state === "confirmed" && operation === "answer" ? "回答已保存；尚未恢复执行。使用 /resume 独立继续原 Turn。" : `控制回执：${receipt?.state ?? "unconfirmed"}；started 仅表示启动，不代表完成。`;
    }
    return (await this.submitTerminalPrompt(workspaceId, run.id, frame.requestId, { content: text }, undefined, isCurrent)).message;
  }

  /** 按原 Run 保存终端输入，Worker 准备期间的手动切换不能把正文投给另一个会话。 */
  private async submitTerminalPrompt(workspaceId: string, runId: string, requestId: string | undefined, prompt: OrchestrationPromptAttachments & { content: string; fileMentions?: OrchestrationTerminalFileMentions }, queue?: OrchestrationQueuedPrompt, isCurrent?: () => boolean): Promise<{ message: string; rejected?: true }> {
    if (!requestId || !/^[\w-]{1,128}$/u.test(requestId) || !prompt.content?.trim()) throw new Error("DESKTOP_IPC_DENIED");
    const run = await this.currentRun(workspaceId), host = this.hosts.get(runId);
    if (run?.id !== runId || run.navigationRemoved || !host) throw new Error("ORCHESTRATION_RUN_MISMATCH");
    if (run.recoveryDialogue?.lastAnswer?.requestId === requestId || run.recoveryDialogue?.pending.some(function same(p) { return p.requestId === requestId; })) return { message: "此请求已保存在旧恢复记录中，可用 /recover 查看原输入。" };
    const { content, attachments, selectedSkills, activeSkills, fileMentions } = prompt;
    const control = !queue && continuationAction({ ...prompt, text: content, scope: "run" });
    if (control === "continue" && run.controller.execution && !run.controlOnly && !run.finishes?.some(function stopping(f) { return f.stop; })) {
      const ref = run.controller.execution, entry = this.runtimes.get(run.checkout);
      const resumeId = orchestrationId(runId, requestId, "manual-resume");
      if (run.controller.control?.requestId === resumeId || run.records.some(function original(r) { return r.requestId === resumeId; })) {
        await this.reconcileController(run.id);
        return { message: "已核查原继续请求，请查看原 Turn 的恢复回执。" };
      }
      if (entry && !run.records.some(function seen(r) { return r.requestId === requestId; })) {
        const inspection = await entry.channel.command({ operation: "inspect", requestId: randomUUID(), sessionId: ref.sessionId }, true) as OrchestrationInspection;
        if (inspection.turnId && inspection.execution === "inactive" && inspection.recoverable && !inspection.activeJobs && inspection.interaction?.state !== "pending" && inspection.status === "interrupted") {
          await this.command({ type: "controller", workspaceId, runId, requestId: resumeId, executionToken: orchestrationId(JSON.stringify(ref), inspection.turnId), operation: "resume" }, isCurrent);
          return { message: "已提交原 Turn 的继续请求，请查看恢复回执。" };
        }
      }
    }
    const template = parseOrchestrationTemplate(content);
    if (template && !template.body.trim() && !run.goal.trim()) return { message: "请在模板首行下方补充任务目标后发送。", rejected: true };
    const selected = template ? [...(selectedSkills ?? []).filter(function other(s) { return s.skillId !== orchestrationSkillRef.skillId; }), orchestrationSkillRef] : selectedSkills;
    const active = template ? [...(activeSkills ?? []).filter(function other(s) { return s.skillId !== orchestrationSkillRef.skillId; }), { skillId: orchestrationSkillRef.skillId, contentHash: orchestrationSkillRef.contentHash }] : activeSkills;
    await host.prompt({ requestId, expectedRevision: run.revision, action: { type: "prompt", text: content, scope: "run", targetId: runId, terminalInput: true, queue, attachments, selectedSkills: selected, activeSkills: active, fileMentions, flow: template?.flow, independentVerification: template?.flow === "review" || undefined } }, isCurrent);
    const current = (await this.store.read()).runs.find(function same(r) { return r.id === runId; })!;
    const record = current.records.find(function same(r) { return r.requestId === requestId; });
    if (record?.action === "continue" || record?.action === "resubmit") {
      const batch = current.batches?.at(-1);
      const message = current.controlOnly ? "请先用 /recover 核查并连接原执行。" : current.paused ? "派工已暂停。用 /dispatch 恢复派工，或 /resume 恢复原 Turn。" :
        batch?.state === "pending" && batch.planVersion === current.planVersion ? "原清单正在等待人工审核。" : batch?.state === "cancelled" ? "原清单已拒绝，输入「重新弹出派工审核」可重新提审。" :
        current.pending?.some(function manual(i) { return i.manualContinue && i.id === orchestrationId(runId, requestId, "continue"); }) ? "已按当前会话的原停点登记继续，请查看主控回执。" :
        batch?.dispatch ? "已按原派工决定核查接续，请查看当前任务进度。" : batch ? "已核查原任务。输入「重新弹出派工审核」可重提仍符合当前要求的原清单；若任务内容已变化，请让主控按现有原文修订任务并封批。" : "已核查原任务，请查看当前主控回执。";
      return { message };
    }
    const version = current.records.find(function match(r) { return r.requestId === requestId; })?.promptVersion;
    const intent = current.pending?.find(function match(i) { return i.kind === "prompt" && i.promptVersion === version; });
    if (intent?.attention === "input_too_large") return { message: pendingMessage(intent.attention), rejected: true };
    const wake = intent?.wake, receipt = wake?.receipt;
    if (intent?.state === "decided" || wake && receipt && !receipt.code && receipt.requestId === wake.requestId
      && receipt.operation === wake.operation && receipt.turnId === wake.turnId && receipt.sessionId === current.controller.execution?.sessionId
      && ["started", "accepted", "confirmed"].includes(receipt.state)) return { message: "输入已交给当前主控会话。" };
    return { message: "输入已保存在当前主控会话，请查看原 Turn 的审批、回答、Job 或执行状态。" };
  }

  /** 应用退出关闭所属通道；断线不推断任务成功，也不释放持久占用。 */
  close(): void { this.closed = true; for (const host of this.hosts.values()) host.close(); for (const entry of this.runtimes.values()) { entry.facts.close(); entry.channel.stop(); } }
}
