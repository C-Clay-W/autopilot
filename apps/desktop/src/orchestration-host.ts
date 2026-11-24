/** H3 受信装配：持久事实生成意图，固定主控经真实 Core 工具读取和提出决定。 */
import { ControllerDecisionValidationError, isCorrectableDecision } from "./orchestration-validation";
import { randomUUID } from "node:crypto";
import type { RuntimeFactSnapshot } from "@autopilot-agent/core";
import { ManagedRuntimeHost } from "./managed-runtime-host";
import { ManagedFactsHost } from "./managed-facts-host";
import { OrchestrationService, requireRun, orchestrationId, type RelationCommand } from "./orchestration-service";
import { collectOrchestrationIntents, settleDirectResponses, intentBasis, isTerminalInputTurn } from "./orchestration-intents";
import { matchesManagedWakeRejection, type ManagedRuntimeReceipt } from "./managed-runtime-service";
import { buildOrchestrationWakeCommand } from "./orchestration-wake-input";
import { saveControllerDecision, applyControllerDecision, type ControllerDecision } from "./orchestration-decisions";
import { saveViewCloseProgress } from "./orchestration-view-close";
import { controllerCancelReceipt } from "./orchestration-store";
import type { OrchestrationBrowser } from "./orchestration-browser";
import { applyRelayAction, blockedExecutorInput, driveExecutorInputs, observeRelayQuestion } from "./orchestration-relay";
import { canCoordinateApproval } from "./orchestration-contract";
import { driveFinishes } from "./orchestration-finish";
import { continuationAction, finishCoversStep } from "./orchestration-admission";
import { ORCHESTRATION_DELIVERY_GUIDANCE, ORCHESTRATION_PHASED_GUIDANCE } from "./orchestration-skill";

/** 仅 main/bootstrap 持有；没有 Renderer/raw channel 的公开入口。 */
export class OrchestrationHost {
  private serial: Promise<unknown> = Promise.resolve();
  private pendingDrive?: { humanPrompt: boolean; refresh: boolean; sessions: Set<string>; result: Promise<void> };
  private unsubscribe?: () => void;
  private unregisterTools?: () => void;
  private closed = false;
  failure?: string;
  constructor(private service: OrchestrationService, private channel: ManagedRuntimeHost, private facts: ManagedFactsHost, private workspaceId: string, private browser?: OrchestrationBrowser, private workspaceLabel?: (workspaceId: string) => string | undefined, readonly desktopWorkspaceId?: string, private recoverApproval?: (id: string) => Promise<void>) {}

  /** 工具处理器先接好再启动主控；H2 重开只补意图，显式 drive 才执行唤醒。 */
  async open(): Promise<void> {
    this.closed = false;
    if (!this.channel.orchestrationTools) throw new Error("ORCHESTRATION_CAPABILITY_REQUIRED");
    const host = this;
    this.unregisterTools = this.channel.registerToolHandler(this.workspaceId, function tool(binding, operation, input, signal) { return host.tool(binding, operation, input, signal); });
    this.unsubscribe = this.facts.subscribe(function changed(sessionId) {
      if (!sessionId) host.browser?.revokeRun(host.workspaceId, host.channel.identity.generation);
      void host.drive(false, sessionId).catch(function failed() {});
    });
    await this.collect();
    const run = requireRun((await this.service.store.read()).runs, this.workspaceId);
    const latest = run.batches?.at(-1);
    if (!run.controlOnly && !run.paused && latest?.decidedByHuman && latest.state === "approved" && run.assignments.some(function outstanding(a) { return a.state === "planned" || a.state === "submitted"; })) await this.drive();
  }

  /** 合并尚未开始的驱动；事实通知直接消费已提交投影，显式对账只刷新本Run的活动身份。 */
  drive(humanPrompt = false, observedSessionId?: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pendingDrive) {
      this.pendingDrive.humanPrompt ||= humanPrompt;
      this.pendingDrive.refresh ||= observedSessionId === undefined;
      if (observedSessionId) this.pendingDrive.sessions.add(observedSessionId);
      return this.pendingDrive.result;
    }
    const host = this;
    const next = this.serial.then(async function drive() {
      host.pendingDrive = undefined;
      if (host.closed) return;
      const before = requireRun((await host.service.store.read()).runs, host.workspaceId);
      const refs = [before.controller.execution, ...before.assignments.filter(function live(a) { return !["released", "cancelled"].includes(a.state); }).map(function execution(a) { return a.execution; })]
        .filter(function current(ref) { return ref && ref.owner === host.channel.identity.owner && ref.generation === host.channel.identity.generation; });
      if (before.navigationRemoved || !request.refresh && !refs.some(function affected(ref) { return request.sessions.has(ref!.sessionId); })) return;
      if (request.refresh) try { await host.facts.refresh(refs.map(function session(ref) { return ref!.sessionId; })); } catch (error) { host.failure = error instanceof Error ? error.message : "MANAGED_FACTS_FAILED"; }
      if (host.closed) return;
      await host.service.reconcile(host.workspaceId); await host.service.reconcileControllerCheckout(host.workspaceId); await host.collect();
      const run = requireRun((await host.service.store.read()).runs, host.workspaceId);
      host.browser?.reconcile(run, host.channel.identity.generation, host.channel.identity.owner);
      if (host.closed || run.navigationRemoved || run.controller.execution?.owner !== host.channel.identity.owner || run.controller.execution?.generation !== host.channel.identity.generation) return;
      if (!run.finishes?.some(function stopped(f) { return f.stop; })) await driveExecutorInputs(host.service, host.channel, run);
      for (const item of run.pending ?? []) if (item.decision?.state === "saved" && item.decision.actions.length === 1 && item.decision.actions[0].kind === "recoverApproval") {
        await applyControllerDecision(host.service, host.workspaceId, item.id, host.recoverApproval);
      }
      await driveFinishes(host.service, host.channel, run);
      try { await host.wake(request.humanPrompt); } catch (error) {
        await host.service.store.update(function offline(ledger) { for (const item of requireRun(ledger.runs, host.workspaceId).pending ?? []) if (item.state === "pending" && !item.decision && item.attention !== "input_too_large") item.attention = "controller_offline"; });
        throw error;
      }
    });
    const request = { humanPrompt, refresh: observedSessionId === undefined, sessions: new Set(observedSessionId ? [observedSessionId] : []), result: next };
    this.pendingDrive = request;
    this.serial = next.catch(function failed(error) { host.failure = error instanceof Error ? error.message : "ORCHESTRATION_DRIVE_FAILED"; });
    return next;
  }

  /** 取消观察不取消任何 Session。 */
  close(): void { this.closed = true; this.unsubscribe?.(); this.unregisterTools?.(); this.browser?.revokeRun(this.workspaceId, this.channel.identity.generation); }

  /** 受信人类输入入口：先保留原文，再精确补充活动执行；审批/问题不接收此输入。 */
  async prompt(input: RelationCommand & { action: Extract<RelationCommand["action"], { type: "prompt" }> }, isCurrent?: () => boolean): Promise<void> {
    if (input.action.type !== "prompt") throw new Error("ORCHESTRATION_INVALID_COMMAND");
    const human = this.service.bind(this.workspaceId, { kind: "human" });
    const before = requireRun((await this.service.store.read()).runs, this.workspaceId);
    const correctable = (before.pending ?? []).filter(function safe(i) { return i.state === "pending" && isCorrectableDecision(before, i); }).map(function original(i) { return { id: i.id, digest: i.decision!.digest }; });
    const ref = before.controller.execution;
    let stopped: typeof ref;
    if (ref && !input.action.queue && continuationAction(input.action) === "continue" && !before.records.some(function duplicate(r) { return r.requestId === input.requestId; })) {
      const activity = await this.channel.command({ operation: "activity", requestId: randomUUID(), sessionId: ref.sessionId }) as { snapshot: RuntimeFactSnapshot; activeJobs: boolean };
      const execution = activity.snapshot.execution;
      if (!activity.activeJobs && execution?.execution === "inactive" && !execution.waiting && execution.turnId && ["interrupted", "failed", "limit_reached"].includes(execution.result ?? "")) stopped = { ...ref, turnId: execution.turnId };
    }
    let run = await human.command(input, isCurrent, stopped);
    if (run.records.some(function operation(r) { return r.requestId === input.requestId && (r.action === "continue" || r.action === "resubmit"); })) {
      await this.drive(true);
      return;
    }
    if (correctable.length && run.revision === before.revision + 1) await this.service.store.update(function rebase(ledger) {
      const current = requireRun(ledger.runs, before.id);
      if (current.revision !== run.revision) return;
      for (const original of correctable) {
        const item = current.pending?.find(function same(i) { return i.id === original.id && i.decision?.digest === original.digest; });
        if (!item || !isCorrectableDecision({ ...current, revision: before.revision }, item)) continue;
        item.correction = { revision: current.revision, originalWake: item.correction?.originalWake ?? item.wake };
        item.basis = intentBasis(current, item.assignmentId); item.state = "pending"; item.wake = undefined;
      }
    });
    if (input.action.terminalInput) {
      try { await this.drive(true); } catch { /* 终端原文已落盘，留在当前主控等待投递。 */ }
      return;
    }
    await this.collect();
    for (const item of run.assignments) {
      if (run.controlOnly || !item.execution || item.state !== "active" || item.local.handoff || !(input.action.scope === "run" || input.action.targetId === (input.action.scope === "step" ? item.stepId : item.id))) continue;
      const requestId = orchestrationId(input.requestId, item.id);
      if (item.controls?.some(function original(c) { return c.requestId === requestId; })) { run = await human.query(item.id, requestId); continue; }
      const activity = await this.channel.command({ operation: "activity", requestId: randomUUID(), sessionId: item.execution.sessionId }) as { snapshot: RuntimeFactSnapshot };
      if (activity.snapshot.execution?.execution !== "active" || activity.snapshot.execution.waiting) continue;
      // 原文已作为人类 Prompt 保存；这里复用绑定控制门，避免再次建立同一 Prompt。
      run = await this.service.bind(this.workspaceId, { kind: "controller", sessionId: run.controller.execution!.sessionId }).control({ expectedRevision: run.revision, assignmentId: item.id, execution: item.execution, command: { requestId, operation: "steer", content: input.action.text } });
    }
    await this.drive(true);
  }

  /** 从原结果重算同一意图，写入失败不确认消费。 */
  private async collect(): Promise<void> {
    const workspaceId = this.workspaceId;
    const facts = this.facts.status().ledger;
    await this.service.store.update(function collect(ledger) { collectOrchestrationIntents(requireRun(ledger.runs, workspaceId), facts, ledger); });
  }

  /** 固定主控复用普通 Runtime 工具与权限；等待交互不接管提示。 */
  private async wake(humanPrompt = false): Promise<void> {
    const host = this;
    const run = requireRun((await this.service.store.read()).runs, this.workspaceId);
    const ref = run.controller.execution;
    if (!ref || ref.owner !== this.channel.identity.owner || ref.generation !== this.channel.identity.generation) return;
    if (finishCoversStep(run)) return;
    /** 只有 Worker 确认原请求在执行前被拒绝，才撤销唤醒登记，等同一会话可接收时再发。 */
    async function saveWake(requestId: string, receipt: ManagedRuntimeReceipt) {
      await host.service.store.update(function reconciled(ledger) {
        const current = requireRun(ledger.runs, host.workspaceId);
        for (const item of current.pending ?? []) {
          const wake = item.wake;
          if (!wake || wake.requestId !== requestId) continue;
          if (matchesManagedWakeRejection(receipt, wake, ref!.sessionId)) item.wake = undefined;
          else wake.receipt = receipt;
          item.attention = receipt.state === "unconfirmed" ? "wake_unconfirmed" : undefined;
        }
      });
    }
    for (const requestId of new Set((run.pending ?? []).filter(function unknown(i) { return i.state === "pending" && (!i.decision || isCorrectableDecision(run, i)) && i.wake; }).map(function id(i) { return i.wake!.requestId; }))) {
      const receipt = await this.channel.command({ operation: "query", requestId: randomUUID(), targetRequestId: requestId }) as ManagedRuntimeReceipt;
      await saveWake(requestId, receipt);
    }
    if (!run.pending?.some(function pending(i) { return i.state === "pending" && i.attention !== "input_too_large" && (!i.decision || i.decision.state === "saved" || isCorrectableDecision(run, i)); })) return;
    const activity = await this.channel.command({ operation: "activity", requestId: randomUUID(), sessionId: ref.sessionId }) as { snapshot: RuntimeFactSnapshot; activeJobs: boolean };
    const execution = activity.snapshot.execution;
    if (run.assignments.some(function waiting(a) { return a.directInputs?.some(function question(i) { return i.state === "clarifying"; }); })) await observeRelayQuestion(this.service, run.id, ref, execution);
    await this.service.store.update(function checkDelivery(ledger) {
      settleDirectResponses(requireRun(ledger.runs, host.workspaceId), ref.sessionId, execution, activity.activeJobs);
      for (const item of requireRun(ledger.runs, host.workspaceId).pending ?? []) {
        if (item.state !== "pending" || item.attention === "input_too_large" || (item.decision && !isCorrectableDecision(requireRun(ledger.runs, host.workspaceId), item))) continue;
        if (execution?.waiting) item.attention = "controller_waiting";
        else if (execution?.execution === "inactive" && execution.result === "interrupted") item.attention = !item.wake ? "input_waiting_recovery" : (item.wake.turnId ?? item.wake.receipt?.turnId) === execution.turnId ? "controller_interrupted" : "wake_unconfirmed";
        else if (execution?.execution === "inactive" && execution.result === "limit_reached") item.attention = "controller_limited";
        else if (execution?.execution === "inactive" && execution.result === "failed") item.attention = "controller_failed";
        else if (execution?.execution === "inactive" && item.wake) {
          const receipt = item.wake.receipt;
          item.attention = !receipt || receipt.state === "unconfirmed" ? "wake_unconfirmed" : item.wake.operation === "steer" && receipt.state !== "confirmed" ? "input_unconsumed" : "decision_missing";
        }
      }
    });
    if (activity.activeJobs || execution?.waiting || execution && !["active", "inactive"].includes(execution.execution)
      || execution?.execution === "inactive" && !execution.result) return;
    const operation = execution?.execution === "active" ? "steer" : "start";
    const afterStop = !!execution?.result && execution.result !== "completed";
    const stop = controllerCancelReceipt(requireRun((await this.service.store.read()).runs, this.workspaceId));
    const stopping = !!stop && !stop.code && stop.sessionId === ref.sessionId && stop.turnId === execution?.turnId && stop.state === "unconfirmed";
    if (!run.controlOnly && !run.paused && !afterStop && !stopping) {
      for (const item of run.pending ?? []) if (item.decision?.state === "saved") await applyControllerDecision(host.service, host.workspaceId, item.id, host.recoverApproval);
    }
    const requestId = randomUUID();
    const delivery = await this.service.store.update(function prepare(ledger) {
      const current = requireRun(ledger.runs, host.workspaceId);
      // release 的持久决定可能刚在本次 drive 完成；同轮补齐接续，不能依赖下一次外部事件。
      collectOrchestrationIntents(current, host.facts.status().ledger, ledger);
      if (current.navigationRemoved || finishCoversStep(current) || current.controller.execution?.sessionId !== ref!.sessionId || current.controller.execution.generation !== ref!.generation) return;
      const cancel = controllerCancelReceipt(current);
      if (operation === "steer" && cancel?.state === "unconfirmed" && cancel.turnId === execution?.turnId && !cancel.code) return;
      const onlyTerminalInput = current.controlOnly || afterStop;
      if (current.controlOnly && operation === "steer" && !isTerminalInputTurn(current, execution?.turnId)) return;
      const eligible = current.pending!.filter(function pending(i) {
        if (i.state !== "pending" || i.attention === "input_too_large" || i.wake || i.decision && !isCorrectableDecision(current, i)) return false;
        if (i.manualContinue) return operation === "start" && afterStop && !current.paused && !current.controlOnly && !stopping
          && i.manualContinue.turnId === execution?.turnId && i.manualContinue.sessionId === ref!.sessionId && i.manualContinue.generation === ref!.generation;
        if (operation === "steer" && i.kind === "host" && i.detail?.startsWith("batch_approved:")) return false;
        if (i.kind === "prompt" && current.prompts[i.promptVersion - 1]?.queue) return operation === "start" && execution?.result === "completed";
        if (i.kind === "prompt" && current.prompts[i.promptVersion - 1]?.terminalInput) return true;
        return !onlyTerminalInput && (!current.paused || humanPrompt && i.kind === "prompt");
      });
      // 仅在成功终态后按 FIFO 领取，先前投递不明时保留后续排队。
      const firstQueue = current.pending!.find(function head(i) {
        if (i.kind !== "prompt" || i.state !== "pending" || i.attention === "input_too_large" || !current.prompts[i.promptVersion - 1]?.queue) return false;
        const wake = i.wake, receipt = wake?.receipt;
        return !wake || !receipt || receipt.code || receipt.requestId !== wake.requestId || receipt.turnId !== wake.turnId || receipt.sessionId !== ref!.sessionId
          || receipt.operation !== "start" || !["started", "confirmed"].includes(receipt.state);
      });
      const queued = firstQueue && eligible.includes(firstQueue) ? firstQueue : undefined;
      const items = queued ? [queued] : eligible.filter(function immediate(i) { return i.kind !== "prompt" || !current.prompts[i.promptVersion - 1]?.queue; });
      if (!items.length) return;
      const prompts = current.prompts.filter(function selected(prompt) { return items.some(function pending(intent) { return intent.kind === "prompt" && intent.promptVersion === prompt.version; }); });
      const command = buildOrchestrationWakeCommand(host.channel.identity, {
        operation, requestId, sessionId: ref.sessionId,
        turnId: operation === "steer" ? execution?.turnId : undefined,
        previousTurnId: items.some(function manual(i) { return !!i.manualContinue; }) || prompts.some(function terminal(prompt) { return prompt.terminalInput; }) ? execution?.turnId ?? null : undefined,
        queued: queued ? true : undefined,
      }, items.map(function id(item) { return item.id; }), prompts);
      if (!command) {
        for (const item of items) item.attention = "input_too_large";
        return;
      }
      // 新对话可以立即启动，旧动作保持暂停，等人类显式恢复派工。
      if (afterStop && !current.paused && !items.some(function manual(i) { return !!i.manualContinue; })) { current.paused = true; current.revision++; }
      const queue = queued && current.prompts[queued.promptVersion - 1].queue;
      if (queue && !queue.activated) {
        queue.activated = true;
        for (const step of current.steps) step.verdict = undefined;
        current.planVersion++; current.revision++; current.acceptance = "pending";
      }
      const turnId = operation === "steer" ? execution?.turnId : orchestrationId(ref!.hostId, ref!.sessionId, requestId);
      const directResponse = items.every(function prompt(i) { return i.kind === "prompt"; });
      for (const item of items) item.wake = { requestId, operation, turnId, generation: ref!.generation, directResponse, revision: current.revision };
      if (queued) queued.basis = intentBasis(current);
      return command;
    });
    if (!delivery || this.closed) return;
    let receipt: ManagedRuntimeReceipt;
    try { receipt = await this.channel.command(delivery) as ManagedRuntimeReceipt; }
    catch { receipt = { requestId, state: "unconfirmed" }; }
    await saveWake(requestId, receipt);
  }

  /** 会话身份由 Runtime 反向 RPC 绑定，目录与查询不能由模型自报角色。 */
  private async tool(binding: { sessionId: string; turnId: string }, operation: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("ORCHESTRATION_HOST_CLOSED");
    const ledger = await this.service.store.read();
    const run = requireRun(ledger.runs, this.workspaceId);
    if (run.navigationRemoved) return undefined;
    const controller = run.controller.execution?.sessionId === binding.sessionId;
    const assignment = run.assignments.find(function own(a) { return a.execution?.sessionId === binding.sessionId && a.execution.turnId === binding.turnId; });
    if (!controller && !assignment) return undefined;
    const generation = this.channel.identity.generation;
    const owner = this.channel.identity.owner;
    const controllerAttached = controller && run.controller.execution?.generation === generation && run.controller.execution.owner === owner;
    const executorAttached = assignment?.execution?.owner === owner && assignment?.execution?.generation === generation;
    if (!(controllerAttached || executorAttached)) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    if (operation === "catalog") {
      const ownsCheckout = executorAttached && ledger.leases?.some(function claimed(lease) { return lease.runId === run.id && lease.assignmentId === assignment?.id && lease.checkout === run.checkout; });
      const label = controllerAttached || ownsCheckout ? this.workspaceLabel?.(run.workspaceId) : undefined;
      return { role: controller ? "controller" : "executor", ...(label ? { browserKey: this.browser?.register(run, binding, generation, label, owner) } : {}) };
    }
    if (operation === "browser_end" && (controllerAttached || executorAttached)) {
      this.browser?.end(run, binding, generation, (input as { key?: string } | null)?.key, owner);
      return { released: true };
    }
    const current = await this.channel.command({ operation: "snapshot", requestId: randomUUID(), sessionId: binding.sessionId }) as RuntimeFactSnapshot;
    if (current.execution?.turnId !== binding.turnId) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    if (operation === "browser_request") {
      if (!(controllerAttached || executorAttached) || !this.browser || !this.workspaceLabel?.(run.workspaceId) || current.execution.execution !== "active" || current.execution.waiting
        || current.sessionId !== binding.sessionId) throw new Error("BROWSER_TURN_UNAVAILABLE");
      const state = await this.service.store.read();
      const latest = requireRun(state.runs, run.id);
      if (executorAttached && !state.leases?.some(function claimed(lease) { return lease.runId === latest.id && lease.assignmentId === assignment?.id && lease.checkout === latest.checkout; })) throw new Error("BROWSER_TURN_UNAVAILABLE");
      if (assignment && blockedExecutorInput(latest, assignment.id)) throw new Error("ORCHESTRATION_INPUT_NEEDS_DECISION");
      return this.browser.request(latest, binding, generation, input, signal, owner);
    }
    if (operation === "tool_admission") {
      if (current.execution.execution !== "active" || current.execution.waiting) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
      const clarification = (input as { toolName?: string } | null)?.toolName === "ask_user_question" && run.assignments.some(function waiting(a) { return a.directInputs?.some(function same(i) { return i.state === "clarifying" && i.question?.turnId === binding.turnId && i.question.sessionId === binding.sessionId; }); });
      if (controller && !clarification && finishCoversStep(run)) throw new Error("ORCHESTRATION_FINISHING");
      if (controller && !clarification) await this.service.admitControllerTool(this.workspaceId, binding.sessionId, binding.turnId);
      if (assignment) {
        if (blockedExecutorInput(run, assignment.id)) throw new Error("ORCHESTRATION_INPUT_NEEDS_DECISION");
        if (run.handoffs?.some(function waiting(h) { return h.assignmentId === assignment.id && !h.received; })) throw new Error("ORCHESTRATION_HANDOFF_TARGET_REQUIRED");
      }
      return { admitted: true };
    }
    if (operation === "orchestration_relay") {
      const payload = input as { expectedRevision?: number; action?: unknown };
      if (!payload || !Number.isSafeInteger(payload.expectedRevision) || Object.keys(payload).some(function extra(k) { return !["expectedRevision", "action"].includes(k); })) throw new Error("ORCHESTRATION_INVALID_COMMAND");
      // Ask 回答后可能继续同 Turn 立即裁决，先从 Core 记录真正已消费的原问题。
      if (controller && run.controller.execution && current.execution.interaction?.requestId) await observeRelayQuestion(this.service, run.id, run.controller.execution, current.execution);
      const relay = await applyRelayAction(this.service, run.id, binding, this.channel.identity, payload.expectedRevision!, current.execution.lastSeq, payload.action);
      void this.drive().catch(function failed() {});
      return relay;
    }
    if (controller && operation === "orchestration_decide") await this.service.store.update(function used(ledger) {
      for (const item of requireRun(ledger.runs, run.id).pending ?? []) if (item.wake && item.state === "pending" && (!item.wake.turnId && !item.wake.receipt?.turnId || (item.wake.turnId ?? item.wake.receipt?.turnId) === binding.turnId)) item.wake.orchestrationUsed = true;
    });
    const api = this.service.bind(this.workspaceId, { kind: controller ? "controller" : "executor", sessionId: binding.sessionId });
    if (operation === "orchestration_query") return { ...await api.snapshot(), approvalRecovery: controller ? run.approvalContinuations?.filter(function blocked(i) { return i.reconciliation?.stopped; }).map(function action(i) { return { id: i.id, assignmentId: i.assignmentId, reason: i.reconciliation!.stopped, canCheck: canCoordinateApproval(i), canContinue: canCoordinateApproval(i) && i.resume?.retryable === true }; }) : undefined, role: controller ? "controller" : "executor", contract: controller ? {
       relay: "orchestration_relay {expectedRevision,action:{type:'inputDecision',assignmentId,sessionId,requestId,decision:'allow'|'deny'|'clarify',detail}}。从当前 query 取 Assignment ID、directInputs[].source.sessionId 和 requestId，按原记录裁决。clarify 后在同一主控 Turn 用 ask_user_question 问用户，原问题已回答后再 query 并提交 allow/deny。业务移交在同一 orchestration_decide 的 assign 后、seal/dispatch 前登记 {kind:'relation',action:{type:'handoff',handoff:{assignmentId,fromAssignmentId?,goal,background,artifacts:[{artifact,contentVersion}],unresolved:[],scope}}}，新负责人确认接收才改变移交状态。独立检查走 verification。用户明确要求收尾时提交 {type:'finish',promptVersion,stepId?}，以原输入的真实 version 冻结该 Step 或整个 Run。",
      decide: "用户明确停止整个编排时，提交唯一动作 {kind:'stopRun'}，宿主冻结派工并分别核查 Turn 和 Job。approvalRecovery 中 canCheck 的原任务可用 {kind:'recoverApproval',id}。orchestration_decide的payload只允许intentId、basis、expectedRevision、reason、actions五个顶层字段；禁止附加report/local/result。主控不提交执行者报告，执行者必须用自己的orchestration_report报告。intentId和basis必须逐字复制同一最新query中state=pending的意图id/basis，expectedRevision取该query顶层revision，禁止改写或估算；若DECISION_STALE，重新query并按最新前提重交，不向用户索取重复授权。用户明确制作/修改请求已授权范围内派工；主控和执行者均复用普通 Runtime 工具与权限，受管 Thread 禁用。{intentId,basis,expectedRevision:run.revision,reason,actions:[{kind:'relation',action:RelationAction}|{kind:'dispatch'|'release'|'query',assignmentId}|{kind:'continue',assignmentId,content}|{kind:'control',assignmentId,execution,operation:'steer'|'queue'|'resume'|'cancel'|'stop_job',content?,jobId?}]}. 简单请求可直接使用普通工具并回答，无需 decide；需显式确认消费时可用 actions:[]，不建立计划或封批；需要复杂委派时才一次提交完整计划，step/assign 后 seal 再 dispatch。历史 prompts 只作上下文，不得重答已消费输入。交付报告先 release 再 accept。阻塞或失败报告可以在原委派用 continue 续做；改派使用对应 result 意图，同一决定先 release，再紧接引用该 resultId 的 replan，然后 assign(previousId,purpose:repair/reassign)、seal、dispatch。Host 核查原 Turn、Job 和回执后才退出旧尝试，失败报告与未完成义务保留。保留同批尚未开始的下游复核，等新交付满足原依赖后派发。工具 saved 表示决定已登记，请用 query 查 pending[].decision 的进度或错误后再汇报。必要独立验证另建平级工作项；无须固定 Tester。未报告的failed终态不能control.resume；应以continue在原委派新Turn核查已有产物并补真实报告，尊重用户拒绝，不重试被拒操作或改写为通过。completed未交接同样用continue；审批已决定且原Turn可恢复才用control.resume。" + ORCHESTRATION_PHASED_GUIDANCE,
       relation: "完整嵌套示例：{kind:\"relation\",action:{type:\"step\",step:{id:\"s1\",goal:\"检查项目\",scope:\".\",dependencies:[],deliverables:[\"结果\"],acceptance:[\"证据可核查\"]}}}；{kind:\"relation\",action:{type:\"assign\",assignment:{id:\"a1\",stepId:\"s1\",content:\"检查并报告\",purpose:\"initial\",access:\"read\"}}}。禁止把实体平铺到 action。step:{id,goal,scope,dependencies:[],deliverables:[],acceptance:[],verifies?:{stepId,browser?:boolean}}；assign:{id,stepId,content,purpose:initial|repair|reassign,previousId?,access:write|read}; accept:{assignmentId,resultId,evidenceIds:[],verificationAssignmentId?}; replan:{assignmentId,resultId,reason}; revise:{assignmentId,content}; seal:{}; acceptRun:{}; cancelPlanned:{assignmentId}。独立复核必须把实现步骤写入 dependencies 和 verifies.stepId，独立委派使用 access:read；需要实际打开本地 HTML/Markdown 时设置 verifies.browser:true，要求实现报告在 evidence 中使用工作区相对路径和 64 位十六进制 SHA-256，不带 sha256: 前缀。先启动实现；收到结果后 release 实现，再直接 dispatch 复核，无须先验收实现或让用户追问。只有验证交付物不全、检查失败或权限未获得才留真实缺口；复核报告并 release 后，提交实现 accept 并带 verificationAssignmentId，再核复核步骤和 acceptRun。",
    } : {
       relay: "orchestration_relay {expectedRevision,action:{type:'inputImpact',requestId,impact:'local'|'cross_scope',detail}}。收到本终端人工输入先登记影响；影响角色、依赖、验收、共享资源或不清楚时必须 cross_scope，等主控裁决。原任务内处理完成用 {type:'inputResult',requestId,detail}。存在 assignment.handoff 时先完整核对并用 {type:'handoffReceived',requestId} 确认实际接收。",
       report: "仅执行者调用orchestration_report。{expectedRevision,promptVersion,local:{source:'agent',phase:string,obligations:[],handoff:boolean,skills:[],requiredSkills:[],cooperation:[]},result?:{id,revision,summary,outcome:delivered|partial|failed|blocked|cancelled,checks:[],unresolved:[],verificationPending?:true,evidence:[{id,artifact,contentVersion,method,result,source:'agent'}]}}。Session/Turn/Assignment 由宿主绑定。仅收到宿主明确的视图关闭请求时，按原通知以单一 viewCloseProgress 对象保存进度；业务报告继续使用上述格式。obligations 和 cooperation 只记录未完成本地义务和协作等待。真实缺口必须保留在 unresolved，按实际情况报告 partial/failed/blocked。assignment.plannedReview 已指派独立复核，且本地交付完整、实际未完成项仅是该独立复核时，可以报告 partial + verificationPending:true、unresolved:[]，并交付准确产物及版本；任何本地缺口都不能使用此标记。assignment.verification 冻结上游报告和证据；复核使用同一 artifact 和 contentVersion 独立运行实际检查，每项记录真实观察。若要求浏览器复核，用原生 browser document 打开冻结的工作区相对文件，由用户确认实际文件；用返回页身份操作并用 snapshot 或 screenshot 取得实际输出。无法运行的检查按实际报告，不读取系统剪贴板，不用 Shell 或其他浏览器路线替代审批。" + ORCHESTRATION_DELIVERY_GUIDANCE,
    } };
    if (operation === "orchestration_decide" && controller) {
      try { await saveControllerDecision(this.service, this.workspaceId, binding.sessionId, input as ControllerDecision, binding.turnId); }
      catch (error) {
        if (error instanceof ControllerDecisionValidationError) return { saved: false, code: error.message, fields: error.fields, instruction: "修正字段后按同一最新意图重新提交；step/assign 必须嵌套于 action.step/action.assignment。" };
        throw error;
      }
      // 工具先确认已持久化，由串行 Host 驱动执行，不让模型工具占住 Runtime 命令循环。
      void this.drive().catch(function failed() {});
      return { saved: true, intentId: (input as ControllerDecision).intentId };
    }
    if (operation === "orchestration_report" && assignment) {
      if (input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 1 && "viewCloseProgress" in input) return saveViewCloseProgress(this.service, run.id, assignment.id, assignment.execution!, input.viewCloseProgress);
      const report = input as { expectedRevision: number; promptVersion: number; local: import("./orchestration-store").LocalWorkflow; result?: import("./orchestration-store").AssignmentResult };
      if (!report || Object.keys(report).some(function extra(k) { return !["expectedRevision", "promptVersion", "local", "result"].includes(k); })) throw new Error("ORCHESTRATION_INVALID_REPORT");
      const browserObservations = this.browser?.observations(run, binding, generation, owner);
      const updated = await api.command({ requestId: orchestrationId(binding.turnId, JSON.stringify(report)), expectedRevision: report.expectedRevision, action: { type: "report", assignmentId: assignment.id, execution: assignment.execution!, revision: assignment.revision, promptVersion: report.promptVersion, local: report.local, result: report.result, browserObservations } });
      void this.drive().catch(function failed() {});
      return updated;
    }
    throw new Error("ORCHESTRATION_TOOL_DENIED");
  }
}
