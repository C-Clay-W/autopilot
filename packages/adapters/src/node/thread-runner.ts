/**
 * Node 协作 Runner：在宿主进程内消费已持久化的 run 投递并驱动既有 TurnService。
 * 页面/SSE 只观察结果；停机、崩溃与失联窗口由持久投递记录和 reconcile 收敛。
 */

import { sanitizeContinuationFailure, type ThreadControlIntent } from "@autopilot-agent/core";
import { getFileOperationDiagnostic } from "./file-utils";
import { NodeStateError } from "./node-errors";
import { createHash } from "node:crypto";
import type { AgentRuntime, RuntimePorts, ThreadActor, ThreadControl, ThreadDeliveryService, ThreadHandoffRef, ThreadMessage, ThreadReconcileResult, ThreadStartDelivery } from "@autopilot-agent/core";

/** Runner 启动 Turn 前的受信投影事实；正文与来源都来自已持久化消息。 */
export interface NodeThreadRunnerPrompt {
  content: string;
  messageId: string;
  from: ThreadActor;
  handoff?: ThreadHandoffRef;
  handoffDisplay?: ThreadMessage["handoffDisplay"];
}

/** Runner 装配参数；投递服务由宿主用同一 Ports 装配，身份不来自消息正文。 */
export interface NodeThreadRunnerOptions {
  /** 绑定本宿主实例与状态根的 Core 投递服务。 */
  delivery: ThreadDeliveryService;
  /** 与 Ports 同源的 Runtime；Runner 只调用既有 turns，不另建模型循环。 */
  runtime: AgentRuntime;
  ports: RuntimePorts;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  reconcileEveryMs?: number;
  /** 单轮调度失败的观测回调；不改变持久事实，也不触发自动重放。 */
  onError?: (error: unknown, continuation?: Pick<ThreadControlIntent, "threadId" | "expectedTurnId" | "controlId" | "approvalId" | "requestId" | "failureDiagnostic">) => void;
  /**
   * Turn 真正启动前的宿主投影回调；Web 用它把 thread 来源 Prompt 写入展示历史。
   * 回调失败不回滚已领取的投递，也不改写消息事实。
   */
  onTurnStarted?: (input: { threadId: string; turnId: string; prompt: NodeThreadRunnerPrompt }) => Promise<void> | void;
  /** Turn 收尾后的宿主投影回调；宿主据持久事件补齐展示消息，不参与交付记账。 */
  onTurnSettled?: (input: { threadId: string; turnId: string }) => Promise<void> | void;
}

/** 停机报告；未确认项必须显式列出，不能假定已停止。 */
export interface NodeThreadRunnerStopReport {
  stopped: boolean;
  cancelledTurnIds: string[];
  unconfirmedTurnIds: string[];
  releasedMessageIds: string[];
  waitingTurnIds?: string[];
  pendingMessageIds?: string[];
  recoverableTurnIds?: string[];
}

/** 宿主持有的协作执行驱动器。 */
export interface NodeThreadRunner {
  /** 复制现有活动索引身份，仅供宿主发现目标，不证明执行状态。 */
  listExecutions(): Array<{ threadId: string; turnId: string }>;
  /** 启动循环；首次调度前先收敛上次崩溃遗留的领取。 */
  start(): Promise<void>;
  /** 停止新领取，取消本 owner 的 Turn，退回未启动交付并报告未确认项。 */
  stop(): Promise<NodeThreadRunnerStopReport>;
  /** 立即触发一次调度，仅加速，不代表已持久化。 */
  kick(): void;
  isRunning(): boolean;
  /** 暴露收敛结果供宿主观测与测试。 */
  reconcile(): Promise<ThreadReconcileResult>;
  /** 在同一 owner 索引登记普通执行；取得 lease 后激活，收尾时按身份移除。 */
  registerExecution(input: { threadId: string; turnId: string; cancel(): void }): { activate(): void; release(): void };
}

/** 本进程内正在执行的一条交付。 */
interface ActiveDelivery {
  threadId: string;
  turnId: string;
  groupId: string;
  messageId: string;
  cancelled: boolean;
  task: Promise<void>;
  external?: boolean;
  ready?: boolean;
  cancelExecution?: () => void;
}

/** 创建 Node 协作 Runner；不启动隐藏服务，也不接管其他 owner 的执行。 */
export function createNodeThreadRunner(options: NodeThreadRunnerOptions): NodeThreadRunner {
  const delivery = options.delivery;
  const ownerId = delivery.ownerId;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleMs = options.staleMs ?? 45_000;
  // 心跳必须明显快于失联阈值，否则启动 Turn 的冷启动窗口会被误判为失联。
  const heartbeatMs = options.heartbeatMs ?? Math.max(200, Math.min(5_000, Math.floor(staleMs / 3)));
  const reconcileEveryMs = options.reconcileEveryMs ?? 3_000;
  const active = new Map<string, ActiveDelivery>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking = false;
  let stopped = false;
  let lastReconcileAt = 0;
  let running = false;
  let kicked = false;
  let idleDelayMs = pollIntervalMs;

  /** 判断 Session 是否仍由未过期的执行 lease 持有；超时只代表失联，不代表副作用已停止。 */
  async function hasFreshLease(threadId: string): Promise<boolean> {
    const checkpoint = await options.ports.checkpointStore.getLatest(threadId);
    return Boolean(checkpoint && checkpoint.status === "running" && checkpoint.lease && Date.now() - checkpoint.lease.heartbeatAt <= delivery.leaseStaleMs);
  }

  /** 本宿主正在执行的领取不能被自己判为失联后重复启动。 */
  function activeMessageIds(): string[] {
    return [...active.values()].filter(function deliveryRecord(record) { return !record.external && Boolean(record.messageId); }).map(function id(record) { return record.messageId; });
  }

  /** 单轮异常不终止 Runner；持久记录仍然是下一次调度的依据。 */
  async function safeTick(reconcileFirst = false): Promise<void> {
    if (ticking || stopped) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    kicked = false;
    ticking = true;
    try {
      const snapshot = await delivery.querySnapshot();
      if (reconcileFirst || Date.now() - lastReconcileAt >= reconcileEveryMs) {
        lastReconcileAt = Date.now();
        await delivery.reconcile({ staleMs, activeMessageIds: activeMessageIds(), snapshot });
      }
      await applyInterrupts(snapshot);
      await applyResumes(snapshot);
      await applyInteractionContinuations(snapshot);
      const claimed = await delivery.claimDeliveries({ snapshot, activeThreads: [...active.values()].filter(function controllable(record) { return record.ready; }).map(function thread(record) { return record.threadId; }) });
      for (const item of claimed) startDelivery(item);
      idleDelayMs = active.size || claimed.length ? pollIntervalMs : Math.min(Math.max(pollIntervalMs, 2_000), idleDelayMs * 2);
    } catch (error) {
      // 存储暂不可用或损坏时保持现状，由宿主恢复流程处理，不在这里重放命令。
      options.onError?.(error);
    } finally {
      ticking = false;
      if (running && !stopped) {
        timer = setTimeout(function poll() { void safeTick(); }, kicked ? 0 : idleDelayMs);
        timer.unref?.();
      }
    }
  }

  /** 只消费跨进程中断意图；实际取消由持有该 Turn 的 owner 调用 turns.cancel。 */
  async function applyInterrupts(snapshot: readonly ThreadControl[]): Promise<void> {
    for (const intent of await delivery.pendingInterrupts(snapshot)) {
      const task = active.get(intent.threadId);
      if (!task || !task.ready || task.turnId !== intent.expectedTurnId) {
        const turn = await options.ports.turnStore.get(intent.expectedTurnId);
        // 审批/用户输入等待没有活动执行体：本 owner 在场时直接收尾为 interrupted，完成跨进程取消。
        if (turn && (turn.status === "waiting_approval" || turn.status === "waiting_user_input")) {
          const [session, latest, checkpoint] = await Promise.all([options.ports.sessionStore.get(intent.threadId), options.ports.turnStore.getLatest(intent.threadId), options.ports.checkpointStore.getLatest(intent.threadId)]);
          const checkpointStatus = turn.status === "waiting_approval" ? "awaiting_approval" : "awaiting_user_input";
          // 迟到意图必须仍指向当前等待轮；旧Turn不能借新一轮等待状态更新Session。
          if (!session || turn.sessionId !== intent.threadId || session.status !== turn.status || (session.activeTurnId && session.activeTurnId !== intent.expectedTurnId)
            || latest?.id !== intent.expectedTurnId || checkpoint?.turnId !== intent.expectedTurnId || checkpoint.status !== checkpointStatus) {
            await delivery.settleInterrupt({ groupId: intent.groupId, controlId: intent.controlId, applied: false });
            continue;
          }
          try {
            await options.runtime.turns.cancel({ sessionId: intent.threadId, turnId: intent.expectedTurnId });
            await delivery.settleInterrupt({ groupId: intent.groupId, controlId: intent.controlId, applied: true });
          } catch {
            await delivery.settleInterrupt({ groupId: intent.groupId, controlId: intent.controlId, applied: false });
          }
          continue;
        }
        const terminal = turn && turn.status !== "running" && turn.status !== "waiting_approval" && turn.status !== "waiting_user_input";
        // 只有已证明 Turn 终态，或长时间既无 Turn 也无活动 lease 时才拒绝，避免抢在 owner 之前下结论。
        if (terminal) await delivery.settleInterrupt({ groupId: intent.groupId, controlId: intent.controlId, applied: false });
        else if (!turn && !(await hasFreshLease(intent.threadId))) {
          const control = await delivery.readGroup(intent.groupId);
          const recorded = control?.controls.find(function match(item) { return item.controlId === intent.controlId; });
          if (recorded && Date.now() - recorded.createdAt > staleMs) await delivery.settleInterrupt({ groupId: intent.groupId, controlId: intent.controlId, applied: false });
        }
        continue;
      }
      try {
        if (task.cancelExecution) await task.cancelExecution();
        else await options.runtime.turns.cancel({ sessionId: intent.threadId, turnId: intent.expectedTurnId });
        await delivery.settleInterrupt({ groupId: intent.groupId, controlId: intent.controlId, applied: true });
      } catch {
        await delivery.settleInterrupt({ groupId: intent.groupId, controlId: intent.controlId, applied: false });
      }
    }
  }

  /** 恢复只驱动精确原 Turn；持久 CAS 领取和原 Core lease 共同阻止双启动。 */
  async function applyResumes(snapshot: readonly ThreadControl[]): Promise<void> {
    for (const intent of await delivery.pendingResumes(snapshot)) {
      if (active.has(intent.threadId) || await hasFreshLease(intent.threadId)) continue;
      if (!await delivery.claimResume(intent)) continue;
      const [session, latest, checkpoint] = await Promise.all([options.ports.sessionStore.get(intent.threadId), options.ports.turnStore.getLatest(intent.threadId), options.ports.checkpointStore.getLatest(intent.threadId)]);
      if (!session || session.status !== "interrupted" || latest?.id !== intent.expectedTurnId || checkpoint?.turnId !== intent.expectedTurnId || createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex") !== intent.checkpointDigest) {
        await delivery.rejectResume(intent);
        continue;
      }
      const record: ActiveDelivery = { threadId: intent.threadId, turnId: intent.expectedTurnId, groupId: intent.groupId, messageId: "", cancelled: false, task: Promise.resolve() };
      active.set(intent.threadId, record);
      record.task = continueOriginal().finally(function settled() { if (active.get(intent.threadId) === record) active.delete(intent.threadId); kick(); });
      /** 消费既有 Core continuation；不覆写配置、不代替原工具审批、不启动新任务。 */
      async function continueOriginal(): Promise<void> {
        let started = false;
        try {
          for await (const event of options.runtime.turns.continue({ sessionId: intent.threadId, turnId: intent.expectedTurnId })) {
            if (event.type === "turn_started") { started = true; record.ready = true; }
            if (["turn_completed", "turn_failed", "turn_limit_reached", "turn_interrupted", "question_required", "approval_required"].includes(event.type)) record.ready = false;
          }
        } catch (error) {
          if (!started) await delivery.rejectResume(intent);
          options.onError?.(error);
        } finally { await notifySettled(record); }
      }
    }
  }

  /** 已保存交互沿既有continue执行；领取、首事件与结果分别记账，崩溃后按原边界收敛。 */
  async function applyInteractionContinuations(snapshot: readonly ThreadControl[]): Promise<void> {
    for (const intent of await delivery.pendingInteractionContinuations(snapshot)) {
      if (active.has(intent.threadId) || await hasFreshLease(intent.threadId)) continue;
      if (!await delivery.claimInteractionContinuation(intent)) continue;
      const record: ActiveDelivery = { threadId: intent.threadId, turnId: intent.expectedTurnId, groupId: intent.groupId, messageId: "", cancelled: false, task: Promise.resolve() };
      active.set(intent.threadId, record);
      record.task = continueInteraction().finally(function settled() { if (active.get(intent.threadId) === record) active.delete(intent.threadId); kick(); }).catch(function report(error) { options.onError?.(error); });
      /** 读取唯一持久决定，不接受客户端重传工具输入或答案。 */
      async function continueInteraction(): Promise<void> {
        const beat = setInterval(function heartbeat() { delivery.settleInteractionContinuation({ groupId: intent.groupId, controlId: intent.controlId }).catch(function failed(error) { options.onError?.(error); }); }, heartbeatMs);
        let stage: "read_decision" | "continue" | "after_started" = "read_decision";
        let started = false;
        try {
          const decision = intent.approvalId ? await options.ports.approvalStore.getDecision({ sessionId: intent.threadId, turnId: intent.expectedTurnId, approvalId: intent.approvalId }) : undefined;
          if (intent.approvalId && !decision) throw Object.assign(new Error("INTERACTION_DECISION_REQUIRED"), { code: "INTERACTION_DECISION_REQUIRED" });
          if (stopped || record.cancelled) { await delivery.settleInteractionContinuation({ ...intent, status: "pending" }); return; }
          stage = "continue";
          for await (const event of options.runtime.turns.continue({ sessionId: intent.threadId, turnId: intent.expectedTurnId, requestId: intent.requestId, ...(decision ? { approval: { approvalId: decision.approvalId, decision: decision.decision === "deny" ? "deny" as const : "allow" as const } } : {}) })) {
            if (event.type === "turn_started") { started = true; stage = "after_started"; record.ready = true; await delivery.settleInteractionContinuation({ ...intent, status: "executing" }); }
            if (["turn_completed", "turn_failed", "turn_limit_reached", "turn_interrupted", "question_required", "approval_required"].includes(event.type)) record.ready = false;
          }
          await notifySettled(record);
          await delivery.settleInteractionContinuation({ ...intent, status: "completed" });
        } catch (error) {
          const file = getFileOperationDiagnostic(error) ?? (error instanceof NodeStateError ? error.getStorageDiagnostic() : undefined);
          const code = file?.osCode ?? (error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "CONTINUE_UNKNOWN");
          const failureDiagnostic = sanitizeContinuationFailure({ stage, started, category: "unknown", code, ...(file && ["lock", "temporary_write", "rename", "cleanup"].includes(file.phase) ? { filePhase: file.phase as "lock" | "temporary_write" | "rename" | "cleanup" } : {}) });
          await delivery.settleInteractionContinuation({ ...intent, status: "failed", failureCode: "CONTINUE_FAILED", failureDiagnostic });
          options.onError?.(error, { threadId: intent.threadId, expectedTurnId: intent.expectedTurnId, controlId: intent.controlId, approvalId: intent.approvalId, requestId: intent.requestId, failureDiagnostic });
          await notifySettled(record);
        } finally {
          clearInterval(beat);
        }
      }
    }
  }

  /** 同一 Session 只允许本进程一个任务，跨宿主双启动由既有 lease 拒绝。 */
  function startDelivery(item: ThreadStartDelivery): void {
    const threadId = item.delivery.threadId;
    const turnId = item.delivery.reservedTurnId;
    if (!turnId) {
      void delivery.failDelivery({ groupId: item.groupId, messageId: item.delivery.messageId, reason: "start_failed" });
      return;
    }
    if (active.has(threadId)) {
      void delivery.releaseDelivery({ groupId: item.groupId, messageId: item.delivery.messageId });
      return;
    }
    const record: ActiveDelivery = { threadId, turnId, groupId: item.groupId, messageId: item.delivery.messageId, cancelled: false, task: Promise.resolve() };
    record.task = runDelivery(item, record).catch(function ignore() { /* 单条失败已在存储中记账 */ }).finally(function finish() {
      if (active.get(threadId) === record) active.delete(threadId);
      kick();
    });
    active.set(threadId, record);
  }

  /** 启动前的宿主投影失败只观测；已领取的投递和消息事实不受影响。 */
  async function notifyStarted(record: ActiveDelivery, message: ThreadMessage): Promise<void> {
    if (!options.onTurnStarted) return;
    try {
      await options.onTurnStarted({
        threadId: record.threadId,
        turnId: record.turnId,
        prompt: { content: message.content, messageId: message.messageId, from: message.from, ...(message.handoff ? { handoff: message.handoff } : {}), ...(message.handoffDisplay ? { handoffDisplay: message.handoffDisplay } : {}) },
      });
    } catch (error) {
      options.onError?.(error);
    }
  }

  /** 收尾后的宿主投影失败不影响交付记账；展示可由下一次 History 读取补齐。 */
  async function notifySettled(record: ActiveDelivery): Promise<void> {
    if (!options.onTurnSettled) return;
    try { await options.onTurnSettled({ threadId: record.threadId, turnId: record.turnId }); }
    catch (error) { options.onError?.(error); }
  }

  /** 消费完整 Turn 流后再确认交付；预留 Turn 已存在时只回填，不重复启动。 */
  async function runDelivery(item: ThreadStartDelivery, record: ActiveDelivery): Promise<void> {
    const { groupId, delivery: claimed, message } = item;
    const turnId = record.turnId;
    const existing = await options.ports.turnStore.get(turnId);
    if (existing) {
      await settle(item, record, turnId);
      return;
    }
    if (await hasFreshLease(record.threadId)) {
      await delivery.releaseDelivery({ groupId, messageId: claimed.messageId });
      return;
    }
    let failure: unknown;
    // 启动 Turn 前可能长时间没有事件；独立心跳保证领取不被其他宿主误判为失联。
    const beat = setInterval(function heartbeat() { void delivery.heartbeat({ groupId, messageId: claimed.messageId }); }, heartbeatMs);
    beat.unref?.();
    let controlEnded = false;
    try {
      await delivery.heartbeat({ groupId, messageId: claimed.messageId });
      await notifyStarted(record, message);
      for await (const event of options.runtime.turns.start({
        sessionId: record.threadId,
        turnId,
        content: message.content,
        // 与页面队列同语义：这是目标空闲后的下一轮，不是新话题。
        continuity: { source: "claimed_queue" },
      })) {
        // 首个事件表明本执行已取得 lease；终态或等待之后不再接收控制。
        if (["turn_completed", "turn_failed", "turn_limit_reached", "turn_interrupted", "question_required", "approval_required"].includes(event.type)) controlEnded = true;
        record.ready = !controlEnded;
        if (record.cancelled) break;
      }
    } catch (error) {
      failure = error;
    } finally {
      clearInterval(beat);
    }
    await settle(item, record, turnId, failure);
  }

  /** 按真实 Turn 事实收敛交付；没有 Turn 的失败不重放原任务。 */
  async function settle(item: ThreadStartDelivery, record: ActiveDelivery, turnId: string, failure?: unknown): Promise<void> {
    const groupId = item.groupId;
    const messageId = item.delivery.messageId;
    const turn = await options.ports.turnStore.get(turnId);
    // Turn存在不表示流成功收尾；错误必须报告且封住重放，不能吞成delivered成功。
    if (failure) {
      options.onError?.(failure);
      // 已有Turn时delivered仅确认运输结束，业务暂停/失败/未知仍由Core事实投影。
    }
    if (turn) {
      await delivery.completeDelivery({ groupId, messageId, turnId });
      await notifySettled(record);
      return;
    }
    const code = (failure as { code?: unknown } | undefined)?.code;
    if (code === "TURN_ALREADY_RUNNING") {
      // 另一宿主已持有 lease：退回 pending，等待目标空闲后重新领取。
      await delivery.releaseDelivery({ groupId, messageId });
      return;
    }
    await delivery.failDelivery({ groupId, messageId, reason: "start_failed" });
  }

  /** 停机顺序：停止新领取 → 取消本 owner 的 Turn → 退回未启动领取 → 报告未确认项。 */
  async function stop(): Promise<NodeThreadRunnerStopReport> {
    stopped = true;
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const cancelledTurnIds: string[] = [];
    const unconfirmedTurnIds: string[] = [];
    const releasedMessageIds: string[] = [];
    const waitingTurnIds: string[] = [];
    const pendingMessageIds: string[] = [];
    const recoverableTurnIds: string[] = [];
    const tasks = [...active.values()].filter(function ownDelivery(record) { return !record.external; });
    for (const record of tasks) {
      if (record.cancelled) continue;
      const actual = await options.ports.turnStore.get(record.turnId);
      if (actual && actual.status !== "running") {
        if (actual.status === "waiting_approval" || actual.status === "waiting_user_input") waitingTurnIds.push(actual.id);
        continue;
      }
      record.cancelled = true;
      try {
        await options.runtime.turns.cancel({ sessionId: record.threadId, turnId: record.turnId });
        cancelledTurnIds.push(record.turnId);
      } catch {
        unconfirmedTurnIds.push(record.turnId);
      }
    }
    await Promise.allSettled(tasks.map(function task(record) { return record.task; }));
    for (const groupId of await delivery.listGroups()) {
      const control = await delivery.readGroup(groupId);
      if (!control) continue;
      for (const item of control.deliveries) {
        if (item.status === "pending" || item.status === "blocked") pendingMessageIds.push(item.messageId);
        const turnId = item.turnId ?? item.reservedTurnId;
        const turn = turnId ? await options.ports.turnStore.get(turnId) : undefined;
        if (turn?.status === "waiting_approval" || turn?.status === "waiting_user_input") waitingTurnIds.push(turn.id);
        if (turn?.status === "interrupted") recoverableTurnIds.push(turn.id);
        if (item.ownerId === ownerId && item.status === "claimed" && turn?.status === "running" && !cancelledTurnIds.includes(turn.id)) unconfirmedTurnIds.push(turn.id);
        if (item.status === "claimed" && item.ownerId === ownerId && !turn) {
          await delivery.releaseDelivery({ groupId, messageId: item.messageId });
          releasedMessageIds.push(item.messageId);
          pendingMessageIds.push(item.messageId);
        }
      }
      if (control.deliveries.some(function pending(item) { return item.status === "pending" || item.status === "blocked"; })) await delivery.recordHostOffline(groupId);
    }
    // 取消后仍为 running 的 Turn 不能当作已停止。
    for (const turnId of cancelledTurnIds) {
      const turn = await options.ports.turnStore.get(turnId);
      if (!turn || turn.status === "running") unconfirmedTurnIds.push(turnId);
    }
    return { stopped: true, cancelledTurnIds: cancelledTurnIds.filter(function confirmed(id) { return !unconfirmedTurnIds.includes(id); }), unconfirmedTurnIds: [...new Set(unconfirmedTurnIds)], releasedMessageIds, waitingTurnIds: [...new Set(waitingTurnIds)], pendingMessageIds: [...new Set(pendingMessageIds)], recoverableTurnIds: [...new Set(recoverableTurnIds)] };
  }

  /** 调度加速只触发一次异步 tick，不等待执行完成。 */
  function kick(): void {
    if (!running || stopped) return;
    idleDelayMs = pollIntervalMs;
    kicked = true;
    if (!ticking) void safeTick();
  }

  /** 普通执行先占位；只有取得 Core lease 后才参与控制，旧收尾不能移除新登记。 */
  function registerExecution(input: { threadId: string; turnId: string; cancel(): void }): { activate(): void; release(): void } {
    const previous = active.get(input.threadId);
    if (previous && (previous.ready || previous.turnId !== input.turnId)) throw Object.assign(new Error("TURN_ALREADY_RUNNING"), { code: "TURN_ALREADY_RUNNING" });
    const record: ActiveDelivery = { threadId: input.threadId, turnId: input.turnId, groupId: "", messageId: "", cancelled: false, task: Promise.resolve(), external: true, ready: false, cancelExecution: input.cancel };
    active.set(input.threadId, record);
    return {
      activate: function activate() { if (active.get(input.threadId) === record) { record.ready = true; kick(); } },
      release: function release() { if (active.get(input.threadId) === record) { active.delete(input.threadId); kick(); } },
    };
  }

  /** 启动调度；首次调度先收敛上次崩溃遗留的领取，再进入短轮询。 */
  async function start(): Promise<void> {
    if (running) return;
    stopped = false;
    running = true;
    await safeTick(true);
  }

  return {
    start,
    stop,
    kick,
    registerExecution,
    listExecutions: function listExecutions() { return [...active.values()].map(function identity(record) { return { threadId: record.threadId, turnId: record.turnId }; }); },
    isRunning: function isRunning() { return running; },
    reconcile: function converge() { return delivery.reconcile({ staleMs, activeMessageIds: activeMessageIds() }); },
  };
}
