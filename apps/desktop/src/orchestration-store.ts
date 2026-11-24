/** Desktop 编排关系账本：只保存宿主业务关系和引用，不复制 Core transcript。 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { withNodeRuntimeOwner } from "@autopilot-agent/adapters";
import { readManagedRecord, writeManagedRecord } from "./managed-runtime-store";
import type { ManagedRuntimeReceipt } from "./managed-runtime-service";

export interface OrchestrationPromptAttachments { selectedSkills?: Array<{ skillRef: string; skillId: string; contentHash: string; pinned: boolean }>; attachments?: import("@autopilot-agent/core").SessionImageRef[]; activeSkills?: Array<{ skillId: string; contentHash: string }>; flow?: import("../../cli/src/orchestration-templates").OrchestrationFlow }
export type OrchestrationTerminalFileMentions = readonly import("@autopilot-agent/cli/dist/file-mention-budget.js").FileMentionReference[];
export interface OrchestrationQueuedPrompt { inputId: string; afterTurnId: string; activated?: boolean }
export interface ExecutorInput {
  requestId: string; promptVersion: number; revision: number; source: ExecutionReference; digest?: string;
  state: "offered" | "local" | "escalated" | "clarifying" | "allowed" | "denied" | "reported";
  impact?: string; result?: string; decision?: string;
  question?: { sessionId: string; turnId: string; generation: string; sequence: number; requestId?: string; answered?: true };
  delivery?: ExecutorInputDelivery; returnDelivery?: ExecutorInputDelivery;
}
export interface ExecutorInputDelivery { requestId: string; operation: "start" | "steer"; turnId: string; previousTurnId?: string; receipt?: ManagedRuntimeReceipt }
export interface BusinessHandoff {
  requestId: string; fromAssignmentId?: string; assignmentId: string; revision: number;
  goal: string; background: string; artifacts: { artifact: string; contentVersion: string }[];
  unresolved: string[]; scope: string;
  received?: { sessionId: string; turnId: string; at: string };
}
export interface OrchestrationFinish {
  stop?: true; controllerStops?: import("./managed-runtime-service").ManagedRuntimeReceipt[];
  requestId: string; text: string; source: ExecutionReference; assignmentId?: string; stepId?: string; revision: number; at: string;
  targets: { assignmentId: string; noticeId: string }[];
  receipt?: { at: string; results: { assignmentId: string; resultId?: string; accepted: boolean; released: boolean; unresolved: string[] }[] };
}

export interface OrchestrationPolicy {
  settingsVersion: string; permissionVersion: string;
  permissionMode?: import("./workspace").ApPermissionMode;
  responsibility: "local" | "controller";
  maxConcurrent: number; repairLimit: number; automaticDispatch: boolean;
  versions: { app: string; core: string; protocol: string; schema: string };
}
export interface ExecutionReference { hostId: string; sessionId: string; requestId: string; owner: string; generation: string; turnId?: string }
export interface LocalWorkflow {
  source: "agent" | "unknown"; phase: string; obligations: string[]; handoff: boolean;
  skills: { name: string; source: string; version?: string; repairLimit?: number; requiresAgents?: boolean }[];
  requiredSkills: string[]; cooperation: string[];
}
export interface EvidenceReference { id: string; artifact: string; contentVersion: string; method: string; result: string; source: "agent" | "human" }
export interface AssignmentResult { id: string; revision: number; promptVersion?: number; turnId?: string; summary: string; outcome: "delivered" | "partial" | "failed" | "blocked" | "cancelled"; checks: string[]; unresolved: string[]; evidence: EvidenceReference[]; verificationPending?: true; browserObservations?: EvidenceReference[] }
/** 复核派工冻结当前实现报告，后续报告不能用另一文件或版本补票。 */
export interface VerificationHandoff { assignmentId: string; resultId: string; evidence: EvidenceReference[]; browser?: boolean }
export interface OrchestrationAssignment {
  id: string; stepId: string; revision: number; planVersion: number; promptVersion: number;
  execution?: ExecutionReference; createRequestId: string; startRequestId: string;
  previousId?: string; purpose: "initial" | "repair" | "reassign"; content: string;
  checkout: string; access: "write" | "read"; local: LocalWorkflow;
  native?: { turnId: string; sequence: number; eventType: string; source: "core" };
  results: AssignmentResult[]; state: "planned" | "submitted" | "active" | "released" | "cancelled";
  takeover: boolean; receipt?: ManagedRuntimeReceipt;
  submission?: "create" | "start"; unsent?: "create" | "start";
  /** 创建回执已核对；启动回执未知时仍可定位原 Session。 */
  sessionConfirmed?: true;
  directInputs?: ExecutorInput[];
  controls?: { requestId: string; operation: string; digest: string; receipt: ManagedRuntimeReceipt }[];
  previousExecutions?: ExecutionReference[];
  checkoutYielded?: boolean;
  completedReleaseTurnId?: string;
  /** 原尝试确认停止并以失败报告退出，未产生可供验收的交付。 */
  retiredForRepair?: { turnId: string; resultId: string };
  /** 关闭视图的进度只写审计回执，与业务交付分开。 */
  viewCloseReports?: { requestId: string; execution: ExecutionReference; requestedAt: string; receipt?: ManagedRuntimeReceipt; report?: { progress: string; completed: string[]; remaining: string[]; conclusion: string; savedAt: string } }[];
  verification?: VerificationHandoff;
}

/** 旧账本通过原生回执或已经活动过的状态证明会话已创建。 */
export function confirmedAssignmentSession(item: OrchestrationAssignment): string | undefined {
  const sessionId = item.execution?.sessionId;
  return sessionId && (item.sessionConfirmed || item.state === "active" || item.state === "released" || item.receipt?.sessionId === sessionId && ["confirmed", "started"].includes(item.receipt.state)) ? sessionId : undefined;
}
export interface OrchestrationStep {
  id: string; revision: number; goal: string; scope: string; dependencies: string[];
  deliverables: string[]; acceptance: string[]; currentAssignmentId?: string;
  verifies?: { stepId: string; browser?: boolean };
  repairs: number; skillRepairLimit?: number;
  verdict?: { resultId: string; assignmentId: string; evidenceIds: string[]; accepted: boolean; verificationAssignmentId?: string };
}
export interface OrchestrationRun {
  approvalContinuations?: import("./orchestration-contract").ApprovalContinuation[];
  id: string; workspaceId: string; hostId: string; checkout: string; goal: string;
  revision: number; planVersion: number; policy: OrchestrationPolicy;
  controller: { createRequestId: string; execution?: ExecutionReference; threadPolicy: "disabled"; executor: "ap"; receipt?: ManagedRuntimeReceipt; control?: { requestId: string; operation: string; sessionId: string; turnId?: string; jobId?: string }; cancelReceipt?: ManagedRuntimeReceipt };
  prompts: (OrchestrationPromptAttachments & { version: number; text: string; scope: "run" | "step" | "assignment"; targetId: string; at: string; independentVerification?: boolean; terminalInput?: boolean; queue?: OrchestrationQueuedPrompt; fileMentions?: OrchestrationTerminalFileMentions; executorSource?: { sessionId: string; assignmentId: string; requestId: string } })[];
  steps: OrchestrationStep[]; assignments: OrchestrationAssignment[];
  paused: boolean; acceptance: "pending" | "accepted";
  records: { requestId: string; digest: string; action: string; at: string; promptVersion?: number; text?: string; batchTarget?: { planVersion: number; digest: string };
    viewClose?: { revision: number; targets: { id: string; sessionId: string; turnId?: string; status: string; result?: string }[] } }[];
  batches?: { planVersion: number; assignmentIds: string[]; digest: string; state: "pending" | "approved" | "cancelled"; decidedByHuman?: boolean; sealRequestId?: string; dispatch?: { intentId: string; digest: string; next: number } }[];
  pending?: OrchestrationIntent[];
  handoffs?: BusinessHandoff[];
  finishes?: OrchestrationFinish[];
  checkoutFingerprint?: string;
  controlOnly?: boolean;
  navigationRemoved?: boolean;
  recoveryDialogue?: import("./recovery-dialogue").RecoveryDialogueState;
}
/** H3 意图只引用已落盘事实；投递与语义决定分别记账。 */
export interface OrchestrationIntent {
  id: string; kind: "prompt" | "result" | "host"; source: "human" | "agent" | "host";
  assignmentId?: string; resultId?: string; basis: string; promptVersion: number; policyVersion: string;
  state: "pending" | "decided" | "stale"; at: string;
  wake?: { requestId: string; operation: "start" | "steer"; turnId?: string; generation?: string; receipt?: ManagedRuntimeReceipt; directResponse?: boolean; revision?: number; orchestrationUsed?: boolean };
  attention?: "wake_unconfirmed" | "input_unconsumed" | "decision_missing" | "controller_waiting" | "controller_offline" | "controller_failed" | "controller_interrupted" | "controller_limited" | "input_waiting_recovery" | "input_too_large";
  manualContinue?: { sessionId: string; generation: string; turnId: string };
  correction?: { revision: number; originalWake?: OrchestrationIntent["wake"] };
  decisionHistory?: (NonNullable<OrchestrationIntent["decision"]> & { supersededAt: string })[];
  decision?: { version?: number; digest: string; reason: string; actions: import("./orchestration-decisions").DecisionAction[]; next: number; waitingBatch?: { planVersion: number; digest: string; next: number }; expectedRevision: number; state: "saved" | "done" | "stale" | "blocked"; error?: string };
  detail?: string;
  /** 原计划、精确释放交付和待推进阶段的稳定身份，旧账本可缺省。 */
  continuation?: { planVersion: number; key: string };
}
export interface CheckoutLease { checkout: string; runId: string; assignmentId: string; access: "read" | "write"; controllerExecution?: ExecutionReference; controllerAcquisitionId?: string }
export interface OrchestrationLedger { schema: 1; runs: OrchestrationRun[]; leases?: CheckoutLease[]; currentRunIds?: Record<string, string> }

/** 兼容旧账本的审计记录，只恢复回执自身已保存的操作目标。 */
export function controllerControl(run: OrchestrationRun): OrchestrationRun["controller"]["control"] {
  if (run.controller.control) return run.controller.control;
  const receipt = run.controller.receipt;
  const record = run.records.find(function original(r) { return r.requestId === receipt?.requestId && r.action.startsWith("human_controller_"); });
  return run.controller.execution && receipt && record ? { requestId: receipt.requestId, operation: record.action.slice("human_controller_".length), sessionId: run.controller.execution.sessionId, turnId: receipt.turnId, jobId: receipt.jobId } : undefined;
}

/** 回执必须匹配原请求和目标；不一致时保留原身份待确认。 */
export function controllerReceipt(control: OrchestrationRun["controller"]["control"], receipt?: ManagedRuntimeReceipt): ManagedRuntimeReceipt | undefined {
  if (!receipt) return undefined;
  if (control && receipt.requestId === control.requestId && receipt.sessionId === control.sessionId && receipt.turnId === control.turnId && receipt.operation === control.operation && receipt.jobId === control.jobId && (control.operation !== "stop_job" || !!control.jobId) && (!receipt.execution || receipt.execution.turnId === control.turnId)) return receipt;
  return { requestId: control?.requestId ?? receipt.requestId, sessionId: control?.sessionId, turnId: control?.turnId, operation: control?.operation as ManagedRuntimeReceipt["operation"], jobId: control?.jobId, state: "unconfirmed" };
}

/** 向当前主控会话投影最近一次精确 Turn 停止，旧账本兼容原最新操作槽。 */
export function controllerCancelReceipt(run: OrchestrationRun) {
  const receipt = run.controller.cancelReceipt ?? controllerReceipt(controllerControl(run), run.controller.receipt);
  if (receipt?.operation !== "cancel" || !receipt.turnId || !receipt.sessionId || receipt.sessionId !== run.controller.execution?.sessionId) return undefined;
  return { ...receipt, operation: receipt.operation, sessionId: receipt.sessionId, turnId: receipt.turnId };
}

/** 其他控制成为最新操作前保留原 Turn 停止，避免丢失独立对账目标。 */
export function saveControllerOperation(run: OrchestrationRun, control: NonNullable<OrchestrationRun["controller"]["control"]>, receipt: ManagedRuntimeReceipt): void {
  if (control.operation === "cancel" && control.turnId) run.controller.cancelReceipt = receipt;
  else run.controller.cancelReceipt ??= controllerCancelReceipt(run);
  run.controller.control = control;
  run.controller.receipt = receipt;
}

/** 多服务实例共用磁盘锁，每次从磁盘读取，写失败不替换旧状态。 */
export class OrchestrationStore {
  private removed = new Set<string>();
  readonly path: string;
  constructor(private root: string, private persist = writeManagedRecord) { this.path = join(root, "orchestration.json"); }

  /** 删除入口独立于运行账本；首次创建的迟到请求也需核对。 */
  navigationRemoved(id: string): boolean { return this.removed.has(id); }

  /** 导航删除独立落盘，避免被持有关系事务的在途业务命令拖住。组 ID 不复用。 */
  async removeNavigation(id: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("DESKTOP_WORKSPACE_INVALID");
    await mkdir(join(this.root, "removed-workspaces", id), { recursive: true });
    this.removed.add(id);
  }

  /** 启动时先恢复已提交的删除，覆盖布局和关系账本尚未同步的退出窗口。 */
  async restoreRemovedNavigation(): Promise<ReadonlySet<string>> {
    try {
      for (const entry of await readdir(join(this.root, "removed-workspaces"), { withFileTypes: true })) {
        if (entry.isDirectory()) this.removed.add(entry.name);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return this.removed;
  }

  /** 读和写入前都套用已提交的删除；迟到的业务事务也不能复活原占用。 */
  private applyRemovedNavigation(ledger: OrchestrationLedger): void {
    if (!this.removed.size) return;
    const ids = new Set<string>();
    for (const run of ledger.runs) if (this.removed.has(run.workspaceId)) {
      run.navigationRemoved = true; run.paused = true; run.controlOnly = true;
      ids.add(run.id);
    }
    if (ledger.leases) ledger.leases = ledger.leases.filter(function keep(lease) { return !ids.has(lease.runId); });
  }

  /** 新账本为兼容新增；未知版本或坏数据停止，不清空历史。 */
  async read(): Promise<OrchestrationLedger> {
    const ledger = await readManagedRecord<OrchestrationLedger>(this.path, { schema: 1, runs: [] });
    if (ledger.schema !== 1 || !Array.isArray(ledger.runs)) throw new Error("ORCHESTRATION_STORE_INVALID");
    this.applyRemovedNavigation(ledger);
    return ledger;
  }

  /** 宿主事务只处理关系，回调失败不写入；锁内不得启动长时间模型循环。 */
  async update<T>(operation: (ledger: OrchestrationLedger) => T | Promise<T>): Promise<T> {
    const store = this;
    return withNodeRuntimeOwner(this.root, async function transaction() {
      const ledger = await store.read();
      const result = await operation(ledger);
      store.applyRemovedNavigation(ledger);
      await store.persist(store.path, ledger);
      return structuredClone(result);
    });
  }
}
