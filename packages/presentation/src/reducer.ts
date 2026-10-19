/** Presentation 纯 reducer：将安全 Runtime/Host 输入投影为可重放的统一视图状态。 */
import type { AgentEventEnvelope, ToolDisplayFacts } from "@autopilot-agent/core";
import { getRuntimeEventId, type PresentationInput } from "./input.js";
import type { AgentPresentationItem, AgentPresentationState, ApprovalItem, ContextNoticeItem, ToolCallItem, ToolCallState, TurnState, UserQuestionItem } from "./model.js";
import { createPresentationState } from "./model.js";
import { getToolPresentationProfile } from "./tool-profiles.js";

/** 按稳定 id 在不可变 item 列表中替换或追加单个节点。 */
function upsertItem<T extends AgentPresentationItem>(items: AgentPresentationItem[], item: T): AgentPresentationItem[] {
  const index = items.findIndex(function findItem(candidate) { return candidate.id === item.id; });
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

/** 获取指定 id 的已有节点，仅用于同一 callId/stepId 的安全状态更新。 */
function findItem<T extends AgentPresentationItem["kind"]>(items: AgentPresentationItem[], id: string, kind: T): Extract<AgentPresentationItem, { kind: T }> | undefined {
  return items.find(function matchesItem(item): item is Extract<AgentPresentationItem, { kind: T }> { return item.id === id && item.kind === kind; });
}

/** 新活动开始时结束此前可见 Thinking，避免多个同时活动的执行摘要。 */
function completeActiveThinking(state: AgentPresentationState): AgentPresentationState {
  if (state.activeOperation?.kind !== "thinking") return state;
  const items = state.items.map(function completeThinking(item) {
    return item.kind === "thinking" && item.state === "active" ? { ...item, state: "completed" as const } : item;
  });
  return { ...state, items, activeOperation: state.activeOperation?.kind === "thinking" ? undefined : state.activeOperation };
}

/** 使用已安全生成的 display facts 更新工具节点，绝不回读旧事件的 summary/detail 或 raw output。 */
function applyToolDisplay(item: ToolCallItem, display: ToolDisplayFacts | undefined): ToolCallItem {
  if (!display) return item;
  return {
    ...item,
    titleKey: display.titleKey || item.titleKey,
    target: display.target,
    resultSummary: display.summary,
    metrics: display.metrics,
    detail: display.detail,
    job: display.job,
    diff: display.diff,
    executionMode: display.executionMode,
    diagnostics: display.diagnostics,
  };
}

/** 根据 ToolExecutionResult 的公开状态转换为 Presentation 终态。 */
function getToolState(status: string): ToolCallState {
  if (status === "success") return "completed";
  if (status === "denied") return "denied";
  if (status === "cancelled") return "cancelled";
  if (status === "timeout") return "timeout";
  return "failed";
}

/** 取得或创建同一 callId 的工具节点，保证同名工具绝不互相覆盖。 */
function getToolItem(state: AgentPresentationState, envelope: AgentEventEnvelope, stepId: string, callId: string, toolName: string): ToolCallItem {
  const current = findItem(state.items, `tool:${callId}`, "tool_call");
  if (current) return current;
  const profile = getToolPresentationProfile(toolName);
  return {
    id: `tool:${callId}`,
    kind: "tool_call",
    turnId: envelope.turnId,
    stepId,
    callId,
    toolName,
    profileKey: profile.key,
    category: profile.category,
    state: "running",
    titleKey: profile.runningTitleKey,
  };
}

/** 将与工具调用关联的审批标记为已解决，不额外制造另一张工具卡。 */
function resolveApprovals(items: AgentPresentationItem[], callId: string): AgentPresentationItem[] {
  return items.map(function resolveApproval(item) {
    return item.kind === "approval" && item.callId === callId ? { ...item, state: "resolved" as const } : item;
  });
}

/** 只复制 Question 事件约定的展示字段，拒绝把未来未知字段或用户答案正文透传到 Presentation。 */
function createSafeUserQuestions(questions: import("@autopilot-agent/core").UserQuestionItem[]): UserQuestionItem["questions"] {
  return questions.map(function copyQuestion(question) {
    return {
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options.map(function copyOption(option) {
        return { label: option.label, description: option.description };
      }),
    };
  });
}

/** 只投影回答事件的安全摘要，custom 正文始终停留在 Runtime 私有 Store。 */
function createSafeQuestionAnswerSummary(answerSummary: { questionCount: number; selectedLabels: string[]; hasCustom: boolean }): NonNullable<UserQuestionItem["answerSummary"]> {
  return {
    questionCount: answerSummary.questionCount,
    selectedLabels: [...answerSummary.selectedLabels],
    hasCustom: answerSummary.hasCustom,
  };
}

/** 取消 Turn 时关闭该 Turn 尚未作答的问题，避免 History 重放后继续阻塞输入框。 */
function cancelRequiredUserQuestions(state: AgentPresentationState, turnId: string): AgentPresentationState {
  return {
    ...state,
    items: state.items.map(function cancelRequiredQuestion(item) {
      return item.kind === "user_question" && item.turnId === turnId && item.state === "required"
        ? { ...item, state: "cancelled" as const }
        : item;
    }),
    activeOperation: state.activeOperation?.kind === "question" ? undefined : state.activeOperation,
  };
}

/** 将当前最终候选原位归档为可追溯过程输出，避免过程文字与最终正文共用通道。 */
function archiveFinalAnswer(items: AgentPresentationItem[], turnId: string, stepId: string): AgentPresentationItem[] {
  const current = findItem(items, `answer:${turnId}`, "assistant_answer");
  if (!current || current.channel !== "final" || current.stepId !== stepId) return items;
  const processIndex = items.filter(function countProcessAnswer(item) {
    return item.kind === "assistant_answer" && item.turnId === turnId && item.channel === "process";
  }).length;
  return items.map(function archiveAnswer(item): AgentPresentationItem {
    return item.kind === "assistant_answer" && item.id === current.id
      ? { ...item, id: `process:${turnId}:${processIndex}`, channel: "process" }
      : item;
  });
}

/** 删除 Core 明确 discard 的当前候选，不能将其误归档为客户可追溯的过程输出。 */
function discardFinalAnswer(items: AgentPresentationItem[], turnId: string, stepId: string): AgentPresentationItem[] {
  const current = findItem(items, `answer:${turnId}`, "assistant_answer");
  if (!current || current.channel !== "final" || current.stepId !== stepId) return items;
  return items.filter(function omitDiscardedAnswer(item) { return item.id !== current.id; });
}

/** 乐观提交审批决定后立即收起对应卡片；服务端失败时由调用方或 History 恢复真实状态。 */
export function resolvePresentationApproval(state: AgentPresentationState, approvalId: string): AgentPresentationState {
  const approval = state.items.find(function findApproval(item): item is ApprovalItem {
    return item.kind === "approval" && item.approvalId === approvalId;
  });
  if (!approval) return state;
  return {
    ...state,
    items: state.items.map(function resolveApproval(item) {
      return item.kind === "approval" && item.approvalId === approvalId ? { ...item, state: "resolved" as const } : item;
    }),
    activeOperation: state.activeOperation?.id === approval.id ? undefined : state.activeOperation,
  };
}

/** 审批提交接口失败时恢复本地乐观状态；若工具已继续执行则尊重后续 Runtime 事实。 */
export function restorePresentationApproval(state: AgentPresentationState, approvalId: string): AgentPresentationState {
  const approval = state.items.find(function findApproval(item): item is ApprovalItem {
    return item.kind === "approval" && item.approvalId === approvalId;
  });
  if (!approval) return state;
  const tool = state.items.find(function findApprovalTool(item): item is ToolCallItem {
    return item.kind === "tool_call" && item.callId === approval.callId;
  });
  if (tool && tool.state !== "awaiting_approval") return state;
  if (state.turnSummary?.turnId === approval.turnId) return state;
  return {
    ...state,
    items: state.items.map(function restoreApproval(item) {
      return item.kind === "approval" && item.approvalId === approvalId ? { ...item, state: "required" as const } : item;
    }),
    activeOperation: { kind: "approval", id: approval.id },
  };
}

/** 计算 Turn 终态的结构化统计，不从文本或命令输出猜测测试结论。 */
function createTurnSummary(state: AgentPresentationState, envelope: AgentEventEnvelope, turnState: TurnState): AgentPresentationState {
  const tools = state.items.filter(function isTurnTool(item): item is ToolCallItem { return item.kind === "tool_call" && item.turnId === envelope.turnId; });
  const modifiedTools = tools.filter(function isCompletedMutation(item) { return item.state === "completed" && (item.category === "write" || item.category === "edit"); });
  const targets = new Set(modifiedTools.filter(function hasTarget(item) { return Boolean(item.target); }).map(function getTarget(item) { return item.target as string; }));
  const diffFileCount = modifiedTools.reduce(function countDiffFiles(total, item) { return total + (item.diff?.files ?? 0); }, 0);
  const startedAt = state.turnStartedAt[envelope.turnId];
  const durationMs = startedAt ? Math.max(0, Date.parse(envelope.timestamp) - Date.parse(startedAt)) : undefined;
  const summary = {
    id: `turn:${envelope.turnId}:summary`,
    kind: "turn_summary" as const,
    turnId: envelope.turnId,
    state: turnState,
    durationMs,
    toolCount: new Set(tools.map(function getCallId(item) { return item.callId; })).size,
    modifiedFileCount: targets.size || diffFileCount || undefined,
  };
  return { ...state, items: upsertItem(state.items, summary), turnSummary: summary, activeOperation: undefined };
}

/** 投影单个已按顺序到达的 Runtime 信封。 */
function reduceRuntimeEvent(state: AgentPresentationState, envelope: AgentEventEnvelope): AgentPresentationState {
  const event = envelope.event;
  if (event.type === "reasoning_delta") return state;
  if (event.type === "turn_started") {
    // 继续同一 Turn 时撤下旧中断总结，避免旧终态被宿主用于结束新 SSE。
    const items = state.items.filter(item => item.kind !== "turn_summary" || item.turnId !== envelope.turnId);
    return { ...state, items, turnSummary: undefined, sessionId: envelope.sessionId, turnId: envelope.turnId, turnStartedAt: { ...state.turnStartedAt, [envelope.turnId]: state.turnStartedAt[envelope.turnId] ?? envelope.timestamp } };
  }
  if (event.type === "reasoning_summary") {
    if (!event.summary.trim()) return state;
    const base = completeActiveThinking(state);
    return {
      ...base,
      items: upsertItem(base.items, { id: `thinking:${envelope.turnId}:${event.stepId}`, kind: "thinking", turnId: envelope.turnId, stepId: event.stepId, summary: event.summary, state: "active" }),
      activeOperation: { kind: "thinking", id: `thinking:${envelope.turnId}:${event.stepId}` },
    };
  }
  if (event.type === "answer_delta") {
    const base = completeActiveThinking(state);
    const current = findItem(base.items, `answer:${envelope.turnId}`, "assistant_answer");
    const items = current && current.stepId !== event.stepId ? archiveFinalAnswer(base.items, envelope.turnId, current.stepId) : base.items;
    const answer = findItem(items, `answer:${envelope.turnId}`, "assistant_answer");
    return { ...base, items: upsertItem(items, { id: `answer:${envelope.turnId}`, kind: "assistant_answer", channel: "final", turnId: envelope.turnId, stepId: event.stepId, content: `${answer?.content ?? ""}${event.delta}` }) };
  }
  if (event.type === "answer_reset") {
    // 工具调用、steer 或模型恢复后的候选转入过程通道，最终正文位置随即让给下一次采样。
    return { ...state, items: archiveFinalAnswer(state.items, envelope.turnId, event.stepId) };
  }
  if (event.type === "answer_discard") {
    // Core 明确判定本次候选无效，不进入过程或最终通道。
    return { ...state, items: discardFinalAnswer(state.items, envelope.turnId, event.stepId) };
  }
  if (event.type === "tool_started") {
    const base = completeActiveThinking(state);
    const item = { ...getToolItem(base, envelope, event.stepId, event.callId, event.toolName), state: "running" as const, startedAt: envelope.timestamp };
    return { ...base, items: upsertItem(base.items, item), activeOperation: { kind: "tool", id: item.id } };
  }
  if (event.type === "approval_required") {
    const base = completeActiveThinking(state);
    const tool = applyToolDisplay({ ...getToolItem(base, envelope, event.stepId, event.callId, event.toolName), state: "awaiting_approval" }, event.result.display);
    const display = event.result.approval.display;
    const approval: ApprovalItem = { id: `approval:${event.result.approval.approvalId}`, kind: "approval", turnId: envelope.turnId, approvalId: event.result.approval.approvalId, callId: event.callId, toolName: event.toolName, state: "required", constraint: event.result.approval.constraint, display };
    // 同一次 Fetch 跨域后产生新审批，旧域名审批已被消费，重放时也只保留当前目标可操作。
    return { ...base, items: upsertItem(upsertItem(resolveApprovals(base.items, event.callId), tool), approval), activeOperation: { kind: "approval", id: approval.id } };
  }
  if (event.type === "question_required") {
    const base = completeActiveThinking(state);
    const question: UserQuestionItem = {
      id: `question:${event.requestId}`,
      kind: "user_question",
      turnId: envelope.turnId,
      requestId: event.requestId,
      callId: event.callId,
      state: "required",
      questions: createSafeUserQuestions(event.questions),
    };
    return { ...base, items: upsertItem(base.items, question), activeOperation: { kind: "question", id: question.id } };
  }
  if (event.type === "question_answered") {
    const question = findItem(state.items, `question:${event.requestId}`, "user_question");
    if (!question) return state;
    const answered: UserQuestionItem = { ...question, state: "answered", answerSummary: createSafeQuestionAnswerSummary(event.answerSummary) };
    return { ...state, items: upsertItem(state.items, answered), activeOperation: state.activeOperation?.id === answered.id ? undefined : state.activeOperation };
  }
  if (event.type === "tool_result") {
    const base = completeActiveThinking(state);
    const result = event.result;
    const previous = getToolItem(base, envelope, event.stepId, event.callId, event.toolName);
    const item = applyToolDisplay({
      ...previous,
      state: getToolState(result.status),
      completedAt: envelope.timestamp,
      durationMs: "meta" in result ? result.meta?.durationMs : undefined,
      errorCode: "error" in result ? result.error.code : undefined,
    }, result.display);
    return { ...base, items: resolveApprovals(upsertItem(base.items, item), event.callId), activeOperation: base.activeOperation?.id === item.id ? undefined : base.activeOperation };
  }
  if (event.type === "todo_updated") {
    // Session 任务链单卡 latest-write-wins：timestamp 守卫保证跨 Turn 乱序回放时只有最近快照生效。
    const todo: import("./model.js").TodoSnapshotItem = { id: `todo:${envelope.sessionId}`, kind: "todo", turnId: envelope.turnId, todos: event.todos, counts: event.counts };
    const todosByTurn = { ...state.todosByTurn, [envelope.turnId]: { ...todo, id: `todo:${envelope.turnId}` } };
    if (state.todoLastUpdatedAt && envelope.timestamp < state.todoLastUpdatedAt) return { ...state, todosByTurn };
    return { ...state, items: upsertItem(state.items, todo), todosByTurn, todoLastUpdatedAt: envelope.timestamp };
  }
  if (event.type === "input_queued" || event.type === "input_joined" || event.type === "input_consumed") {
    const stateName = event.type === "input_queued" ? "queued" : event.type === "input_joined" ? "joined" : "consumed";
    const prior = findItem(state.items, `input:${event.inputId}`, "input_notice");
    if (prior && (prior.state === "consumed" || (prior.state === "joined" && stateName === "queued"))) return state;
    return {
      ...state,
      items: upsertItem(state.items, {
        ...prior,
        id: `input:${event.inputId}`,
        kind: "input_notice",
        turnId: envelope.turnId,
        inputId: event.inputId,
        delivery: event.type === "input_queued" ? event.delivery : prior?.delivery,
        state: stateName,
      }),
    };
  }
  if (event.type === "context_compact_started" || event.type === "context_compacted" || event.type === "context_compact_failed" || event.type === "context_compact_circuit_open" || event.type === "context_overflow") {
    const contextState: ContextNoticeItem["state"] = event.type === "context_compact_started" ? "compacting" : event.type === "context_compacted" ? "compacted" : event.type === "context_compact_failed" ? "failed" : event.type === "context_compact_circuit_open" ? "circuit_open" : "overflow";
    const trigger = "trigger" in event ? event.trigger : undefined;
    const summary = event.type === "context_compacted" ? event.summary : undefined;
    const notice: ContextNoticeItem = { id: `context:${envelope.turnId}:${envelope.seq}`, kind: "context_notice", turnId: envelope.turnId, state: contextState, trigger, summary };
    return { ...completeActiveThinking(state), items: upsertItem(state.items, notice), activeOperation: contextState === "compacting" ? { kind: "context", id: notice.id } : state.activeOperation };
  }
  if (event.type === "undo_completed" || event.type === "undo_failed") {
    return { ...state, items: upsertItem(state.items, { id: `undo:${event.transactionId}`, kind: "undo", turnId: envelope.turnId, transactionId: event.transactionId, state: event.type === "undo_completed" ? "completed" : "failed", restoredPaths: event.restoredPaths, compensatedPaths: event.compensatedPaths, conflicts: event.conflicts }) };
  }
  if (event.type === "turn_paused") return completeActiveThinking(state);
  if (event.type === "turn_completed" || event.type === "turn_interrupted" || event.type === "turn_failed" || event.type === "turn_limit_reached") {
    const turnState: TurnState = event.type === "turn_completed" ? "completed" : event.type === "turn_interrupted" ? "interrupted" : event.type === "turn_limit_reached" ? "limit_reached" : "failed";
    const terminalState = event.type === "turn_interrupted" ? cancelRequiredUserQuestions(state, envelope.turnId) : state;
    return createTurnSummary(completeActiveThinking(terminalState), envelope, turnState);
  }
  return state;
}

/** 投影 Host 安全事件；这些事件不会获得 Runtime transcript 身份。 */
function reduceHostEvent(state: AgentPresentationState, input: Extract<PresentationInput, { kind: "host_event" }>): AgentPresentationState {
  const event = input.event;
  if (event.kind === "input") {
    const prior = findItem(state.items, `input:${event.input.inputId}`, "input_notice");
    const consumed = prior?.state === "consumed" || prior?.state === "joined";
    const next = { ...prior, ...event.input, id: `input:${event.input.inputId}`, kind: "input_notice" as const, turnId: consumed ? prior!.turnId : event.input.turnId, state: consumed ? prior!.state : event.input.state };
    return { ...state, items: upsertItem(state.items, next) };
  }
  if (event.kind === "transport") return { ...state, transport: event.state };
  if (event.kind === "job") {
    if (state.sessionId && state.sessionId !== event.job.sessionId) return state;
    const existing = findItem(state.items, `job:${event.job.jobId}`, "job");
    if (existing && (existing.sessionId !== event.job.sessionId || existing.revision > event.job.revision)) return state;
    return { ...state, items: upsertItem(state.items, { id: `job:${event.job.jobId}`, kind: "job", ...event.job }) };
  }
  if (event.kind === "capability") return { ...state, items: upsertItem(state.items, { id: `capability:${event.id}`, kind: "capability_notice", scope: event.scope, state: event.state, summary: event.summary }) };
  return { ...state, items: upsertItem(state.items, { id: `capability:undo:${event.transactionId}`, kind: "capability_notice", scope: "undo", state: event.state }) };
}

/** 处理一个输入；Runtime 重复或乱序信封被拒绝，History 应改用 replayPresentationInputs 预排序。 */
export function reducePresentationInput(state: AgentPresentationState, input: PresentationInput): AgentPresentationState {
  if (input.kind === "host_event") return reduceHostEvent(state, input);
  const { envelope } = input;
  const eventId = getRuntimeEventId(envelope);
  // 同 Turn 的 seq 单调门禁已覆盖重复 ID，避免长历史上再扫描全部已应用事件。
  if (envelope.seq <= (state.lastSeqByTurn[envelope.turnId] ?? -1)) return state;
  const next = reduceRuntimeEvent(state, envelope);
  return { ...next, sessionId: envelope.sessionId, turnId: envelope.turnId, appliedEventIds: [...next.appliedEventIds, eventId], lastSeqByTurn: { ...next.lastSeqByTurn, [envelope.turnId]: envelope.seq } };
}

/** 将 History Runtime 信封按 Session、时间和同 Turn seq 回放；跨 Turn 同毫秒保留 Transcript 追加顺序。 */
export function replayPresentationInputs(inputs: PresentationInput[], initialState = createPresentationState()): AgentPresentationState {
  const runtimeInputs = inputs.filter(function isRuntime(input): input is Extract<PresentationInput, { kind: "runtime_event" }> { return input.kind === "runtime_event"; }).sort(function compareRuntime(left, right) {
    const a = left.envelope;
    const b = right.envelope;
    if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
    if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
    return a.turnId === b.turnId ? a.seq - b.seq : 0;
  });
  const hostInputs = inputs.filter(function isHost(input): input is Extract<PresentationInput, { kind: "host_event" }> { return input.kind === "host_event"; });
  return [...runtimeInputs, ...hostInputs].reduce(reducePresentationInput, initialState);
}
