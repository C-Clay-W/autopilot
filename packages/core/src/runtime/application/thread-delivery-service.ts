/**
 * 宿主级协作投递服务：把已持久化消息领取、桥接和收敛到真实 Turn 事实。
 * 由受信宿主调用，不绑定会话来源；模型参数不能决定 owner、交付或执行结果。
 */
import { createHash, randomUUID } from "node:crypto";
import type { RuntimePorts } from "../ports";
import type { ThreadStore } from "../ports/thread-store";
import type {
  ThreadControl,
  ThreadControlIntent,
  ThreadDelivery,
  ThreadDeliveryReason,
  ThreadEvent,
  ThreadEventActor,
  ThreadMessage,
} from "../domain/thread-collaboration";
import { interactionCheckpointDigest, ThreadServiceError } from "./thread-service";
import { resolveThreadExecutionHost } from "./thread-execution-host";
import { STALE_AGENT_LEASE_MS } from "./turn/turn-lease-coordinator";

/** 受信宿主身份；owner 用于领取与心跳，不由消息正文提供。 */
export interface ThreadDeliveryHostContext {
  workspaceId: string;
  /** 受信宿主的稳定执行档位；具名宿主拒绝未消歧旧任务，浏览器/模型不能指定。 */
  executionHost?: string;
  stateRootId: string;
  /** 本宿主实例稳定身份；同一实例重启后视为新 owner。 */
  ownerId: string;
}

/** 一条已领取、需要宿主启动 Turn 的投递。 */
export interface ThreadStartDelivery {
  groupId: string;
  message: ThreadMessage;
  delivery: ThreadDelivery;
}

/** 一次 reconcile 的收敛结果，仅用于宿主日志与测试观察。 */
export interface ThreadReconcileResult {
  requeued: string[];
  delivered: string[];
  recoveryRequired: string[];
  observing: string[];
}

/** 组控制变更计划；helper 统一补 revision、事件序号和来源。 */
interface MutationPlan {
  changes: Partial<ThreadControl>;
  event?: Omit<ThreadEvent, "groupId" | "groupSeq" | "actor" | "createdAt">;
  result?: unknown;
}

/** 目标状态是否允许启动新的下一 Turn；等待审批/用户输入与需恢复状态一律不启动。 */
function startable(status: string): boolean {
  return status === "idle" || status === "completed" || status === "failed";
}

/** 阻塞原因只保留稳定枚举，不向消息正文或宿主日志透传原始异常。 */
function blockedReason(status: string): ThreadDeliveryReason | undefined {
  if (status === "running") return "target_running";
  if (status === "waiting_approval") return "target_waiting_approval";
  if (status === "waiting_user_input") return "target_waiting_user_input";
  if (status === "interrupted") return "target_interrupted";
  return undefined;
}

/** 创建绑定受信宿主的投递服务；所有写操作经组控制 CAS 原子提交。 */
export function createThreadDeliveryService(ports: RuntimePorts, store: ThreadStore, context: ThreadDeliveryHostContext) {
  const actor: ThreadEventActor = { kind: "host", hostId: context.ownerId };
  const groups = () => store.listGroups();

  /** 单轮只发现一次组与控制；快照仅用于候选筛选，所有写入仍实时读取并CAS。 */
  async function querySnapshot(): Promise<ThreadControl[]> {
    const result: ThreadControl[] = [];
    for (const groupId of await groups()) {
      const control = await store.readControl(groupId);
      if (control?.group.enabled && control.group.workspaceId === context.workspaceId) result.push(control);
    }
    return result;
  }

  /** 精确匹配目标与投递档位；具名宿主不能领取尚未消歧的旧任务。 */
  function compatible(control: ThreadControl, threadId: string, delivery?: ThreadDelivery): boolean {
    const required = control.members.find(function target(item) { return item.threadId === threadId; })?.executionHost ?? delivery?.executionHost;
    return control.group.workspaceId === context.workspaceId && required === context.executionHost
      && (!delivery?.executionHost || delivery.executionHost === required);
  }

  /** 统一收敛存储异常，避免向宿主返回路径或原始异常正文。 */
  async function invoke<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ThreadServiceError) throw error;
      const code = error instanceof Error ? error.message : "";
      if (code === "THREAD_REQUEST_CONFLICT" || code === "THREAD_STORAGE_FULL" || code === "THREAD_PAYLOAD_TOO_LARGE" || code === "THREAD_CURSOR_INVALID" || code === "THREAD_CURSOR_EXPIRED") throw new ThreadServiceError(code);
      if (code === "THREAD_CONTROL_CORRUPTED" || code === "THREAD_EVENT_CORRUPTED" || code === "THREAD_MESSAGE_CORRUPTED" || code === "DURABLE_JSONL_CORRUPTED") throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      throw new ThreadServiceError("THREADS_UNAVAILABLE");
    }
  }

  /** 只读当前组快照；不存在或未启用时返回 null。 */
  async function readGroup(groupId: string): Promise<ThreadControl | null> {
    return store.readControl(groupId);
  }

  /** 在组控制上执行一次带事件的 CAS；无变化或无权限时返回 undefined。 */
  async function mutate<T>(groupId: string, apply: (current: ThreadControl) => MutationPlan | undefined): Promise<T | undefined> {
    for (let n = 0; n < 32; n++) {
      const current = await store.readControl(groupId);
      if (!current || !current.group.enabled) return undefined;
      const plan = apply(current);
      if (!plan) return undefined;
      const record: ThreadEvent | undefined = plan.event
        ? { groupId, groupSeq: current.nextGroupSeq, actor, createdAt: ports.clock.now(), ...plan.event }
        : undefined;
      const next: ThreadControl = {
        ...current,
        ...plan.changes,
        revision: current.revision + 1,
        nextGroupSeq: current.nextGroupSeq + (record ? 1 : 0),
        eventIntents: record ? [...current.eventIntents, record] : current.eventIntents,
      };
      if (await store.compareAndSetControl(groupId, current.revision, next)) {
        if (record) await store.writeEvent(record);
        return plan.result as T;
      }
    }
    throw new ThreadServiceError("THREAD_STATE_CONFLICT");
  }

  /** 替换单条交付记录，不改写不可变消息正文。 */
  function replaceDelivery(current: ThreadControl, messageId: string, patch: Partial<ThreadDelivery>): ThreadControl["deliveries"] {
    return current.deliveries.map(function replace(item) { return item.messageId === messageId ? { ...item, ...patch } : item; });
  }

  /** 判断 checkpoint lease 是否仍由活动执行持有；超时只代表失联。 */
  async function hasFreshLease(threadId: string): Promise<boolean> {
    const checkpoint = await ports.checkpointStore.getLatest(threadId);
    return Boolean(checkpoint && checkpoint.status === "running" && checkpoint.lease && ports.clock.now() - checkpoint.lease.heartbeatAt <= STALE_AGENT_LEASE_MS);
  }

  /** 通知/引导的目标活动 Turn；只有本宿主正在驱动的 Turn 才能安全注入。 */
  async function activeTurnOf(threadId: string, activeThreads: readonly string[]): Promise<string | undefined> {
    if (!activeThreads.includes(threadId)) return undefined;
    const session = await ports.sessionStore.get(threadId);
    return session?.status === "running" ? session.activeTurnId : undefined;
  }

  /**
   * 领取可执行的交付并尽力桥接：
   * run 返回宿主启动动作；steer/notify 在本宿主驱动的活动 Turn 上直接幂等桥接 Inbox。
   */
  async function claimDeliveries(input: { activeThreads: readonly string[]; limit?: number; snapshot?: readonly ThreadControl[] }): Promise<ThreadStartDelivery[]> {
    const limit = input.limit ?? 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new ThreadServiceError("INVALID_INPUT");
    const claimed: ThreadStartDelivery[] = [];
    for (const control of input.snapshot ?? await querySnapshot()) {
      const groupId = control.group.groupId;
      if (claimed.length >= limit) break;
      if (!control || !control.group.enabled || control.group.workspaceId !== context.workspaceId) continue;
      let resolved = control;
      for (const delivery of control.deliveries) {
        if (delivery.status === "pending" && (!delivery.executionHost || !control.members.find(function target(item) { return item.threadId === delivery.threadId; })?.executionHost)) { await resolveThreadExecutionHost(ports, groupId, delivery.threadId); resolved = await store.readControl(groupId) ?? control; }
      }
      if (!resolved) continue;
      for (const delivery of resolved.deliveries) {
        if (claimed.length >= limit) break;
        if (delivery.status !== "pending" || !compatible(resolved, delivery.threadId, delivery)) continue;
        const session = await ports.sessionStore.get(delivery.threadId);
        if (!session) continue;
        if (delivery.mode === "notify") {
          // 空闲目标的通知留在协作存储，不进入会触发执行的 Inbox.queue。
          const turnId = await activeTurnOf(delivery.threadId, input.activeThreads);
          if (turnId) await bridgeToInbox(groupId, delivery, turnId, "steer");
          continue;
        }
        if (delivery.mode === "steer") {
          // 只进入发送时匹配的活动 Turn；竞态结束不降级成新 Turn。
          const message = await messageOf(groupId, delivery.messageId);
          const turnId = await activeTurnOf(delivery.threadId, input.activeThreads);
          if (turnId && message.expectedTurnId === turnId) await bridgeToInbox(groupId, delivery, turnId, "steer");
          else if (turnId) await markBlocked(groupId, delivery.messageId, "turn_not_running");
          else if ((await ports.sessionStore.get(delivery.threadId))?.status !== "running") await markBlocked(groupId, delivery.messageId, "turn_not_running");
          continue;
        }
        if (!startable(session.status)) {
          const reason = blockedReason(session.status);
          if (reason) await markBlocked(groupId, delivery.messageId, reason);
          continue;
        }
        if (await hasFreshLease(delivery.threadId)) continue;
        const reserved = await claimRun(groupId, delivery.messageId);
        if (reserved) claimed.push(reserved);
      }
    }
    return claimed;
  }

  /** 原子领取 run 交付并预留稳定 Turn 身份；同一目标只允许一条在途领取。 */
  async function claimRun(groupId: string, messageId: string): Promise<ThreadStartDelivery | undefined> {
    const message = await messageOf(groupId, messageId);
    const reservedTurnId = randomUUID();
    const now = ports.clock.now();
    const result = await mutate<ThreadStartDelivery>(groupId, function claim(current) {
      const target = current.deliveries.find(function target(item) { return item.messageId === messageId; });
      if (!target || target.status !== "pending" || target.mode !== "run" || !compatible(current, target.threadId, target)) return undefined;
      // 单目标 FIFO：同一目标已有任意在途领取时不得双启。
      if (current.deliveries.some(function busy(item) { return item.threadId === target.threadId && item.status === "claimed" && item.messageId !== messageId; })) return undefined;
      const delivery: ThreadDelivery = { ...target, status: "claimed", ownerId: context.ownerId, ownerHeartbeatAt: now, reservedTurnId, attempts: target.attempts + 1, updatedAt: now };
      return {
        changes: { deliveries: replaceDelivery(current, messageId, delivery) },
        result: { groupId, message, delivery },
      };
    });
    return result;
  }

  /** 读取不可变消息；缺失必须显式恢复，不能用交付记录伪造正文。 */
  async function messageOf(groupId: string, messageId: string): Promise<ThreadMessage> {
    const control = await store.readControl(groupId);
    const intent = control?.messageIntents.find(function match(item) { return item.message.messageId === messageId; });
    if (!intent?.committed) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
    const message = await store.readMessage(groupId, intent.message.toThreadId, intent.message.deliverySeq);
    if (!message || message.messageId !== messageId) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
    return message;
  }

  /** 把另一会话消息幂等桥接到目标 Inbox；已交付则直接返回。 */
  async function bridgeToInbox(groupId: string, delivery: ThreadDelivery, turnId: string, mode: "steer" | "queue"): Promise<void> {
    const message = await messageOf(groupId, delivery.messageId);
    const origin = message.from.kind === "thread"
      ? { kind: "thread" as const, threadId: message.from.threadId, turnId: message.from.turnId, ...(message.purpose?.kind === "reporting_agreement" ? { purpose: "reporting_agreement" as const } : {}) }
      : { kind: "human" as const };
    const claimed = await claimBridge(groupId, delivery.messageId, turnId);
    if (!claimed) return;
    const inboxInput = await ports.inputInbox.post({
      sessionId: claimed.threadId,
      clientMessageId: claimed.messageId,
      turnId: mode === "steer" ? turnId : undefined,
      delivery: mode,
      content: message.content,
      origin,
    });
    await mutate(groupId, function delivered(current) {
      const target = current.deliveries.find(function match(item) { return item.messageId === claimed.messageId; });
      if (!target || target.status !== "claimed" || target.ownerId !== context.ownerId) return undefined;
      const now = ports.clock.now();
      return {
        changes: { deliveries: replaceDelivery(current, claimed.messageId, { status: "delivered", inputId: inboxInput.inputId, turnId, updatedAt: now }) },
        event: { kind: "message_delivered", threadId: claimed.threadId, messageId: claimed.messageId, turnId },
      };
    });
  }

  /** 桥接动作互斥；仅允许本 owner 同一 Turn 的 run 执行领取与桥接并存。 */
  async function claimBridge(groupId: string, messageId: string, turnId: string): Promise<ThreadDelivery | undefined> {
    const now = ports.clock.now();
    return mutate<ThreadDelivery>(groupId, function claim(current) {
      const target = current.deliveries.find(function match(item) { return item.messageId === messageId; });
      if (!target || target.status !== "pending" || !compatible(current, target.threadId, target)) return undefined;
      // run 锁保护新执行启动；同宿主、同 Turn 的 Inbox 桥接不启动模型循环。
      if (current.deliveries.some(function busy(item) {
        return item.threadId === target.threadId && item.status === "claimed" && item.messageId !== messageId
          && !(item.mode === "run" && item.ownerId === context.ownerId && (item.turnId ?? item.reservedTurnId) === turnId);
      })) return undefined;
      const delivery: ThreadDelivery = { ...target, status: "claimed", ownerId: context.ownerId, ownerHeartbeatAt: now, attempts: target.attempts + 1, updatedAt: now };
      return { changes: { deliveries: replaceDelivery(current, messageId, delivery) }, result: delivery };
    });
  }

  /** 交付进入阻塞：保留请求，等待目标恢复后再排队。 */
  async function markBlocked(groupId: string, messageId: string, reason: ThreadDeliveryReason): Promise<void> {
    await mutate(groupId, function blocked(current) {
      const target = current.deliveries.find(function match(item) { return item.messageId === messageId; });
      if (!target || target.status !== "pending" || !compatible(current, target.threadId, target)) return undefined;
      return {
        changes: { deliveries: replaceDelivery(current, messageId, { status: "blocked", reason, updatedAt: ports.clock.now() }) },
        event: { kind: "message_blocked", threadId: target.threadId, messageId },
      };
    });
  }

  /** 仅当前领取者可推进交付状态；其他 owner 的领取不能被覆盖。 */
  async function ownedDelivery(groupId: string, messageId: string): Promise<ThreadDelivery | undefined> {
    const control = await store.readControl(groupId);
    const target = control?.deliveries.find(function match(item) { return item.messageId === messageId; });
    return target && target.status === "claimed" && target.ownerId === context.ownerId ? target : undefined;
  }

  /** 续租当前宿主持有的交付；返回是否仍持有，非本 owner 不写存储。 */
  async function heartbeat(input: { groupId: string; messageId: string }): Promise<boolean> {
    const now = ports.clock.now();
    const result = await mutate<boolean>(input.groupId, function beat(current) {
      const target = current.deliveries.find(function match(item) { return item.messageId === input.messageId; });
      if (!target || target.status !== "claimed" || target.ownerId !== context.ownerId) return undefined;
      return { changes: { deliveries: replaceDelivery(current, input.messageId, { ownerHeartbeatAt: now }) }, result: true };
    });
    return result === true;
  }

  /** Turn 已收尾：按真实 Turn 状态回填交付，不把接受写成成功。 */
  async function completeDelivery(input: { groupId: string; messageId: string; turnId: string }): Promise<void> {
    if (!await ownedDelivery(input.groupId, input.messageId)) return;
    const turn = await ports.turnStore.get(input.turnId);
    const now = ports.clock.now();
    const failed = turn?.status === "failed" || turn?.status === "interrupted";
    await mutate(input.groupId, function complete(current) {
      const target = current.deliveries.find(function match(item) { return item.messageId === input.messageId; });
      if (!target || target.status !== "claimed") return undefined;
      return {
        changes: { deliveries: replaceDelivery(current, input.messageId, { status: "delivered", turnId: input.turnId, updatedAt: now, ...(failed ? { reason: turn?.status === "failed" ? "turn_failed" as const : "turn_interrupted" as const } : {}) }) },
        event: { kind: "message_delivered", threadId: target.threadId, messageId: input.messageId, turnId: input.turnId },
      };
    });
    if (turn && (turn.status === "failed" || turn.status === "interrupted")) {
      await mutate(input.groupId, function terminal(current) {
        const target = current.deliveries.find(function match(item) { return item.messageId === input.messageId; });
        if (!target) return undefined;
        return { changes: {}, event: { kind: "turn_terminal", threadId: target.threadId, messageId: input.messageId, turnId: input.turnId } };
      });
    }
  }

  /** 无法继续自动执行的交付明确失败，由人类/上层按原流程处理。 */
  async function failDelivery(input: { groupId: string; messageId: string; reason: ThreadDeliveryReason }): Promise<void> {
    if (!await ownedDelivery(input.groupId, input.messageId)) return;
    await mutate(input.groupId, function fail(current) {
      const target = current.deliveries.find(function match(item) { return item.messageId === input.messageId; });
      if (!target || target.status !== "claimed") return undefined;
      return {
        changes: { deliveries: replaceDelivery(current, input.messageId, { status: "failed", reason: input.reason, updatedAt: ports.clock.now() }) },
        event: { kind: input.reason === "recovery_required" ? "recovery_required" : "message_blocked", threadId: target.threadId, messageId: input.messageId },
      };
    });
  }

  /** 未启动任何 Turn 的领取退回 pending；重放依赖 clientMessageId=messageId 的 Inbox 去重。 */
  async function releaseDelivery(input: { groupId: string; messageId: string }): Promise<void> {
    if (!await ownedDelivery(input.groupId, input.messageId)) return;
    await mutate(input.groupId, function release(current) {
      const target = current.deliveries.find(function match(item) { return item.messageId === input.messageId; });
      if (!target || target.status !== "claimed") return undefined;
      return { changes: { deliveries: replaceDelivery(current, input.messageId, { status: "pending", ownerId: undefined, ownerHeartbeatAt: undefined, reservedTurnId: undefined, updatedAt: ports.clock.now() }) } };
    });
  }

  /**
   * 重启/失联收敛：按 Turn、Inbox 与 checkpoint lease 事实决定回填、退回或需恢复。
   * 外部副作用无法判定时只标 recovery_required，禁止自动重放。
   */
  async function reconcile(input?: { staleMs?: number; activeMessageIds?: readonly string[]; snapshot?: readonly ThreadControl[] }): Promise<ThreadReconcileResult> {
    const staleMs = input?.staleMs ?? STALE_AGENT_LEASE_MS;
    // 本宿主正在执行的领取不能由自己收敛，避免启动窗口内被判失联后重复启动。
    const active = new Set(input?.activeMessageIds ?? []);
    const result: ThreadReconcileResult = { requeued: [], delivered: [], recoveryRequired: [], observing: [] };
    const now = ports.clock.now();
    for (const control of input?.snapshot ?? await querySnapshot()) {
      const groupId = control.group.groupId;
      if (!control || !control.group.enabled || control.group.workspaceId !== context.workspaceId) continue;
      for (const delivery of control.deliveries) {
        if (delivery.status === "claimed") {
          if (active.has(delivery.messageId)) continue;
          // 心跳新鲜说明可能仍在执行，无论 owner 是谁都不抢；只有失联领取才收敛。
          if ((delivery.ownerHeartbeatAt ?? 0) > now - staleMs) continue;
          const outcome = await convergeClaim(groupId, delivery, staleMs, active);
          if (outcome === "observing") result.observing.push(delivery.messageId);
          else if (outcome === "delivered") result.delivered.push(delivery.messageId);
          else if (outcome === "requeued") result.requeued.push(delivery.messageId);
          else if (outcome === "recoveryRequired") result.recoveryRequired.push(delivery.messageId);
        } else if (delivery.status === "blocked" && delivery.mode === "run") {
          await requeueRecovered(groupId, delivery);
        }
      }
    }
    return result;
  }

  /** 领取在本次 CAS 时刻是否仍然失联；决策不能依赖可能过期的快照。 */
  function stillStale(current: ThreadControl, messageId: string, staleMs: number, active: Set<string>): boolean {
    if (active.has(messageId)) return false;
    const target = current.deliveries.find(function match(item) { return item.messageId === messageId; });
    return Boolean(target && target.status === "claimed" && (target.ownerHeartbeatAt ?? 0) <= ports.clock.now() - staleMs);
  }

  /** 收敛一条其他 owner 的领取；只有当前仍失联时才写状态。 */
  async function convergeClaim(groupId: string, delivery: ThreadDelivery, staleMs: number, active: Set<string>): Promise<"observing" | "delivered" | "requeued" | "recoveryRequired" | undefined> {
    const turnId = delivery.turnId ?? delivery.reservedTurnId;
    const turn = turnId ? await ports.turnStore.get(turnId) : null;
    if (turn && (turn.status === "running" || turn.status === "waiting_approval" || turn.status === "waiting_user_input")) {
      // 有效执行 lease 说明仍有宿主在驱动；心跳已失联也无法证明外部副作用停止。
      if (await hasFreshLease(delivery.threadId)) return "observing";
      return await markRecovery(groupId, delivery.messageId, staleMs, active) ? "recoveryRequired" : undefined;
    }
    if (turn) {
      const now = ports.clock.now();
      const failed = turn.status === "failed" || turn.status === "interrupted";
      const applied = await mutate<boolean>(groupId, function backfill(current) {
        if (!stillStale(current, delivery.messageId, staleMs, active)) return undefined;
        const target = current.deliveries.find(function match(item) { return item.messageId === delivery.messageId; });
        if (!target) return undefined;
        return {
          changes: { deliveries: replaceDelivery(current, delivery.messageId, { status: "delivered", turnId: turn.id, updatedAt: now, ...(failed ? { reason: turn.status === "failed" ? "turn_failed" as const : "turn_interrupted" as const } : {}) }) },
          event: { kind: "message_delivered", threadId: target.threadId, messageId: delivery.messageId, turnId: turn.id },
          result: true,
        };
      });
      return applied ? "delivered" : undefined;
    }
    if (delivery.inputId) {
      // 已桥接但 Turn 未落盘：输入仍待消费时可安全退回，已被消费则无法证明副作用。
      const inputs = await ports.inputInbox.list({ sessionId: delivery.threadId });
      const input = inputs.find(function match(item) { return item.inputId === delivery.inputId; });
      if (input && (input.status === "pending" || input.status === "claimed")) {
        return await releaseStale(groupId, delivery.messageId, staleMs, active) ? "requeued" : undefined;
      }
      return await markRecovery(groupId, delivery.messageId, staleMs, active) ? "recoveryRequired" : undefined;
    }
    return await releaseStale(groupId, delivery.messageId, staleMs, active) ? "requeued" : undefined;
  }

  /** 无 Turn、无已消费输入的领取可以安全退回；不删除消息与回执。 */
  async function releaseStale(groupId: string, messageId: string, staleMs: number, active: Set<string>): Promise<boolean> {
    const applied = await mutate<boolean>(groupId, function release(current) {
      if (!stillStale(current, messageId, staleMs, active)) return undefined;
      return {
        changes: { deliveries: replaceDelivery(current, messageId, { status: "pending", ownerId: undefined, ownerHeartbeatAt: undefined, reservedTurnId: undefined, updatedAt: ports.clock.now() }) },
        result: true,
      };
    });
    return applied === true;
  }

  /** 恢复后重新排队被阻塞的 run 请求。 */
  async function requeueRecovered(groupId: string, delivery: ThreadDelivery): Promise<void> {
    const session = await ports.sessionStore.get(delivery.threadId);
    if (!session || !startable(session.status)) return;
    if (await hasFreshLease(delivery.threadId)) return;
    await mutate(groupId, function requeue(current) {
      const target = current.deliveries.find(function match(item) { return item.messageId === delivery.messageId; });
      if (!target || target.status !== "blocked") return undefined;
      return { changes: { deliveries: replaceDelivery(current, delivery.messageId, { status: "pending", reason: undefined, updatedAt: ports.clock.now() }) } };
    });
  }

  /** 无法消歧的领取标记需恢复，并保留未来人工处置入口。 */
  async function markRecovery(groupId: string, messageId: string, staleMs: number, active: Set<string>): Promise<boolean> {
    const applied = await mutate<boolean>(groupId, function recovery(current) {
      if (!stillStale(current, messageId, staleMs, active)) return undefined;
      const target = current.deliveries.find(function match(item) { return item.messageId === messageId; });
      if (!target) return undefined;
      return {
        changes: { deliveries: replaceDelivery(current, messageId, { status: "failed", reason: "recovery_required", updatedAt: ports.clock.now() }) },
        event: { kind: "recovery_required", threadId: target.threadId, messageId },
        result: true,
      };
    });
    return applied === true;
  }

  /** 列出待执行的跨进程中断意图；实际取消只能由持有 Turn 的 owner 执行。 */
  async function pendingInterrupts(snapshot?: readonly ThreadControl[]): Promise<Array<{ groupId: string; controlId: string; threadId: string; expectedTurnId: string }>> {
    const pending: Array<{ groupId: string; controlId: string; threadId: string; expectedTurnId: string }> = [];
    for (const control of snapshot ?? await querySnapshot()) {
      const groupId = control.group.groupId;
      if (!control || !control.group.enabled || control.group.workspaceId !== context.workspaceId) continue;
      for (const intent of control.controls) {
        if (intent.kind !== "interrupt" || intent.status !== "pending") continue;
        pending.push({ groupId, controlId: intent.controlId, threadId: intent.threadId, expectedTurnId: intent.expectedTurnId });
      }
    }
    return pending;
  }

  /** 记录中断意图的处置结果；applied 只表示本 owner 已发出取消并观察到 Turn 收尾。 */
  async function settleInterrupt(input: { groupId: string; controlId: string; applied: boolean }): Promise<void> {
    await mutate(input.groupId, function settle(current) {
      const intent = current.controls.find(function match(item) { return item.controlId === input.controlId; });
      if (!intent || intent.status !== "pending") return undefined;
      const now = ports.clock.now();
      const controls = current.controls.map(function update(item) {
        return item.controlId === input.controlId ? { ...item, status: input.applied ? "applied" as const : "rejected" as const, ownerId: context.ownerId, updatedAt: now } : item;
      });
      return {
        changes: { controls },
        ...(input.applied ? { event: { kind: "turn_terminal" as const, threadId: intent.threadId, turnId: intent.expectedTurnId } } : {}),
      };
    });
  }

  /** 读取精确恢复控制；不把普通 run 或中断控制当作恢复。 */
  async function pendingResumes(snapshot?: readonly ThreadControl[]): Promise<Array<{ groupId: string; controlId: string; threadId: string; expectedTurnId: string; checkpointDigest?: string }>> {
    const result: Array<{ groupId: string; controlId: string; threadId: string; expectedTurnId: string; checkpointDigest?: string }> = [];
    for (const control of snapshot ?? await querySnapshot()) {
      const groupId = control.group.groupId;
      if (!control?.group.enabled || control.group.workspaceId !== context.workspaceId) continue;
      let resolved = control;
      for (const intent of control.controls) {
        if (intent.kind === "resume" && intent.status === "pending" && !control.members.find(function target(item) { return item.threadId === intent.threadId; })?.executionHost) { await resolveThreadExecutionHost(ports, groupId, intent.threadId); resolved = await store.readControl(groupId) ?? control; }
      }
      if (!resolved) continue;
      for (const intent of resolved.controls) if (intent.kind === "resume" && intent.status === "pending" && compatible(resolved, intent.threadId, resolved.deliveries.find(function task(item) { return item.mode === "run" && (item.turnId ?? item.reservedTurnId) === intent.expectedTurnId; }))) result.push({ groupId, ...intent });
    }
    return result;
  }

  /** 先原子领取为 applied 再交给原 continue；崩溃窗口禁止自动重放不可确认的副作用。 */
  async function claimResume(input: { groupId: string; controlId: string }): Promise<boolean> {
    return await mutate<boolean>(input.groupId, function claim(current) {
      if (current.group.workspaceId !== context.workspaceId) return undefined;
      const intent = current.controls.find(function same(item) { return item.controlId === input.controlId && item.kind === "resume" && item.status === "pending"; });
      if (!intent || !compatible(current, intent.threadId, current.deliveries.find(function task(item) { return item.mode === "run" && (item.turnId ?? item.reservedTurnId) === intent.expectedTurnId; }))) return undefined;
      return { changes: { controls: current.controls.map(function update(item) { return item === intent ? { ...item, status: "applied" as const, ownerId: context.ownerId, updatedAt: ports.clock.now() } : item; }) }, result: true };
    }) === true;
  }

  /** 恢复在启动前失败时留下拒绝事实；不自动重试，用户可重新确认新的请求。 */
  async function rejectResume(input: { groupId: string; controlId: string }): Promise<void> {
    await mutate(input.groupId, function reject(current) {
      return { changes: { controls: current.controls.map(function update(item) { return item.controlId === input.controlId && item.kind === "resume" && item.ownerId === context.ownerId ? { ...item, status: "rejected" as const, updatedAt: ports.clock.now() } : item; }) } };
    });
  }

  /** 发现已保存交互的待接手意图；失联领取仅在无活动lease且原暂停边界未变时可重领。 */
  async function pendingInteractionContinuations(snapshot?: readonly ThreadControl[]): Promise<Array<ThreadControlIntent & { groupId: string }>> {
    const pending: Array<ThreadControlIntent & { groupId: string }> = [];
    for (const control of snapshot ?? await querySnapshot()) {
      const groupId = control.group.groupId;
      if (!control?.group.enabled || control.group.workspaceId !== context.workspaceId) continue;
      for (const intent of control.controls) {
        if (intent.kind !== "continue_interaction" || !compatible(control, intent.threadId)) continue;
        if (intent.status === "pending" || ((intent.status === "claimed" || intent.status === "executing") && ports.clock.now() - intent.updatedAt > STALE_AGENT_LEASE_MS)) pending.push({ groupId, ...intent });
      }
    }
    return pending;
  }

  /** 领取交互意图，只标记已领取；实际首个执行事件由Runner另行确认。 */
  async function claimInteractionContinuation(input: { groupId: string; controlId: string }): Promise<boolean> {
    const claimed = await mutate<boolean>(input.groupId, function claim(current) {
      const intent = current.controls.find(function same(item) { return item.controlId === input.controlId && item.kind === "continue_interaction"; });
      if (!intent || !compatible(current, intent.threadId) || !(intent.status === "pending" || ((intent.status === "claimed" || intent.status === "executing") && ports.clock.now() - intent.updatedAt > STALE_AGENT_LEASE_MS))) return undefined;
      return { changes: { controls: current.controls.map(function claimTarget(item) { return item === intent ? { ...item, status: "claimed" as const, ownerId: context.ownerId, updatedAt: ports.clock.now() } : item; }) }, result: true };
    }) === true;
    if (!claimed) return false;
    const control = await store.readControl(input.groupId);
    const intent = control?.controls.find(function own(item) { return item.controlId === input.controlId && item.ownerId === context.ownerId; });
    if (!intent) return false;
    const checkpoint = await ports.checkpointStore.getLatest(intent.threadId);
    const latest = await ports.turnStore.getLatest(intent.threadId);
    if (!checkpoint || checkpoint.turnId !== intent.expectedTurnId || latest?.id !== intent.expectedTurnId) {
      await settleInteractionContinuation({ ...input, status: "failed", failureCode: "BOUNDARY_CHANGED" });
      return false;
    }
    const digest = intent.pauseSeq === undefined ? createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex") : interactionCheckpointDigest(checkpoint);
    let sameBoundary = intent.pauseSeq === undefined || checkpoint.lease?.safeBoundarySeq === intent.pauseSeq;
    if (!sameBoundary && checkpoint.lease?.safeBoundarySeq === 0 && digest === intent.checkpointDigest) {
      const events = await ports.transcriptStore.getEvents(intent.threadId);
      sameBoundary = !events.some(function started(item) { return item.turnId === intent.expectedTurnId && item.seq > intent.pauseSeq! && item.event.type === "turn_started"; });
    }
    if (digest === intent.checkpointDigest && sameBoundary) return true;
    const advanced = intent.pauseSeq === undefined || (checkpoint.lease?.safeBoundarySeq ?? 0) > intent.pauseSeq;
    await settleInteractionContinuation({ ...input, status: advanced ? "completed" : "failed", ...(advanced ? {} : { failureCode: "BOUNDARY_CHANGED" as const }) });
    return false;
  }

  /** 本owner心跳或收敛自己的交互领取，不改写后来owner的结果。 */
  async function settleInteractionContinuation(input: { groupId: string; controlId: string; status?: "pending" | "executing" | "completed" | "failed"; failureCode?: "BOUNDARY_CHANGED" | "CONTINUE_FAILED"; failureDiagnostic?: import("../domain/thread-collaboration").ThreadControlIntent["failureDiagnostic"] }): Promise<void> {
    await mutate(input.groupId, function settle(current) {
      const intent = current.controls.find(function own(item) { return item.controlId === input.controlId && item.kind === "continue_interaction" && item.ownerId === context.ownerId && (item.status === "claimed" || item.status === "executing"); });
      if (!intent) return undefined;
      return { changes: { controls: current.controls.map(function update(item) { return item === intent ? { ...item, status: input.status ?? item.status, failureCode: input.failureCode, failureDiagnostic: input.failureDiagnostic ?? item.failureDiagnostic, updatedAt: ports.clock.now() } : item; }) } };
    });
  }

  /** 宿主停机时留下可解释事件；不清空待处理消息。 */
  async function recordHostOffline(groupId: string): Promise<void> {
    await mutate(groupId, function offline() { return { changes: {}, event: { kind: "host_offline" } }; });
  }

  return {
    /** 只读宿主实例身份；调用方据此判断交付归属，不能改写。 */
    ownerId: context.ownerId,
    /** Core 执行 lease 的失联阈值，宿主据此判断目标是否仍被执行持有。 */
    leaseStaleMs: STALE_AGENT_LEASE_MS,
    listGroups: groups,
    querySnapshot: () => invoke(querySnapshot),
    readGroup,
    claimDeliveries: (input: { activeThreads: readonly string[]; limit?: number; snapshot?: readonly ThreadControl[] }) => invoke(function claim() { return claimDeliveries(input); }),
    heartbeat: (input: { groupId: string; messageId: string }) => invoke(function beat() { return heartbeat(input); }),
    completeDelivery: (input: { groupId: string; messageId: string; turnId: string }) => invoke(function complete() { return completeDelivery(input); }),
    failDelivery: (input: { groupId: string; messageId: string; reason: ThreadDeliveryReason }) => invoke(function fail() { return failDelivery(input); }),
    releaseDelivery: (input: { groupId: string; messageId: string }) => invoke(function release() { return releaseDelivery(input); }),
    reconcile: (input?: { staleMs?: number; activeMessageIds?: readonly string[]; snapshot?: readonly ThreadControl[] }) => invoke(function converge() { return reconcile(input); }),
    pendingInteractionContinuations: (snapshot?: readonly ThreadControl[]) => invoke(function query() { return pendingInteractionContinuations(snapshot); }),
    claimInteractionContinuation: (input: { groupId: string; controlId: string }) => invoke(function claim() { return claimInteractionContinuation(input); }),
    settleInteractionContinuation: (input: Parameters<typeof settleInteractionContinuation>[0]) => invoke(function settle() { return settleInteractionContinuation(input); }),
    pendingResumes: (snapshot?: readonly ThreadControl[]) => invoke(function query() { return pendingResumes(snapshot); }),
    claimResume: (input: { groupId: string; controlId: string }) => invoke(function claim() { return claimResume(input); }),
    rejectResume: (input: { groupId: string; controlId: string }) => invoke(function reject() { return rejectResume(input); }),
    pendingInterrupts: (snapshot?: readonly ThreadControl[]) => invoke(function query() { return pendingInterrupts(snapshot); }),
    settleInterrupt: (input: { groupId: string; controlId: string; applied: boolean }) => invoke(function settle() { return settleInterrupt(input); }),
    recordHostOffline: (groupId: string) => invoke(function offline() { return recordHostOffline(groupId); }),
  };
}

/** 受信宿主持有的投递服务。 */
export type ThreadDeliveryService = ReturnType<typeof createThreadDeliveryService>;
