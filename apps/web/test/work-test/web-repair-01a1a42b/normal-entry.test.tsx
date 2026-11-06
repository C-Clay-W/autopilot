/** 按真实Presentation reducer、selector和TurnPresentation入口验证观察采样占位与消息边界。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { capturePresentationInputPosition, createPresentationState, reducePresentationInput, selectTurnTimeline, type AgentPresentationState } from "@autopilot-agent/presentation";
import ChatMessageItem from "@/app/chat/components/ChatMessageItem";
import { restoreWebInputPresentation } from "@/lib/runtime-host/web-input-presentation";
import TurnPresentation from "@/app/chat/components/TurnPresentation";
import { groupWebObservations } from "@/app/chat/web-observation-groups";

/** 用生产reducer接收按seq单调的真实协议事件。 */
function append(state: AgentPresentationState, event: Record<string, unknown>): AgentPresentationState {
  const seq = (state.lastSeqByTurn.t ?? 0) + 1;
  return reducePresentationInput(state, { kind: "runtime_event", envelope: { sessionId: "s", turnId: "t", seq, timestamp: new Date(seq).toISOString(), event: event as never } });
}

/** 每次采样都先出现固定“正在思考”，之后才启动并完成对应wait工具。 */
function observe(state: AgentPresentationState, index: number): AgentPresentationState {
  const stepId = `step-${index}`;
  const callId = `call-${index}`;
  state = append(state, { type: "reasoning_summary", turnId: "t", stepId, summary: "正在思考" });
  state = append(state, { type: "tool_started", turnId: "t", stepId, callId, toolName: "wait_threads" });
  return append(state, { type: "tool_result", turnId: "t", stepId, callId, toolName: "wait_threads", result: { status: "success", callId, toolName: "wait_threads", output: {}, display: { titleKey: "tool.thread.read.completed", observation: { key: "target-task-operation", phase: "running", lines: ["execution=active"] } } } });
}

/** 当前视图仍走生产TurnPresentation，不在测试中复制分组与渲染算法。 */
function markup(state: AgentPresentationState): string {
  return renderToStaticMarkup(createElement(TurnPresentation, { state, turnId: "t", showThinking: true } as never));
}

/** 返回真实selector之后Web展示分组中的观察组。 */
function groups(state: AgentPresentationState) {
  return groupWebObservations(selectTurnTimeline(state, "t")).filter(function observation(item) { return item.kind === "web_tool_activity"; });
}

it("正常入口三次采样thinking占位不阻断观察组，第四次追加同组且审计节点保留", function placeholdersInNormalEntry() {
  let state = createPresentationState();
  state = observe(observe(observe(state, 1), 2), 3);
  expect(selectTurnTimeline(state, "t").filter(function thinking(item) { return item.kind === "thinking" && item.summary === "正在思考"; })).toHaveLength(3);
  const before = JSON.stringify(state.items);
  expect(groups(state)).toHaveLength(1);
  const first = groups(state)[0];
  expect(first).toMatchObject({ toolCallIds: ["call-1", "call-2", "call-3"] });
  expect(markup(state).match(/data-tool-activity=/g)).toHaveLength(1);
  expect(JSON.stringify(state.items)).toBe(before);
  state = observe(state, 4);
  expect(groups(state)[0]).toMatchObject({ id: first.id, toolCallIds: ["call-1", "call-2", "call-3", "call-4"] });
  expect(markup(state).match(/data-tool-activity=/g)).toHaveLength(1);
  expect(state.items.filter(function thinking(item) { return item.kind === "thinking"; })).toHaveLength(4);
});

it("正常入口模型过程回复、输入及实质thinking后重新形成活动段", function realTimelineBoundaries() {
  for (const boundary of ["process", "input", "thinking"]) {
    let state = observe(observe(observe(createPresentationState(), 1), 2), 3);
    if (boundary === "process") {
      state = append(state, { type: "answer_delta", turnId: "t", stepId: "boundary", delta: "真实模型过程回复" });
      state = append(state, { type: "answer_reset", turnId: "t", stepId: "boundary" });
    } else if (boundary === "input") {
      const position = capturePresentationInputPosition(state, "t");
      state = reducePresentationInput(state, { kind: "host_event", event: { kind: "input", input: { inputId: "input", turnId: "t", delivery: "steer", state: "consumed", content: "真实Thread输入", origin: { kind: "thread", threadId: "source" }, position } } });
    } else state = append(state, { type: "reasoning_summary", turnId: "t", stepId: "boundary", summary: "已核对新的实质阶段" });
    state = observe(observe(observe(state, 5), 6), 7);
    const found = groups(state);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ toolCallIds: ["call-1", "call-2", "call-3"] });
    expect(found[1]).toMatchObject({ toolCallIds: ["call-5", "call-6", "call-7"] });
    expect(found[1].id).not.toBe(found[0].id);
    const html = markup(state);
    expect(html.match(/data-tool-activity=/g)).toHaveLength(2);
    if (boundary === "process") expect(html).toContain("真实模型过程回复");
    if (boundary === "input") expect(html).toContain("真实Thread输入");
    if (boundary === "thinking") expect(html).toContain("已核对新的实质阶段");
  }
});

it("活动段从首调用归并混排工具，首身份稳定，安全历史保持顺序", function mixedActivity() {
  let state = observe(createPresentationState(), 1);
  const one = groupWebObservations(selectTurnTimeline(state, "t"))[0];
  expect(one).toMatchObject({ kind: "web_tool_activity", toolCallIds: ["call-1"] });
  state = append(state, { type: "tool_started", turnId: "t", stepId: "s2", callId: "send", toolName: "send_thread" });
  expect(groupWebObservations(selectTurnTimeline(state, "t"))[0]).toMatchObject({ id: one.id, toolCallIds: ["call-1", "send"] });
  const html = markup(state);
  expect(html.match(/data-tool-activity=/g)).toHaveLength(1);
  expect(html).not.toContain("执行工具操作");
});

it("追加Thread与用户输入统一Prompt框，来源在框外，恢复幂等", function promptStyle() {
  let state = createPresentationState();
  for (const input of [{ inputId: "thread", origin: { kind: "thread", threadId: "source" } }, { inputId: "human" }]) {
    for (let repeat = 0; repeat < 2; repeat += 1) state = reducePresentationInput(state, { kind: "host_event", event: { kind: "input", input: { ...input, turnId: "t", content: "同样正文", delivery: "steer", state: "consumed" } } } as never);
  }
  const html = markup(state);
  expect(html.match(/data-prompt-body=/g)).toHaveLength(2);
  expect(html.match(/Sent by Autopilot from another thread/g)).toHaveLength(1);
  expect(html).toMatch(/Sent by Autopilot from another thread<\/p><div[^>]*data-prompt-body/);
  expect(html).not.toContain("bg-accent");
});

it("仅末尾活动段扫描，正文切段与终态冻结，探索组保留全部调用", function activityLifecycle() {
  let state = append(createPresentationState(), { type: "turn_started", turnId: "t" });
  for (const callId of ["read-1", "read-2"]) state = append(state, { type: "tool_started", turnId: "t", stepId: "reads", callId, toolName: "read_file" });
  const options = { turnId: "t", showThinking: true, disabled: true };
  const live = renderToStaticMarkup(createElement(TurnPresentation, { ...options, state } as never));
  expect(live.match(/data-tool-activity=/g)).toHaveLength(1);
  expect(live.match(/knowledge-ingest-sweep/g)).toHaveLength(1);
  expect(live.match(/aria-label="read_file/g)).toHaveLength(2);
  state = append(state, { type: "answer_delta", turnId: "t", stepId: "answer", delta: "真实过程正文" });
  state = append(state, { type: "answer_reset", turnId: "t", stepId: "answer" });
  state = observe(state, 3);
  const split = renderToStaticMarkup(createElement(TurnPresentation, { ...options, state } as never));
  expect(split.match(/data-tool-activity=/g)).toHaveLength(2);
  expect(split.match(/knowledge-ingest-sweep/g)).toHaveLength(1);
  state = append(state, { type: "turn_completed", turnId: "t" });
  const frozen = renderToStaticMarkup(createElement(TurnPresentation, { ...options, state } as never));
  expect(frozen).not.toContain('knowledge-ingest-sweep');
  expect(frozen).toContain('真实过程正文');
});

it("主会话受信子审批只展示固定短句和目标入口，正文保持原文", function childApprovalNotice() {
  let state = createPresentationState();
  const target = "44438780-5607-4e06-8151-3e65d70fa968";
  state = append(state, { type: "tool_started", turnId: "t", stepId: "wait", callId: "wait", toolName: "wait_threads" });
  state = append(state, { type: "tool_result", turnId: "t", stepId: "wait", callId: "wait", toolName: "wait_threads", result: { status: "success", display: { titleKey: "tool.thread.read.completed", summary: "旧的工具UUID教程", observation: { key: "task", phase: "approval", lines: ["旧的详细教程"], approvalTargets: [target] } } } });
  const html = renderToStaticMarkup(createElement(TurnPresentation, { state, turnId: "t", showThinking: true, workspaceId: "ws" } as never));
  expect(html).toContain("子会话等待审批，需要人为介入");
  expect(html).toContain(`sessionId=${target}`);
  expect(html).not.toContain("旧的工具UUID教程");
  expect(html).not.toContain("旧的详细教程");
  state = append(state, { type: "answer_delta", turnId: "t", stepId: "body", delta: "真实正文保留Ctrl+A和UUID教程" });
  expect(markup(state)).toContain("真实正文保留Ctrl+A和UUID教程");
});

it("初始Thread Prompt与普通人类Prompt复用同一框外标签和默认样式", function initialPromptStyle() {
  const common = { presentation: createPresentationState(), msg: { id: "prompt", role: "user", content: "Sent by Autopilot from another thread" }, workspaceId: "ws", sessionId: "s" };
  const human = renderToStaticMarkup(createElement(ChatMessageItem, common as never));
  const thread = renderToStaticMarkup(createElement(ChatMessageItem, { ...common, msg: { ...common.msg, origin: { kind: "thread", threadId: "source" } } } as never));
  expect(human).toContain('data-prompt-body');
  expect(human).not.toContain('tracking-wide');
  expect(thread).toMatch(/Sent by Autopilot from another thread<\/p><div[^>]*data-prompt-body/);
  expect(thread.match(/data-prompt-body/g)).toHaveLength(1);
  expect(thread).not.toContain('bg-accent');
});

it("实时与刷新恢复的Thread输入位置及活动段一致，重复恢复只保留一个输入", function liveHistoryParity() {
  const events: Array<Record<string, unknown>> = [
    { type: "tool_started", turnId: "t", stepId: "s1", callId: "one", toolName: "read_file" },
    { type: "tool_result", turnId: "t", stepId: "s1", callId: "one", toolName: "read_file", result: { status: "success", display: { titleKey: "tool.read.completed" } } },
    { type: "input_consumed", turnId: "t", inputId: "thread", delivery: "steer" },
    { type: "tool_started", turnId: "t", stepId: "s2", callId: "two", toolName: "send_thread" },
    { type: "tool_result", turnId: "t", stepId: "s2", callId: "two", toolName: "send_thread", result: { status: "success", display: { titleKey: "tool.thread.send.completed" } } },
  ];
  const envelopes = events.map(function envelope(event, index) { return { sessionId: "s", turnId: "t", seq: index + 1, timestamp: new Date(index + 1).toISOString(), event }; });
  let live = createPresentationState();
  for (const envelope of envelopes) {
    const position = capturePresentationInputPosition(live, "t", 0);
    live = reducePresentationInput(live, { kind: "runtime_event", envelope } as never);
    if (envelope.event.type === "input_consumed") live = reducePresentationInput(live, { kind: "host_event", event: { kind: "input", input: { inputId: "thread", turnId: "t", delivery: "steer", state: "consumed", content: "受信追加输入", origin: { kind: "thread", threadId: "source" }, position } } });
  }
  let history = createPresentationState();
  for (const envelope of JSON.parse(JSON.stringify(envelopes))) history = reducePresentationInput(history, { kind: "runtime_event", envelope });
  const inputs = [{ inputId: "thread", turnId: "t", delivery: "steer", status: "consumed", content: "受信追加输入", origin: { kind: "thread", threadId: "source" } }];
  history = restoreWebInputPresentation(history, envelopes as never, inputs as never);
  history = restoreWebInputPresentation(history, envelopes as never, inputs as never);
  expect(markup(history)).toBe(markup(live));
  expect(groups(history)).toHaveLength(2);
  expect(history.items.filter(function input(item) { return item.kind === "input_notice"; })).toHaveLength(1);
});

it("失败审批保留原时间位置和状态，系统行动标题不逐项占行", function safetyTimeline() {
  let state = observe(createPresentationState(), 1);
  state = append(state, { type: "tool_started", turnId: "t", stepId: "failed", callId: "failed", toolName: "send_thread" });
  state = append(state, { type: "tool_result", turnId: "t", stepId: "failed", callId: "failed", toolName: "send_thread", result: { status: "error", error: { code: "THREADS_UNAVAILABLE", message: "安全失败" } } });
  state = observe(state, 2);
  const html = markup(state);
  const timeline = groupWebObservations(selectTurnTimeline(state, "t"));
  expect(timeline.map(function kind(item) { return item.kind; })).toEqual(["web_tool_activity", "tool_call", "web_tool_activity"]);
  expect(timeline[1]).toMatchObject({ callId: "failed", state: "failed" });
  expect(html).toContain("执行失败");
  expect(html).not.toContain("执行工具操作");
  expect(html.match(/data-tool-activity=/g)).toHaveLength(2);
});

it("直发与追加Prompt共用完整消息列右缘，追加输入不受助手宽度和padding二次缩进", function promptColumnAlignment() {
  for (const origin of [undefined, { kind: "thread", threadId: "source" }]) {
    const state = reducePresentationInput(createPresentationState(), { kind: "host_event", event: { kind: "input", input: { inputId: "follow-up", turnId: "t", content: "追加消息", delivery: "steer", state: "consumed", origin } } } as never);
    const common = { workspaceId: "ws", sessionId: "s", isChat: false, presentation: state, renderEvidence: function evidence() { return null; } };
    const direct = renderToStaticMarkup(createElement(ChatMessageItem, { ...common, msg: { id: "direct", role: "user", content: "直发消息", origin } } as never));
    const turn = renderToStaticMarkup(createElement(ChatMessageItem, { ...common, msg: { id: "assistant", role: "assistant", turnId: "t", content: "" } } as never));
    expect(direct).toContain('<div class="flex justify-end"><div class="max-w-[80%]">');
    expect(turn).toContain('<div class="flex justify-start"><div class="w-full">');
    expect(turn).toContain('<div class="group relative break-words py-3 text-sm leading-relaxed text-ink">');
    expect(turn).toContain('<section class="mt-3 flex justify-end"><div class="max-w-[80%]">');
    expect(turn).toContain("追加消息");
  }
});
