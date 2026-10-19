/** Presentation selectors：为 CLI/Web 提供同一时间线、分组和终态读取接口。 */
import { groupToolCalls, type TimelineItem } from "./grouping.js";
import type { AgentPresentationItem, AgentPresentationState, ApprovalItem, AssistantAnswerItem, InputNoticeItem, PresentationInputPosition, TodoSnapshotItem, ToolCallItem, UserQuestionItem } from "./model.js";

/** 仅识别 Provider 为同批工具调用自动拼出的名称摘要。 */
function isRedundantToolCallSummary(item: AgentPresentationItem, items: AgentPresentationItem[]): boolean {
  if (item.kind !== "thinking" || !item.summary.startsWith("模型请求调用 ")) return false;
  return items.some(function hasMatchingToolCall(candidate) {
    return candidate.kind === "tool_call" && candidate.turnId === item.turnId && candidate.stepId === item.stepId;
  });
}

/** 返回按 reducer 事实顺序排列、并仅做视图级分组的时间线。 */
export function selectTimeline(state: AgentPresentationState): TimelineItem[] {
  const visibleItems = state.items.filter(function retainNonDuplicateSummary(item) {
    return !isRedundantToolCallSummary(item, state.items);
  });
  return groupToolCalls(visibleItems);
}

/** 捕获当前轮安全展示边界，连续回答按字符位置分割，工具分组仍交给共享 selector。 */
export function capturePresentationInputPosition(state: AgentPresentationState, turnId: string, order?: number): PresentationInputPosition {
  return { turnId, order, items: state.items.filter(function belongs(item) { return (item.kind === "capability_notice" || ("turnId" in item && item.turnId === turnId)) && item.kind !== "todo" && item.kind !== "turn_summary" && item.kind !== "input_notice"; }).map(function anchor(item) { return { id: item.id, answerLength: item.kind === "assistant_answer" ? item.content.length : undefined }; }) };
}

/** 每轮最后快照独立于 Session latest 单卡，旧 Presentation 保持按 turnId 回退。 */
export function selectTurnTodoSnapshot(state: AgentPresentationState, turnId: string): TodoSnapshotItem | undefined {
  return state.todosByTurn?.[turnId] ?? state.items.find(function todo(item): item is TodoSnapshotItem { return item.kind === "todo" && item.turnId === turnId; });
}

/** 合并宿主原文位置与共享时间线，末尾固定为本轮 Todo 然后终态摘要。 */
export function selectTurnTimeline(state: AgentPresentationState, turnId: string): TimelineItem[] {
  const items = state.items.filter(function belongs(item) { return item.kind !== "todo" && (item.kind === "capability_notice" || ("turnId" in item && item.turnId === turnId)); });
  const inputs = items.filter(function host(item): item is InputNoticeItem { return item.kind === "input_notice" && item.content !== undefined && item.position !== undefined; }).sort(function order(a, b) { return (a.position?.order ?? 0) - (b.position?.order ?? 0); });
  const inputIds = new Set(inputs.map(function id(item) { return item.id; }));
  let remaining = items.filter(function body(item) { return !inputIds.has(item.id); });
  const output: TimelineItem[] = [];
  /** 每一段使用原 selector，保留摘要去重与工具分组。 */
  function append(segment: AgentPresentationItem[]): void { output.push(...selectTimeline({ ...state, items: segment })); }
  for (const input of inputs) {
    const anchors = new Map(input.position!.items.map(function pair(item) { return [item.id, item]; }));
    const prefix: AgentPresentationItem[] = [];
    const tail: AgentPresentationItem[] = [];
    for (const item of remaining) {
      const anchor = anchors.get(item.id);
      if (!anchor) { tail.push(item); continue; }
      if (item.kind === "assistant_answer" && anchor.answerLength !== undefined) {
        const original = items.find(function same(candidate) { return candidate.id === item.id; });
        const used = original?.kind === "assistant_answer" ? original.content.length - item.content.length : 0;
        const length = Math.max(0, anchor.answerLength - used);
        if (length > 0) prefix.push({ ...item, id: `${item.id}:before:${input.inputId}`, content: item.content.slice(0, length) });
        if (length < item.content.length) tail.push({ ...item, content: item.content.slice(length) });
      } else prefix.push(item);
    }
    append(prefix);
    output.push(input);
    remaining = tail;
  }
  append(remaining.filter(function body(item) { return item.kind !== "turn_summary"; }));
  const todo = selectTurnTodoSnapshot(state, turnId);
  if (todo) output.push(todo);
  output.push(...remaining.filter(function summary(item): item is Extract<AgentPresentationItem, { kind: "turn_summary" }> { return item.kind === "turn_summary"; }));
  return output;
}

/** 返回指定 Turn 的真实 ToolCall 节点，供展开组或明细视图按 callId 获取。 */
export function selectToolCalls(state: AgentPresentationState, turnId?: string): ToolCallItem[] {
  return state.items.filter(function isTool(item): item is ToolCallItem { return item.kind === "tool_call" && (!turnId || item.turnId === turnId); });
}

/** 返回当前仍等待明确用户决定的冻结审批节点。 */
export function selectRequiredApprovals(state: AgentPresentationState): ApprovalItem[] {
  return state.items.filter(function isRequiredApproval(item): item is ApprovalItem { return item.kind === "approval" && item.state === "required"; });
}

/** 返回当前仍等待用户提交答案的结构化问题，不把已回答摘要误作可再次提交的请求。 */
export function selectRequiredUserQuestions(state: AgentPresentationState): UserQuestionItem[] {
  return state.items.filter(function isRequiredUserQuestion(item): item is UserQuestionItem { return item.kind === "user_question" && item.state === "required"; });
}

/** 返回某 Turn 的唯一最终助手答复；过程通道只供时间线追溯，绝不混入最终正文。 */
export function selectAssistantAnswers(state: AgentPresentationState, turnId?: string): AssistantAnswerItem[] {
  return state.items.filter(function isAnswer(item): item is AssistantAnswerItem { return item.kind === "assistant_answer" && item.channel === "final" && (!turnId || item.turnId === turnId) && Boolean(item.content); });
}

/** 返回 Session 任务链当前 Todo 快照；最新合法事件整值替换，普通新 Turn 不清空旧卡。 */
export function selectTodoSnapshot(state: AgentPresentationState): TodoSnapshotItem | undefined {
  return state.items.find(function isTodoSnapshot(item): item is TodoSnapshotItem { return item.kind === "todo"; });
}
