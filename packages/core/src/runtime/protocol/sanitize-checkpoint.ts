/**
 * runtime/protocol/sanitize-checkpoint.ts — 对外事件持久化的 checkpoint 脱敏
 *
 * AgentCheckpoint.messages 可能携带 Provider 内部 reasoning/replay 续接数据。
 * 该字段只允许出现在内部 checkpointStore 与 kernel 消息链中用于回传 Provider，
 * 绝不能进入 EventSink / TranscriptStore / CLI / JSONL / 日志 / 公开 DTO。
 *
 * 本文件提供纯函数，在 turn-service 持久化事件到 eventSink/transcriptStore 前，
 * 将宿主可见 checkpoint 收窄为生命周期字段与 Skill 身份。
 */

import type { AgentCheckpoint } from "../../internal/agent-runtime";
import { normalizeAgentMessages, type AgentMessage } from "../../internal/types/agent-message";
import { projectPublicContextUsage } from "../../internal/kernel/context-budget";
import { projectPublicTurnUsageSummary } from "../../internal/kernel/turn-usage";
import type { AgentEvent } from "./event-envelope";
import type { AgentLoopEvent } from "../../internal/agent-runtime";
import { sanitizeAgentTerminationView } from "./recoverable-turn-view";
import { isSandboxAvailabilityFailureCode } from "../domain/sandbox-policy";
import { sanitizeAgentProviderFailureDetail, sanitizeAgentProviderFailureReason } from "../provider/provider-failure-guidance";
import { projectUiDocument } from "../../ui/document";
import { TOOL_ERROR_CODES } from "../../internal/tools/tool-error";

/** 将 Web 工具与 open_preview 的调用与结果改成可恢复的安全占位；完整工具消息仍只保留在 Core 私有 checkpoint。 */
export function redactWebCheckpoint(checkpoint: AgentCheckpoint): AgentCheckpoint {
  /** Web 与 Work 预览的原始输入都不进入 durable checkpoint；同进程 restore 缝隙负责回填。 */
  const isRedactedCallName = (name: string): boolean => name === "web_search" || name === "web_fetch" || name === "open_preview";
  const webCallIds = new Set<string>();
  for (const message of checkpoint.messages) {
    for (const block of message.content) {
      if (block.type === "tool-call" && isRedactedCallName(block.name)) webCallIds.add(block.id);
    }
  }
  const hasPendingWeb = checkpoint.pendingCalls?.some(
    /** 判断暂停调用中是否存在尚未执行的受脱敏工具。 */
    function isPendingWebCall(call) { return isRedactedCallName(call.name); },
  ) === true;
  if (webCallIds.size === 0 && !hasPendingWeb) return checkpoint;
  const messages: AgentMessage[] = checkpoint.messages.map(
    /** 对每条 canonical message 只处理属于 Web 工具的内容块。 */
    function redactWebMessage(message) {
      const containsWebCall = message.content.some(
        /** 判断当前消息是否发起 Web 调用，以便同时删除同一消息的内部推理块。 */
        function isWebCall(block) { return block.type === "tool-call" && isRedactedCallName(block.name); },
      );
      const content: AgentMessage["content"] = message.content.flatMap(
        /** 替换 Web 参数/结果，并删除同一 Web 消息的内部推理块。 */
        function redactWebBlock(block) {
          if (containsWebCall && block.type === "reasoning") return [];
          if (block.type === "tool-call" && isRedactedCallName(block.name)) {
            return [{ ...block, input: { redacted: true } }];
          }
          if (block.type === "tool-result" && webCallIds.has(block.toolCallId)) {
            return [{ ...block, content: [{ type: "text" as const, text: "{\"redacted\":true}" }] }];
          }
          return [block];
        },
      );
      return containsWebCall ? { role: message.role, content } : { ...message, content };
    },
  );
  const pendingCalls = checkpoint.pendingCalls?.map(
    /** 替换尚未执行的 Web 工具输入，同时保留调用身份和顺序。 */
    function redactPendingWebCall(call) {
      return isRedactedCallName(call.name) ? { ...call, input: { redacted: true } } : call;
    },
  );
  return { ...checkpoint, messages, ...(pendingCalls ? { pendingCalls } : {}) };
}

/** 生成只含生命周期与安全 Skill 身份的 checkpoint 投影。 */
function projectSafeCheckpoint(checkpoint: AgentCheckpoint, eventType?: AgentLoopEvent["type"], includeConsumedInputIds = false): import("./event-envelope").PublicCheckpointView {
  const statuses: AgentCheckpoint["status"][] = [
    "running",
    "awaiting_approval",
    "awaiting_user_input",
    "interrupted",
    "interrupted_recoverable",
    "completed",
    "failed",
    "limit_reached",
  ];
  const fallbackStatus = eventType === "turn_completed" ? "completed"
    : eventType === "turn_interrupted" ? "interrupted"
      : eventType === "turn_limit_reached" ? "limit_reached"
        : "failed";
  const status = statuses.find(function keepKnownStatus(item) { return checkpoint.status === item; }) ?? fallbackStatus;
  const activeSkills = Array.isArray(checkpoint.activeSkills)
    ? checkpoint.activeSkills.flatMap(function keepSafeSkill(skill) {
        return skill && typeof skill.skillId === "string" && typeof skill.contentHash === "string"
          ? [{ skillId: skill.skillId, contentHash: skill.contentHash }]
          : [];
      })
    : undefined;
  const stepCount = Number.isSafeInteger(checkpoint.stepCount) && checkpoint.stepCount >= 0 ? checkpoint.stepCount : 0;
  const consumedInputIds = includeConsumedInputIds && Array.isArray(checkpoint.consumedInputIds)
    ? checkpoint.consumedInputIds.filter(function keepInputId(inputId) { return typeof inputId === "string"; })
    : undefined;
  return {
    turnId: checkpoint.turnId,
    status,
    stepCount,
    messages: [],
    completedCallIds: [],
    ...(activeSkills ? { activeSkills } : {}),
    ...(consumedInputIds ? { consumedInputIds } : {}),
  };
}

/** 宿主可见 checkpoint 只含生命周期与 Skill 身份，canonical messages 留在 Core 私有存储。 */
export function sanitizeCheckpoint(checkpoint: AgentCheckpoint): import("./event-envelope").PublicCheckpointView {
  return projectSafeCheckpoint(checkpoint, undefined, true);
}

/** 剥离 V2 消息中的 reasoning block 与 Adapter 私有 replay state。 */
export function sanitizeAgentMessagesForExternal(messages: AgentMessage[]): AgentMessage[] {
  return normalizeAgentMessages(messages).map(
    /** 为每条外部消息同时删除 replay state 与 reasoning。 */
    function stripPrivateAgentMessage(message) {
      const content = message.content.filter(
        /** 删除单个消息中的 reasoning block。 */
        function dropReasoning(block) { return block.type !== "reasoning"; },
      );
      return { role: message.role, content };
    },
  );
}

/** 把 todo_write 的公开工具结果降级为计数；完整安全快照只通过 todo_updated 事件投影。 */
function sanitizeTodoToolResult(event: AgentLoopEvent): AgentLoopEvent {
  if (event.type !== "tool_result" || event.toolName !== "todo_write" || event.result.status !== "success") return event;
  const output = event.result.output as { counts?: unknown };
  return { ...event, result: { ...event.result, output: { counts: output.counts } } };
}

/** render_ui 仅向模型和通用工具事件保留有限确认，不让文档副本进入工具结果。 */
function sanitizeRenderUiToolResult(event: AgentLoopEvent): AgentLoopEvent {
  if (event.type !== "tool_result" || event.toolName !== "render_ui" || event.result.status !== "success") return event;
  return { ...event, result: { ...event.result, output: { delivered: true } } };
}

/** 对 ui_document 再做一次字段白名单投影，事件只暴露文档协议所需身份与内容。 */
function sanitizeUiDocumentEvent(event: AgentLoopEvent): AgentLoopEvent {
  if (event.type !== "ui_document") return event;
  return {
    type: "ui_document",
    turnId: event.turnId,
    stepId: event.stepId,
    callId: event.callId,
    document: projectUiDocument(event.document),
  };
}

/**
 * 把 context_usage_updated 的 usage 与 turnUsage 收窄为白名单副本；
 * 任一字段非法时 usage fail closed 为 null，turnUsage 缺省保持缺省（表示无新事实），不信任对象形状。
 */
function sanitizeContextUsageEvent(event: AgentLoopEvent): AgentLoopEvent {
  if (event.type !== "context_usage_updated") return event;
  const usage = projectPublicContextUsage(event.usage);
  const turnUsage = event.turnUsage === undefined ? undefined : projectPublicTurnUsageSummary(event.turnUsage);
  if (usage === event.usage && turnUsage === event.turnUsage) return event;
  return {
    ...event,
    usage,
    ...(turnUsage === undefined ? {} : { turnUsage }),
  };
}

/** 把 Web 工具的公开事件结果降级为安全事实，原始答案、网页正文与 URL 只留在进程内采样链。 */
function sanitizeWebToolResult(event: AgentLoopEvent): AgentLoopEvent {
  if (event.type !== "tool_result" || (event.toolName !== "web_search" && event.toolName !== "web_fetch") || event.result.status !== "success") return event;
  const detail = event.result.display?.detail;
  const output = detail?.kind === "web_search"
    ? { sourceCount: detail.sourceCount, truncated: detail.truncated }
    : detail?.kind === "web_fetch"
      ? { host: detail.host, contentType: detail.contentType, truncated: detail.truncated }
      : { redacted: true };
  return { ...event, result: { ...event.result, output } };
}

/** 系统会话图片回退的公开事件只保留审批身份和有限状态，私有调用与观察不变。 */
function sanitizeSessionImageFallback(event: AgentLoopEvent): AgentLoopEvent {
  if ((event.type !== "tool_started" && event.type !== "tool_progress" && event.type !== "tool_result" && event.type !== "approval_required")
    || event.toolName !== "vision_analyze" || !/^image-fallback-[0-9a-f-]{36}-[0-9a-f-]{36}$/i.test(event.callId)) return event;
  const base = { turnId: event.turnId, stepId: event.stepId, callId: event.callId, toolName: event.toolName };
  if (event.type === "tool_started") return { type: "tool_started", ...base, summary: "正在分析会话图片" };
  if (event.type === "tool_progress") return { type: "tool_progress", ...base, tail: "正在分析会话图片" };
  if (event.type === "approval_required") {
    const approval = event.result.approval;
    const allowedDecisions = approval.display?.allowedDecisions ?? approval.allowedDecisions ?? [];
    return { type: "approval_required", ...base, result: { status: "approval_required", callId: event.callId, toolName: event.toolName, approval: {
      approvalId: approval.approvalId, callId: event.callId, toolName: event.toolName, normalizedInputHash: approval.normalizedInputHash,
      constraint: "vision-analyze:workspace", reason: "向配置的视觉 Provider 发送会话图片需要用户审批", risk: "read_only", preview: {}, expiresAt: approval.expiresAt,
      ...(approval.allowedDecisions ? { allowedDecisions: approval.allowedDecisions } : {}),
      display: { operation: "analyze", effect: "external", destructive: false, resource: "会话图片", risk: "read_only", allowedDecisions },
    } } };
  }
  const result = event.result;
  const meta = "meta" in result && result.meta ? { durationMs: result.meta.durationMs, inputHash: result.meta.inputHash, ...(result.meta.outputBytes !== undefined ? { outputBytes: result.meta.outputBytes } : {}), ...(result.meta.truncated !== undefined ? { truncated: result.meta.truncated } : {}) } : undefined;
  const display = { titleKey: result.status === "success" ? "tool.other.completed" : "tool.other.failed", target: "会话图片" };
  if (result.status === "success") return { type: "tool_result", ...base, retryCount: event.retryCount, summary: "会话图片分析完成", result: { status: "success", callId: event.callId, toolName: event.toolName, output: { analyzed: true }, meta: meta!, display } };
  if (result.status === "approval_required") return sanitizeSessionImageFallback({ type: "approval_required", ...base, result });
  if (result.status === "question_required") return { type: "tool_result", ...base, retryCount: event.retryCount, summary: "会话图片分析失败", result: { status: "error", callId: event.callId, toolName: event.toolName, error: { code: "TOOL_EXECUTION_FAILED", message: "会话图片分析失败" }, display } };
  const code = Object.values(TOOL_ERROR_CODES).find(function known(item) { return item === result.error.code; }) ?? "TOOL_EXECUTION_FAILED";
  const error = { code, message: "会话图片分析失败" };
  if (result.status === "cancelled" || result.status === "timeout") return { type: "tool_result", ...base, retryCount: event.retryCount, summary: "会话图片分析未完成", result: { status: result.status, callId: event.callId, toolName: event.toolName, error, meta: meta!, interruption: { phase: result.interruption.phase, normalizedInputHash: result.interruption.normalizedInputHash, sideEffectState: result.interruption.sideEffectState, safeToRetry: result.interruption.safeToRetry, reason: "会话图片分析未完成" }, display } };
  return { type: "tool_result", ...base, retryCount: event.retryCount, summary: "会话图片分析失败", result: { status: result.status, callId: event.callId, toolName: event.toolName, error, ...(meta ? { meta } : {}), display } } as AgentLoopEvent;
}

/** 只保留稳定错误码或 Core 固定文案；其他内容统一降级，避免 Provider 文本流出。 */
function sanitizeExternalError(value: string): string {
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
  const code = knownCodes.find(function findKnownCode(item) { return value.includes(item); });
  if (code) return code;

  const safeMessages = [
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
    "视觉分析工具不可用，无法处理图片",
    "图片视觉分析失败，无法继续处理",
    "会话图片不可用或已损坏",
    "Agent Loop 执行失败",
  ];
  return safeMessages.find(function findKnownMessage(message) { return value === message; }) ?? "Agent Loop 执行失败";
}

/** 终态只保留明确登记的诊断类别、阶段、反馈 ID 与 Provider HTTP 状态。 */
function sanitizeTerminalFailureDiagnostic(event: AgentLoopEvent): AgentLoopEvent {
  if (event.type !== "turn_failed") return event;
  const allowedCodes = new Set([
    "MISSING_CREDENTIAL", "PROVIDER_CONFIGURATION_INVALID", "CREDENTIAL_REF_INVALID", "PROVIDER_PROTOCOL_REQUIRED", "UNSUPPORTED_API_PROTOCOL", "TURN_EXECUTION_FAILED",
    "TOOL_CALL_REJECTED", "TOKEN_BUDGET_EXCEEDED", "TOOL_DENIED", "CONTEXT_COMPACTION_FAILED", "IMAGE_VISION_UNAVAILABLE", "IMAGE_VISION_FAILED", "IMAGE_INPUT_UNAVAILABLE",
    "TURN_COMPLETION_REJECTED", "CONTEXT_OVERFLOW", "MODEL_OUTPUT_LIMIT", "TOOL_CALL_TRUNCATED",
    "TOOL_CALL_INVALID_JSON", "STREAM_INCOMPLETE", "EMPTY_RESPONSE", "PROVIDER_CONNECTION",
    "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR", "PROVIDER_REQUEST_REJECTED",
  ]);
  const allowedStages = new Set([
    "tool_preflight", "runtime_budget", "tool_execution", "context_compaction", "provider_sampling",
    "provider_recovery", "completion_policy", "agent_loop",
  ]);
  const errorCode = typeof event.errorCode === "string"
    && (allowedCodes.has(event.errorCode) || isSandboxAvailabilityFailureCode(event.errorCode))
    ? event.errorCode
    : "TURN_EXECUTION_FAILED";
  const feedbackId = typeof event.feedbackId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.feedbackId)
    ? event.feedbackId
    : undefined;
  const failureStage = typeof event.failureStage === "string" && allowedStages.has(event.failureStage)
    ? event.failureStage as Extract<AgentLoopEvent, { type: "turn_failed" }>["failureStage"]
    : "agent_loop";
  const providerHttpStatus = errorCode.startsWith("PROVIDER_")
    && Number.isInteger(event.providerHttpStatus)
    && event.providerHttpStatus! >= 400
    && event.providerHttpStatus! <= 599
    ? event.providerHttpStatus
    : undefined;
  const providerFailureReason = sanitizeAgentProviderFailureReason(errorCode, event.providerFailureReason);
  const providerFailureDetail = errorCode.startsWith("PROVIDER_") ? sanitizeAgentProviderFailureDetail(event.providerFailureDetail) : undefined;
  const safeEvent = { ...event };
  delete safeEvent.feedbackId;
  delete safeEvent.failureStage;
  delete safeEvent.providerHttpStatus;
  delete (safeEvent as unknown as Record<string, unknown>).providerFailureProfile;
  delete safeEvent.providerFailureReason;
  delete safeEvent.providerFailureDetail;
  return {
    ...safeEvent,
    errorCode,
    failureStage,
    ...(feedbackId ? { feedbackId } : {}),
    ...(providerHttpStatus !== undefined ? { providerHttpStatus } : {}),
    ...(providerFailureReason ? { providerFailureReason } : {}),
    ...(providerFailureDetail ? { providerFailureDetail } : {}),
  };
}

/** 终态可继续状态只由 Core checkpoint 状态计算。 */
function isRecoverableCheckpointStatus(status: AgentCheckpoint["status"]): boolean {
  return status === "awaiting_approval"
    || status === "awaiting_user_input"
    || status === "interrupted"
    || status === "interrupted_recoverable"
    || status === "limit_reached";
}

/** 从 Core 终态事件构造严格白名单投影；旧字段缺失时只保留可信恢复布尔值。turn_paused 是审批/等待输入的可恢复暂停，不是终态，绝不投影 termination。 */
function projectTermination(event: AgentLoopEvent): ReturnType<typeof sanitizeAgentTerminationView> {
  if (!("checkpoint" in event) || !event.checkpoint) return undefined;
  if (event.type !== "turn_interrupted" && event.type !== "turn_failed" && event.type !== "turn_limit_reached") return undefined;

  const source = "termination" in event ? event.termination : undefined;
  const recoverable = isRecoverableCheckpointStatus(event.checkpoint.status);
  const reason = source?.reason !== undefined
    ? source.reason
    : event.checkpoint.interruptionReason ?? (event.type === "turn_limit_reached" ? "turn_limit_reached" : undefined);
  return sanitizeAgentTerminationView({
    ...(reason !== undefined ? { reason } : {}),
    recoverable,
    ...(source?.budget ? { budget: source.budget } : {}),
  }, recoverable);
}

/**
 * 对携带 checkpoint 的事件生成脱敏副本；不携带 checkpoint 的事件原样返回。
 * 供 turn-service 在写入 eventSink / transcriptStore 前调用。
 * @param event 原始事件（可能携带 checkpoint）
 * @returns 脱敏后的事件副本
 */
export function sanitizeEventForExternal(event: AgentLoopEvent | AgentEvent): AgentEvent {
  if (event.type === "thread_wait") {
    const valid = ["waiting", "processing", "none"].includes(event.phase) && [event.pending, event.running, event.approvals].every(function bounded(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 8; }) && event.running + event.approvals <= event.pending;
    return { type: "thread_wait", turnId: event.turnId, phase: valid ? event.phase : "none", pending: valid ? event.pending : 0, running: valid ? event.running : 0, approvals: valid ? event.approvals : 0 };
  }
  const internalEvent = event as AgentLoopEvent;
  const safeEvent = sanitizeSessionImageFallback(sanitizeUiDocumentEvent(sanitizeContextUsageEvent(sanitizeWebToolResult(sanitizeRenderUiToolResult(sanitizeTodoToolResult(sanitizeTerminalFailureDiagnostic(internalEvent)))))));
  const eventWithoutRawError = "error" in safeEvent && typeof safeEvent.error === "string"
    ? { ...safeEvent, error: sanitizeExternalError(safeEvent.error) } as AgentLoopEvent
    : safeEvent;
  if (!("checkpoint" in eventWithoutRawError) || !eventWithoutRawError.checkpoint) {
    const { termination: _droppedTermination, ...withoutTermination } = eventWithoutRawError as AgentLoopEvent & { termination?: unknown };
    return withoutTermination as AgentEvent;
  }

  const sanitizedCheckpoint = projectSafeCheckpoint(eventWithoutRawError.checkpoint, eventWithoutRawError.type);
  const termination = projectTermination(eventWithoutRawError);
  const { checkpoint: _checkpoint, termination: _oldTermination, ...rest } = eventWithoutRawError as AgentLoopEvent & { checkpoint: AgentCheckpoint; termination?: unknown };
  return {
    ...rest,
    checkpoint: sanitizedCheckpoint,
    ...(termination ? { termination } : {}),
  } as AgentEvent;
}
