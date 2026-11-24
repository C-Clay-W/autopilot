/** Core只读执行投影：同一执行段的checkpoint/事件与租约交叉核对，交互独立于摘要。 */
import { normalizeQuestions } from "../user-question-service";
import type { UserQuestionRequest } from "../../domain/user-question";
import { sanitizeContinuationFailure, type ThreadControlIntent } from "../../domain/thread-collaboration";
import type { RuntimePorts } from "../../ports";
import type { Session, Turn } from "../../domain";
import type { AgentEventEnvelope } from "../../protocol";
import { sanitizeEventForExternal } from "../../protocol/sanitize-checkpoint";
import { STALE_AGENT_LEASE_MS } from "./turn-lease-coordinator";

/** 安全执行事实：所有权不表示模型进度；未确认/失联均不能推导成功。 */
export interface TurnExecutionView {
  sessionId: string;
  turnId: string;
  status: Session["status"];
  execution: "active" | "inactive" | "unconfirmed" | "lost";
  executionHost?: string;
  /** 只读未确认原因，不携带路径、正文或私有lease。 */
  unconfirmedReason?: "snapshot_changed" | "checkpoint_missing" | "lease_mismatch" | "turn_summary_lag" | "boundary_unconfirmed";
  continuation?: { controlId: string; state: ThreadControlIntent["status"]; requestId?: string; approvalId?: string; failureCode?: ThreadControlIntent["failureCode"]; failureDiagnostic?: ThreadControlIntent["failureDiagnostic"] };
  waiting?: "approval" | "user_input" | "threads";
  result?: "completed" | "failed" | "interrupted" | "limit_reached";
  warning?: "summary_lag";
  interaction?: { state: "pending" | "decided" | "expired" | "unconfirmed"; decision?: "approved" | "denied"; approval?: AgentEventEnvelope; requestId?: string; question?: UserQuestionRequest; continuation?: { controlId: string; state: ThreadControlIntent["status"]; failureCode?: ThreadControlIntent["failureCode"]; failureDiagnostic?: ThreadControlIntent["failureDiagnostic"] } };
  lastSeq: number;
}

interface ExecutionEventSummary {
  turnId: string;
  cursor?: string;
  events: Map<string, AgentEventEnvelope>;
  lastSeq: number;
  bytes: number;
}

const executionEventSummaries = new WeakMap<RuntimePorts["transcriptStore"], Map<string, ExecutionEventSummary>>();

/** 安全投影只保留当前执行段边界，旧正文解析一次后由原Store游标追尾。 */
async function readExecutionEvents(ports: RuntimePorts, input: { sessionId: string; signal?: AbortSignal }, turnId: string, resetAllowed = true): Promise<{ events: AgentEventEnvelope[]; lastSeq: number }> {
  let summaries = executionEventSummaries.get(ports.transcriptStore);
  if (!summaries) { summaries = new Map(); executionEventSummaries.set(ports.transcriptStore, summaries); }
  const prior = summaries.get(input.sessionId);
  const summary: ExecutionEventSummary = prior?.turnId === turnId ? { ...prior, events: new Map(prior.events) } : { turnId, events: new Map(), lastSeq: 0, bytes: 0 };
  try {
    let more: string | undefined;
    do {
      input.signal?.throwIfAborted();
      const page = await ports.transcriptStore.readPage(input.sessionId, { cursor: summary.cursor, limit: 100 });
      input.signal?.throwIfAborted();
      for (const item of page.items) {
        if (item.turnId !== turnId) continue;
        summary.lastSeq = Math.max(summary.lastSeq, item.seq);
        const type = item.event.type;
        if (type === "turn_started") { summary.events.clear(); summary.bytes = 0; }
        const key = type === "approval_required" ? `approval:${item.event.callId}` : ["turn_started", "turn_completed", "turn_failed", "turn_interrupted", "turn_limit_reached", "thread_wait"].includes(type) ? type : undefined;
        if (key) {
          const previous = summary.events.get(key);
          summary.bytes += Buffer.byteLength(JSON.stringify(item), "utf8") - (previous ? Buffer.byteLength(JSON.stringify(previous), "utf8") : 0);
          summary.events.set(key, item);
        }
      }
      summary.cursor = page.cursor ?? page.nextCursor;
      more = page.nextCursor;
    } while (more);
    // 只有读取起点仍为当前快照时提交；迟到查询不能覆盖其他查询的新游标/执行段。
    if (summaries.get(input.sessionId) === prior) {
      summaries.delete(input.sessionId);
      if (summary.cursor && summary.events.size <= 1024 && summary.bytes <= 2 * 1024 * 1024) {
        while (summaries.size >= 8) summaries.delete(summaries.keys().next().value!);
        summaries.set(input.sessionId, summary);
      }
    }
    return { events: [...summary.events.values()].sort(function chronological(a, b) { return a.seq - b.seq; }), lastSeq: summary.lastSeq };
  } catch (error) {
    if (summaries.get(input.sessionId) === prior) summaries.delete(input.sessionId);
    input.signal?.throwIfAborted();
    const code = error instanceof Error ? error.message : "";
    if (code === "THREAD_CURSOR_EXPIRED" && resetAllowed) return readExecutionEvents(ports, input, turnId, false);
    // 旧超大/损坏JSONL沿原全量审计兼容规则读取，异常文件不缓存派生。
    if (code !== "DURABLE_JSONL_CORRUPTED" && code !== "THREAD_PAYLOAD_TOO_LARGE") throw error;
    const events = (await ports.transcriptStore.getEvents(input.sessionId)).filter(function sameTurn(item) { return item.turnId === turnId; });
    input.signal?.throwIfAborted();
    return { events, lastSeq: events.reduce(function maximum(n, item) { return Math.max(n, item.seq); }, 0) };
  }
}

/** 只读且复核执行段，避免正文分页决定请求是否可见；不触发recoverStale或执行。 */
export async function readTurnExecutionView(ports: RuntimePorts, input: { sessionId: string; turnId?: string; signal?: AbortSignal }): Promise<TurnExecutionView | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    input.signal?.throwIfAborted();
    const turn = input.turnId ? await ports.turnStore.get(input.turnId) : await ports.turnStore.getLatest(input.sessionId);
    if (!turn || turn.sessionId !== input.sessionId) return null;
    input.signal?.throwIfAborted();
    const latest = await ports.turnStore.getLatest(input.sessionId);
    input.signal?.throwIfAborted();
    const checkpoint = latest?.id === turn.id ? await ports.checkpointStore.getLatest(input.sessionId) : await ports.checkpointStore.getByTurn(input.sessionId, turn.id);
    input.signal?.throwIfAborted();
    const owner = await ports.leaseStore.readCurrent?.(input.sessionId);
    const { events, lastSeq } = await readExecutionEvents(ports, input, turn.id);
    input.signal?.throwIfAborted();
    const after = await ports.checkpointStore.getLatest(input.sessionId);
    input.signal?.throwIfAborted();
    const ownerAfter = await ports.leaseStore.readCurrent?.(input.sessionId);
    input.signal?.throwIfAborted();
    const latestAfter = await ports.turnStore.getLatest(input.sessionId);
    // 同Turn/同owner的running边界单调前进不改变执行代次；暂停、回退或换lease仍须重读。
    const runningAdvance = checkpoint?.status === "running" && after?.status === "running"
      && checkpoint.turnId === turn.id && after.turnId === turn.id
      && checkpoint.lease !== undefined && after.lease?.leaseId === checkpoint.lease.leaseId && after.lease?.ownerId === checkpoint.lease.ownerId
      && owner?.turnId === turn.id && owner.lease.leaseId === checkpoint.lease.leaseId && owner.lease.ownerId === checkpoint.lease.ownerId
      && (after.lease?.safeBoundarySeq ?? -1) >= checkpoint.lease.safeBoundarySeq;
    if (latestAfter?.id !== latest?.id || (latest?.id === turn.id && (after?.turnId !== checkpoint?.turnId || after?.lease?.leaseId !== checkpoint?.lease?.leaseId || after?.lease?.ownerId !== checkpoint?.lease?.ownerId || (!runningAdvance && after?.lease?.safeBoundarySeq !== checkpoint?.lease?.safeBoundarySeq) || after?.status !== checkpoint?.status)) || ownerAfter?.lease.leaseId !== owner?.lease.leaseId || ownerAfter?.lease.ownerId !== owner?.lease.ownerId || ownerAfter?.turnId !== owner?.turnId) continue;
    input.signal?.throwIfAborted();
    const view: TurnExecutionView = { sessionId: input.sessionId, turnId: turn.id, status: "interrupted", execution: "unconfirmed", lastSeq };
    input.signal?.throwIfAborted();
    const session = ports.sessionStore.getDirectoryEntry ? await ports.sessionStore.getDirectoryEntry(input.sessionId) : await ports.sessionStore.get(input.sessionId);
    input.signal?.throwIfAborted();
    for (const groupId of session?.productMode === "work" ? await ports.threadStore.listGroups() : []) {
      input.signal?.throwIfAborted();
      const control = await ports.threadStore.readControl(groupId);
      input.signal?.throwIfAborted();
      const member = control?.members.find(function target(item) { return item.threadId === input.sessionId; });
      if (!member) continue;
      view.executionHost = member.executionHost;
      const requestId = checkpoint?.pendingUserQuestion?.requestId;
      const approval = [...events].reverse().find(function currentApproval(item) { return item.event.type === "approval_required" && checkpoint?.pendingCalls?.some(function pending(call) { return item.event.type === "approval_required" && call.id === item.event.callId; }); })?.event;
      const intent = [...control!.controls].reverse().find(function latestIntent(item) { return item.kind === "continue_interaction" && item.threadId === input.sessionId && item.expectedTurnId === turn.id && (requestId ? item.requestId === requestId : approval?.type === "approval_required" ? item.approvalId === approval.result.approval.approvalId : true); });
      if (intent) view.continuation = { controlId: intent.controlId, state: intent.status, ...(intent.requestId ? { requestId: intent.requestId } : {}), ...(intent.approvalId ? { approvalId: intent.approvalId } : {}), ...(intent.failureCode ? { failureCode: intent.failureCode } : {}), ...(sanitizeContinuationFailure(intent.failureDiagnostic) ? { failureDiagnostic: sanitizeContinuationFailure(intent.failureDiagnostic) } : {}) };
    }
    if (!checkpoint || checkpoint.turnId !== turn.id) {
      // 首个 checkpoint 前装配失败时，Turn 和 Session 已落失败事实且租约已释放。
      if (latest?.id === turn.id && turn.status === "failed" && session?.status === "failed" && !session.activeTurnId && !ownerAfter) {
        return { ...view, status: "failed", execution: "inactive", result: "failed" };
      }
      view.unconfirmedReason = "checkpoint_missing"; return view;
    }
    const started = [...events].reverse().find(function start(item) { return item.event.type === "turn_started"; })?.seq ?? 0;
    const boundarySeq = checkpoint.lease?.safeBoundarySeq ?? lastSeq;
    const terminal = [...events].reverse().find(function ended(item) { return item.seq >= started && item.seq >= boundarySeq && ["turn_completed", "turn_failed", "turn_interrupted", "turn_limit_reached"].includes(item.event.type); });
    if (terminal) {
      const result = terminal.event.type === "turn_completed" ? "completed" : terminal.event.type === "turn_failed" ? "failed" : terminal.event.type === "turn_limit_reached" ? "limit_reached" : "interrupted";
      view.execution = "inactive"; view.result = result; view.status = result === "limit_reached" ? "interrupted" : result;
      return view;
    }
    const owns = owner?.turnId === turn.id && owner.lease.leaseId === checkpoint.lease?.leaseId && owner.lease.ownerId === checkpoint.lease?.ownerId;
    const fresh = owns && ports.clock.now() - owner.lease.heartbeatAt <= STALE_AGENT_LEASE_MS;
    // Continue初始checkpoint仍含旧pendingCalls；新lease的seq=0不代表旧暂停仍有效。
    const boundary = checkpoint.status !== "running" && boundarySeq >= started && boundarySeq > 0;
    if (boundary) {
      view.execution = "inactive";
      if (checkpoint.status === "awaiting_approval") {
        view.status = "waiting_approval"; view.waiting = "approval";
        if (turn.status !== view.status || session?.status !== view.status) view.warning = "summary_lag";
        const envelope = [...events].reverse().find(function request(item) {
          if (item.seq < started || item.seq > boundarySeq || item.event.type !== "approval_required") return false;
          const request = item.event.result.approval;
          return request.callId === item.event.callId && request.toolName === item.event.toolName
            && checkpoint.pendingCalls?.some(function matches(call) { return call.id === request.callId && call.name === request.toolName; });
        });
        if (!envelope || envelope.event.type !== "approval_required") { view.interaction = { state: "unconfirmed" }; return view; }
        const request = envelope.event.result.approval;
        const decision = await ports.approvalStore.getDecision({ sessionId: input.sessionId, turnId: turn.id, approvalId: request.approvalId });
        const expiresAt = Date.parse(request.expiresAt);
        const state = decision ? "decided" : !Number.isFinite(expiresAt) || expiresAt <= ports.clock.now() ? "expired" : "pending";
        view.interaction = { state, ...(decision ? { decision: decision.decision === "deny" ? "denied" as const : "approved" as const } : {}), approval: { ...envelope, event: sanitizeEventForExternal(envelope.event) } };
      } else if (checkpoint.status === "awaiting_user_input") {
        view.status = "waiting_user_input"; view.waiting = "user_input";
        const question = checkpoint.pendingUserQuestion;
        const stored = question ? await ports.userQuestionStore.getRequest({ sessionId: input.sessionId, turnId: turn.id, requestId: question.requestId }) : null;
        view.interaction = { state: stored ? stored.answer ? "decided" : "pending" : "unconfirmed", ...(question ? { requestId: question.requestId } : {}) };
        if (stored) {
          try { view.interaction.question = { requestId: stored.request.requestId, questions: normalizeQuestions(stored.request.questions) }; }
          catch { view.interaction = { state: "unconfirmed" }; }
        }
      } else {
        const result = checkpoint.status === "completed" ? "completed" : checkpoint.status === "failed" ? "failed" : checkpoint.status === "limit_reached" ? "limit_reached" : "interrupted";
        view.result = result; view.status = result === "limit_reached" ? "interrupted" : result;
      }
      const continuation = view.continuation;
      const approval = view.interaction?.approval?.event;
      if (view.interaction && continuation && (approval?.type === "approval_required" ? continuation.approvalId === approval.result.approval.approvalId : continuation.requestId === view.interaction.requestId)) {
        view.interaction.continuation = { controlId: continuation.controlId, state: continuation.state, ...(continuation.failureCode ? { failureCode: continuation.failureCode } : {}), ...(continuation.failureDiagnostic ? { failureDiagnostic: continuation.failureDiagnostic } : {}) };
      }
      return view;
    }
    if (fresh && latest?.id === turn.id && turn.status === "running") {
      view.execution = "active"; view.status = "running";
      const wait = [...events].reverse().find(function waiting(item) { return item.seq >= started && item.event.type === "thread_wait"; });
      if (wait?.event.type === "thread_wait" && wait.event.phase === "waiting") view.waiting = "threads";
    } else if (owns && !fresh) view.execution = "lost";
    else view.unconfirmedReason = !owns ? "lease_mismatch" : turn.status !== "running" ? "turn_summary_lag" : "boundary_unconfirmed";
    return view;
  }
  const turn: Turn | null = input.turnId ? await ports.turnStore.get(input.turnId) : await ports.turnStore.getLatest(input.sessionId);
  return turn?.sessionId === input.sessionId ? { sessionId: input.sessionId, turnId: turn.id, status: "interrupted", execution: "unconfirmed", unconfirmedReason: "snapshot_changed", lastSeq: 0 } : null;
}
