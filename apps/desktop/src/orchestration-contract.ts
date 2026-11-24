/** 编排页面只消费宿主安全投影，身份和运行配置由 main 保管。 */
export const ORCHESTRATION_CHANNEL = "desktop:orchestration";
export const ORCHESTRATION_CHANGED = "desktop:orchestration-changed";
export const managedApprovalDecisions = ["allow_once", "allow_session", "allow_workspace", "deny"] as const;
export type ManagedApprovalDecision = typeof managedApprovalDecisions[number];
/** 宿主只传递 Core 已有的四种人类决定，具体请求集合仍由 Core 校验。 */
export function isManagedApprovalDecision(value: unknown): value is ManagedApprovalDecision { return typeof value === "string" && (managedApprovalDecisions as readonly string[]).includes(value); }
export interface ApprovalContinuation {
  id: string; assignmentId?: string; sessionId: string; turnId: string; approvalId: string; decision?: ManagedApprovalDecision;
  origin?: { hostId: string; owner: string; generation: string };
  reconciliation?: { checks: number; reason?: string; retried?: true; stopped?: string };
  requestId: string; approval: import("./managed-runtime-service").ManagedRuntimeReceipt;
  resume?: import("./managed-runtime-service").ManagedRuntimeReceipt; attempt?: number; autoResume?: true; ready?: boolean; pauseSeq?: number; dispatchPauseId?: string;
}
/** 主控仅能要求重新核实确定的预检或首事件前存储失败；实际继续仍需 Worker 当前证明。 */
export function canCoordinateApproval(item: ApprovalContinuation): boolean {
  return !!item.origin && !!item.reconciliation?.stopped && item.approval.state === "confirmed" && !item.approval.code &&
    (item.resume?.phase === "check_resume" || item.resume?.code === "STATE_STORAGE_UNAVAILABLE" && item.resume.phase !== "started");
}
export interface OrchestrationPreferences { responsibility: "local" | "controller"; repairLimit: number; automaticDispatch: boolean; executorLayout?: "tab" | "split" }
export interface OrchestrationInspection {
  canCancel?: boolean; lastSeq?: number; turnId?: string; status: string; execution: string; activeJobs: boolean; recoverable: boolean; checkpoint: boolean; threadPolicy: "disabled";
  interaction?: { state: string; question?: { requestId: string; questions: { id: string; header: string; question: string; options: { label: string; description: string }[] }[] }; approval?: { approvalId: string; toolName: string; reason: string; constraint?: string; allowedDecisions?: ManagedApprovalDecision[]; decision?: ManagedApprovalDecision; display?: { operation?: string; resource?: string; risk?: string; hostExecution?: boolean; actionPreview?: string; allowedDecisions?: string[] } } };
  jobs: { jobId: string; status: string; canStop: boolean; controlState: string }[];
}
export interface OrchestrationRunView {
  id: string; workspaceId: string; revision: number; goal: string; controllerId?: string;
  connected: boolean; paused: boolean; accepted: boolean; needsRecovery: boolean; current: boolean;
  controllerCanCancel?: boolean; waitingForGoal?: boolean; controllerStatus: string; controllerExecution?: string; controllerJobs?: "active" | "inactive" | "unknown"; checkoutLabel: string;
  interactions?: { key: string; assignmentId?: string; sessionId: string; turnId: string; requestId: string; kind: "approval" | "question"; state: "pending" | "unconfirmed" }[];
  handoffs?: { requestId: string; assignmentId: string; fromAssignmentId?: string; scope: string; received: boolean }[];
  finishes?: { requestId: string; text: string; assignmentId?: string; stepId?: string; stop?: true; completed: boolean; controllerStops?: { requestId: string; operation?: string; state: string; code?: string }[]; targets: { assignmentId: string; state: string; report?: string; checks: string[]; unresolved: string[]; notice?: string; accepted: boolean }[] }[];
  steps: { id: string; goal: string; dependencies: string[]; deliverables: string[]; accepted: boolean; repairs: number }[];
  assignments: { id: string; stepId: string; content: string; state: string; native: string; source: string; sessionId?: string; terminalSessionId?: string; executionToken?: string;
    canCancel?: boolean; local: { phase: string; source: string; handoff: boolean; obligations: string[]; skills: string[]; cooperation: string[] };
    results: { id: string; summary: string; outcome: string; checks: string[]; unresolved: string[]; evidence: { id: string; artifact: string; contentVersion: string; method: string; result: string; source: string }[] }[];
    controls: { requestId: string; operation: string; state: string; code?: string }[]; pendingResume?: boolean; takeover: boolean; occupied: boolean;
    directInputs?: { requestId: string; text: string; state: string; impact?: string; result?: string; decision?: string; delivery?: string; questionId?: string }[];
    activity: { id: string; type: string; source: string; at: string }[]; inspection?: OrchestrationInspection }[];
  pending: { id: string; assignmentId?: string; source: string; reason: string }[];
  batches: { planVersion: number; digest: string; state: string; assignmentIds: string[]; maxConcurrent: number; reason?: string; tasks: { id: string; content: string; stepId: string; stepGoal: string; scope: string; purpose: "initial" | "repair" | "reassign"; checkout: string; access: "read" | "write"; dependencies: string[]; deliverables: string[] }[] }[];
  controllerReceipt?: { state: string; code?: string; requestId?: string; operation?: string; sessionId?: string; turnId?: string; jobId?: string }; controllerToken?: string; controllerInspection?: OrchestrationInspection;
  controllerCancelReceipt?: OrchestrationRunView["controllerReceipt"];
  approvalContinuations?: ApprovalContinuation[];
  recoverySummary?: string; recovery?: { token: string; ready: boolean; changed: boolean; checks: string[] };
  lastViewClose?: { at: string; revision: number };
}
export interface OrchestrationView { runs: OrchestrationRunView[]; modes: Record<string, "parallel" | "orchestration">; preferences: OrchestrationPreferences }
export type OrchestrationUiCommand = (
  | { type: "approvalRecovery"; workspaceId: string; id: string; action: "query" | "resume" }
  | { type: "newTask"; workspaceId: string }
  | { type: "selectRun"; workspaceId: string; runId: string }
  | { type: "preferences"; value: OrchestrationPreferences }
  | { type: "checkRecovery"; workspaceId: string }
  | { type: "reconnect"; workspaceId: string; token: string; acceptCheckout: boolean }
  | { type: "controller"; workspaceId: string; executionToken: string; requestId: string; operation: "inspect" | "query" | "cancel" | "resume" | "approval" | "answer" | "stop_job"; approvalId?: string; decision?: ManagedApprovalDecision; continueAfterApproval?: true; continueAfterAnswer?: true; questionId?: string; answers?: { id: string; selected: string[]; custom?: string }[]; jobId?: string }
  | { type: "mode"; workspaceId: string; mode: "parallel" | "orchestration" }
  | { type: "enter"; workspaceId: string; goal: string; trust: boolean }
  | { type: "batch"; workspaceId: string; revision: number; planVersion: number; digest: string; approve: boolean }
  | { type: "pause"; workspaceId: string; revision: number; paused: boolean }
  | { type: "prompt"; workspaceId: string; revision: number; requestId: string; text: string; scope: "run" | "step" | "assignment"; targetId: string }
  | { type: "inspect" | "takeover" | "cancelPlanned" | "cancelUnstarted" | "abandonStopped" | "query"; workspaceId: string; revision: number; assignmentId: string; executionToken?: string }
  | { type: "control"; workspaceId: string; revision: number; assignmentId: string; executionToken: string; requestId: string; operation: "cancel" | "resume" | "approval" | "answer" | "stop_job"; jobId?: string; approvalId?: string; decision?: ManagedApprovalDecision; continueAfterApproval?: true; continueAfterAnswer?: true; questionId?: string; answers?: { id: string; selected: string[]; custom?: string }[] }) & { runId?: string };
export interface OrchestrationBridge {
  terminal(workspaceId: string, operation: "ensure" | "waitReady" | "read" | "write" | "resize" | "prepareResize" | "closeView", generationOrRunId?: number | string, a?: number | string | string[], b?: number, location?: string): Promise<unknown>;
  snapshot(reconcile?: boolean, sessionIds?: string[]): Promise<OrchestrationView>;
  onChanged(listener: (sessionId?: string) => void): () => void;
  command(command: OrchestrationUiCommand): Promise<void>;
}

/** Core 活动及可取消等待可停止；未知和普通终态不可取消。 */
export function canCancelTurn(view?: { turnId?: string; execution?: string; status?: string } | null): boolean {
  return !!view?.turnId && (view.execution === "active" || view.execution === "inactive" && ["waiting_approval", "waiting_user_input", "interrupted"].includes(view.status ?? ""));
}
