/** Desktop H2 可靠消费：安全事实、游标与投影同次落盘，不产生业务关系或后续执行。 */
import { randomUUID } from "node:crypto";
import type { RuntimeFact, RuntimeFactSnapshot } from "@autopilot-agent/core";
import type { ManagedRuntimeHost } from "./managed-runtime-host";
import { readManagedRecord, writeManagedRecord } from "./managed-runtime-store";

export interface ManagedSessionFacts {
  sessionId: string;
  association: "pending";
  cursor?: string;
  facts: Record<string, RuntimeFact>;
  turns: Record<string, { sequence: number; eventType: string }>;
  snapshot?: RuntimeFactSnapshot;
  reconciliation: "pending" | "consistent" | "gap" | "failed" | "disconnected";
  failure?: "read_failed" | "cursor_gap" | "invalid_fact";
  historyGap?: true;
}
export interface ManagedFactsLedger {
  protocol: 1;
  hostId: string;
  connection: { source: "host"; owner?: string; generation?: string; state: "connected" | "disconnected" };
  sessions: Record<string, ManagedSessionFacts>;
}
type Channel = Pick<ManagedRuntimeHost, "identity" | "command" | "subscribe">;
const eventTypes = new Set(["turn_started", "turn_completed", "turn_failed", "turn_interrupted", "turn_limit_reached", "turn_paused", "tool_started", "tool_result", "approval_required", "question_required", "question_answered", "input_queued", "input_joined", "input_consumed"]);

/** 重建受限字段并拒绝混入正文；安全查询返回仍须通过 Host 边界检查。 */
export function validateRuntimeFact(value: unknown, sessionId: string): asserts value is RuntimeFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_fact");
  const fact = value as RuntimeFact;
  if (fact.protocol !== 1 || fact.source !== "core" || fact.sessionId !== sessionId || typeof fact.turnId !== "string" || !/^[\w-]{1,128}$/.test(fact.turnId) || !Number.isSafeInteger(fact.sequence) || fact.sequence < 1 || fact.eventId !== JSON.stringify([sessionId, fact.turnId, fact.sequence]) || !eventTypes.has(fact.eventType) || !Number.isFinite(Date.parse(fact.timestamp))) throw new Error("invalid_fact");
  if (Object.keys(fact).some(function extra(key) { return !["protocol", "source", "eventId", "sessionId", "turnId", "sequence", "timestamp", "eventType", "payload"].includes(key); }) || !fact.payload || typeof fact.payload !== "object" || Array.isArray(fact.payload)) throw new Error("invalid_fact");
  for (const [key, value] of Object.entries(fact.payload)) {
    if (!["callId", "requestId", "approvalId", "inputId", "status"].includes(key) || typeof value !== "string" || value.length > 128 || (key === "status" ? !["success", "error", "denied", "approval_required", "question_required", "cancelled", "timeout"].includes(value) : !/^[\w:.-]+$/.test(value))) throw new Error("invalid_fact");
  }
}

/** Snapshot 仅保留 Core 声明的状态字段，拒绝错会话与非法序号。 */
function validateSnapshot(value: unknown, sessionId: string): asserts value is RuntimeFactSnapshot {
  if (!value || typeof value !== "object") throw new Error("invalid_fact");
  const snapshot = value as RuntimeFactSnapshot;
  if (snapshot.protocol !== 1 || snapshot.sessionId !== sessionId || snapshot.consistency !== "overlap" || Object.keys(snapshot).some(function extra(key) { return !["protocol", "sessionId", "cursor", "consistency", "execution"].includes(key); }) || (snapshot.cursor !== undefined && (typeof snapshot.cursor !== "string" || snapshot.cursor.length > 4096))) throw new Error("invalid_fact");
  const execution = snapshot.execution;
  if (execution === null) return;
  if (!execution || typeof execution !== "object" || !/^[\w-]{1,128}$/.test(execution.turnId) || !Number.isSafeInteger(execution.lastSeq) || execution.lastSeq < 0 || !["active", "inactive", "unconfirmed", "lost"].includes(execution.execution) || !["idle", "running", "waiting_approval", "waiting_user_input", "completed", "failed", "interrupted", "limit_reached"].includes(execution.status)) throw new Error("invalid_fact");
  if (Object.keys(execution).some(function extra(key) { return !["turnId", "status", "execution", "lastSeq", "result", "waiting", "interaction"].includes(key); }) || (execution.result !== undefined && !["completed", "failed", "interrupted", "limit_reached"].includes(execution.result)) || (execution.waiting !== undefined && !["approval", "user_input", "threads"].includes(execution.waiting))) throw new Error("invalid_fact");
  if (execution.interaction) {
    const interaction = execution.interaction;
    if (!["pending", "decided", "expired", "unconfirmed"].includes(interaction.state) || Object.keys(interaction).some(function extra(key) { return !["state", "requestId", "approvalId"].includes(key); })) throw new Error("invalid_fact");
    for (const key of ["requestId", "approvalId"] as const) if (interaction[key] !== undefined && (typeof interaction[key] !== "string" || !/^[\w:.-]{1,128}$/.test(interaction[key]!))) throw new Error("invalid_fact");
  }
}

/** 每次变更写成功才替换内存；重启读取记录后必须再查真实 Runtime。 */
export class ManagedFactsHost {
  private ledger?: ManagedFactsLedger;
  private serial: Promise<unknown> = Promise.resolve();
  private unsubscribe?: () => void;
  private failure?: string;
  private listeners = new Set<(sessionId?: string) => void>();
  private scheduled = new Set<string>();
  private failed = new Set<string>();
  constructor(private channel: Channel, private path: string, private persist = writeManagedRecord) {}

  /** 读取旧账本并订阅，旧事实保留但连接可信度必须重新核查。 */
  async open(): Promise<void> {
    const identity = this.channel.identity;
    const ledger = await readManagedRecord<ManagedFactsLedger>(this.path, { protocol: 1, hostId: identity.hostId, connection: { source: "host", state: "disconnected" }, sessions: {} });
    if (ledger.protocol !== 1 || ledger.hostId !== identity.hostId || !ledger.sessions) throw new Error("MANAGED_FACTS_INVALID");
    for (const [sessionId, session] of Object.entries(ledger.sessions)) {
      if (session.sessionId !== sessionId || session.association !== "pending" || !session.facts || !session.turns) throw new Error("MANAGED_FACTS_INVALID");
      for (const fact of Object.values(session.facts)) validateRuntimeFact(fact, sessionId);
      if (session.snapshot) validateSnapshot(session.snapshot, sessionId);
    }
    this.ledger = ledger;
    const host = this;
    this.unsubscribe = this.channel.subscribe(function changed(sessionId) {
      if (sessionId) {
        if (!host.ledger?.sessions[sessionId] || host.scheduled.has(sessionId)) return;
        host.scheduled.add(sessionId);
        void host.enqueue(async function observed() {
          host.scheduled.delete(sessionId);
          await host.observeSession(sessionId);
        }).catch(function failed() { /* 核查状态由投影公开。 */ });
      } else {
        host.emit();
        void host.enqueue(async function disconnected() {
          const next = structuredClone(host.ledger!);
          next.connection = { source: "host", state: "disconnected" };
          for (const session of Object.values(next.sessions)) session.reconciliation = "disconnected";
          await host.commit(next);
        }).catch(function failed() { /* 不确认消费。 */ });
      }
    });
    await this.refresh();
  }

  /** 登记仅接受受信 create 回执的 Session；无 Run 关系时保持待关联。 */
  async register(sessionId: string): Promise<void> {
    const host = this;
    await this.enqueue(async function register() {
      // 先由远端受管身份门核查，未知或自由会话不落本地可信账本。
      const snapshot = await host.channel.command({ operation: "snapshot", requestId: randomUUID(), sessionId });
      validateSnapshot(snapshot, sessionId);
      if (!host.ledger!.sessions[sessionId]) {
        const next = structuredClone(host.ledger!);
        next.sessions[sessionId] = { sessionId, association: "pending", facts: {}, turns: {}, reconciliation: "pending" };
        await host.commit(next);
      }
      await host.observeSession(sessionId);
    });
  }

  /** 显式重连/启动只读取，不调用 start/resume 或任何业务命令。 */
  async refresh(sessionIds?: readonly string[]): Promise<void> {
    const host = this;
    if (sessionIds?.length === 0) return;
    await this.enqueue(async function refresh() {
      let failure: unknown;
      for (const sessionId of sessionIds ?? Object.keys(host.ledger!.sessions)) if (host.ledger!.sessions[sessionId]) {
        try { await host.observeSession(sessionId); } catch (error) { failure = error; }
      }
      if (failure) throw failure;
    });
  }

  /** 状态副本含未落盘故障，调用方不能把失败当消费确认。 */
  status() { return { ledger: structuredClone(this.ledger), failure: this.failure }; }

  /** 已提交账本以替换方式更新，内部只读界面投影复用同一版本。 */
  projection(): Readonly<ManagedFactsLedger> | undefined { return this.ledger; }

  /** 投影不能信任未落盘的 Session 核查。 */
  failedSessions(): ReadonlySet<string> { return this.failed; }

  /** 核查结果提交后通知调用方；Worker 事件本身不能使交互可操作。 */
  subscribe(listener: (sessionId?: string) => void): () => void {
    this.listeners.add(listener);
    const listeners = this.listeners;
    return function unsubscribe() { listeners.delete(listener); };
  }

  /** 关闭后旧 Runtime 的通知不再进入界面。 */
  close(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.listeners.clear(); }

  /** 发送安全提示，不携带运行数据。 */
  private emit(sessionId?: string): void { for (const listener of this.listeners) listener(sessionId); }

  /** 只在已提交状态或读取错误变化时发布，避免核对本身触发重复读取。 */
  private async observeSession(sessionId: string): Promise<void> {
    const before = this.ledger?.sessions[sessionId];
    try { await this.reconcileSession(sessionId); }
    catch (error) { this.failure = "MANAGED_CONSUMPTION_FAILED"; if (!this.failed.has(sessionId)) { this.failed.add(sessionId); this.emit(sessionId); } throw error; }
    const after = this.ledger?.sessions[sessionId];
    if (this.failed.delete(sessionId) || before?.cursor !== after?.cursor || before?.reconciliation !== after?.reconciliation || JSON.stringify(before?.snapshot?.execution) !== JSON.stringify(after?.snapshot?.execution)) this.emit(sessionId);
  }

  /** 同一 Host 串行消费，避免慢 Snapshot 覆盖新游标。 */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const host = this;
    const next = this.serial.then(operation);
    this.serial = next.catch(function failed() { host.failure = "MANAGED_CONSUMPTION_FAILED"; });
    return next;
  }

  /** 先写记录再提交内存，写后故障可从同一游标重复读取。 */
  private async commit(next: ManagedFactsLedger): Promise<void> { await this.persist(this.path, next); this.ledger = next; this.failure = undefined; }

  /** 续读至页尾再校准 Snapshot；游标失效留缺口，不虚构被丢弃的历史。 */
  private async reconcileSession(sessionId: string): Promise<void> {
    let gap = this.ledger!.sessions[sessionId].historyGap === true;
    try {
      let more: string | undefined;
      do {
        const current = this.ledger!.sessions[sessionId];
        const response = await this.channel.command({ operation: "read", requestId: randomUUID(), sessionId, cursor: current.cursor }) as { items: unknown[]; cursor?: string; nextCursor?: string };
        if (!response || !Array.isArray(response.items) || response.items.length > 100 || (response.cursor !== undefined && (typeof response.cursor !== "string" || response.cursor.length > 4096)) || (response.nextCursor !== undefined && response.nextCursor !== response.cursor)) throw new Error("invalid_fact");
        more = response.nextCursor;
        if (more && more === current.cursor) throw new Error("invalid_fact");
        if (!response.items.length && response.cursor === current.cursor) continue;
        const next = structuredClone(this.ledger!);
        const session = next.sessions[sessionId];
        for (const value of response.items) {
          validateRuntimeFact(value, sessionId);
          const previous = session.facts[value.eventId];
          if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("invalid_fact");
          session.facts[value.eventId] = structuredClone(value);
          if ((session.turns[value.turnId]?.sequence ?? 0) < value.sequence) session.turns[value.turnId] = { sequence: value.sequence, eventType: value.eventType };
        }
        session.cursor = response.cursor;
        session.reconciliation = "pending";
        next.connection = { source: "host", owner: this.channel.identity.owner, generation: this.channel.identity.generation, state: "connected" };
        await this.commit(next);
      } while (more);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (/CURSOR_(EXPIRED|INVALID)/.test(code)) {
        gap = true;
        const next = structuredClone(this.ledger!);
        next.sessions[sessionId].historyGap = true;
        next.sessions[sessionId].reconciliation = "gap";
        await this.commit(next);
      }
      else {
        const next = structuredClone(this.ledger!);
        next.sessions[sessionId].reconciliation = "failed";
        next.sessions[sessionId].failure = code === "invalid_fact" ? "invalid_fact" : "read_failed";
        await this.commit(next);
        throw error;
      }
    }
    let snapshot: RuntimeFactSnapshot;
    try {
      const value = await this.channel.command({ operation: "snapshot", requestId: randomUUID(), sessionId });
      validateSnapshot(value, sessionId);
      snapshot = value;
    } catch (error) {
      const next = structuredClone(this.ledger!);
      next.sessions[sessionId].reconciliation = "failed";
      next.sessions[sessionId].failure = error instanceof Error && error.message === "invalid_fact" ? "invalid_fact" : "read_failed";
      await this.commit(next);
      throw error;
    }
    const current = this.ledger!.sessions[sessionId];
    const connection = this.ledger!.connection;
    if (!gap && current.reconciliation === "consistent" && !current.failure && connection.state === "connected" && connection.owner === this.channel.identity.owner && connection.generation === this.channel.identity.generation && JSON.stringify(current.snapshot) === JSON.stringify(snapshot)) return;
    const next = structuredClone(this.ledger!);
    const session = next.sessions[sessionId];
    const previous = session.snapshot?.execution;
    if (snapshot.execution && (snapshot.execution.lastSeq < (session.turns[snapshot.execution.turnId]?.sequence ?? 0) || (previous && snapshot.execution.turnId === previous.turnId && snapshot.execution.lastSeq < previous.lastSeq))) {
      session.reconciliation = "pending";
    } else {
      session.snapshot = structuredClone(snapshot);
      session.reconciliation = gap ? "gap" : "consistent";
    }
    if (gap) { session.cursor = snapshot.cursor; session.failure = "cursor_gap"; }
    else delete session.failure;
    next.connection = { source: "host", owner: this.channel.identity.owner, generation: this.channel.identity.generation, state: "connected" };
    await this.commit(next);
  }
}
