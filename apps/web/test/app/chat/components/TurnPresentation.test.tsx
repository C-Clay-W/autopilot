/** TurnPresentation 回归测试：阶段性总结、工具组与编辑结果必须沿真实时间线交错显示。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolDisplayDetail } from "@autopilot-agent/core";
import type { AgentPresentationState } from "@autopilot-agent/presentation";
import TurnPresentation from "@/app/chat/components/TurnPresentation";
import { CurrentWorkTodo } from "@/app/chat/components/TodoListCard";

const userQuestionCallbacks = { onUserQuestionSubmit: async function ignoreQuestionSubmit() {}, onUserQuestionCancel: function ignoreQuestionCancel() {} };

/** 构造最小交错时间线，覆盖 Thinking、探索组、编辑 Diff 与末尾 Turn Summary。 */
function createTimelineState(): AgentPresentationState {
  const readDetail: ToolDisplayDetail = { kind: "read_file", path: "agent/API-Design.md", startLine: 205, endLine: 245, totalLines: 912, returnedLines: 41, truncated: true };
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    appliedEventIds: [],
    lastSeqByTurn: {},
    turnStartedAt: {},
    items: [
      { id: "thinking:turn-1:one", kind: "thinking", turnId: "turn-1", stepId: "one", summary: "先检查文件", state: "completed" },
      { id: "process:turn-1:0", kind: "assistant_answer", channel: "process", turnId: "turn-1", stepId: "one", content: "过程回答不能被吞" },
      { id: "tool:read-1", kind: "tool_call", turnId: "turn-1", stepId: "one", callId: "read-1", toolName: "read_file", profileKey: "read_file", category: "read", state: "completed", titleKey: "tool.read.completed", target: "agent/API-Design.md", detail: readDetail },
      { id: "tool:read-2", kind: "tool_call", turnId: "turn-1", stepId: "one", callId: "read-2", toolName: "read_file", profileKey: "read_file", category: "read", state: "completed", titleKey: "tool.read.completed" },
      { id: "thinking:turn-1:two", kind: "thinking", turnId: "turn-1", stepId: "two", summary: "再修改目标文件", state: "completed" },
      { id: "turn:turn-1:summary", kind: "turn_summary", turnId: "turn-1", state: "completed", toolCount: 3 },
      { id: "tool:edit-1", kind: "tool_call", turnId: "turn-1", stepId: "two", callId: "edit-1", toolName: "edit_file", profileKey: "edit_file", category: "edit", state: "completed", titleKey: "tool.edit.completed", target: "index.html", diff: { text: "-old\n+new", files: 1 } },
      { id: "answer:turn-1", kind: "assistant_answer", channel: "final", turnId: "turn-1", stepId: "two", content: "修改完成" },
    ],
  };
}

/** 构造重复工具标记摘要，验证展示层归并而不触碰真实 ToolCall 节点。 */
function createRepeatedToolSummaryState(): AgentPresentationState {
  const state = createTimelineState();
  return {
    ...state,
    items: state.items.filter(function omitInterleavedAnswer(item) { return item.id !== "process:turn-1:0"; }).map(function replaceSummary(item) {
      return item.kind === "thinking" && item.stepId === "one" ? { ...item, summary: "模型请求调用 read_file、read_file" } : item;
    }),
  };
}

/** 构造首个不可分组工具后接探索组的请求，覆盖 UI 摘要跨节点去重。 */
function createMixedToolRequestState(): AgentPresentationState {
  const state = createTimelineState();
  return {
    ...state,
    items: [
      { id: "thinking:turn-1:mixed", kind: "thinking", turnId: "turn-1", stepId: "mixed", summary: "模型请求调用 todo_write、glob_files、glob_files、glob_files", state: "completed" },
      { id: "tool:todo-1", kind: "tool_call", turnId: "turn-1", stepId: "mixed", callId: "todo-1", toolName: "todo_write", profileKey: "todo_write", category: "write", state: "completed", titleKey: "tool.write.completed" },
      { id: "tool:glob-1", kind: "tool_call", turnId: "turn-1", stepId: "mixed", callId: "glob-1", toolName: "glob_files", profileKey: "glob_files", category: "search", state: "completed", titleKey: "tool.search.completed" },
      { id: "tool:glob-2", kind: "tool_call", turnId: "turn-1", stepId: "mixed", callId: "glob-2", toolName: "glob_files", profileKey: "glob_files", category: "search", state: "completed", titleKey: "tool.search.completed" },
      { id: "tool:glob-3", kind: "tool_call", turnId: "turn-1", stepId: "mixed", callId: "glob-3", toolName: "glob_files", profileKey: "glob_files", category: "search", state: "completed", titleKey: "tool.search.completed" },
    ],
  };
}

/** 构造 Thinking 与工具组之间夹有过程输出的时间线，覆盖浅灰摘要的 UI 去重。 */
function createThinkingGapState(): AgentPresentationState {
  const state = createTimelineState();
  const toolNames = ["read_file", "read_file", "glob_files", "glob_files", "grep_files", "grep_files"];
  const readTools = toolNames.map(function createReadTool(toolName, index) {
    const isReadTool = toolName === "read_file";
    return { id: `tool:gap-read-${index}`, kind: "tool_call" as const, turnId: "turn-1", stepId: "gap", callId: `gap-read-${index}`, toolName, profileKey: toolName, category: isReadTool ? "read" as const : "search" as const, state: "completed" as const, titleKey: isReadTool ? "tool.read.completed" : "tool.search.completed" };
  });
  return {
    ...state,
    items: [
      { id: "thinking:turn-1:gap", kind: "thinking", turnId: "turn-1", stepId: "gap", summary: "模型请求调用 read_file, read_file, read_file, read_file, read_file, read_file", state: "completed" },
      { id: "process:turn-1:gap", kind: "assistant_answer", channel: "process", turnId: "turn-1", stepId: "gap", content: "发现项目结构" },
      ...readTools,
    ],
  };
}

/** 构造等待用户回答与已回答摘要同时存在的安全问题时间线。 */
function createUserQuestionState(): AgentPresentationState {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    appliedEventIds: [],
    lastSeqByTurn: {},
    turnStartedAt: {},
    items: [
      { id: "question:required", kind: "user_question", turnId: "turn-1", requestId: "request-required", callId: "call-required", state: "required", questions: [{ id: "scope", header: "范围", question: "这次处理哪些内容？", options: [{ label: "最小修改", description: "只处理已确认问题" }, { label: "额外整理", description: "同时修改相邻模块" }] }] },
      { id: "question:answered", kind: "user_question", turnId: "turn-1", requestId: "request-answered", callId: "call-answered", state: "answered", questions: [{ id: "verify", header: "验证", question: "如何验证？", options: [{ label: "定向测试", description: "只运行相关测试" }, { label: "全量测试", description: "运行全部测试" }] }], answerSummary: { questionCount: 1, selectedLabels: ["定向测试"], hasCustom: true } },
    ],
  };
}

/** 构造中断 Summary 与待回答问题并存的恢复时间线，覆盖 History 重放后的旧摘要抑制。 */
function createInterruptedQuestionState(): AgentPresentationState {
  const state = createTimelineState();
  return {
    ...state,
    items: [
      ...state.items.map(function markInterrupted(item) {
        return item.kind === "turn_summary" ? { ...item, state: "interrupted" as const } : item;
      }),
      { id: "question:required", kind: "user_question", turnId: "turn-1", requestId: "request-required", callId: "call-required", state: "required", questions: [{ id: "scope", header: "范围", question: "这次处理哪些内容？", options: [{ label: "最小修改", description: "只处理已确认问题" }, { label: "额外整理", description: "同时修改相邻模块" }] }] },
    ],
  };
}

describe("Stage4 历史控制", function stage4History() {
  it("Chat 隐去 Agent 提问控件，Work 只读历史不再提供回答操作", function gatesProductControls() {
    const state = createUserQuestionState();
    const callbacks = { ...userQuestionCallbacks, onApprovalDecision: function noApproval() {} };
    const chat = renderToStaticMarkup(<TurnPresentation state={state} turnId="turn-1" showThinking productMode="chat" {...callbacks} />);
    expect(chat).not.toContain("这次处理哪些内容");
    const work = renderToStaticMarkup(<TurnPresentation state={state} turnId="turn-1" showThinking readOnly {...callbacks} />);
    expect(work).toContain("历史提问记录（仅查看）");
    expect(work).not.toContain("<button");
  });
});

describe("TurnPresentation", function turnPresentationSuite() {
  it("显示白名单终态原因、Core 恢复状态与预算数值", function rendersSafeTerminationSummary() {
    const markup = renderToStaticMarkup(<TurnPresentation
      state={createTimelineState()}
      turnId="turn-1"
      showThinking
      termination={{ reason: "runtime_budget", recoverable: true, budget: { used: 1_001, limit: 1_000, unit: "ms" } }}
      onApprovalDecision={function ignoreDecision() {}}
      {...userQuestionCallbacks}
    />);

    expect(markup).toContain("执行时长达到上限 · 可以继续执行 · 1001 / 1000 ms");
    expect(markup).toContain('role="status"');
  });

  it("保留过程输出的既有正文样式，并将 Summary 固定在唯一最终回答末尾", function keepsTimelineOrder() {
    const markup = renderToStaticMarkup(<TurnPresentation state={createTimelineState()} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup.indexOf("先检查文件")).toBeLessThan(markup.indexOf("过程回答不能被吞"));
    expect(markup.indexOf("过程回答不能被吞")).toBeLessThan(markup.indexOf("已检查 2 项"));
    expect(markup.indexOf("已检查 2 项")).toBeLessThan(markup.indexOf("再修改目标文件"));
    expect(markup.indexOf("再修改目标文件")).toBeLessThan(markup.indexOf("index.html"));
    expect(markup).toContain("▾");
    const groupStart = markup.indexOf("已检查 2 项");
    const groupMarkup = markup.slice(groupStart, markup.indexOf("</button>", groupStart));
    expect(groupMarkup.indexOf("▸")).toBeLessThan(groupMarkup.indexOf("✓"));
    expect(markup).not.toContain("AUTOPILOT · THINKING");
    expect(markup).not.toContain("border-l");
    expect(markup).not.toContain("过程输出");
    expect(markup.indexOf("修改完成")).toBeLessThan(markup.indexOf("Turn Summary"));
  });

  it("显示通用思考状态并保留安全过程摘要", function showsGenericThinkingSummary() {
    const state = createTimelineState();
    const withGenericThinking = {
      ...state,
      items: state.items.map(function replaceFirstThinking(item) {
        return item.kind === "thinking" && item.stepId === "one" ? { ...item, summary: "正在思考" } : item;
      }),
    };
    const markup = renderToStaticMarkup(<TurnPresentation state={withGenericThinking} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup).toContain("正在思考");
    expect(markup).toContain("再修改目标文件");
  });

  it("探索组收起时只显示组摘要，子调用明细不提前渲染到页面", function keepsGroupDetailsCollapsed() {
    const markup = renderToStaticMarkup(<TurnPresentation state={createTimelineState()} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup).toContain("已检查 2 项");
    expect(markup).not.toContain("已读取第");
    expect(markup).not.toContain("205–245");
  });

  it("同一步已有真实调用时不再渲染自动工具名清单", function hidesRedundantToolNameSummary() {
    const markup = renderToStaticMarkup(<TurnPresentation state={createRepeatedToolSummaryState()} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup).not.toContain("模型请求调用 read_file、read_file");
    expect(markup).toContain("已检查 2 项");
    expect(createRepeatedToolSummaryState().items.filter(function isReadCall(item) { return item.kind === "tool_call" && item.stepId === "one"; })).toHaveLength(2);
  });

  it("共享时间线隐藏自动摘要但保留不可分组工具与探索组", function hidesMixedToolSummaryInUi() {
    const markup = renderToStaticMarkup(<TurnPresentation state={createMixedToolRequestState()} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup).not.toContain("模型请求调用 todo_write、glob_files、glob_files、glob_files");
    expect(markup).toContain("已检查 3 项");
    expect(markup).toContain("todo_write");
    expect(markup).toContain("space-y-2");
  });

  it("过程输出夹在中间时仍隐藏冗余工具名摘要并保留过程与工具组", function hidesThinkingSummaryAcrossProcessOutput() {
    const markup = renderToStaticMarkup(<TurnPresentation state={createThinkingGapState()} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);
    const groupStart = markup.indexOf("已检查 6 项");
    const groupMarkup = markup.slice(groupStart, markup.indexOf("</button>", groupStart));

    expect(markup).not.toContain("模型请求调用 read_file");
    expect(markup).toContain("已检查 6 项");
    expect(groupMarkup).toContain("read_file</span>、<span");
    expect(groupMarkup).not.toContain("read_fileglob_filesgrep_files");
    expect(markup).toContain("发现项目结构");
  });

  it("用户取消的 Turn Summary 显示用户已取消", function labelsUserCancellation() {
    const state = createTimelineState();
    const interrupted = {
      ...state,
      items: state.items.map(function markInterrupted(item) {
        return item.kind === "turn_summary" ? { ...item, state: "interrupted" as const } : item;
      }),
    };
    const markup = renderToStaticMarkup(<TurnPresentation state={interrupted} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup).toContain("Turn Summary · 用户已取消");
    expect(markup).not.toContain("Turn Summary · 已中断");
  });

  it("Turn Summary 将耗时格式化为时分秒", function formatsSummaryDurationAsHoursMinutesSeconds() {
    const state = createTimelineState();
    const withDuration = {
      ...state,
      items: state.items.map(function addDuration(item) {
        return item.kind === "turn_summary" ? { ...item, durationMs: 3_665_000 } : item;
      }),
    };
    const markup = renderToStaticMarkup(<TurnPresentation state={withDuration} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup).toContain("1 小时 1 分 5 秒");
    expect(markup).not.toContain("3665 秒");
  });

  it("继续执行期间隐藏上一轮 Summary 并显示活动提示", function hidesPreviousSummaryWhileResuming() {
    const state = createTimelineState();
    const interrupted = {
      ...state,
      items: state.items.map(function markInterrupted(item) {
        return item.kind === "turn_summary" ? { ...item, state: "interrupted" as const } : item;
      }),
    };
    const markup = renderToStaticMarkup(<TurnPresentation state={interrupted} turnId="turn-1" showThinking disabled isResuming onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup).not.toContain("Turn Summary");
    expect(markup).toContain("正在等待下一步事件");
  });

  it("将安全问题节点交给问题卡，并只展示已回答问题的脱敏摘要", function rendersUserQuestionTimelineItems() {
    const markup = renderToStaticMarkup(<TurnPresentation state={createUserQuestionState()} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup).toContain("最小修改（推荐）");
    expect(markup).toContain("提交并继续");
    expect(markup).toContain("澄清已提交");
    expect(markup).toContain("定向测试");
    expect(markup).not.toContain("Other 的原始正文");
  });

  it("待回答问题出现时隐藏旧的中断 Summary", function hidesInterruptedSummaryWhileQuestionRequired() {
    const markup = renderToStaticMarkup(<TurnPresentation state={createInterruptedQuestionState()} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup).toContain("需要你确认");
    expect(markup).not.toContain("Turn Summary · 用户已取消");
  });

  it("Todo 位于所属 Turn 摘要前，旧 selector 保留 Session latest 兼容语义", function rendersTodoSnapshotInOwningTurnOnly() {
    const state = createTimelineState();
    const withTodo = {
      ...state,
      items: [...state.items, { id: "todo:session-1", kind: "todo" as const, turnId: "turn-1", todos: [{ content: "补充回归测试", activeForm: "正在补充回归测试", status: "in_progress" as const }], counts: { pending: 0, inProgress: 1, completed: 0 } }],
    };
    const owningMarkup = renderToStaticMarkup(<TurnPresentation state={withTodo} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);
    const movedWithTodo = {
      ...withTodo,
      items: withTodo.items.map(function reassignTodoTurn(item) {
        return item.kind === "todo" ? { ...item, turnId: "turn-2" } : item;
      }),
    };
    const otherTurnMarkup = renderToStaticMarkup(<TurnPresentation state={movedWithTodo} turnId="turn-1" showThinking disabled={false} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(owningMarkup).toContain("Todo");
    expect(owningMarkup.indexOf("Todo")).toBeLessThan(owningMarkup.indexOf("Turn Summary"));
    expect(otherTurnMarkup).not.toContain("Todo");
    const workCard = renderToStaticMarkup(<CurrentWorkTodo presentation={movedWithTodo} isChat={false} />);
    expect(workCard).toContain("Todo");
    expect(workCard).toContain("0/1");
    expect(workCard).toContain("正在补充回归测试");
    expect(renderToStaticMarkup(<CurrentWorkTodo presentation={movedWithTodo} isChat />)).toBe("");
    const cleared = { ...movedWithTodo, items: movedWithTodo.items.map(function clearTodo(item) {
      return item.kind === "todo" ? { ...item, todos: [], counts: { pending: 0, inProgress: 0, completed: 0 } } : item;
    }) };
    expect(renderToStaticMarkup(<CurrentWorkTodo presentation={cleared} isChat={false} />)).toBe("");
  });
});

/** 构造带成功 open_preview 交付的 Turn 状态；不传终态摘要表示仍在运行。 */
function createPreviewDeliveryState(summaryState?: "completed" | "failed" | "interrupted" | "limit_reached"): AgentPresentationState {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    appliedEventIds: [],
    lastSeqByTurn: {},
    turnStartedAt: {},
    items: [
      { id: "tool:preview-1", kind: "tool_call", turnId: "turn-1", stepId: "one", callId: "preview-1", toolName: "open_preview", profileKey: "open_preview", category: "external", state: "completed", titleKey: "tool.external.completed", detail: { kind: "open_preview", previewId: "pvw-1", hostLabel: "127.0.0.1:5173", copyUrl: "http://127.0.0.1:5173/demo", openWhen: "after_turn", state: "prepared" } },
      { id: "answer:turn-1", kind: "assistant_answer", channel: "final", turnId: "turn-1", stepId: "two", content: "页面已准备好" },
      ...(summaryState ? [{ id: "turn:turn-1:summary", kind: "turn_summary" as const, turnId: "turn-1", state: summaryState, toolCount: 1 }] : []),
    ],
  };
}

/** 结果尾部接线桩：静态渲染只验证终态门与顺序，不触达网络。 */
const previewView = {
  panelPreviewId: null,
  resolvingPreviewId: null,
  onTogglePreview: function noopTogglePreview() {},
  onOpenInPreview: async function noopOpenInPreview() { return undefined; },
};

describe("结果尾部终态门（AC-8）", function resultAreaGate() {
  it("正常终态在最终正文之后、Turn Summary 之前渲染结果操作与完整链接", function rendersAfterNormalTerminal() {
    const markup = renderToStaticMarkup(<TurnPresentation state={createPreviewDeliveryState("completed")} turnId="turn-1" showThinking workPreview={previewView} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);

    expect(markup).toContain("打开预览");
    expect(markup).toContain("http://127.0.0.1:5173/demo");
    expect(markup.indexOf("页面已准备好")).toBeLessThan(markup.indexOf("打开预览"));
    expect(markup.indexOf("打开预览")).toBeLessThan(markup.indexOf("Turn Summary"));
  });

  it("运行中、失败、取消与 limit 终态都不渲染正常结果入口", function hidesWithoutNormalTerminal() {
    const states = [createPreviewDeliveryState(), createPreviewDeliveryState("failed"), createPreviewDeliveryState("interrupted"), createPreviewDeliveryState("limit_reached")];
    for (const state of states) {
      const markup = renderToStaticMarkup(<TurnPresentation state={state} turnId="turn-1" showThinking workPreview={previewView} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);
      expect(markup).not.toContain("打开预览");
      expect(markup).not.toContain("复制链接");
    }
  });

  it("终止提示与恢复中不渲染结果操作", function hidesOnTerminationAndResume() {
    const terminated = renderToStaticMarkup(<TurnPresentation state={createPreviewDeliveryState("completed")} turnId="turn-1" showThinking workPreview={previewView} termination={{ reason: "runtime_budget", recoverable: true }} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);
    expect(terminated).not.toContain("打开预览");
    const resuming = renderToStaticMarkup(<TurnPresentation state={createPreviewDeliveryState("completed")} turnId="turn-1" showThinking isResuming workPreview={previewView} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);
    expect(resuming).not.toContain("打开预览");
  });

  it("只读历史保留链接文本但不提供结果操作按钮", function readOnlyWithoutActions() {
    const markup = renderToStaticMarkup(<TurnPresentation state={createPreviewDeliveryState("completed")} turnId="turn-1" showThinking readOnly workPreview={previewView} onApprovalDecision={function ignoreDecision() {}} {...userQuestionCallbacks} />);
    expect(markup).not.toContain("打开预览");
  });
});
