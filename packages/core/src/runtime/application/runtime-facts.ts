/** Core 执行事实的最小安全投影；复用 transcript 游标和执行视图，不保存第二份事实。 */
import type { RuntimePorts } from "../ports";
import type { AgentEventEnvelope } from "../protocol";
import { readTurnExecutionView } from "./turn/turn-execution-view";

/** 稳定事件身份与仅含状态的 payload，不携带对话、工具参数或展示文本。 */
export interface RuntimeFact {
  protocol: 1;
  source: "core";
  eventId: string;
  sessionId: string;
  turnId: string;
  sequence: number;
  timestamp: string;
  eventType: string;
  payload: { callId?: string; requestId?: string; approvalId?: string; inputId?: string; status?: string };
}

/** 仅提供 H1 观察需要的状态；交互正文留在原来的显式人类入口。 */
export interface RuntimeFactSnapshot {
  protocol: 1;
  sessionId: string;
  cursor?: string;
  consistency: "overlap";
  execution: null | {
    turnId: string;
    status: string;
    execution: "active" | "inactive" | "unconfirmed" | "lost";
    lastSeq: number;
    result?: string;
    waiting?: string;
    interaction?: { state: string; requestId?: string; approvalId?: string };
  };
}

const factTypes = new Set(["turn_started", "turn_completed", "turn_failed", "turn_interrupted", "turn_limit_reached", "turn_paused", "tool_started", "tool_result", "approval_required", "question_required", "question_answered", "input_queued", "input_joined", "input_consumed"]);

/** 白名单字段重建对象，禁止把 transcript 的扩展字段透传给主控或 Host。 */
export function projectRuntimeFact(envelope: AgentEventEnvelope): RuntimeFact | null {
  const event = envelope.event;
  if (!factTypes.has(event.type)) return null;
  const payload: RuntimeFact["payload"] = {};
  if ("callId" in event) payload.callId = event.callId;
  if ("requestId" in event) payload.requestId = event.requestId;
  if ("inputId" in event) payload.inputId = event.inputId;
  if (event.type === "tool_result") payload.status = event.result.status;
  if (event.type === "approval_required") payload.approvalId = event.result.approval.approvalId;
  return { protocol: 1, source: "core", eventId: JSON.stringify([envelope.sessionId, envelope.turnId, envelope.seq]), sessionId: envelope.sessionId, turnId: envelope.turnId, sequence: envelope.seq, timestamp: envelope.timestamp, eventType: event.type, payload };
}

/** 在原 Store 上只读分页；Snapshot 的游标先于状态读取，续读允许重叠。 */
export function createRuntimeFacts(ports: RuntimePorts) {
  /** 只有已持久 Session 可读，ephemeral 不承诺重放。 */
  async function requireDurable(sessionId: string) {
    const session = await ports.sessionStore.get(sessionId);
    if (!session || session.persistenceMode !== "durable") throw new Error("FACTS_SESSION_UNAVAILABLE");
  }
  /** 过滤不会改变底层页游标，空事实页也必须保存消费进度。 */
  async function read(input: { sessionId: string; cursor?: string; limit: number }) {
    await requireDurable(input.sessionId);
    const page = await ports.transcriptStore.readPage(input.sessionId, input);
    return { items: page.items.map(projectRuntimeFact).filter(function exists(item): item is RuntimeFact { return item !== null; }), cursor: page.cursor, nextCursor: page.nextCursor };
  }
  /** Snapshot 只校准当前状态，不生成不存在的历史事件或业务成功。 */
  async function snapshot(input: { sessionId: string }): Promise<RuntimeFactSnapshot> {
    await requireDurable(input.sessionId);
    let cursor: string | undefined;
    let more: string | undefined;
    do {
      const page = await ports.transcriptStore.readPage(input.sessionId, { cursor, limit: 100 });
      cursor = page.cursor ?? page.nextCursor;
      more = page.nextCursor;
    } while (more);
    const view = await readTurnExecutionView(ports, input);
    const execution: RuntimeFactSnapshot["execution"] = view ? {
      turnId: view.turnId, status: view.status, execution: view.execution, lastSeq: view.lastSeq,
      ...(view.result ? { result: view.result } : {}), ...(view.waiting ? { waiting: view.waiting } : {}),
      ...(view.interaction ? { interaction: { state: view.interaction.state, ...(view.interaction.requestId ? { requestId: view.interaction.requestId } : {}), ...(view.interaction.approval?.event.type === "approval_required" ? { approvalId: view.interaction.approval.event.result.approval.approvalId } : {}) } } : {}),
    } : null;
    return { protocol: 1, sessionId: input.sessionId, cursor, consistency: "overlap", execution };
  }
  return { read, snapshot };
}

export type RuntimeFacts = ReturnType<typeof createRuntimeFacts>;
