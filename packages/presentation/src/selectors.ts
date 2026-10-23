/** Presentation selectors：为 CLI/Web 提供同一时间线、分组和终态读取接口。 */
import { groupToolCalls, type TimelineItem } from "./grouping.js";
import type { AgentPresentationItem, AgentPresentationState, ApprovalItem, AssistantAnswerItem, InputNoticeItem, PresentationInputPosition, TodoSnapshotItem, ToolCallItem, UserQuestionItem } from "./model.js";

/** 行动文案只按注册工具名白名单生成，不从命令、参数、路径或日志猜测目的。 */
function getToolAction(toolName: string): string {
  const actions: Record<string, string> = {
    open_preview: "检查预览页面是否可访问", read_file: "读取文件内容", glob_files: "查找相关文件", grep_files: "检索文件内容",
    rag_search: "检索知识库资料", web_search: "搜索网页资料", web_fetch: "读取网页资料", write_file: "写入文件", edit_file: "调整文件内容",
    run_command: "执行本地命令", start_background_job: "启动后台任务", list_background_jobs: "查看后台任务", read_background_job: "查看后台任务结果", stop_background_job: "停止后台任务",
  };
  return actions[toolName] ?? "执行工具操作";
}

/** 固定安全结果文案不推断根因、重试计划或浏览器实际显示状态。 */
function getToolOutcome(tool: ToolCallItem): string | undefined {
  if (tool.state === "awaiting_approval") return "等待确认后执行";
  if (tool.state === "denied") return tool.errorCode === "SANDBOX_UNAVAILABLE" ? "沙箱不可用，命令未启动" : "操作未获授权";
  if (tool.state === "cancelled") return "操作已取消";
  if (tool.state === "timeout") return "操作等待超时";
  if (tool.state === "failed") {
    const previewErrors: Record<string, string> = {
      PREVIEW_PAGE_NOT_FOUND: "预览页面不存在（HTTP 404）", PREVIEW_HTTP_ERROR: "预览地址返回 HTTP 错误",
      PREVIEW_CONNECTION_FAILED: "无法连接预览地址", PREVIEW_PROBE_TIMEOUT: "预览地址检查超时", PREVIEW_PROBE_ABORTED: "预览地址检查已取消",
    };
    return tool.toolName === "open_preview" ? previewErrors[tool.errorCode ?? ""] ?? "预览地址检查未通过" : "操作未成功";
  }
  if (tool.toolName === "open_preview" && tool.state === "completed") return "预览请求已准备";
  return undefined;
}

/** 从现有节点派生短进展；同一步之前已有安全模型正文时只保留结果，Live/History 使用同一规则。 */
export function selectToolProgress(state: AgentPresentationState, item: TimelineItem): { source: "system"; action?: string; outcome?: string } | undefined {
  if (item.kind !== "tool_call" && item.kind !== "tool_group") return undefined;
  const calls = item.kind === "tool_call" ? [item] : selectToolCalls(state, item.turnId).filter(function grouped(call) { return item.toolCallIds.includes(call.callId); });
  if (!calls.length) return undefined;
  const modelExplains = calls.every(function explained(call) {
    const position = state.items.findIndex(function same(candidate) { return candidate.id === call.id; });
    return Boolean(call.stepId) && state.items.slice(0, position).some(function process(candidate) {
      return candidate.kind === "assistant_answer" && candidate.turnId === call.turnId && candidate.stepId === call.stepId && Boolean(candidate.content.trim());
    });
  });
  const waiting = calls.some(function pending(call) { return call.state === "awaiting_approval"; });
  const notExecuted = calls.every(function stopped(call) { return call.state === "denied" || call.state === "cancelled"; });
  const action = waiting ? "等待确认后执行" : modelExplains || notExecuted ? undefined : [...new Set(calls.map(function action(call) { return getToolAction(call.toolName); }))].join("、");
  const outcome = item.kind === "tool_call" && !waiting ? getToolOutcome(item) : undefined;
  return { source: "system", action, outcome };
}

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
