/**
 * CLI AgentEvent 安全投影器。
 *
 * 它在宿主边界补充本地 seq，并把 Core 事件归约为不包含 checkpoint、冻结
 * 工具输入、raw reasoning 或绝对受控路径的公开 ViewModel。
 */

import { sanitizeAgentTerminationView, type AgentEvent, type PublicCheckpointView, type RecoverableTurnView } from "@autopilot-agent/core";
import { createPresentationState, getPresentationCopy, getToolPresentationProfile, reducePresentationInput } from "@autopilot-agent/presentation";
import type { CliEventEnvelope, CliProjection, CliPublicEvent, CliTurnStatus } from "./types.js";

/** 创建空的 CLI 投影状态。 */
export function createInitialCliProjection(): CliProjection {
  return {
    status: "idle",
    recoverable: false,
    answer: "",
    activeSkills: [],
    events: [],
    presentation: createPresentationState(),
    seenKeys: new Set<string>(),
  };
}

/** 将内部 checkpoint 状态映射为 CLI 可见的生命周期状态。 */
function mapCheckpointStatus(status: PublicCheckpointView["status"]): Exclude<CliTurnStatus, "idle"> {
  if (status === "awaiting_approval") return "waiting_approval";
  if (status === "awaiting_user_input") return "waiting_user_input";
  if (status === "interrupted_recoverable") return "interrupted_recoverable";
  if (status === "interrupted") return "interrupted";
  if (status === "limit_reached") return "limit_reached";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "running";
}

/** 对 CLI 可见的文本做长度、路径和常见凭据字段脱敏。 */
function sanitizeText(value: unknown, maxLength = 4_000): string {
  const text = String(value ?? "").slice(0, maxLength);
  return text
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|tmp|var|mnt|workspace|Volumes)\/)[^\s"'`]+/gu, "[path]")
    .replace(/\b(api[_-]?key|access[_-]?token|password|secret|dsn)\s*[:=]\s*[^\s,;]+/giu, function redactSensitiveField(_match: string, key: string): string {
      return `${key}=[redacted]`;
    });
}

/** 只保留模型/工具边界允许公开的稳定错误码。 */
function safeErrorCode(value: unknown): string | undefined {
  const text = String(value ?? "");
  const knownCodes = [
    "MODEL_OUTPUT_LIMIT",
    "EMPTY_RESPONSE",
    "STREAM_INCOMPLETE",
    "TOOL_CALL_INVALID_JSON",
    "TOOL_CALL_TRUNCATED",
    "PROVIDER_UNAUTHORIZED",
    "MODEL_NOT_FOUND",
    "RUNTIME_ERROR",
    "COMMAND_FAILED",
    "TOOL_TIMEOUT",
  ];
  return knownCodes.find(function findKnownCode(code: string): boolean { return text.includes(code); });
}

/** 仅透传 Core 固定的安全终态原因，避免暴露 Provider 原文、路径或凭据。 */
function safeTurnFailureReason(value: unknown): string | undefined {
  const text = String(value ?? "");
  const safeReasons = [
    "修改任务未完成写后验证，不能标记为完成",
    "修改任务未完成真实写入，不能标记为完成",
    "模型连续返回空响应，未执行工具或产生可显示答复",
    "供应商连接持续失败，已停止自动恢复",
    "供应商请求持续超时，已停止自动恢复",
    "供应商请求持续被限流，已停止自动恢复",
    "供应商服务持续不可用，已停止自动恢复",
    "供应商流式响应持续中断，已停止自动恢复",
    "模型返回非法工具参数 JSON，格式修复后仍失败",
    "模型输出连续截断，已达到最大恢复次数",
    "上下文溢出后已完成一次压缩重试，compact 熔断器已阻止重复请求",
    "reactive compact 失败，已熔断以避免重复请求",
    "Agent Loop 执行失败",
  ];
  return safeReasons.find(function matchSafeReason(reason: string): boolean { return text === reason; });
}

/** 复制投影状态，确保 reducer 不修改调用方持有的旧快照。 */
function cloneProjection(previous: CliProjection, envelope: CliEventEnvelope): CliProjection {
  const seenKeys = new Set(previous.seenKeys);
  seenKeys.add(`${envelope.turnId}:${envelope.seq}`);
  return {
    ...previous,
    turnId: envelope.turnId,
    lastSeq: Math.max(previous.lastSeq ?? 0, envelope.seq),
    activeSkills: previous.activeSkills,
    events: [...previous.events],
    seenKeys,
  };
}

/** 比较两份 activeSkills 身份，避免 checkpoint 事件重复渲染技能记录。 */
function sameSkills(first: Array<{ skillId: string; contentHash: string }>, second: Array<{ skillId: string; contentHash: string }>): boolean {
  return first.length === second.length && first.every(function matchSkill(skill, index): boolean {
    const other = second[index];
    return other?.skillId === skill.skillId && other.contentHash === skill.contentHash;
  });
}

/** 从 checkpoint 提取只包含 Skill 身份的安全投影。 */
function applyCheckpoint(projection: CliProjection, checkpoint: Pick<PublicCheckpointView, "status" | "activeSkills">, seq: number, turnId: string): void {
  projection.status = mapCheckpointStatus(checkpoint.status);
  if (checkpoint.status !== "awaiting_approval") projection.pendingApproval = undefined;
  const activeSkills = (checkpoint.activeSkills ?? []).map(function copySkill(skill) {
    return { skillId: skill.skillId, contentHash: skill.contentHash };
  });
  if (sameSkills(projection.activeSkills, activeSkills)) return;
  projection.activeSkills = activeSkills;
  appendEvent(projection, { type: "active_skills", seq, turnId, skills: activeSkills });
}

/** 将安全事件追加到投影事件列表。 */
function appendEvent(projection: CliProjection, event: CliPublicEvent): void {
  projection.events.push(event);
}

/** 将一个 Core AgentEvent 归约为兼容 Plain/JSONL 的安全 CLI 公开事件。 */
function projectEvent(envelope: CliEventEnvelope, projection: CliProjection): CliPublicEvent | undefined {
  const event = envelope.event;
  const base = { seq: envelope.seq, turnId: envelope.turnId };
  switch (event.type) {
    case "turn_started":
      projection.status = "running";
      projection.recoverable = false;
      return { ...base, type: "turn_started", stepCount: event.stepCount };
    case "reasoning_summary":
      return { ...base, type: "reasoning_summary", summary: sanitizeText(event.summary) };
    case "reasoning_delta":
      return { ...base, type: "reasoning_hidden" };
    case "answer_delta":
      {
        const delta = sanitizeText(event.delta);
        projection.answer += delta;
        return { ...base, type: "answer_delta", delta };
      }
    case "answer_reset":
    case "answer_discard":
      projection.answer = "";
      return { ...base, type: "answer_reset" };
    case "tool_started":
      {
        const profile = getToolPresentationProfile(event.toolName);
      return {
        ...base,
        type: "tool_started",
        callId: event.callId,
        toolName: sanitizeText(event.toolName, 160),
        summary: getPresentationCopy(profile.runningTitleKey),
      };
      }
    case "tool_progress":
      return { ...base, type: "tool_progress", callId: event.callId, toolName: sanitizeText(event.toolName, 160), tail: sanitizeText(event.tail, 160) };
    case "tool_result":
      {
        const result = event.result;
        const errorCode = "error" in result && result.error ? safeErrorCode(result.error.code) : undefined;
        const profile = getToolPresentationProfile(event.toolName);
        // 展示事实由 Core 在 schema 后生成；不回读旧 event.summary/diff 或 ToolExecutionResult.output。
        const display = result.display;
        const diff = display?.diff?.text;
        return {
          ...base,
          type: "tool_result",
          callId: event.callId,
          toolName: sanitizeText(event.toolName, 160),
          status: result.status,
          summary: display?.summary ?? getPresentationCopy(profile.completedTitleKey),
          errorCode,
          diff,
          display,
        };
      }
    case "approval_required":
      {
      const display = event.result.approval.display;
      const reason = display?.actionPreview ?? display?.operation ?? "需要确认";
      const allowedDecisions = display?.allowedDecisions ?? ["deny"];
      projection.status = "waiting_approval";
      projection.pendingApproval = {
        approvalId: event.result.approval.approvalId,
        callId: event.callId,
        toolName: sanitizeText(event.toolName, 160),
        reason,
        risk: display?.risk,
        constraint: event.result.approval.constraint,
        allowedDecisions,
        display,
      };
      return {
        ...base,
        type: "approval_required",
        approvalId: event.result.approval.approvalId,
        callId: event.callId,
        toolName: sanitizeText(event.toolName, 160),
        reason,
        risk: display?.risk,
        constraint: event.result.approval.constraint,
        allowedDecisions,
        display,
      };
      }
    case "input_queued":
      return { ...base, type: "input_queued", inputId: event.inputId, delivery: event.delivery };
    case "todo_updated":
      // Todo 字段已由 Core schema 限长并拒绝路径/凭据片段；宿主只做事件转发，不解析 raw Tool args。
      return { ...base, type: "todo_updated", todos: event.todos, counts: event.counts };
    case "input_joined":
    case "input_consumed":
      applyCheckpoint(projection, event.checkpoint, envelope.seq, envelope.turnId);
      return { ...base, type: event.type, inputId: event.inputId };
    case "model_recovery":
      return {
        ...base,
        type: "model_recovery",
        reason: safeErrorCode(event.reason) ?? "MODEL_RECOVERY",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      };
    case "context_overflow":
      applyCheckpoint(projection, event.checkpoint, envelope.seq, envelope.turnId);
      return { ...base, type: "context_overflow" };
    case "context_compact_started":
      return { ...base, type: "context_compact_started" };
    case "context_compacted":
      return { ...base, type: "context_compacted", preTokens: event.preTokens, postTokens: event.postTokens };
    case "context_compact_failed":
      return { ...base, type: "context_compact_failed" };
    case "context_compact_circuit_open":
      return { ...base, type: "context_compact_circuit_open" };
    case "context_usage_updated":
      // Core 出口已对 usage 做白名单投影；它只刷新状态栏事实，不进入 transcript 时间线。
      projection.contextUsage = event.usage;
      return { ...base, type: "context_usage", usage: event.usage };
    case "turn_paused":
    case "turn_completed":
    case "turn_interrupted":
    case "turn_failed":
    case "turn_limit_reached":
      applyCheckpoint(projection, event.checkpoint, envelope.seq, envelope.turnId);
      {
        const termination = sanitizeAgentTerminationView(event.termination);
        projection.recoverable = termination?.recoverable === true;
      }
      if (event.type === "turn_failed") {
        const failedStatus = projection.status === "idle" ? "failed" : projection.status;
        const termination = sanitizeAgentTerminationView(event.termination);
        return {
          ...base,
          type: "status",
          status: failedStatus,
          code: safeErrorCode(event.error) ?? "RUNTIME_ERROR",
          reason: termination?.reason ? undefined : safeTurnFailureReason(event.error),
          ...(termination ? { termination } : {}),
        };
      }
      const status = projection.status === "idle" ? "running" : projection.status;
      const termination = sanitizeAgentTerminationView(event.termination);
      return { ...base, type: "status", status, ...(termination ? { termination } : {}) };
  }
}

/** 归约单个本地事件信封；同一 turn/seq 重复信封不会再次产生公开事件。 */
export function reduceCliEvent(previous: CliProjection, envelope: CliEventEnvelope): CliProjection {
  const key = `${envelope.turnId}:${envelope.seq}`;
  if (previous.seenKeys.has(key)) return previous;
  const next = cloneProjection(previous, envelope);
  next.presentation = reducePresentationInput(previous.presentation, {
    kind: "runtime_event",
    envelope: {
      seq: envelope.seq,
      sessionId: envelope.sessionId ?? "cli-local-session",
      turnId: envelope.turnId,
      timestamp: envelope.timestamp,
      event: envelope.event,
    },
  });
  const projected = projectEvent(envelope, next);
  if (projected) appendEvent(next, projected);
  return next;
}

/** 生成本地单调 seq 的事件投影器；continue 阶段沿用同一实例，不重置 seq。 */
export function createCliEventProjector(options: { now?: () => Date; sessionId?: string } = {}): {
  project(event: AgentEvent): { envelope: CliEventEnvelope; projection: CliProjection; added: boolean };
  getProjection(): CliProjection;
  setSessionId(sessionId: string): void;
  restore(view: RecoverableTurnView): CliProjection;
} {
  const now = options.now ?? function currentTime(): Date { return new Date(); };
  const nextSeqByTurn = new Map<string, number>();
  let sessionId = options.sessionId;
  let projection = createInitialCliProjection();

  return {
    project(event: AgentEvent) {
      const currentSeq = nextSeqByTurn.get(event.turnId) ?? 0;
      const envelope: CliEventEnvelope = {
        seq: currentSeq + 1,
        sessionId,
        turnId: event.turnId,
        timestamp: now().toISOString(),
        event,
      };
      nextSeqByTurn.set(event.turnId, envelope.seq);
      const previousLength = projection.events.length;
      projection = reduceCliEvent(projection, envelope);
      return { envelope, projection, added: projection.events.length > previousLength };
    },
    getProjection() {
      return projection;
    },
    setSessionId(nextSessionId: string) {
      sessionId = nextSessionId;
    },
    restore(view: RecoverableTurnView) {
      const restored = createInitialCliProjection();
      restored.turnId = view.turnId;
      restored.lastSeq = view.lastSeq;
      restored.status = view.status === "awaiting_approval"
        ? "waiting_approval"
        : view.status === "awaiting_user_input"
          ? "waiting_user_input"
          : view.status;
      restored.recoverable = view.recoverable;
      if (view.termination) {
        restored.events.push({ type: "status", seq: view.lastSeq ?? 0, turnId: view.turnId, status: restored.status, termination: sanitizeAgentTerminationView(view.termination) });
      }
      restored.activeSkills = view.activeSkills.map(function copySkill(skill) { return { ...skill }; });
      if (view.approval) restored.pendingApproval = { ...view.approval };
      projection = restored;
      nextSeqByTurn.set(view.turnId, view.lastSeq ?? 0);
      return projection;
    },
  };
}
