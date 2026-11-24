/** 受管 AP 命令边界：只调用正式 Runtime，不承担 Run/Assignment、派工或资源准入。 */
import { isApPermissionMode, type ApPermissionMode } from "./workspace";
import { canCancelTurn, isManagedApprovalDecision, type ManagedApprovalDecision } from "./orchestration-contract";
import type { CliAction } from "@autopilot-agent/cli/dist/types.js";
import type { CliController } from "@autopilot-agent/cli/dist/controller.js";
export interface ManagedCliServices { root: Pick<import("@autopilot-agent/cli/dist/composition-root.js").CliCompositionRoot, "getRuntimeStatusDefaults" | "listSkills" | "resolveSkill">; createCliController: typeof import("@autopilot-agent/cli/dist/controller.js").createCliController }
import { createHash } from "node:crypto";
import type { AgentRuntime, CreateAgentRuntimeOptions, RuntimeFactSnapshot } from "@autopilot-agent/core";
import { readManagedRecord, writeManagedRecord } from "./managed-runtime-store";

export interface ManagedRuntimeIdentity { protocol: 1; hostId: string; owner: string; generation: string }
export interface ManagedRuntimeCommand extends ManagedRuntimeIdentity {
  requestId: string;
  operation: "create" | "start" | "steer" | "queue" | "cancel" | "snapshot" | "activity" | "lease_activity" | "inspect" | "active_turns" | "read" | "transcript" | "query" | "resume" | "approval" | "answer" | "cancel_input" | "stop_job" | "cli";
  permissionMode?: ApPermissionMode;
  sessionId?: string; turnId?: string; previousTurnId?: string | null; queued?: true; content?: string; cursor?: string;
  targetRequestId?: string; approvalId?: string; decision?: ManagedApprovalDecision; retryOf?: string;
  questionId?: string; answers?: Parameters<AgentRuntime["questions"]["submit"]>[0]["answers"];
  inputId?: string; jobId?: string; action?: CliAction;
  selectedSkills?: Array<{ skillRef: string; skillId: string; contentHash: string; pinned: boolean }>;
  attachments?: import("@autopilot-agent/core").SessionImageRef[]; activeSkills?: Array<{ skillId: string; contentHash: string }>;
}
export interface ManagedRuntimeReceipt {
  requestId: string;
  operation?: ManagedRuntimeCommand["operation"]; jobId?: string;
  state: "submitted" | "accepted" | "started" | "confirmed" | "unconfirmed" | "rejected";
  sessionId?: string; turnId?: string; inputId?: string; code?: string; inputStatus?: string;
  execution?: { turnId: string; execution: string; result?: string; waiting?: string } | null;
  phase?: "check_resume" | "read_turn" | "read_decision" | "await_first_event" | "started";
  retryable?: boolean;
  diagnostic?: { phase?: string; osCode?: string; lockWaitMs?: number; attempts?: number; elapsedMs?: number; cleanupFailed?: boolean };
}
interface CommandRecord { digest: string; operation: ManagedRuntimeCommand["operation"]; receipt: ManagedRuntimeReceipt; jobId?: string; resumeBasis?: { lastSeq: number; approvalId?: string; questionId?: string } }
interface CommandJournal { protocol: 1; hostId: string; records: Record<string, CommandRecord> }
export interface ManagedLeaseActivity {
  sessionId: string; turnId?: string; status: string; execution: string; result?: string; waiting?: string; activeJobs: boolean; activeTurn: boolean;
}

/** 只有目标与操作完全一致且 Worker 确认零执行，Host 才能为原输入重新择机投递。 */
export function matchesManagedWakeRejection(receipt: ManagedRuntimeReceipt, wake: { requestId: string; operation: string; turnId?: string }, sessionId: string): boolean {
  return receipt.state === "rejected" && receipt.code === "MANAGED_WAKE_BLOCKED" && receipt.requestId === wake.requestId
    && receipt.sessionId === sessionId && receipt.turnId === wake.turnId && receipt.operation === wake.operation;
}

/** 使用实际 Worker 命令序列化结果统一检查正文与 IPC 大小。 */
export function fitsManagedCommandPayload(value: { operation?: unknown; content?: unknown }): boolean {
  return (value.content === undefined || typeof value.content === "string" && value.content.length <= 32_000)
    && Buffer.byteLength(JSON.stringify(value)) <= (value.operation === "cli" ? 32 * 1024 * 1024 : 65_536);
}

/** 仅投影本机存储诊断白名单，不传路径、异常正文、cause 或其他扩展字段。 */
export function managedStorageDiagnostic(error: unknown): ManagedRuntimeReceipt["diagnostic"] {
  const getter = error && typeof error === "object" ? (error as { getStorageDiagnostic?: unknown }).getStorageDiagnostic : undefined;
  if (typeof getter !== "function") return;
  const value = getter.call(error) as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object") return;
  return {
    phase: ["prepare", "identity", "lock", "temporary_write", "rename", "cleanup"].includes(value.phase as string) ? value.phase as string : undefined,
    osCode: ["EACCES", "EPERM", "ENOENT", "EEXIST", "ENOSPC", "EIO", "EMFILE", "ENFILE", "EBUSY", "EROFS", "ENOTDIR", "ETIMEDOUT"].includes(value.osCode as string) ? value.osCode as string : undefined,
    lockWaitMs: typeof value.lockWaitMs === "number" && Number.isSafeInteger(value.lockWaitMs) && value.lockWaitMs >= 0 ? value.lockWaitMs : undefined,
    ...(Number.isSafeInteger(value.attempts) && Number(value.attempts) >= 0 ? { attempts: Number(value.attempts) } : {}),
    ...(Number.isSafeInteger(value.elapsedMs) && Number(value.elapsedMs) >= 0 ? { elapsedMs: Number(value.elapsedMs) } : {}),
    cleanupFailed: typeof value.cleanupFailed === "boolean" ? value.cleanupFailed : undefined,
  };
}

/** 校验封闭消息形状，身份来自私有 IPC 启动握手；正文只用于受限输入。 */
export function validateManagedCommand(value: unknown, identity: ManagedRuntimeIdentity): asserts value is ManagedRuntimeCommand {
  if (!value || typeof value !== "object" || Array.isArray(value) || !fitsManagedCommandPayload(value)) throw new Error("MANAGED_INVALID_MESSAGE");
  const input = value as ManagedRuntimeCommand;
  if (input.protocol !== 1 || input.hostId !== identity.hostId || input.owner !== identity.owner || input.generation !== identity.generation) throw new Error("MANAGED_STALE_OWNER");
  if (typeof input.requestId !== "string" || !/^[\w-]{1,128}$/.test(input.requestId) || !["create", "start", "steer", "queue", "cancel", "snapshot", "activity", "lease_activity", "inspect", "active_turns", "read", "transcript", "query", "resume", "approval", "answer", "cancel_input", "stop_job", "cli"].includes(input.operation)) throw new Error("MANAGED_INVALID_MESSAGE");
  const fields = new Set(["protocol", "hostId", "owner", "generation", "requestId", "operation", "sessionId", "turnId", "previousTurnId", "queued", "content", "cursor", "targetRequestId", "approvalId", "decision", "questionId", "answers", "inputId", "jobId", "action", "attachments", "activeSkills", "selectedSkills", "permissionMode", "retryOf"]);
  if (Object.keys(input).some(function unknown(key) { return !fields.has(key); })) throw new Error("MANAGED_INVALID_MESSAGE");
  for (const key of ["sessionId", "turnId", "targetRequestId", "approvalId", "questionId", "inputId", "jobId"] as const) if (input[key] !== undefined && (typeof input[key] !== "string" || !/^[\w-]{1,128}$/.test(input[key]!))) throw new Error("MANAGED_INVALID_MESSAGE");
  if (input.permissionMode !== undefined && (input.operation !== "create" || !isApPermissionMode(input.permissionMode))) throw new Error("MANAGED_INVALID_MESSAGE");
  if (input.previousTurnId !== undefined && (!["start", "steer"].includes(input.operation) || input.previousTurnId !== null && (typeof input.previousTurnId !== "string" || !/^[\w-]{1,128}$/u.test(input.previousTurnId)))) throw new Error("MANAGED_INVALID_MESSAGE");
  if (input.queued !== undefined && (input.queued !== true || input.operation !== "start" || !input.previousTurnId)) throw new Error("MANAGED_INVALID_MESSAGE");
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 4096)) throw new Error("MANAGED_INVALID_MESSAGE");
  if (input.retryOf !== undefined && (input.operation !== "resume" || !input.approvalId || typeof input.retryOf !== "string" || !/^[\w-]{1,128}$/u.test(input.retryOf))) throw new Error("MANAGED_INVALID_MESSAGE");
}

/** 单 Runtime 内串行接纳命令，长 Turn 自行驱动，取消不等待模型完成。 */
export class ManagedRuntimeService {
  private controllerCursors = new Map<string, string>();
  private controllers = new Map<string, CliController>();
  private serial: Promise<unknown> = Promise.resolve();
  private journalSerial: Promise<unknown> = Promise.resolve();
  private active = new Map<string, { turnId: string; stopping?: boolean }>();
  private starting = new Map<string, number>();
  private inspections = new Map<string, Promise<unknown>>();
  constructor(private runtime: AgentRuntime, readonly identity: ManagedRuntimeIdentity, private journalPath: string, private workspaceRoot: string, private transcript?: CreateAgentRuntimeOptions["ports"]["transcriptStore"], private cli?: ManagedCliServices) {}

  /** 人类来源由受信调用入口绑定，绝不接受模型在 JSON 内自报。 */
  dispatch(input: unknown, source: "host" | "human" = "host"): Promise<unknown> {
    const service = this;
    let startingSession: string | undefined;
    if (input && typeof input === "object") {
      const command = input as ManagedRuntimeCommand;
      if (command.operation === "inspect") {
        try { validateManagedCommand(input, this.identity); }
        catch (error) { return Promise.reject(error); }
        if (source !== "human" || !command.sessionId) return service.execute(input, source);
        const prior = this.inspections.get(command.sessionId);
        if (prior) return prior;
        const result = service.execute(input, source).finally(function done() {
          if (service.inspections.get(command.sessionId!) === result) service.inspections.delete(command.sessionId!);
        });
        this.inspections.set(command.sessionId, result);
        return result;
      }
      if (["active_turns", "read", "snapshot", "activity", "lease_activity", "inspect", "transcript", "query"].includes(command.operation) || command.operation === "cli" && !command.action) return service.execute(input, source);
      const active = command.operation === "cancel" && command.sessionId ? this.active.get(command.sessionId) : undefined;
      if (active) return service.execute(input, source, active);
      if ((command.operation === "start" || command.operation === "resume") && command.sessionId) {
        try { validateManagedCommand(input, this.identity); }
        catch (error) { return Promise.reject(error); }
        startingSession = command.sessionId;
        this.starting.set(startingSession, (this.starting.get(startingSession) ?? 0) + 1);
      }
    }
    const next = this.serial.then(function handle() { return service.execute(input, source); }).then(function committed(value) {
      const command = input as ManagedRuntimeCommand;
      // 决定后的读取必须跨过本次写入；旧读取的 finally 只清理自身。
      if (command.sessionId && (command.operation === "approval" || command.operation === "answer")) service.inspections.delete(command.sessionId);
      return value;
    }).finally(function settled() {
      if (!startingSession) return;
      const count = service.starting.get(startingSession)! - 1;
      if (count) service.starting.set(startingSession, count); else service.starting.delete(startingSession);
    });
    this.serial = next.catch(function keepQueue() {});
    return next;
  }

  /** 核实持久归属，不允许控制 Parallel 自由 Session 或其他宿主的 Session。 */
  private async requireSession(sessionId?: string): Promise<string> {
    if (!sessionId) throw new Error("MANAGED_TARGET_REQUIRED");
    const session = await this.runtime.sessions.get(sessionId);
    if (session?.managedExecution?.hostId !== this.identity.hostId || session.managedExecution.threadPolicy !== "disabled") throw new Error("MANAGED_SCOPE_DENIED");
    return sessionId;
  }

  /** 以最新 Turn 身份检查精确控制，历史目标不得影响当前执行。 */
  private async requireTurn(sessionId: string, turnId?: string): Promise<RuntimeFactSnapshot> {
    const snapshot = await this.runtime.facts.snapshot({ sessionId });
    if (!turnId || snapshot.execution?.turnId !== turnId) throw new Error("MANAGED_TURN_MISMATCH");
    return snapshot;
  }

  /** 并行取消只竞争短日志事务，记录提交后就能请求中断。 */
  private async readJournal(): Promise<CommandJournal> {
    const journal = await readManagedRecord<CommandJournal>(this.journalPath, { protocol: 1, hostId: this.identity.hostId, records: {} });
    if (journal.protocol !== 1 || journal.hostId !== this.identity.hostId || !journal.records) throw new Error("MANAGED_JOURNAL_INVALID");
    return journal;
  }

  /** 每次只合并原请求记录，避免覆盖并行命令刚保存的回执。 */
  private changeJournal<T>(change: (journal: CommandJournal) => { value: T; write?: boolean }): Promise<T> {
    const service = this;
    const next = this.journalSerial.then(async function commit() {
      const journal = await service.readJournal();
      const { value, write } = change(journal);
      if (write) await writeManagedRecord(service.journalPath, journal);
      return value;
    });
    this.journalSerial = next.catch(function keepQueue() {});
    return next;
  }

  /** 已知的首事件前存储失败，须仍是原已决暂停点、无执行/Job 且 checkpoint 一致才可重试。 */
  private async canRetryResume(record: CommandRecord, approvalId?: string, ownStarting = 0): Promise<boolean> {
    const receipt = record.receipt;
    const original = record.resumeBasis?.approvalId ?? approvalId;
    if (record.operation !== "resume" || receipt.state !== "unconfirmed" || receipt.code !== "STATE_STORAGE_UNAVAILABLE" || receipt.phase === "started" || !receipt.sessionId || !receipt.turnId || !original || approvalId && approvalId !== original) return false;
    if (this.active.has(receipt.sessionId) || (this.starting.get(receipt.sessionId) ?? 0) > ownStarting) return false;
    const snapshot = await this.requireTurn(receipt.sessionId, receipt.turnId);
    const view = snapshot.execution!;
    const recovery = await this.runtime.turns.getRecoverableState({ sessionId: receipt.sessionId, turnId: receipt.turnId });
    let pauseSeq = record.resumeBasis?.lastSeq;
    // 旧 Worker 未保存序号时，仅接受唯一原审批之后直接发布的暂停边界。
    if (!record.resumeBasis && this.transcript) {
      const events = (await this.transcript.getEvents(receipt.sessionId)).filter(function sameTurn(e) { return e.turnId === receipt.turnId; });
      const requests = events.filter(function approval(e) { return e.event.type === "approval_required"; });
      const last = events.at(-1);
      if (requests.length === 1 && requests[0].event.type === "approval_required" && requests[0].event.result.approval.approvalId === original && last?.event.type === "turn_paused" && events.slice(events.indexOf(requests[0]) + 1, -1).every(function sameSegment(e) { return !["turn_started", "approval_required", "turn_paused"].includes(e.event.type); })) pauseSeq = last.seq;
    }
    return view.execution === "inactive" && view.waiting === "approval" && view.interaction?.state === "decided" && view.interaction.approvalId === original
      && pauseSeq !== undefined && pauseSeq === view.lastSeq && recovery?.turnId === receipt.turnId && recovery.recoverable === true
      && recovery.lastSeq === view.lastSeq && !await this.runtime.jobs.hasActiveJobs(receipt.sessionId)
      && !!await this.runtime.approvals.getDecision({ sessionId: receipt.sessionId, turnId: receipt.turnId, approvalId: original });
  }

  /** 接纳前落盘原请求摘要；崩溃窗口返回未知，不根据超时重新执行。 */
  private async execute(value: unknown, source: "host" | "human", priority?: { turnId: string; stopping?: boolean }): Promise<unknown> {
    validateManagedCommand(value, this.identity);
    const input = value;
    // 删除仅查询指定会话的当前执行，避开命令队列、历史分页和 Job。
    if (input.operation === "active_turns") {
      if (!input.sessionId) return [...this.active.keys()];
      const active = this.active.get(input.sessionId);
      if (!active || input.turnId && input.turnId !== active.turnId) return [];
      const turn = await this.runtime.turns.getExecutionState({ sessionId: input.sessionId, turnId: active.turnId });
      return this.active.get(input.sessionId) === active && turn?.turnId === active.turnId && turn.execution === "active" && turn.status === "running" && !turn.waiting ? [input.sessionId] : [];
    }
    if ((input.operation === "approval" || input.operation === "answer") && source !== "human") throw new Error("MANAGED_HUMAN_REQUIRED");
    if (input.operation === "query") {
      const journal = await this.readJournal();
      const record = Object.hasOwn(journal.records, input.targetRequestId ?? "") ? journal.records[input.targetRequestId!] : undefined;
      if (!record) return { requestId: input.targetRequestId, state: "unconfirmed", code: "MANAGED_REQUEST_UNKNOWN" };
      // 操作与Job来自原命令日志，不由查询者补填；旧回执也在读取时补齐身份。
      record.receipt = { ...record.receipt, operation: record.operation, jobId: record.jobId ?? record.receipt.jobId };
      if (record.receipt.state === "rejected") return record.receipt;
      if (record.operation === "stop_job") {
        let state: ManagedRuntimeReceipt["state"] = "unconfirmed";
        try {
          const sessionId = await this.requireSession(record.receipt.sessionId);
          const job = record.jobId ? await this.runtime.jobs.get(record.jobId) : null;
          if (job && job.sessionId === sessionId && job.turnId === record.receipt.turnId) {
            const view = await this.runtime.jobs.forSession({ workspaceId: this.workspaceRoot, sessionId }).read({ jobId: job.id });
            if (view.job.controlState === "terminal") state = "confirmed";
          }
        } catch { /* 历史记录缺身份或 Core 无法核查时保留未知，不重发停止。 */ }
        record.receipt.state = state;
        await this.changeJournal(function save(current) { current.records[record.receipt.requestId] = record; return { value: undefined, write: true }; });
        return record.receipt;
      }
      if (record.receipt.sessionId && record.receipt.inputId) {
        await this.requireSession(record.receipt.sessionId);
        const item = (await this.runtime.inbox.list({ sessionId: record.receipt.sessionId })).find(function same(item) { return item.inputId === record.receipt.inputId; });
        return { ...record.receipt, state: item?.status === "consumed" || item?.status === "cancelled" ? "confirmed" : item ? "accepted" : "unconfirmed", inputStatus: item?.status };
      }
      if (record.operation === "create" && record.receipt.sessionId) {
        try { await this.requireSession(record.receipt.sessionId); return { ...record.receipt, state: "confirmed" }; }
        catch { return { ...record.receipt, state: "unconfirmed" }; }
      }
      if (["start", "resume", "cancel"].includes(record.operation) && record.receipt.sessionId && record.receipt.turnId) {
        await this.requireSession(record.receipt.sessionId);
        const execution = await this.runtime.turns.getExecutionState({ sessionId: record.receipt.sessionId, turnId: record.receipt.turnId });
        const progressed = record.operation !== "resume" || record.receipt.state === "started" || !!record.resumeBasis && (execution?.lastSeq ?? -1) > record.resumeBasis.lastSeq;
        const state = !execution || execution.turnId !== record.receipt.turnId ? "unconfirmed" : execution.execution === "active" ? (record.operation === "cancel" ? "unconfirmed" : "started") : execution.execution === "inactive" && (!!execution.result && !execution.waiting || progressed && record.operation !== "cancel") ? "confirmed" : "unconfirmed";
        return { ...record.receipt, state, retryable: record.operation === "resume" && state === "unconfirmed" ? await this.canRetryResume(record, input.approvalId).catch(function unknown() { return false; }) : false, execution: execution ? { turnId: execution.turnId, execution: execution.execution, result: execution.result, waiting: execution.waiting } : null };
      }
      return record.receipt;
    }
    const sessionId = input.operation === "create" ? undefined : priority ? input.sessionId : await this.requireSession(input.sessionId);
    if (input.operation === "cli") {
      if (source !== "human" || !this.cli) throw new Error("MANAGED_HUMAN_REQUIRED");
      let controller = this.controllers.get(sessionId!);
      if (!controller) {
        controller = this.cli.createCliController({ runtime: this.runtime, sessionId, workspaceRoot: this.workspaceRoot, handoffPrompt: true,
          renderer: { format: "text", render: function silent() { return ""; } },
          getRuntimeStatusDefaults: this.cli.root.getRuntimeStatusDefaults, listSkills: this.cli.root.listSkills, resolveSkill: this.cli.root.resolveSkill });
        this.controllers.set(sessionId!, controller);
      }
      let cursor = this.controllerCursors.get(sessionId!);
      for (;;) {
        const page = await this.transcript!.readPage(sessionId!, { cursor, limit: 100 });
        controller.observe?.(page.items);
        cursor = page.nextCursor ?? page.cursor ?? cursor;
        if (cursor) this.controllerCursors.set(sessionId!, cursor);
        if (!page.nextCursor) break;
      }
      const execution = await this.runtime.turns.getExecutionState({ sessionId: sessionId! });
      const queuing = input.action?.type === "submit_prompt" && input.action.delivery === "queue";
      if (queuing && (!execution?.turnId || !(execution.execution === "active" && !execution.waiting || execution.status === "waiting_approval"))) {
        return { kind: "error", exitCode: 2, lines: [], message: "CLI_QUEUE_REQUIRES_ACTIVE_TURN" };
      }
      if (input.action?.type === "submit_prompt") {
        const question = execution?.status === "waiting_user_input" && execution.interaction?.state === "pending" ? execution.interaction.question : undefined;
        if (input.questionId !== question?.requestId || execution?.status === "waiting_user_input" && !question) {
          return { kind: "error", exitCode: 1, lines: ["原 Turn 的问题状态已变化，本次输入未提交。请查看问题并从输入历史取回。"] };
        }
      }
      if (execution && (controller.getProjection().turnId !== execution.turnId || controller.getProjection().status !== execution.status)) controller.invalidateObservedTurn?.({ turnId: execution.turnId, status: execution.status });
      if (execution?.interaction?.question && execution.interaction.state === "pending") controller.syncObservedInteraction?.({ turnId: execution.turnId, status: "waiting_user_input", requestId: execution.interaction.question.requestId });
      if (!input.action) return controller.getStatusView!();
      if (["resume", "cancel_turn"].includes(input.action.type)) throw new Error("MANAGED_HOST_CONTROL_REQUIRED");
      // 仅接收原生CliAction，自由Session/Thread/项目命令不能进入此通道。
      const allowed = ["approve", "submit_prompt", "compact", "show_context", "select_skill", "toggle_skill", "list_skills", "open_permissions", "set_permission_mode", "list_permission_grants", "revoke_permission_grant", "open_model_picker", "set_model", "open_effort_picker", "set_effort", "list_jobs", "show_job", "read_job_output", "stop_job", "undo_preview", "undo_confirm", "exit"];
      if (!allowed.includes(input.action.type)) throw new Error("MANAGED_SCOPE_DENIED");
      if (input.action.type === "set_permission_mode" && !["ask", "auto_approve", "full_access"].includes(input.action.mode)) throw new Error("MANAGED_INVALID_MESSAGE");
      const action = structuredClone(input.action);
      if (action.type === "submit_prompt" && action.images) action.images = action.images.map(function decode(image) { return { ...image, bytes: typeof image.bytes === "string" ? new Uint8Array(Buffer.from(image.bytes, "base64")) : new Uint8Array(Object.values(image.bytes)) }; });
      const result = await controller.dispatch(action);
      return { ...result, projection: undefined, ...(queuing && result.preparedPrompt ? { queuedAfterTurnId: execution!.turnId } : {}) };
    }
    if (input.operation === "transcript") {
      if (source !== "human" || !this.transcript) throw new Error("MANAGED_HUMAN_REQUIRED");
      return this.transcript.readPage(sessionId!, { cursor: input.cursor, limit: 20 });
    }
    if (input.operation === "snapshot") return this.runtime.facts.snapshot({ sessionId: sessionId! });
    if (input.operation === "activity") return { snapshot: await this.runtime.facts.snapshot({ sessionId: sessionId! }), activeJobs: await this.runtime.jobs.hasActiveJobs(sessionId!) };
    if (input.operation === "lease_activity") {
      const before = this.active.has(sessionId!) || this.starting.has(sessionId!);
      const view = await this.runtime.turns.getExecutionState({ sessionId: sessionId! });
      const activeJobs = await this.runtime.jobs.hasActiveJobs(sessionId!);
      return { sessionId: sessionId!, turnId: view?.turnId, status: view?.status ?? "idle", execution: view?.execution ?? "inactive",
        result: view?.result, waiting: view?.waiting, activeJobs, activeTurn: before || this.active.has(sessionId!) || this.starting.has(sessionId!) } satisfies ManagedLeaseActivity;
    }
    if (input.operation === "inspect") {
      if (source !== "human") throw new Error("MANAGED_HUMAN_REQUIRED");
      const view = await this.runtime.turns.getExecutionState({ sessionId: sessionId! });
      const recovery = await this.runtime.turns.getRecoverableState({ sessionId: sessionId! });
      const jobs = await this.runtime.jobs.forSession({ workspaceId: this.workspaceRoot, sessionId: sessionId! }).list({ limit: 100 });
      const event = view?.interaction?.approval?.event;
      const approval = event?.type === "approval_required" ? event.result.approval : undefined;
      const decision = approval && view?.interaction?.state === "decided" ? await this.runtime.approvals.getDecision({ sessionId: sessionId!, turnId: view.turnId, approvalId: approval.approvalId }) : undefined;
      return { canCancel: canCancelTurn(view), lastSeq: view?.lastSeq, turnId: view?.turnId, status: view?.status ?? "idle", execution: view?.execution ?? "inactive", activeJobs: await this.runtime.jobs.hasActiveJobs(sessionId!),
        jobs: jobs.jobs.map(function job(j) { return { jobId: j.jobId, status: j.status, canStop: j.canStop, controlState: j.controlState }; }),
        recoverable: recovery?.recoverable === true, checkpoint: !!recovery, threadPolicy: "disabled",
        interaction: view?.interaction ? { state: view.interaction.state, question: view.interaction.question,
          approval: approval ? { approvalId: approval.approvalId, toolName: approval.toolName, reason: approval.reason, constraint: approval.constraint, allowedDecisions: approval.allowedDecisions, display: approval.display, decision: decision?.decision } : undefined } : undefined };
    }
    if (input.operation === "read") return this.runtime.facts.read({ sessionId: sessionId!, cursor: input.cursor, limit: 100 });
    const digest = createHash("sha256").update(JSON.stringify({ ...input, owner: undefined, generation: undefined })).digest("hex");
    const turnId = input.operation === "start" ? createHash("sha256").update(JSON.stringify([this.identity.hostId, sessionId, input.requestId])).digest("hex") : input.turnId;
    const receipt: ManagedRuntimeReceipt = { requestId: input.requestId, operation: input.operation, jobId: input.jobId, state: "submitted", ...(sessionId ? { sessionId } : {}), ...(input.operation === "create" ? { sessionId: createHash("sha256").update(JSON.stringify([this.identity.hostId, input.requestId])).digest("hex") } : {}), ...(turnId ? { turnId } : {}) };
    const record: CommandRecord = { digest, operation: input.operation, receipt };
    const prior = await this.changeJournal<CommandRecord | undefined>(function prepare(journal) {
      const saved = Object.hasOwn(journal.records, input.requestId) ? journal.records[input.requestId] : undefined;
      if (saved) return { value: saved };
      Object.defineProperty(journal.records, input.requestId, { value: record, enumerable: true, configurable: true, writable: true });
      return { value: undefined, write: true };
    });
    if (prior) {
      if (prior.digest !== digest) throw new Error("MANAGED_REQUEST_CONFLICT");
      return { ...prior.receipt, operation: prior.operation, jobId: prior.jobId ?? prior.receipt.jobId, ...(prior.receipt.state === "submitted" ? { state: "unconfirmed" } : {}) };
    }
    const service = this;
    /** 只保存本次已登记的请求，不写回旧日志快照。 */
    function saveReceipt() { return service.changeJournal(function save(journal) { journal.records[input.requestId] = record; return { value: undefined, write: true }; }); }
    try {
      if (input.previousTurnId !== undefined) {
        const previous = await this.runtime.turns.getExecutionState({ sessionId: sessionId! });
        const active = this.active.get(sessionId!);
        const canWake = (previous?.turnId ?? null) === input.previousTurnId && !previous?.waiting && !await this.runtime.jobs.hasActiveJobs(sessionId!)
          && (input.operation === "start"
            ? !active && (!previous || previous.execution === "inactive" && !!previous.result) && (!input.queued || previous?.result === "completed")
            : !!active && !active.stopping && active.turnId === turnId && previous?.execution === "active");
        if (!canWake) {
          receipt.state = "rejected"; receipt.code = "MANAGED_WAKE_BLOCKED";
          await saveReceipt(); return receipt;
        }
      }
      if (input.operation === "create") {
        const session = await this.runtime.sessions.create({ defaultRunConfig: { permissionMode: input.permissionMode ?? "ask" }, managedExecution: { hostId: this.identity.hostId, requestId: input.requestId, threadPolicy: "disabled" } });
        receipt.sessionId = session.id; receipt.state = "confirmed";
      } else if (input.operation === "start" || input.operation === "resume") {
        receipt.phase = "read_turn";
        await saveReceipt();
        const resumeSnapshot = input.operation === "resume" ? await this.requireTurn(sessionId!, turnId) : undefined;
        if (this.active.has(sessionId!)) throw new Error("MANAGED_SESSION_BUSY");
        if (input.operation === "start" && !input.content?.trim()) throw new Error("MANAGED_INPUT_REQUIRED");
        const approvalId = resumeSnapshot?.execution?.interaction?.approvalId;
        const questionId = resumeSnapshot?.execution?.interaction?.requestId;
        if (input.retryOf) {
          if (source !== "human") throw new Error("MANAGED_HUMAN_REQUIRED");
          const previous = (await this.readJournal()).records[input.retryOf];
          if (!previous || previous.receipt.sessionId !== sessionId || previous.receipt.turnId !== turnId || !await this.canRetryResume(previous, input.approvalId, 1)) throw new Error("MANAGED_RESUME_RETRY_UNAVAILABLE");
        }
        receipt.phase = "read_decision";
        if (resumeSnapshot?.execution) record.resumeBasis = { lastSeq: resumeSnapshot.execution.lastSeq, approvalId, questionId };
        await saveReceipt();
        const decision = approvalId ? await this.runtime.approvals.getDecision({ sessionId: sessionId!, turnId: turnId!, approvalId }) : null;
        // 图形交互续接只消费原审批或原回答，手动恢复继续由 Core 核查当前状态。
        if (input.operation === "resume" && input.approvalId && (approvalId !== input.approvalId || !decision || await this.runtime.jobs.hasActiveJobs(sessionId!))) throw new Error("MANAGED_APPROVAL_RESUME_UNAVAILABLE");
        if (input.operation === "resume" && input.questionId && (questionId !== input.questionId || resumeSnapshot?.execution?.interaction?.state !== "decided" || await this.runtime.jobs.hasActiveJobs(sessionId!))) throw new Error("MANAGED_QUESTION_RESUME_UNAVAILABLE");
        const stream = input.operation === "start" ? this.runtime.turns.start({ sessionId: sessionId!, turnId, content: input.content, activeSkills: input.activeSkills, ...(input.queued ? { continuity: { source: "claimed_queue" as const } } : {}), messages: input.attachments?.length ? [{ role: "user", content: [{ type: "text", text: input.content! }, ...input.attachments.map(function image(image) { return { type: "image-ref" as const, id: image.id, sha256: image.sha256, width: image.width, height: image.height }; })] }] : undefined }) : this.runtime.turns.continue({ sessionId: sessionId!, turnId: turnId!, ...(questionId ? { requestId: questionId } : {}), ...(decision && approvalId ? { approval: { approvalId, decision: decision.decision === "deny" ? "deny" as const : "allow" as const } } : {}) });
        const service = this;
        // 收到首个真实事件后才称为 started；执行结果始终通过 Core 查询，不由回调写成功。
        const iterator = stream[Symbol.asyncIterator]();
        receipt.phase = "await_first_event";
        await saveReceipt();
        const first = await iterator.next();
        if (first.done) throw new Error("MANAGED_START_UNCONFIRMED");
        receipt.state = "started";
        receipt.phase = "started";
        this.active.set(sessionId!, { turnId: turnId! });
        const running = (async function drive() { try { while (!(await iterator.next()).done) {} } finally { service.active.delete(sessionId!); } })();
        void running.catch(function executionFailed() { /* Core 持久终态或查询中的未知保留事实。 */ });
      } else if (input.operation === "steer" || input.operation === "queue") {
        await this.requireTurn(sessionId!, turnId);
        if (!input.content?.trim()) throw new Error("MANAGED_INPUT_REQUIRED");
        const posted = await this.runtime.turns.steer({ sessionId: sessionId!, turnId: turnId!, content: input.content!, delivery: input.operation, attachments: input.attachments, selectedSkills: input.selectedSkills, clientMessageId: input.requestId });
        receipt.inputId = posted.inputId; receipt.state = "accepted";
      } else if (input.operation === "cancel") {
        if (priority) {
          let delivered = false;
          if (priority.turnId === turnId && this.active.get(sessionId!) === priority) {
            priority.stopping = true;
            delivered = await this.runtime.turns.cancelLocalExecution?.({ sessionId: sessionId!, turnId: turnId! }) === true;
          }
          receipt.state = "unconfirmed";
          if (!delivered) receipt.code = "MANAGED_TURN_MISMATCH";
        } else {
          const before = await this.requireTurn(sessionId!, turnId);
          if (!canCancelTurn(before.execution) && before.execution?.execution !== "inactive") throw new Error("MANAGED_CANCEL_UNAVAILABLE");
          if (before.execution?.waiting || before.execution?.result === "interrupted") await this.runtime.turns.cancel({ sessionId: sessionId!, turnId: turnId! });
          const execution = await this.runtime.turns.getExecutionState({ sessionId: sessionId!, turnId });
          receipt.state = execution && execution.turnId === turnId && execution.execution === "inactive" && !!execution.result && !execution.waiting ? "confirmed" : "unconfirmed";
        }
      } else if (input.operation === "approval") {
        await this.requireTurn(sessionId!, turnId);
        if (!input.approvalId || !isManagedApprovalDecision(input.decision)) throw new Error("MANAGED_INVALID_MESSAGE");
        await this.runtime.approvals.submit({ sessionId: sessionId!, turnId: turnId!, approvalId: input.approvalId, decision: input.decision! });
        receipt.state = "confirmed";
      } else if (input.operation === "answer") {
        await this.requireTurn(sessionId!, turnId);
        if (!input.questionId || !Array.isArray(input.answers)) throw new Error("MANAGED_INVALID_MESSAGE");
        await this.runtime.questions.submit({ sessionId: sessionId!, turnId: turnId!, requestId: input.questionId, answers: input.answers });
        receipt.state = "confirmed";
      } else if (input.operation === "cancel_input") {
        const item = (await this.runtime.inbox.list({ sessionId: sessionId! })).find(function target(item) { return item.inputId === input.inputId; });
        if (!item) throw new Error("MANAGED_SCOPE_DENIED");
        receipt.state = await this.runtime.inbox.cancel(item.inputId) ? "confirmed" : "unconfirmed";
      } else if (input.operation === "stop_job") {
        await this.requireTurn(sessionId!, turnId);
        const job = input.jobId ? await this.runtime.jobs.get(input.jobId) : null;
        if (!job || job.sessionId !== sessionId || job.turnId !== turnId) throw new Error("MANAGED_SCOPE_DENIED");
        record.jobId = job.id;
        await saveReceipt();
        const stopped = await this.runtime.jobs.forSession({ workspaceId: this.workspaceRoot, sessionId: sessionId! }).stop({ jobId: job.id, source: "host" });
        receipt.state = stopped.controlState === "terminal" ? "confirmed" : "unconfirmed";
      }
    } catch (error) {
      receipt.state = "unconfirmed";
      const code = (error as { code?: string }).code ?? (error instanceof Error ? error.message : "");
      receipt.code = /^[A-Z][A-Z_]{1,80}$/.test(code) ? code : "MANAGED_OPERATION_FAILED";
      receipt.diagnostic = managedStorageDiagnostic(error);
    }
    await saveReceipt();
    return receipt;
  }
}
